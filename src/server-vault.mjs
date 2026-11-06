import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { fail, json, mediaTypes, parseByteRange, readJson, writeResponseChunk } from './http-utils.mjs';
import { rejectSymlinkTraversal, resolveShareInside, safeName } from './path-guards.mjs';
import { hashManagedFile } from './duplicates.mjs';
import { clearThrottle, getThrottle, recordFailure } from './throttle-store.mjs';
import {
  copyVaultBackupObject,
  createVaultBackup,
  listVaultBackupDirectories,
  readVaultBackup,
  readVaultBackupSidecar,
  validateVaultBackupObjects,
} from './vault-backups.mjs';
import {
  createVaultKeyEnvelope,
  decryptVaultMetadata,
  decryptVaultStream,
  deriveVaultObjectKey,
  encryptVaultMetadata,
  encryptVaultStream,
  rewrapVaultMasterKey,
  createVaultRecoveryCode,
  createVaultRecoveryEnvelope,
  unlockVaultMasterKey,
  unlockVaultWithRecoveryCode,
} from './vault-crypto.mjs';

const VAULT_IDLE_LOCK_MS = 15 * 60 * 1000;

export function createVaultRouter(ctx) {
  const { db, dataDir, now = () => Date.now(), withPathLocks, withPathLock, ensureManagedDirectory, requirePermission, shareRoot } = ctx;

    const unlockedVaultKeys = new Map();
    const activeVaultImports = new Map();
    const activeVaultOperations = new Map();
    const pendingVaultLocks = new Set();
    const vaultLockWaiters = new Map();
    function finishVaultLock(userId) {
      const state = unlockedVaultKeys.get(userId);
      if (state) {
        clearTimeout(state.idleTimer);
        state.key.fill(0);
        unlockedVaultKeys.delete(userId);
      }
      pendingVaultLocks.delete(userId);
      for (const resolve of vaultLockWaiters.get(userId) || []) resolve();
      vaultLockWaiters.delete(userId);
    }
    function lockVaultKey(userId) {
      if (!unlockedVaultKeys.has(userId)) return Promise.resolve();
      const operations = activeVaultOperations.get(userId);
      if (operations?.size > 0) {
        pendingVaultLocks.add(userId);
        for (const controller of operations) controller.abort();
        return new Promise((resolve) => {
          const waiters = vaultLockWaiters.get(userId) || [];
          waiters.push(resolve);
          vaultLockWaiters.set(userId, waiters);
        });
      }
      finishVaultLock(userId);
      return Promise.resolve();
    }
    function setVaultKey(userId, key) {
      const scheduleIdleLock = (state) => {
        clearTimeout(state.idleTimer);
        state.idleTimer = setTimeout(() => { void lockVaultKey(userId); }, VAULT_IDLE_LOCK_MS);
        state.idleTimer.unref();
      };
      const state = { key, idleTimer: null, scheduleIdleLock };
      unlockedVaultKeys.set(userId, state);
      scheduleIdleLock(state);
    }
    function currentVaultKey(userId) {
      const state = unlockedVaultKeys.get(userId);
      if (!state || pendingVaultLocks.has(userId)) return null;
      state.scheduleIdleLock(state);
      return state.key;
    }
    async function withVaultKey(userId, operation) {
      const key = currentVaultKey(userId);
      if (!key) throw fail(423, 'vault_locked', '請先解鎖加密空間。');
      const controller = new AbortController();
      const operations = activeVaultOperations.get(userId) || new Set();
      operations.add(controller);
      activeVaultOperations.set(userId, operations);
      try { return await operation(key, controller.signal); }
      finally {
        operations.delete(controller);
        if (operations.size > 0) activeVaultOperations.set(userId, operations);
        else {
          activeVaultOperations.delete(userId);
          if (pendingVaultLocks.has(userId)) finishVaultLock(userId);
        }
      }
    };
    async function reconcileVaultOrphans(userId, masterKey, signal) {
      const vaultRoot = path.join(dataDir, '.nanako-vault');
      const directory = path.join(vaultRoot, userId);
      const directoryInfo = await lstat(directory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!directoryInfo) return;
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw fail(500, 'vault_storage_invalid', '加密空間儲存目錄不安全；已停止復原。');
      const entries = await readdir(directory, { withFileTypes: true });
      const candidates = new Set();
      for (const entry of entries) {
        const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.nkm$/iu.exec(entry.name);
        if (match && entry.isFile()) candidates.add(match[1].toLowerCase());
      }
      for (const objectId of candidates) {
        if (signal.aborted) throw fail(499, 'vault_recovery_cancelled', '加密空間鎖定已取消孤兒檔案核對。');
        const objectPath = path.join(directory, `${objectId}.nkv`);
        const temporaryPath = `${objectPath}.tmp`;
        const metadataPath = path.join(directory, `${objectId}.nkm`);
        const metadataTemporaryPath = `${metadataPath}.tmp`;
        await withPathLocks([objectPath, temporaryPath, metadataPath, metadataTemporaryPath], async () => {
          if (db.prepare('SELECT id FROM vault_objects WHERE id = ? AND user_id = ?').get(objectId, userId)) return;
          try {
            for (const target of [objectPath, temporaryPath, metadataPath]) await rejectSymlinkTraversal(dataDir, vaultRoot, target);
            const sidecarInfo = await lstat(metadataPath);
            if (!sidecarInfo.isFile() || sidecarInfo.isSymbolicLink() || sidecarInfo.size > 96 * 1024) return;
            const envelope = JSON.parse(await readFile(metadataPath, 'utf8'));
            const metadata = decryptVaultMetadata(envelope, masterKey, userId, objectId);
            if (typeof metadata.name !== 'string' || !Number.isSafeInteger(metadata.size) || metadata.size < 0
              || typeof metadata.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(metadata.sourceDigest)) return;
            let contentPath = objectPath;
            let contentInfo = await lstat(objectPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
            if (!contentInfo) {
              contentPath = temporaryPath;
              contentInfo = await lstat(temporaryPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
            }
            if (!contentInfo?.isFile() || contentInfo.isSymbolicLink()) return;
            const objectKey = deriveVaultObjectKey(masterKey, userId, objectId);
            const digest = crypto.createHash('sha256');
            let size = 0;
            try {
              for await (const chunk of decryptVaultStream(createReadStream(contentPath, { signal }), { key: objectKey, objectId })) {
                digest.update(chunk); size += chunk.length;
              }
            } finally { objectKey.fill(0); }
            if (size !== metadata.size || digest.digest('hex') !== metadata.sourceDigest) return;
            if (contentPath === temporaryPath) await rename(temporaryPath, objectPath);
            await rm(metadataTemporaryPath, { force: true }).catch(() => {});
            db.exec('BEGIN IMMEDIATE');
            try {
              db.prepare('INSERT INTO vault_objects(id, user_id, metadata_json) VALUES(?,?,?)').run(objectId, userId, JSON.stringify(envelope));
              db.prepare('INSERT INTO vault_pending_imports(object_id, user_id, created_at) VALUES(?,?,?)')
                .run(objectId, userId, new Date().toISOString());
              db.exec('COMMIT');
            } catch (error) {
              try { db.exec('ROLLBACK'); } catch { /* transaction may not have begun */ }
              throw error;
            }
          } catch (error) {
            if (signal.aborted) throw fail(499, 'vault_recovery_cancelled', '加密空間鎖定已取消孤兒檔案核對。');
            if (['ENOENT', 'EISDIR', 'ENOTDIR', 'ELOOP', 'invalid_vault_config', 'vault_integrity_failed'].includes(error.code)) return;
            throw error;
          }
        });
      }
      const afterReconcile = await readdir(directory, { withFileTypes: true });
      const incompleteIds = new Set(afterReconcile.flatMap((entry) => {
        const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.nk[vm]\.tmp$/iu.exec(entry.name);
        return match && entry.isFile() ? [match[1].toLowerCase()] : [];
      }));
      for (const objectId of incompleteIds) {
        const objectPath = path.join(directory, `${objectId}.nkv`);
        const temporaryPath = `${objectPath}.tmp`;
        const metadataPath = path.join(directory, `${objectId}.nkm`);
        const metadataTemporaryPath = `${metadataPath}.tmp`;
        await withPathLocks([objectPath, temporaryPath, metadataPath, metadataTemporaryPath], async () => {
          if (db.prepare('SELECT id FROM vault_objects WHERE id = ? AND user_id = ?').get(objectId, userId)) return;
          const finalMetadata = await lstat(metadataPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
          if (finalMetadata) return;
          for (const target of [temporaryPath, metadataTemporaryPath]) {
            await rejectSymlinkTraversal(dataDir, vaultRoot, target);
            const info = await lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
            if (info?.isSymbolicLink() || (info && !info.isFile())) throw fail(500, 'vault_storage_invalid', '加密空間暫存檔案不安全；已停止清理。');
            if (info) await rm(target, { force: true });
          }
        });
      }
    }
    async function listVaultOrphans(userId) {
      const directory = path.join(dataDir, '.nanako-vault', userId);
      const entries = await readdir(directory, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
      const indexed = new Set(db.prepare('SELECT id FROM vault_objects WHERE user_id = ?').all(userId).map((row) => row.id));
      const found = new Map();
      for (const entry of entries) {
        const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.nkv(?:\.tmp)?$/iu.exec(entry.name);
        if (!match || !entry.isFile()) continue;
        const id = match[1].toLowerCase();
        if (indexed.has(id)) continue;
        const fullPath = path.join(directory, entry.name);
        await rejectSymlinkTraversal(dataDir, path.join(dataDir, '.nanako-vault'), fullPath);
        const info = await lstat(fullPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (info?.isFile() && !info.isSymbolicLink()) found.set(id, { id, encryptedBytes: info.size });
      }
      return [...found.values()].sort((left, right) => left.id.localeCompare(right.id));
    }
    const vaultAttemptKey = (req, user) => `${req.socket.remoteAddress || 'local'}\0${user.id}`;
    function assertVaultUnlockAllowed(key, timestamp = now()) {
      const attempt = getThrottle(db, 'vault_unlock', key, timestamp);
      if (attempt?.lockedUntil > timestamp) throw fail(429, 'vault_unlock_throttled', '嘗試次數過多，請稍後再解鎖加密空間。');
    }
    function recordVaultUnlockFailure(key, timestamp = now()) {
      recordFailure(db, 'vault_unlock', key, timestamp);
    }

  function matchesVaultRoute(method, route) {
    if (method === 'GET' && ['/api/vault/status', '/api/vault/objects/import/status', '/api/vault/objects', '/api/vault/trash', '/api/vault/backups', '/api/vault/recovery'].includes(route)) return true;
    if (method === 'POST' && ['/api/vault/objects/import/cancel', '/api/vault/setup', '/api/vault/unlock', '/api/vault/recover', '/api/vault/recovery-key', '/api/vault/password', '/api/vault/lock', '/api/vault/backups', '/api/vault/objects/import'].includes(route)) return true;
    if (method === 'POST' && /^\/api\/vault\/backups\/[0-9a-f-]{36}\/restore$/iu.test(route)) return true;
    if (method === 'DELETE' && /^\/api\/vault\/backups\/[0-9a-f-]{36}$/iu.test(route)) return true;
    if (method === 'POST' && (/^\/api\/vault\/recovery\/[0-9a-f-]{36}$/iu.test(route) || /^\/api\/vault\/orphans\/[0-9a-f-]{36}$/iu.test(route) || /^\/api\/vault\/trash\/[0-9a-f-]{36}\/restore$/iu.test(route))) return true;
    if (method === 'GET' && /^\/api\/vault\/objects\/[0-9a-f-]{36}\/content$/iu.test(route)) return true;
    if (method === 'DELETE' && (/^\/api\/vault\/objects\/[0-9a-f-]{36}$/iu.test(route) || /^\/api\/vault\/trash\/[0-9a-f-]{36}$/iu.test(route))) return true;
    return false;
  }

  async function dispatchVaultRoute({ req, res, method, route, url, user }) {
    if (route === '/api/vault/status' && method === 'GET') {
      const vault = db.prepare('SELECT user_id FROM vaults WHERE user_id = ?').get(user.id);
      return json(res, 200, { configured: Boolean(vault), unlocked: unlockedVaultKeys.has(user.id) });
    }
    if (route === '/api/vault/objects/import/status' && method === 'GET') {
      const active = activeVaultImports.get(user.id);
      return json(res, 200, { active: Boolean(active), ...(active ? {
        id: active.id, bytesRead: active.bytesRead, totalBytes: active.totalBytes, phase: active.phase,
      } : {}) });
    }
    if (route === '/api/vault/objects/import/cancel' && method === 'POST') {
      const active = activeVaultImports.get(user.id);
      if (!active) return json(res, 200, { active: false });
      if (active.phase === '移除已驗證來源') throw fail(409, 'vault_import_too_late_to_cancel', '來源移除階段已開始，無法安全取消；請等待作業完成。');
      active.controller.abort();
      return json(res, 200, { active: true, cancelling: true });
    }
    if (route === '/api/vault/setup' && method === 'POST') {
      if (db.prepare('SELECT user_id FROM vaults WHERE user_id = ?').get(user.id)) throw fail(409, 'vault_already_setup', '這個帳號已建立加密空間。');
      const body = await readJson(req);
      let created; let recoveryCode; let recoveryEnvelope;
      try { created = await createVaultKeyEnvelope(body.password, user.id); }
      catch (error) {
        if (error.code === 'invalid_vault_password') throw fail(400, error.code, error.message);
        throw error;
      }
      try {
        recoveryCode = createVaultRecoveryCode();
        recoveryEnvelope = await createVaultRecoveryEnvelope(recoveryCode, created.masterKey, user.id);
      } catch (error) {
        created.masterKey.fill(0);
        throw error;
      }
      try {
        db.exec('BEGIN IMMEDIATE');
        db.prepare('INSERT INTO vaults(user_id, envelope_json, recovery_json, created_at) VALUES(?,?,?,?)')
          .run(user.id, JSON.stringify(created.envelope), JSON.stringify(recoveryEnvelope), new Date().toISOString());
        db.exec('COMMIT');
        await lockVaultKey(user.id);
        setVaultKey(user.id, created.masterKey);
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* transaction may not have begun */ }
        created.masterKey.fill(0);
        if (db.prepare('SELECT user_id FROM vaults WHERE user_id = ?').get(user.id)) throw fail(409, 'vault_already_setup', '這個帳號已建立加密空間。');
        throw error;
      }
      return json(res, 201, { configured: true, unlocked: true, recoveryCode });
    }
    if (route === '/api/vault/unlock' && method === 'POST') {
      const attemptKey = vaultAttemptKey(req, user);
      assertVaultUnlockAllowed(attemptKey);
      const row = db.prepare('SELECT envelope_json FROM vaults WHERE user_id = ?').get(user.id);
      if (!row) throw fail(404, 'vault_not_setup', '這個帳號尚未建立加密空間。');
      const body = await readJson(req);
      let masterKey;
      try { masterKey = await unlockVaultMasterKey(JSON.parse(row.envelope_json), body.password, user.id); }
      catch (error) {
        if (error.code === 'invalid_vault_password') throw fail(400, error.code, error.message);
        if (error.code === 'vault_unlock_failed') {
          recordVaultUnlockFailure(attemptKey);
          throw fail(401, error.code, error.message);
        }
        if (error.code === 'invalid_vault_config') throw fail(500, 'vault_config_corrupt', '加密空間金鑰資料已損毀或格式不支援。');
        throw error;
      }
      await lockVaultKey(user.id);
      setVaultKey(user.id, masterKey);
      clearThrottle(db, 'vault_unlock', attemptKey);
      return json(res, 200, { configured: true, unlocked: true });
    }
    if (route === '/api/vault/recover' && method === 'POST') {
      const attemptKey = vaultAttemptKey(req, user);
      assertVaultUnlockAllowed(attemptKey);
      const row = db.prepare('SELECT recovery_json FROM vaults WHERE user_id = ?').get(user.id);
      if (!row) throw fail(404, 'vault_not_setup', '這個帳號尚未建立加密空間。');
      if (!row.recovery_json) throw fail(409, 'vault_recovery_unavailable', '這個加密空間尚未設定復原金鑰；請先使用加密空間密碼解鎖。');
      const body = await readJson(req);
      let masterKey;
      try { masterKey = await unlockVaultWithRecoveryCode(JSON.parse(row.recovery_json), body.recoveryCode, user.id); }
      catch (error) {
        if (error.code === 'invalid_recovery_code') throw fail(400, error.code, error.message);
        if (error.code === 'vault_recovery_failed') {
          recordVaultUnlockFailure(attemptKey);
          throw fail(401, error.code, error.message);
        }
        if (error.code === 'invalid_vault_config') throw fail(500, 'vault_config_corrupt', '加密空間復原金鑰資料已損毀或格式不支援。');
        throw error;
      }
      await lockVaultKey(user.id);
      setVaultKey(user.id, masterKey);
      clearThrottle(db, 'vault_unlock', attemptKey);
      return json(res, 200, { configured: true, unlocked: true });
    }
    if (route === '/api/vault/recovery-key' && method === 'POST') {
      return await withVaultKey(user.id, async (masterKey) => {
        const recoveryCode = createVaultRecoveryCode();
        const recoveryEnvelope = await createVaultRecoveryEnvelope(recoveryCode, masterKey, user.id);
        db.prepare('UPDATE vaults SET recovery_json = ? WHERE user_id = ?').run(JSON.stringify(recoveryEnvelope), user.id);
        return json(res, 200, { recoveryCode });
      });
    }
    if (route === '/api/vault/password' && method === 'POST') {
      const body = await readJson(req);
      return await withVaultKey(user.id, async (masterKey) => {
        let envelope;
        try { envelope = await rewrapVaultMasterKey(body.password, masterKey, user.id); }
        catch (error) {
          if (error.code === 'invalid_vault_password') throw fail(400, error.code, error.message);
          throw error;
        }
        db.prepare('UPDATE vaults SET envelope_json = ? WHERE user_id = ?').run(JSON.stringify(envelope), user.id);
        return json(res, 200, { ok: true });
      });
    }
    if (route === '/api/vault/lock' && method === 'POST') {
      await lockVaultKey(user.id);
      return json(res, 200, { configured: Boolean(db.prepare('SELECT user_id FROM vaults WHERE user_id = ?').get(user.id)), unlocked: false });
    }

    if (route === '/api/vault/objects' && method === 'GET') {
      return await withVaultKey(user.id, (masterKey) => {
        const rows = db.prepare('SELECT id, metadata_json FROM vault_objects WHERE user_id = ? AND deleted_at IS NULL ORDER BY id').all(user.id);
        const items = rows.map((row) => {
          let metadata;
          try { metadata = decryptVaultMetadata(JSON.parse(row.metadata_json), masterKey, user.id, row.id); }
          catch { throw fail(500, 'vault_metadata_corrupt', '加密空間索引無法驗證；已停止顯示檔案清單。'); }
          if (typeof metadata.name !== 'string' || !Number.isSafeInteger(metadata.size) || metadata.size < 0) {
            throw fail(500, 'vault_metadata_corrupt', '加密空間索引內容不正確；已停止顯示檔案清單。');
          }
          return { id: row.id, name: metadata.name, relativePath: metadata.relativePath, size: metadata.size, modifiedAt: metadata.modifiedAt, mediaType: metadata.mediaType };
        });
        return json(res, 200, { items });
      });
    }
    if (route === '/api/vault/trash' && method === 'GET') {
      return await withVaultKey(user.id, (masterKey) => {
        const rows = db.prepare('SELECT id, metadata_json, deleted_at FROM vault_objects WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC').all(user.id);
        const items = rows.map((row) => {
          let metadata;
          try { metadata = decryptVaultMetadata(JSON.parse(row.metadata_json), masterKey, user.id, row.id); }
          catch { throw fail(500, 'vault_metadata_corrupt', '加密空間資源回收筒索引無法驗證；已停止顯示檔案清單。'); }
          return { id: row.id, name: metadata.name, size: metadata.size, mediaType: metadata.mediaType, deletedAt: row.deleted_at };
        });
        return json(res, 200, { items });
      });
    }
    const vaultRoot = path.join(dataDir, '.nanako-vault');
    const userVaultDirectory = path.join(vaultRoot, user.id);
    const vaultBackupRoot = path.join(userVaultDirectory, 'backups');
    if (route === '/api/vault/backups' && method === 'GET') {
      return await withVaultKey(user.id, async (masterKey) => {
        await rejectSymlinkTraversal(dataDir, vaultRoot, vaultBackupRoot, false);
        const items = [];
        for (const id of await listVaultBackupDirectories(vaultBackupRoot)) {
          try {
            await rejectSymlinkTraversal(dataDir, vaultRoot, path.join(vaultBackupRoot, id));
            const backup = await readVaultBackup({ backupRoot: vaultBackupRoot, backupId: id, userId: user.id, masterKey });
            items.push({ id, createdAt: backup.manifest.createdAt, itemCount: backup.manifest.objects.length, encryptedBytes: backup.manifest.totalEncryptedBytes });
          } catch { items.push({ id, createdAt: null, itemCount: null, encryptedBytes: null, invalid: true }); }
        }
        return json(res, 200, { items });
      });
    }
    if (route === '/api/vault/backups' && method === 'POST') {
      return await withVaultKey(user.id, async (masterKey, signal) => {
        await rejectSymlinkTraversal(dataDir, vaultRoot, vaultBackupRoot, false);
        await ensureManagedDirectory(vaultBackupRoot);
        const vault = db.prepare('SELECT envelope_json, recovery_json FROM vaults WHERE user_id = ?').get(user.id);
        const objects = db.prepare(`SELECT o.id, o.metadata_json, o.deleted_at, p.created_at AS pending_created_at
          FROM vault_objects o LEFT JOIN vault_pending_imports p ON p.object_id = o.id
          WHERE o.user_id = ? ORDER BY o.id`).all(user.id);
        const result = await createVaultBackup({
          backupRoot: vaultBackupRoot,
          sourceRoot: userVaultDirectory,
          userId: user.id,
          masterKey,
          vaultEnvelope: JSON.parse(vault.envelope_json),
          recoveryEnvelope: vault.recovery_json ? JSON.parse(vault.recovery_json) : null,
          objects,
          signal,
        });
        return json(res, 201, { ok: true, backup: result });
      });
    }
    const vaultBackupRestoreRoute = /^\/api\/vault\/backups\/([0-9a-f-]{36})\/restore$/iu.exec(route);
    if (vaultBackupRestoreRoute && method === 'POST') {
      const backupId = vaultBackupRestoreRoute[1].toLowerCase();
      return await withVaultKey(user.id, async (masterKey, signal) => {
        await rejectSymlinkTraversal(dataDir, vaultRoot, vaultBackupRoot, false);
        const backup = await readVaultBackup({ backupRoot: vaultBackupRoot, backupId, userId: user.id, masterKey });
        await rejectSymlinkTraversal(dataDir, vaultRoot, backup.directory);
        const validated = await validateVaultBackupObjects({ backup, userId: user.id, masterKey, signal });
        let restored = 0; let skipped = 0;
        for (const item of validated) {
          if (signal.aborted) throw fail(499, 'vault_backup_cancelled', '加密備份還原因加密空間鎖定而取消。');
          const objectId = item.record.id;
          const objectPath = path.join(userVaultDirectory, `${objectId}.nkv`);
          const temporaryPath = `${objectPath}.tmp`;
          const metadataPath = path.join(userVaultDirectory, `${objectId}.nkm`);
          const metadataTemporaryPath = `${metadataPath}.tmp`;
          await withPathLocks([objectPath, temporaryPath, metadataPath, metadataTemporaryPath], async () => {
            const existing = db.prepare('SELECT id FROM vault_objects WHERE id = ? AND user_id = ?').get(objectId, user.id);
            const currentContent = await lstat(objectPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
            if (existing && currentContent?.isFile() && !currentContent.isSymbolicLink()) { skipped += 1; return; }
            if (!existing && currentContent) throw fail(409, 'vault_orphan_unresolved', '加密空間有尚未處理的孤兒檔案；請先檢查復原清單再還原備份。');
            if (currentContent && (!currentContent.isFile() || currentContent.isSymbolicLink())) throw fail(409, 'vault_storage_invalid', '加密空間目標路徑不安全；未還原備份。');
            await copyVaultBackupObject(item.content, temporaryPath, signal);
            const sidecar = await readVaultBackupSidecar(path.join(backup.directory, 'objects', `${objectId}.nkm`));
            await writeFile(metadataTemporaryPath, sidecar, { flag: 'wx', mode: 0o600 });
            await rename(metadataTemporaryPath, metadataPath);
            await rename(temporaryPath, objectPath);
            db.exec('BEGIN IMMEDIATE');
            try {
              if (existing) db.prepare('UPDATE vault_objects SET metadata_json = ? WHERE id = ? AND user_id = ?')
                .run(JSON.stringify(item.record.metadata), objectId, user.id);
              else db.prepare('INSERT INTO vault_objects(id, user_id, metadata_json, deleted_at) VALUES(?,?,?,?)')
                .run(objectId, user.id, JSON.stringify(item.record.metadata), item.record.deletedAt || null);
              if (!existing && item.record.pendingCreatedAt) {
                db.prepare('INSERT INTO vault_pending_imports(object_id, user_id, created_at) VALUES(?,?,?)')
                  .run(objectId, user.id, item.record.pendingCreatedAt);
              }
              db.exec('COMMIT');
            } catch (error) {
              try { db.exec('ROLLBACK'); } catch { /* transaction may not have begun */ }
              throw error;
            }
            restored += 1;
          });
        }
        return json(res, 200, { ok: true, restored, skipped, total: validated.length });
      });
    }
    const vaultBackupDeleteRoute = /^\/api\/vault\/backups\/([0-9a-f-]{36})$/iu.exec(route);
    if (vaultBackupDeleteRoute && method === 'DELETE') {
      const backupId = vaultBackupDeleteRoute[1].toLowerCase();
      const body = await readJson(req);
      if (body.confirmText !== '刪除備份') throw fail(400, 'confirmation_required', '請輸入「刪除備份」確認操作。');
      return await withVaultKey(user.id, async () => {
        const target = path.join(vaultBackupRoot, backupId);
        await rejectSymlinkTraversal(dataDir, vaultRoot, target);
        const info = await lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (!info?.isDirectory() || info.isSymbolicLink()) throw fail(404, 'vault_backup_not_found', '找不到加密備份。');
        await rm(target, { recursive: true, force: false });
        return json(res, 200, { ok: true });
      });
    }
    if (route === '/api/vault/recovery' && method === 'GET') {
      return await withVaultKey(user.id, async (masterKey, signal) => {
        await reconcileVaultOrphans(user.id, masterKey, signal);
        const rows = db.prepare(`SELECT p.object_id AS id, o.metadata_json
          FROM vault_pending_imports p JOIN vault_objects o ON o.id = p.object_id
          WHERE p.user_id = ? ORDER BY p.created_at LIMIT 101`).all(user.id);
        const items = [];
        for (const row of rows.slice(0, 100)) {
          let metadata;
          try { metadata = decryptVaultMetadata(JSON.parse(row.metadata_json), masterKey, user.id, row.id); }
          catch { throw fail(500, 'vault_metadata_corrupt', '加密空間復原索引無法驗證；已停止處理。'); }
          let sourceState = 'unavailable';
          if (typeof metadata.sourceShareId === 'string' && typeof metadata.relativePath === 'string'
            && typeof metadata.sourceDigest === 'string' && /^[a-f0-9]{64}$/u.test(metadata.sourceDigest)) {
            try {
              const objectPath = path.join(dataDir, '.nanako-vault', user.id, `${row.id}.nkv`);
              await rejectSymlinkTraversal(dataDir, path.join(dataDir, '.nanako-vault'), objectPath);
              const objectInfo = await lstat(objectPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
              if (!objectInfo?.isFile() || objectInfo.isSymbolicLink()) {
                sourceState = 'ciphertext-missing';
                items.push({ id: row.id, name: metadata.name, size: metadata.size, shareId: metadata.sourceShareId, relativePath: metadata.relativePath, sourceState });
                continue;
              }
              const { share, root } = shareRoot(metadata.sourceShareId);
              requirePermission(user, share.id, true);
              const { target } = resolveShareInside(root, metadata.relativePath);
              await rejectSymlinkTraversal(dataDir, root, target);
              const info = await lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
              if (!info) sourceState = 'missing';
              else if (!info.isFile() || info.isSymbolicLink()) sourceState = 'changed';
              else {
                const current = await hashManagedFile(target, { signal });
                sourceState = current.size === metadata.size && current.digest === metadata.sourceDigest ? 'unchanged' : 'changed';
              }
            } catch (error) {
              if (signal.aborted) throw fail(499, 'vault_recovery_cancelled', '復原檢查因加密空間鎖定而取消。');
              sourceState = 'unavailable';
            }
          }
          items.push({ id: row.id, name: metadata.name, size: metadata.size, shareId: metadata.sourceShareId, relativePath: metadata.relativePath, sourceState });
        }
        const orphans = await listVaultOrphans(user.id);
        return json(res, 200, { items, truncated: rows.length > 100, orphans: orphans.slice(0, 100), orphansTruncated: orphans.length > 100 });
      });
    }
    const vaultRecoveryRoute = /^\/api\/vault\/recovery\/([0-9a-f-]{36})$/iu.exec(route);
    if (vaultRecoveryRoute && method === 'POST') {
      const objectId = vaultRecoveryRoute[1].toLowerCase();
      const body = await readJson(req);
      if (!['complete', 'keep'].includes(body.action)) throw fail(400, 'invalid_recovery_action', '復原操作不正確。');
      return await withVaultKey(user.id, async (masterKey, signal) => {
        const row = db.prepare(`SELECT o.metadata_json FROM vault_pending_imports p
          JOIN vault_objects o ON o.id = p.object_id WHERE p.object_id = ? AND p.user_id = ?`).get(objectId, user.id);
        if (!row) throw fail(404, 'vault_recovery_not_found', '找不到待確認的加密空間移入作業。');
        let metadata;
        try { metadata = decryptVaultMetadata(JSON.parse(row.metadata_json), masterKey, user.id, objectId); }
        catch { throw fail(500, 'vault_metadata_corrupt', '加密空間復原索引無法驗證；已停止處理。'); }
        if (body.action === 'keep') {
          const objectPath = path.join(dataDir, '.nanako-vault', user.id, `${objectId}.nkv`);
          await rejectSymlinkTraversal(dataDir, path.join(dataDir, '.nanako-vault'), objectPath);
          const objectInfo = await lstat(objectPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
          if (!objectInfo) db.prepare('DELETE FROM vault_objects WHERE id = ? AND user_id = ?').run(objectId, user.id);
          else {
            if (!objectInfo.isFile() || objectInfo.isSymbolicLink()) throw fail(409, 'vault_recovery_ciphertext_invalid', '加密路徑不是一般檔案；未變更復原資料。');
            db.prepare('DELETE FROM vault_pending_imports WHERE object_id = ? AND user_id = ?').run(objectId, user.id);
          }
          return json(res, 200, { ok: true, action: 'keep' });
        }
        if (typeof metadata.sourceShareId !== 'string' || typeof metadata.relativePath !== 'string'
          || typeof metadata.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(metadata.sourceDigest)) {
          throw fail(409, 'vault_recovery_unavailable', '此筆移入作業缺少安全復原資訊；請保留目前檔案並選擇「保留原檔」。');
        }
        const { share, root } = shareRoot(metadata.sourceShareId);
        requirePermission(user, share.id, true);
        const { target: sourcePath } = resolveShareInside(root, metadata.relativePath);
        const objectPath = path.join(dataDir, '.nanako-vault', user.id, `${objectId}.nkv`);
        await rejectSymlinkTraversal(dataDir, path.join(dataDir, '.nanako-vault'), objectPath);
        const objectInfo = await lstat(objectPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
        if (!objectInfo?.isFile() || objectInfo.isSymbolicLink()) throw fail(409, 'vault_recovery_ciphertext_missing', '加密檔案本體不存在；未移除來源檔案。請保留原檔並清除無效索引。');
        const objectKey = deriveVaultObjectKey(masterKey, user.id, objectId);
        const encryptedHash = crypto.createHash('sha256');
        let encryptedSize = 0;
        try {
          for await (const chunk of decryptVaultStream(createReadStream(objectPath, { signal }), { key: objectKey, objectId })) {
            encryptedHash.update(chunk);
            encryptedSize += chunk.length;
          }
        } catch {
          if (signal.aborted) throw fail(499, 'vault_recovery_cancelled', '復原作業因加密空間鎖定而取消。');
          throw fail(409, 'vault_recovery_ciphertext_invalid', '加密檔案驗證失敗；未移除來源檔案，請保留原檔。');
        } finally { objectKey.fill(0); }
        if (encryptedSize !== metadata.size || encryptedHash.digest('hex') !== metadata.sourceDigest) {
          throw fail(409, 'vault_recovery_ciphertext_invalid', '加密檔案內容與來源驗證資料不符；未移除來源檔案，請保留原檔。');
        }
        await withPathLock(sourcePath, async () => {
          await rejectSymlinkTraversal(dataDir, root, sourcePath);
          const before = await lstat(sourcePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
          if (before) {
            if (!before.isFile() || before.isSymbolicLink()) throw fail(409, 'vault_recovery_changed', '原始路徑已不再是一般檔案；為避免刪錯，未移除任何檔案。');
            let current;
            try { current = await hashManagedFile(sourcePath, { signal }); }
            catch {
              if (signal.aborted) throw fail(499, 'vault_recovery_cancelled', '復原作業因加密空間鎖定而取消。');
              throw fail(409, 'vault_recovery_changed', '無法驗證原始檔案；為避免刪錯，未移除任何檔案。');
            }
            const after = await lstat(sourcePath).catch(() => null);
            if (!after?.isFile() || after.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs
              || (before.ino && after.ino !== before.ino) || before.dev !== after.dev || before.ctimeMs !== after.ctimeMs
              || current.dev !== before.dev || current.ino !== before.ino || current.ctimeMs !== before.ctimeMs
              || current.size !== metadata.size || current.digest !== metadata.sourceDigest) {
              throw fail(409, 'vault_recovery_changed', '原始檔案內容已變更；為避免刪錯，未移除任何檔案。請選擇「保留原檔」。');
            }
            await unlink(sourcePath);
          }
          db.prepare('DELETE FROM vault_pending_imports WHERE object_id = ? AND user_id = ?').run(objectId, user.id);
        });
        return json(res, 200, { ok: true, action: 'complete' });
      });
    }
    const vaultOrphanRoute = /^\/api\/vault\/orphans\/([0-9a-f-]{36})$/iu.exec(route);
    if (vaultOrphanRoute && method === 'POST') {
      const objectId = vaultOrphanRoute[1].toLowerCase();
      const body = await readJson(req);
      if (body.confirmText !== '永久刪除孤兒密文') throw fail(400, 'confirmation_required', '請輸入「永久刪除孤兒密文」確認操作。');
      return await withVaultKey(user.id, async () => {
        if (db.prepare('SELECT id FROM vault_objects WHERE id = ? AND user_id = ?').get(objectId, user.id)) throw fail(409, 'vault_orphan_indexed', '這個物件已出現在加密空間索引；請改用檔案清單操作。');
        const directory = path.join(dataDir, '.nanako-vault', user.id);
        const paths = [`${objectId}.nkv`, `${objectId}.nkv.tmp`, `${objectId}.nkm`, `${objectId}.nkm.tmp`].map((name) => path.join(directory, name));
        await withPathLocks(paths, async () => {
          if (db.prepare('SELECT id FROM vault_objects WHERE id = ? AND user_id = ?').get(objectId, user.id)) throw fail(409, 'vault_orphan_indexed', '這個物件已出現在加密空間索引；請改用檔案清單操作。');
          let found = false;
          for (const target of paths) {
            await rejectSymlinkTraversal(dataDir, path.join(dataDir, '.nanako-vault'), target);
            const info = await lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
            if (!info) continue;
            if (!info.isFile() || info.isSymbolicLink()) throw fail(409, 'vault_orphan_invalid', '孤兒路徑不是一般檔案；未刪除任何內容。');
            found = true;
          }
          if (!found) throw fail(404, 'vault_orphan_not_found', '找不到這筆未索引加密資料。');
          for (const target of paths) await rm(target, { force: true });
        });
        return json(res, 200, { ok: true });
      });
    }
    if (route === '/api/vault/objects/import' && method === 'POST') {
      const body = await readJson(req);
      const shareId = String(body.shareId || '');
      const { share, root } = shareRoot(shareId);
      requirePermission(user, shareId, true);
      const { target: sourcePath, parts } = resolveShareInside(root, body.path || '');
      if (!parts.length) throw fail(400, 'invalid_path', '請先選取要移入加密空間的檔案。');
      await rejectSymlinkTraversal(dataDir, root, sourcePath);
      const sourceInfo = await lstat(sourcePath).catch(() => null);
      if (!sourceInfo?.isFile()) throw fail(404, 'file_not_found', '找不到要移入的檔案，或項目不是一般檔案。');
      if (activeVaultImports.has(user.id)) throw fail(409, 'vault_import_busy', '此帳號已有加密移入作業；請先完成或取消後再試。');
      const name = safeName(parts.at(-1));
      const directory = path.join(dataDir, '.nanako-vault', user.id);
      await ensureManagedDirectory(directory);
      await rejectSymlinkTraversal(dataDir, path.join(dataDir, '.nanako-vault'), directory);
      const objectId = crypto.randomUUID();
      const temporaryPath = path.join(directory, `${objectId}.nkv.tmp`);
      const objectPath = path.join(directory, `${objectId}.nkv`);
      const metadataTemporaryPath = path.join(directory, `${objectId}.nkm.tmp`);
      const metadataPath = path.join(directory, `${objectId}.nkm`);
      const importController = new AbortController();
      if (activeVaultImports.has(user.id)) throw fail(409, 'vault_import_busy', '此帳號已有加密移入作業；請先完成或取消後再試。');
      const importProgress = { id: crypto.randomUUID(), bytesRead: 0, totalBytes: sourceInfo.size, phase: '加密中', controller: importController };
      activeVaultImports.set(user.id, importProgress);
      const cancelImport = () => { if (!res.writableEnded) importController.abort(); };
      res.once('close', cancelImport);
      let item;
      try { item = await withVaultKey(user.id, async (masterKey, vaultSignal) => withPathLocks([sourcePath, temporaryPath, objectPath, metadataTemporaryPath, metadataPath], async () => {
        const abortImport = () => importController.abort();
        if (vaultSignal.aborted) abortImport();
        else vaultSignal.addEventListener('abort', abortImport, { once: true });
        const objectKey = deriveVaultObjectKey(masterKey, user.id, objectId);
        const sourceHash = crypto.createHash('sha256');
        const sourceStream = createReadStream(sourcePath, { signal: importController.signal });
        const trackedSource = new Transform({
          transform(chunk, _encoding, callback) { sourceHash.update(chunk); importProgress.bytesRead += chunk.length; callback(null, chunk); },
        });
        sourceStream.once('error', (error) => trackedSource.destroy(error));
        sourceStream.pipe(trackedSource);
        const output = createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 });
        const outputDone = finished(output);
        let finalCreated = false; let metadataCreated = false;
        let indexed = false;
        try {
          const encrypted = await encryptVaultStream(trackedSource, output, { key: objectKey, objectId });
          output.end();
          await outputDone;
          importProgress.phase = '驗證密文';
          const sourceDigest = sourceHash.digest('hex');
          const verifyHash = crypto.createHash('sha256');
          let verifiedBytes = 0;
          for await (const chunk of decryptVaultStream(createReadStream(temporaryPath), { key: objectKey, objectId })) {
            verifyHash.update(chunk);
            verifiedBytes += chunk.length;
          }
          if (verifiedBytes !== encrypted.plaintextBytes || verifyHash.digest('hex') !== sourceDigest) {
            throw fail(500, 'vault_import_verify_failed', '加密檔案驗證失敗；來源檔案尚未移除。');
          }
          const afterInfo = await lstat(sourcePath).catch(() => null);
          if (!afterInfo?.isFile() || afterInfo.isSymbolicLink()
            || afterInfo.size !== sourceInfo.size || afterInfo.mtimeMs !== sourceInfo.mtimeMs
            || (sourceInfo.ino && afterInfo.ino !== sourceInfo.ino)) {
            throw fail(409, 'vault_source_changed', '加密期間來源檔案有變動；來源檔案尚未移除，請重試。');
          }
          let currentSource;
          try { currentSource = await hashManagedFile(sourcePath); }
          catch { throw fail(409, 'vault_source_changed', '驗證來源檔案時發現內容有變動；來源檔案尚未移除，請重試。'); }
          if (currentSource.digest !== sourceDigest || currentSource.size !== encrypted.plaintextBytes) {
            throw fail(409, 'vault_source_changed', '加密期間來源檔案內容有變動；來源檔案尚未移除，請重試。');
          }
          if (importController.signal.aborted) throw fail(499, 'vault_import_cancelled', '移入作業已取消；來源檔案未移除。');
          const mediaType = mediaTypes.get(path.extname(name).toLowerCase()) || 'application/octet-stream';
          const metadata = encryptVaultMetadata({
            name,
            sourceShareId: share.id,
            sourceDigest,
            relativePath: parts.join('/'),
            size: encrypted.plaintextBytes,
            modifiedAt: sourceInfo.mtime.toISOString(),
            mediaType,
          }, masterKey, user.id, objectId);
          await writeFile(metadataTemporaryPath, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
          await rename(metadataTemporaryPath, metadataPath);
          metadataCreated = true;
          await rename(temporaryPath, objectPath);
          importProgress.phase = '寫入索引';
          finalCreated = true;
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare('INSERT INTO vault_objects(id, user_id, metadata_json) VALUES(?,?,?)')
              .run(objectId, user.id, JSON.stringify(metadata));
            db.prepare('INSERT INTO vault_pending_imports(object_id, user_id, created_at) VALUES(?,?,?)')
              .run(objectId, user.id, new Date().toISOString());
            db.exec('COMMIT');
          } catch (error) {
            try { db.exec('ROLLBACK'); } catch { /* transaction may not have begun */ }
            throw error;
          }
          indexed = true;
          if (importController.signal.aborted) throw fail(499, 'vault_import_cancelled', '移入作業已取消；來源檔案未移除。');
          let sourceRemovalPending = false;
          importProgress.phase = '移除已驗證來源';
          try { await unlink(sourcePath); }
          catch { sourceRemovalPending = true; }
          if (!sourceRemovalPending) {
            try { db.prepare('DELETE FROM vault_pending_imports WHERE object_id = ? AND user_id = ?').run(objectId, user.id); }
            catch { sourceRemovalPending = true; }
          }
          return { id: objectId, name, size: encrypted.plaintextBytes, mediaType, sourceRemovalPending };
        } catch (error) {
          sourceStream.destroy(); trackedSource.destroy(); output.destroy();
          await outputDone.catch(() => {});
          if (indexed) db.prepare('DELETE FROM vault_objects WHERE id = ? AND user_id = ?').run(objectId, user.id);
          if (finalCreated) await rm(objectPath, { force: true }).catch(() => {});
          if (metadataCreated) await rm(metadataPath, { force: true }).catch(() => {});
          await rm(metadataTemporaryPath, { force: true }).catch(() => {});
          await rm(temporaryPath, { force: true }).catch(() => {});
          if (importController.signal.aborted) throw fail(499, 'vault_import_cancelled', '移入作業已取消；來源檔案未移除。');
          throw error;
        } finally {
          objectKey.fill(0);
          vaultSignal.removeEventListener('abort', abortImport);
        }
      })); }
      finally {
        res.off('close', cancelImport);
        if (activeVaultImports.get(user.id) === importProgress) activeVaultImports.delete(user.id);
      }
      return json(res, 201, { ok: true, item });
    }
    const vaultObjectRoute = /^\/api\/vault\/objects\/([0-9a-f-]{36})(\/content)?$/iu.exec(route);
    if (vaultObjectRoute && method === 'GET' && vaultObjectRoute[2] === '/content') {
      const objectId = vaultObjectRoute[1].toLowerCase();
      const row = db.prepare('SELECT metadata_json FROM vault_objects WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(objectId, user.id);
      if (!row) throw fail(404, 'vault_object_not_found', '找不到加密空間檔案。');
      return await withVaultKey(user.id, async (masterKey, signal) => {
        const abortResponse = () => { if (!res.destroyed) res.destroy(); };
        signal.addEventListener('abort', abortResponse, { once: true });
        let metadata;
        try { metadata = decryptVaultMetadata(JSON.parse(row.metadata_json), masterKey, user.id, objectId); }
        catch { throw fail(500, 'vault_metadata_corrupt', '加密空間索引無法驗證；已停止提供檔案內容。'); }
        const extension = path.extname(metadata.name || '').toLowerCase();
        const contentType = mediaTypes.get(extension);
        if (!contentType) throw fail(415, 'vault_preview_not_supported', '此格式目前僅能以密文保存，尚未提供預覽或播放。');
        if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) throw fail(500, 'vault_metadata_corrupt', '檔案大小資料不正確。');
        const directory = path.join(dataDir, '.nanako-vault', user.id);
        const objectPath = path.join(directory, `${objectId}.nkv`);
        await rejectSymlinkTraversal(dataDir, path.join(dataDir, '.nanako-vault'), objectPath);
        const objectInfo = await lstat(objectPath).catch(() => null);
        if (!objectInfo?.isFile() || objectInfo.isSymbolicLink()) throw fail(404, 'vault_object_not_found', '找不到加密空間檔案。');
        const range = parseByteRange(req.headers.range, metadata.size);
        const start = range?.start ?? 0;
        const end = range?.end ?? Math.max(0, metadata.size - 1);
        const length = metadata.size === 0 ? 0 : end - start + 1;
        const objectKey = deriveVaultObjectKey(masterKey, user.id, objectId);
        try {
          res.writeHead(range ? 206 : 200, {
            'Content-Type': contentType,
            'Content-Length': length,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store, private',
            'Pragma': 'no-cache',
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${metadata.size}` } : {}),
          });
          let position = 0;
          let written = 0;
          for await (const chunk of decryptVaultStream(createReadStream(objectPath, { signal }), { key: objectKey, objectId })) {
            if (res.destroyed) break;
            const chunkStart = position;
            const chunkEnd = position + chunk.length - 1;
            position += chunk.length;
            if (chunkEnd < start || chunkStart > end) {
              if (position > end) break;
              continue;
            }
            const slice = chunk.subarray(Math.max(0, start - chunkStart), Math.min(chunk.length, end - chunkStart + 1));
            if (slice.length) { await writeResponseChunk(res, slice); written += slice.length; }
            if (position > end) break;
          }
          if (!range && position !== metadata.size) throw fail(500, 'vault_size_mismatch', '加密檔案大小驗證失敗。');
          if (range && written !== length) throw fail(500, 'vault_size_mismatch', '加密檔案大小驗證失敗。');
          if (!res.destroyed) res.end();
          return;
        } catch (error) {
          if (res.headersSent) { res.destroy(error); return; }
          throw error;
        } finally {
          objectKey.fill(0);
          signal.removeEventListener('abort', abortResponse);
        }
      });
    }
    if (vaultObjectRoute && method === 'DELETE' && !vaultObjectRoute[2]) {
      const objectId = vaultObjectRoute[1].toLowerCase();
      const body = await readJson(req);
        if (body.confirmText !== '移至資源回收筒') throw fail(400, 'confirmation_required', '請輸入「移至資源回收筒」確認操作。');
      return await withVaultKey(user.id, async () => {
        const row = db.prepare('SELECT id FROM vault_objects WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(objectId, user.id);
        if (!row) throw fail(404, 'vault_object_not_found', '找不到加密空間檔案。');
        if (db.prepare('SELECT object_id FROM vault_pending_imports WHERE object_id = ? AND user_id = ?').get(objectId, user.id)) throw fail(409, 'vault_import_pending', '此檔案尚有未完成的移入復原作業；請先處理後再移至資源回收筒。');
        db.prepare('UPDATE vault_objects SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
          .run(new Date().toISOString(), objectId, user.id);
        return json(res, 200, { ok: true });
      });
    }
    const vaultTrashRestoreRoute = /^\/api\/vault\/trash\/([0-9a-f-]{36})\/restore$/iu.exec(route);
    if (vaultTrashRestoreRoute && method === 'POST') {
      const objectId = vaultTrashRestoreRoute[1].toLowerCase();
      return await withVaultKey(user.id, async () => {
        const row = db.prepare('SELECT id FROM vault_objects WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL').get(objectId, user.id);
        if (!row) throw fail(404, 'vault_trash_item_not_found', '找不到加密空間資源回收筒項目。');
        db.prepare('UPDATE vault_objects SET deleted_at = NULL WHERE id = ? AND user_id = ?').run(objectId, user.id);
        return json(res, 200, { ok: true });
      });
    }
    const vaultTrashItemRoute = /^\/api\/vault\/trash\/([0-9a-f-]{36})$/iu.exec(route);
    if (vaultTrashItemRoute && method === 'DELETE') {
      const objectId = vaultTrashItemRoute[1].toLowerCase();
      const body = await readJson(req);
      if (body.confirmText !== '永久刪除') throw fail(400, 'confirmation_required', '請輸入「永久刪除」確認操作。');
      return await withVaultKey(user.id, async () => {
        const row = db.prepare('SELECT id FROM vault_objects WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL').get(objectId, user.id);
        if (!row) throw fail(404, 'vault_trash_item_not_found', '找不到加密空間資源回收筒項目。');
        const directory = path.join(dataDir, '.nanako-vault', user.id);
        const objectPath = path.join(directory, `${objectId}.nkv`);
        const metadataPath = path.join(directory, `${objectId}.nkm`);
        await rejectSymlinkTraversal(dataDir, path.join(dataDir, '.nanako-vault'), objectPath);
        await rejectSymlinkTraversal(dataDir, path.join(dataDir, '.nanako-vault'), metadataPath);
        await withPathLocks([objectPath, metadataPath], async () => {
          await rm(metadataPath, { force: true });
          db.prepare('DELETE FROM vault_objects WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL').run(objectId, user.id);
          await rm(objectPath, { force: true });
        });
        return json(res, 200, { ok: true });
      });
    }


  }

  async function handleVaultRoute(args) {
    if (!matchesVaultRoute(args.method, args.route)) return false;
    await dispatchVaultRoute(args);
    return true;
  }

  function lockAllVaultKeys() {
    return [...unlockedVaultKeys.keys()].map((userId) => lockVaultKey(userId));
  }

  return { handleVaultRoute, lockVaultKey, lockAllVaultKeys };
}
