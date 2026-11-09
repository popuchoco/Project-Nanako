import { createServer } from 'node:http';
import { Server as HttpsServer } from 'node:https';
import { createReadStream } from 'node:fs';
import { mkdir, lstat, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import {
  buildLoopbackOriginAllowlist,
  fail,
  isLoopbackAddress,
  json,
  mimeTypes,
  readJson,
} from './http-utils.mjs';
import { createAuthRouter, passwordHash } from './server-auth.mjs';
import { createVaultRouter } from './server-vault.mjs';
import { createDuplicatesRouter } from './server-duplicates.mjs';
import { createArchiveRouter } from './server-archive.mjs';
import { createSmbRouter } from './server-smb.mjs';
import { createFilesRouter } from './server-files.mjs';
import {
  createPathLockManager,
  rejectSymlinkTraversal,
  resolveInside,
  resolveShareInside,
} from './path-guards.mjs';
import { readWindowsSmbStatus } from './windows-smb-status.mjs';
import { isShareOperationAllowed } from './share-access.mjs';
import { ensureThrottleSchema, pruneExpiredThrottles } from './throttle-store.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');
const AUDIT_RETENTION_OPTIONS = Object.freeze([1, 3, 7, 30, 90, 180, 365]);
const DEFAULT_AUDIT_RETENTION_DAYS = 30;
const MAX_PLAYBACK_PROGRESS_ITEMS = 500;

function initDatabase(dataDir) {
  const dbPath = path.join(dataDir, 'metadata.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_salt TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','user')), created_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1))
    );
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
      storage_path TEXT, source_type TEXT NOT NULL DEFAULT 'managed'
    );
    CREATE TABLE IF NOT EXISTS share_permissions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
      can_read INTEGER NOT NULL DEFAULT 0, can_write INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, share_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vaults (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      envelope_json TEXT NOT NULL, recovery_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS vault_objects (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES vaults(user_id) ON DELETE CASCADE,
      metadata_json TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS vault_pending_imports (
      object_id TEXT PRIMARY KEY REFERENCES vault_objects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES vaults(user_id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trash_items (
      id TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
      original_path TEXT NOT NULL, stored_path TEXT NOT NULL, item_name TEXT NOT NULL,
      is_directory INTEGER NOT NULL, deleted_by TEXT NOT NULL, deleted_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operation_logs (
      id TEXT PRIMARY KEY, occurred_at INTEGER NOT NULL, actor_id TEXT,
      actor_name TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
      outcome TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS playback_progress (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      file_size INTEGER NOT NULL CHECK(file_size >= 0),
      modified_at REAL NOT NULL,
      position REAL NOT NULL CHECK(position >= 0),
      duration REAL NOT NULL CHECK(duration > 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, share_id, relative_path)
    );
    CREATE INDEX IF NOT EXISTS operation_logs_occurred_at_idx ON operation_logs(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS playback_progress_updated_at_idx ON playback_progress(user_id, updated_at DESC);
  `);
  ensureThrottleSchema(db);
  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
  if (!userColumns.has('is_active')) db.exec('ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
  const adminCount = Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n);
  if (adminCount <= 1) {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_single_admin_idx ON users(role) WHERE role = 'admin'");
  } else {
    console.error(`資料庫中有 ${adminCount} 位管理員，略過單一管理員索引建立。`);
  }
  const vaultColumns = new Set(db.prepare('PRAGMA table_info(vaults)').all().map((column) => column.name));
  if (!vaultColumns.has('recovery_json')) db.exec('ALTER TABLE vaults ADD COLUMN recovery_json TEXT');
  const vaultObjectColumns = new Set(db.prepare('PRAGMA table_info(vault_objects)').all().map((column) => column.name));
  if (!vaultObjectColumns.has('deleted_at')) db.exec('ALTER TABLE vault_objects ADD COLUMN deleted_at TEXT');
  db.prepare('INSERT OR IGNORE INTO app_settings(setting_key, setting_value) VALUES(?, ?)')
    .run('audit_retention_days', String(DEFAULT_AUDIT_RETENTION_DAYS));
  const shareColumns = new Set(db.prepare('PRAGMA table_info(shares)').all().map((column) => column.name));
  if (!shareColumns.has('storage_path')) db.exec('ALTER TABLE shares ADD COLUMN storage_path TEXT');
  if (!shareColumns.has('source_type')) db.exec("ALTER TABLE shares ADD COLUMN source_type TEXT NOT NULL DEFAULT 'managed'");
  db.exec(`
    UPDATE shares SET storage_path = NULL, source_type = 'out-of-scope'
      WHERE storage_path IS NOT NULL OR source_type <> 'managed';
    UPDATE trash_items SET stored_path = ''
      WHERE share_id IN (SELECT id FROM shares WHERE source_type = 'out-of-scope');
  `);
  return db;
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function listNetworkInterfaces() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) => (addresses || [])
    .filter((item) => !item.internal)
    .map((item) => ({
      name,
      address: item.address,
      family: item.family,
      netmask: item.netmask,
      mac: item.mac,
      cidr: item.cidr,
      private: item.family === 'IPv4' && isPrivateIpv4(item.address),
    })))
    .sort((a, b) => Number(b.family === 'IPv4') - Number(a.family === 'IPv4') || a.name.localeCompare(b.name, 'zh-TW'));
}

let lastCpuSample;
let windowsExecutionCache;
let windowsExecutionCacheAt = 0;

async function collectWindowsExecutionState() {
  if (process.platform !== 'win32') {
    return { supported: false, checked: false, identity: null, isAdministrator: false, isElevated: false, message: '僅支援在 Windows 上檢查。' };
  }
  if (windowsExecutionCache && Date.now() - windowsExecutionCacheAt < 60_000) return windowsExecutionCache;
  const fallback = { supported: true, checked: false, identity: os.userInfo().username, isAdministrator: false, isElevated: false, message: '無法讀取目前 Windows 權限狀態。' };
  try {
    const [groupsResult, identityResult] = await Promise.all([
      execFileAsync('whoami.exe', ['/groups', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 }),
      execFileAsync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 }),
    ]);
    const groups = groupsResult.stdout || '';
    const identity = /^"([^"]+)"/mu.exec(identityResult.stdout || '')?.[1] || os.userInfo().username;
    windowsExecutionCache = {
      supported: true,
      checked: true,
      identity,
      isAdministrator: /S-1-5-32-544\b/u.test(groups),
      isElevated: /S-1-16-(?:12288|16384)\b/u.test(groups),
      message: null,
    };
  } catch {
    windowsExecutionCache = fallback;
  }
  windowsExecutionCacheAt = Date.now();
  return windowsExecutionCache;
}

function sampleCpuUsage(cpus = os.cpus()) {
  const totals = cpus.reduce((summary, cpu) => {
    const values = Object.values(cpu.times);
    summary.total += values.reduce((sum, value) => sum + value, 0);
    summary.idle += cpu.times.idle;
    return summary;
  }, { total: 0, idle: 0 });
  const previous = lastCpuSample;
  lastCpuSample = totals;
  if (!previous || totals.total <= previous.total) return null;
  return Math.max(0, Math.min(100, Math.round((1 - (totals.idle - previous.idle) / (totals.total - previous.total)) * 100)));
}

async function collectSystemInformation(dataDir) {
  const cpus = os.cpus();
  const memoryTotal = os.totalmem();
  const memoryFree = os.freemem();
  const fsInfo = await statfs(dataDir).catch(() => null);
  const blockSize = fsInfo ? Number(fsInfo.bsize) : 0;
  const storageTotal = fsInfo ? Number(fsInfo.blocks) * blockSize : 0;
  const storageFree = fsInfo ? Number(fsInfo.bavail) * blockSize : 0;
  const release = os.release();
  let windowsVersion = null;
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        "$info = Get-CimInstance -ClassName Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture; [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes(($info | ConvertTo-Json -Compress)))",
      ], { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf8' });
      const info = JSON.parse(Buffer.from(stdout.trim(), 'base64').toString('utf16le'));
      if ([info.Caption, info.OSArchitecture].some((value) => typeof value !== 'string' || value.includes('\uFFFD'))) {
        throw new Error('PowerShell returned invalid Windows system text.');
      }
      windowsVersion = { name: info.Caption, version: info.Version, buildNumber: String(info.BuildNumber), architecture: info.OSArchitecture };
    } catch { /* keep Node.js platform details as a fallback */ }
  }
  return {
    computerName: os.hostname(),
    operatingSystem: windowsVersion?.name || os.version(),
    operatingSystemVersion: windowsVersion?.version || release,
    osRelease: release,
    buildNumber: windowsVersion?.buildNumber || release.split('.').at(-1) || '',
    architecture: windowsVersion?.architecture || os.arch(),
    platform: process.platform,
    processor: cpus[0]?.model?.trim() || '未知處理器',
    logicalProcessors: cpus.length,
    cpuUsagePercent: sampleCpuUsage(cpus),
    memory: { totalBytes: memoryTotal, availableBytes: memoryFree, usedBytes: memoryTotal - memoryFree, usagePercent: Math.round((1 - memoryFree / memoryTotal) * 100) },
    storage: { totalBytes: storageTotal, freeBytes: storageFree, usedBytes: Math.max(0, storageTotal - storageFree) },
    networkInterfaces: listNetworkInterfaces(),
    windowsExecution: await collectWindowsExecutionState(),
  };
}

export async function startServer({ dataDir, storageRoot, host = '127.0.0.1', port = 8765, smbStatusProbe = readWindowsSmbStatus, now = () => Date.now() } = {}) {
  if (!dataDir) dataDir = path.join(projectRoot, 'NanakoData', 'data');
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error('此原型僅允許本機連線；區域網路連線尚未開放。');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('連接埠必須介於 0 至 65535。');
  dataDir = path.resolve(dataDir);
  if (storageRoot) {
    storageRoot = path.resolve(storageRoot);
    if (dataDir !== path.join(storageRoot, 'data')) throw new Error('Nanako 資料目錄必須位於指定的可攜式資料根目錄內。');
  }
  async function ensureManagedDirectory(directory) {
    await mkdir(directory).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('Nanako 資料目錄及其管理目錄不可使用符號連結、重新解析點或非資料夾項目。');
    }
  }
  if (storageRoot) await ensureManagedDirectory(storageRoot);
  await ensureManagedDirectory(dataDir);
  await ensureManagedDirectory(path.join(dataDir, 'files'));
  await ensureManagedDirectory(path.join(dataDir, 'trash'));
  await ensureManagedDirectory(path.join(dataDir, '.nanako-vault'));
  for (const filename of ['metadata.sqlite', 'metadata.sqlite-wal', 'metadata.sqlite-shm']) {
    const info = await lstat(path.join(dataDir, filename)).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink() || info?.isDirectory()) throw new Error('Nanako 資料庫檔案不可使用符號連結、重新解析點或資料夾。');
  }
  const db = initDatabase(dataDir);
  pruneExpiredThrottles(db, now());
  const pathLocks = createPathLockManager();
  const { withPathLocks, withPathLock } = pathLocks;
  const dummyPassword = await passwordHash('Nanako non-existent account timing check');
  const readAuditRetentionDays = () => {
    const raw = db.prepare("SELECT setting_value FROM app_settings WHERE setting_key = 'audit_retention_days'").get()?.setting_value;
    const days = Number(raw);
    return AUDIT_RETENTION_OPTIONS.includes(days) ? days : DEFAULT_AUDIT_RETENTION_DAYS;
  };
  const purgeExpiredAuditLogs = () => {
    const cutoff = Date.now() - readAuditRetentionDays() * 24 * 60 * 60 * 1000;
    db.prepare('DELETE FROM operation_logs WHERE occurred_at < ?').run(cutoff);
  };
  purgeExpiredAuditLogs();

  function auditForRequest(user, method, route, url) {
    const target = (value) => String(value || '').replace(/[\r\n\0]/gu, ' ').slice(0, 512);
    if (method === 'GET' && route === '/api/files') return { action: '瀏覽資料夾', target: target(url.searchParams.get('path') || '主資料夾') };
    if (method === 'GET' && route === '/api/files/search') {
      const categories = { image: '圖片', video: '影片', audio: '音訊', document: '文件', media: '影音' };
      return { action: '搜尋資料空間分類', target: categories[url.searchParams.get('category')] || '檔案分類' };
    }
    if (method === 'GET' && route === '/api/preview') return { action: '開啟媒體預覽', target: target(url.searchParams.get('path')) };
    if (method === 'GET' && /^\/api\/vault\/objects\/[0-9a-f-]{36}\/content$/iu.test(route)) return null;
    if (method === 'GET' && route === '/api/download') return { action: '下載檔案', target: target(url.searchParams.get('path')) };
    if (method === 'POST' && route === '/api/folders') return { action: '建立資料夾', target: target(url.searchParams.get('path')) };
    if (method === 'POST' && route === '/api/upload') return { action: '匯入檔案', target: target(`${url.searchParams.get('path') ? `${url.searchParams.get('path')}/` : ''}${url.searchParams.get('name')}`) };
    if (method === 'POST' && route === '/api/files/rename') return { action: '重新命名檔案', target: '檔案項目' };
    if (method === 'POST' && route === '/api/files/move') return { action: '移動檔案', target: '檔案項目' };
    if (method === 'POST' && route === '/api/files/copy') return { action: '複製檔案', target: '檔案項目' };
    if (method === 'DELETE' && route === '/api/files') return { action: '移至資源回收桶', target: target(url.searchParams.get('path')) };
    if (method === 'GET' && route === '/api/trash') return { action: '檢視資源回收桶', target: '資源回收桶' };
    if (method === 'POST' && route === '/api/trash/restore') return { action: '還原資源回收桶項目', target: '資源回收桶項目' };
    if (method === 'DELETE' && route === '/api/trash') return { action: '永久刪除資源回收桶項目', target: '資源回收桶項目' };
    if (method === 'POST' && route === '/api/users') return { action: '建立使用者', target: '使用者帳號' };
    if (method === 'PATCH' && /^\/api\/users\/[0-9a-f-]{36}$/iu.test(route)) return { action: '更新使用者權限', target: '使用者帳號' };
    if (method === 'POST' && route === '/api/password') return { action: '變更密碼', target: '本機帳號' };
    if (method === 'GET' && route === '/api/users') return { action: '檢視使用者清單', target: '使用者與權限' };
    if (method === 'POST' && route === '/api/archive/create') return { action: '建立 ZIP 壓縮檔', target: target(url.searchParams.get('path')) };
    if (method === 'POST' && route === '/api/archive/extract') return { action: '解壓縮 ZIP 檔案', target: target(url.searchParams.get('path')) };
    if (method === 'POST' && route === '/api/archive/cancel') return { action: '取消 ZIP 作業', target: 'ZIP 壓縮或解壓縮' };
    if (method === 'POST' && route === '/api/vault/setup') return { action: '建立加密空間', target: '加密空間原型' };
    if (method === 'POST' && route === '/api/vault/unlock') return { action: '解鎖加密空間', target: '加密空間原型' };
    if (method === 'POST' && route === '/api/vault/recover') return { action: '使用復原金鑰解鎖加密空間', target: '加密空間原型' };
    if (method === 'POST' && route === '/api/vault/recovery-key') return { action: '重新產生加密空間復原金鑰', target: '加密空間原型' };
    if (method === 'POST' && route === '/api/vault/password') return { action: '更新加密空間密碼', target: '加密空間原型' };
    if (method === 'POST' && route === '/api/vault/lock') return { action: '鎖定加密空間', target: '加密空間原型' };
    if (method === 'GET' && route === '/api/vault/objects') return { action: '檢視加密空間檔案', target: '加密空間' };
    if (method === 'GET' && route === '/api/vault/trash') return { action: '檢視加密空間資源回收筒', target: '加密空間資源回收筒' };
    if (method === 'GET' && route === '/api/vault/backups') return { action: '檢視加密空間備份', target: '加密空間備份' };
    if (method === 'POST' && route === '/api/vault/backups') return { action: '建立加密空間備份', target: '加密空間備份' };
    if (method === 'POST' && /^\/api\/vault\/backups\/[0-9a-f-]{36}\/restore$/iu.test(route)) return { action: '還原加密空間備份', target: '加密空間' };
    if (method === 'DELETE' && /^\/api\/vault\/backups\/[0-9a-f-]{36}$/iu.test(route)) return { action: '刪除加密空間備份', target: '加密空間備份' };
    if (method === 'GET' && route === '/api/vault/recovery') return { action: '檢視加密空間復原狀態', target: '待確認移入作業' };
    if (method === 'POST' && route === '/api/vault/objects/import') return { action: '移入並加密檔案', target: '加密空間' };
    if (method === 'POST' && route === '/api/vault/objects/import/cancel') return { action: '取消加密移入', target: '加密空間移入作業' };
    if (method === 'POST' && /^\/api\/vault\/recovery\/[0-9a-f-]{36}$/iu.test(route)) return { action: '處理加密空間復原', target: '待確認移入作業' };
    if (method === 'POST' && /^\/api\/vault\/orphans\/[0-9a-f-]{36}$/iu.test(route)) return { action: '清理未索引加密檔案', target: '加密空間孤兒檔案' };
    if (method === 'GET' && /^\/api\/vault\/objects\/[0-9a-f-]{36}\/content$/iu.test(route)) return { action: '預覽加密檔案', target: '加密空間' };
    if (method === 'DELETE' && /^\/api\/vault\/objects\/[0-9a-f-]{36}$/iu.test(route)) return { action: '移至加密空間資源回收筒', target: '加密空間' };
    if (method === 'POST' && /^\/api\/vault\/trash\/[0-9a-f-]{36}\/restore$/iu.test(route)) return { action: '還原加密空間檔案', target: '加密空間資源回收筒' };
    if (method === 'DELETE' && /^\/api\/vault\/trash\/[0-9a-f-]{36}$/iu.test(route)) return { action: '永久刪除加密空間檔案', target: '加密空間資源回收筒' };
    if (method === 'POST' && route === '/api/duplicates/scan') return { action: '開始重複檔案掃描', target: 'Nanako 資料空間' };
    if (method === 'DELETE' && route === '/api/duplicates/scan') return { action: '取消重複檔案掃描', target: 'Nanako 資料空間' };
    if (method === 'POST' && route === '/api/duplicates/cleanup') return { action: '整理重複檔案副本', target: 'Nanako 資源回收桶' };
    if (method === 'POST' && route === '/api/audit-settings') return { action: '更新操作紀錄保留期限', target: '操作紀錄設定' };
    if (method === 'DELETE' && route === '/api/audit-logs') return { action: '刪除所有操作紀錄', target: '所有使用者' };
    if (method === 'GET' && route === '/api/smb/status') return { action: '查看 SMB 伺服器狀態', target: 'Windows SMB 前置檢查' };
    return null;
  }

  const findUser = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE');
  const getUserById = db.prepare('SELECT id, username, role, created_at, is_active AS isActive FROM users WHERE id = ?');
  const findShare = db.prepare('SELECT * FROM shares WHERE id = ?');
  const getPerm = db.prepare(`SELECT can_read, can_write FROM share_permissions WHERE user_id = ? AND share_id = ?`);
  const allShares = db.prepare("SELECT id, name, created_at, storage_path, source_type FROM shares WHERE source_type = 'managed' AND storage_path IS NULL ORDER BY name COLLATE NOCASE");

  function shareRoot(shareId) {
    if (!/^[0-9a-f-]{36}$/iu.test(shareId || '')) throw fail(400, 'invalid_share', '分享資料夾不正確。');
    const share = findShare.get(shareId);
    if (!share || share.source_type !== 'managed' || share.storage_path) throw fail(404, 'share_not_found', '找不到這個 Nanako 資料空間。');
    return { share, root: path.join(dataDir, 'files', share.id) };
  }

  function managedTrashPath(shareId, itemId) {
    if (!/^[0-9a-f-]{36}$/iu.test(itemId || '')) throw fail(404, 'trash_item_not_found', '找不到資源回收桶項目。');
    return path.join(dataDir, 'trash', shareId, itemId);
  }

  function permission(user, shareId) {
    if (user.role === 'admin') return { can_read: 1, can_write: 1 };
    return getPerm.get(user.id, shareId) || { can_read: 0, can_write: 0 };
  }

  function requirePermission(user, shareId, write = false) {
    const perm = permission(user, shareId);
    if (!isShareOperationAllowed(user, perm, write ? 'write' : 'read')) throw fail(403, 'permission_denied', '你沒有這項操作的權限。');
  }
  const filesRouter = createFilesRouter({ db, dataDir, requirePermission, shareRoot, permission, managedTrashPath, withPathLock, withPathLocks });
  const vaultRouter = createVaultRouter({ db, dataDir, now, withPathLocks, withPathLock, ensureManagedDirectory, requirePermission, shareRoot });
  const authRouter = createAuthRouter({ db, dataDir, now, dummyPassword, lockVaultKey: vaultRouter.lockVaultKey, findUser, getUserById, findShare, getPerm, allShares });

  function writeOperationLog(actor, action, target, outcome = '成功') {
    db.prepare('INSERT INTO operation_logs(id, occurred_at, actor_id, actor_name, action, target, outcome) VALUES(?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), Date.now(), actor?.id || null, String(actor?.username || '未知使用者').slice(0, 80), String(action).slice(0, 80), String(target || '').slice(0, 512), outcome);
  }
  const duplicatesRouter = createDuplicatesRouter({ db, dataDir, requirePermission, shareRoot, permission, getUserById, withPathLocks, managedTrashPath, writeOperationLog });
  const archiveRouter = createArchiveRouter({ dataDir, requirePermission, shareRoot });
  const smbRouter = createSmbRouter({ smbStatusProbe, collectWindowsExecutionState, listNetworkInterfaces, getPort: () => server.address()?.port });

  let closed = false;
  let allowedOrigins = new Set();
  let allowedHosts = new Set();
  const server = createServer(async (req, res) => {
    let auditEvent = null;
    let auditLogged = false;
    const setAudit = (actor, action, target) => {
      auditEvent = { actorId: actor?.id || null, actorName: String(actor?.username || '未知使用者').replace(/[\r\n\0]/gu, ' ').slice(0, 80), action: String(action).replace(/[\r\n\0]/gu, ' ').slice(0, 80), target: String(target || '').replace(/[\r\n\0]/gu, ' ').slice(0, 512) };
    };
    res.once('finish', () => {
      if (closed || !auditEvent || auditLogged) return;
      auditLogged = true;
      try {
        db.prepare('INSERT INTO operation_logs(id, occurred_at, actor_id, actor_name, action, target, outcome) VALUES(?,?,?,?,?,?,?)')
          .run(crypto.randomUUID(), Date.now(), auditEvent.actorId, auditEvent.actorName, auditEvent.action, auditEvent.target, res.statusCode >= 400 ? '失敗' : '成功');
      } catch (error) { console.error('無法寫入操作紀錄。', error); }
    });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        throw fail(403, 'remote_denied', '僅允許本機連線。');
      }
      const hostHeader = req.headers.host;
      if (typeof hostHeader !== 'string' || !allowedHosts.has(hostHeader)) {
        throw fail(403, 'host_denied', '主機名稱不符。');
      }
      const scheme = server instanceof HttpsServer ? 'https' : 'http';
      const url = new URL(req.url, `${scheme}://${hostHeader}`);
      const method = req.method || 'GET';
      const route = url.pathname;
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
      // Electron uses the loopback URL and same-origin fetch, so Chromium sends Origin on its POST requests.
      if (mutating && (typeof req.headers.origin !== 'string' || req.headers.origin.length === 0 || !allowedOrigins.has(req.headers.origin))) {
        throw fail(403, 'origin_denied', '來源不符或缺少來源資訊。');
      }

      if (route.startsWith('/api/')) {
        if (await authRouter.handleBeforeAuthentication({ req, res, method, route, setAudit })) return;

        const user = await authRouter.currentUser(req);
        if (!user) throw fail(401, 'authentication_required', '請先登入。');
        const inferredAudit = auditForRequest(user, method, route, url);
        if (inferredAudit) setAudit(user, inferredAudit.action, inferredAudit.target);

        if (await vaultRouter.handleVaultRoute({ req, res, method, route, url, user })) return;

        if (route === '/api/activity' && method === 'POST') {
          const body = await readJson(req);
          const views = {
            files: '檔案管理', album: '相簿', player: '播放器', trash: '資源回收桶', vault: '加密空間',
            duplicates: '檔案去重', users: '使用者與權限', computer: '儲存空間', system: '電腦資訊', settings: '系統設定與紀錄', network: '網路狀態',
          };
          const actionLabels = {
            open: '開啟畫面', focus: '切換作用中視窗', minimize: '最小化視窗',
            maximize: '最大化視窗', restore: '還原視窗', close: '關閉視窗', move: '移動視窗', preview: '預覽或播放加密檔案',
          };
          const action = body.action || 'open';
          if (!views[body.view] || !actionLabels[action] || (['users', 'system', 'settings'].includes(body.view) && user.role !== 'admin')) throw fail(400, 'invalid_activity', '操作紀錄類型不正確。');
          const detail = action === 'open' ? views[body.view] : `${views[body.view]}視窗`;
          setAudit(user, actionLabels[action], detail);
          return json(res, 200, { ok: true });
        }

        if (await duplicatesRouter.handleDuplicatesRoute({ req, res, method, route, url, user, setAudit })) return;

        if (await authRouter.handleAccountRoute({ req, res, method, route, user })) return;
        if (route === '/api/shares' && method === 'GET') {
          const shares = allShares.all().filter((share) => permission(user, share.id).can_read).map((share) => ({
            id: share.id,
            name: share.name,
            created_at: share.created_at,
            sourceType: 'managed',
            canWrite: Boolean(permission(user, share.id).can_write),
          }));
          return json(res, 200, { shares });
        }
        if (route === '/api/playback-progress' && ['GET', 'POST', 'DELETE'].includes(method)) {
          const body = method === 'POST' ? await readJson(req) : null;
          const shareId = method === 'POST'
            ? String(body.shareId || '')
            : (url.searchParams.get('shareId') || '');
          requirePermission(user, shareId);
          const { root } = shareRoot(shareId);
          await rejectSymlinkTraversal(dataDir, dataDir, root);
          const rawPath = method === 'POST' ? body.path : (url.searchParams.get('path') || '');
          if (typeof rawPath !== 'string') throw fail(400, 'invalid_path', '檔案路徑不正確。');
          const { target, parts } = resolveShareInside(root, rawPath);
          const relativePath = parts.join('/');

          if (method === 'GET') {
            const rows = db.prepare(`SELECT relative_path, file_size, modified_at, position, duration, updated_at
              FROM playback_progress WHERE user_id = ? AND share_id = ? ORDER BY updated_at DESC LIMIT ?`)
              .all(user.id, shareId, MAX_PLAYBACK_PROGRESS_ITEMS);
            const progress = [];
            const removeStale = db.prepare('DELETE FROM playback_progress WHERE user_id = ? AND share_id = ? AND relative_path = ?');
            for (const row of rows) {
              try {
                const item = resolveShareInside(root, row.relative_path);
                await rejectSymlinkTraversal(dataDir, root, item.target);
                const info = await lstat(item.target);
                if (!info.isFile() || info.size !== row.file_size || info.mtimeMs !== row.modified_at) {
                  removeStale.run(user.id, shareId, row.relative_path);
                  continue;
                }
                progress.push({ path: row.relative_path, position: row.position, duration: row.duration, updatedAt: row.updated_at });
              } catch (error) {
                if (!['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP', 'invalid_path', 'symlink_not_allowed', 'not_found'].includes(error.code)) throw error;
                removeStale.run(user.id, shareId, row.relative_path);
              }
            }
            return json(res, 200, { progress });
          }

          if (method === 'DELETE') {
            db.prepare('DELETE FROM playback_progress WHERE user_id = ? AND share_id = ? AND relative_path = ?')
              .run(user.id, shareId, relativePath);
            return json(res, 200, { ok: true });
          }

          const position = body.position;
          const duration = body.duration;
          if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0
            || duration > 365 * 24 * 60 * 60 || position < 0 || position > duration + 1) {
            throw fail(400, 'invalid_playback_progress', '播放進度資料不正確。');
          }
          const info = await lstat(target).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
          if (!info?.isFile() || info.isSymbolicLink()) throw fail(404, 'file_not_found', '找不到媒體檔案。');
          if (position < 5 || position / duration >= 0.95) {
            db.prepare('DELETE FROM playback_progress WHERE user_id = ? AND share_id = ? AND relative_path = ?')
              .run(user.id, shareId, relativePath);
            return json(res, 200, { saved: false, progress: null });
          }
          const updatedAt = Date.now();
          db.prepare(`INSERT INTO playback_progress(user_id, share_id, relative_path, file_size, modified_at, position, duration, updated_at)
            VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(user_id, share_id, relative_path) DO UPDATE SET
              file_size = excluded.file_size, modified_at = excluded.modified_at,
              position = excluded.position, duration = excluded.duration, updated_at = excluded.updated_at`)
            .run(user.id, shareId, relativePath, info.size, info.mtimeMs, Math.min(position, duration), duration, updatedAt);
          db.prepare(`DELETE FROM playback_progress WHERE user_id = ? AND (share_id, relative_path) NOT IN (
            SELECT share_id, relative_path FROM playback_progress WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?)`)
            .run(user.id, user.id, MAX_PLAYBACK_PROGRESS_ITEMS);
          return json(res, 200, { saved: true, progress: { path: relativePath, position, duration, updatedAt } });
        }
        if (route === '/api/system' && method === 'GET') {
          if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以查看電腦資訊。');
          return json(res, 200, await collectSystemInformation(dataDir));
        }
        if (await filesRouter({
          req, res, method, route, url, user,
          getAuditEvent: () => auditEvent,
          setAuditTarget: (target) => { if (auditEvent) auditEvent.target = target; },
          disableAudit: () => { auditEvent = null; },
        })) return;
        if (await authRouter.handleUsersRoute({
          req, res, method, route, user,
          setAuditTarget: (target) => { if (auditEvent) auditEvent.target = target; },
        })) return;
        if (route === '/api/audit-settings' && method === 'GET') {
          if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以查看操作紀錄設定。');
          return json(res, 200, { retentionDays: readAuditRetentionDays(), options: AUDIT_RETENTION_OPTIONS });
        }
        if (route === '/api/audit-settings' && method === 'POST') {
          if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以調整操作紀錄設定。');
          const body = await readJson(req);
          const days = Number(body.retentionDays);
          if (!AUDIT_RETENTION_OPTIONS.includes(days)) throw fail(400, 'invalid_retention', '請選擇 1、3、7、30、90、180 或 365 日。');
          db.prepare("UPDATE app_settings SET setting_value = ? WHERE setting_key = 'audit_retention_days'").run(String(days));
          if (auditEvent) auditEvent.target = `${days} 日`;
          purgeExpiredAuditLogs();
          return json(res, 200, { retentionDays: days, options: AUDIT_RETENTION_OPTIONS });
        }
        if (route === '/api/audit-logs' && method === 'GET') {
          if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以查看操作紀錄。');
          purgeExpiredAuditLogs();
          const logs = db.prepare(`SELECT id, occurred_at AS occurredAt, actor_name AS actorName, action, target, outcome
            FROM operation_logs ORDER BY occurred_at DESC LIMIT 500`).all().map((item) => ({ ...item, occurredAt: new Date(item.occurredAt).toISOString() }));
          return json(res, 200, { logs, retentionDays: readAuditRetentionDays() });
        }
        if (route === '/api/audit-logs' && method === 'DELETE') {
          if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以刪除操作紀錄。');
          const body = await readJson(req);
          if (body.confirmText !== '刪除所有紀錄') throw fail(400, 'confirmation_required', '請輸入「刪除所有紀錄」確認操作。');
          db.exec('DELETE FROM operation_logs');
          auditEvent = null;
          return json(res, 200, { ok: true });
        }
        if (await archiveRouter.handleArchiveRoute({ req, res, method, route, user, setAuditTarget: (target) => { if (auditEvent) auditEvent.target = target; } })) return;
        if (await smbRouter.handleSmbRoute({ res, method, route, user })) return;
        throw fail(404, 'not_found', '找不到這個功能。');
      }

      if (method !== 'GET' && method !== 'HEAD') throw fail(405, 'method_not_allowed', '不支援這種操作。');
      const relative = route === '/' ? 'index.html' : decodeURIComponent(route.slice(1));
      const { target } = resolveInside(publicRoot, relative);
      if (!target.startsWith(`${publicRoot}${path.sep}`)) throw fail(404, 'not_found', '找不到頁面。');
      const info = await stat(target).catch(() => null);
      if (!info?.isFile()) throw fail(404, 'not_found', '找不到頁面。');
      res.writeHead(200, { 'Content-Type': mimeTypes.get(path.extname(target).toLowerCase()) || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
      if (method === 'HEAD') return res.end();
      return createReadStream(target).pipe(res);
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy(error);
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status === 500) console.error(error);
      return json(res, status, { error: error.code || 'internal_error', message: status === 500 ? '伺服器發生錯誤。' : error.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const allowlists = buildLoopbackOriginAllowlist(server);
  allowedOrigins = allowlists.origins;
  allowedHosts = allowlists.hosts;

  const auditPurgeTimer = setInterval(purgeExpiredAuditLogs, 60 * 60 * 1000);
  auditPurgeTimer.unref();

  return {
    host,
    port: server.address().port,
    dataDir,
    close: () => new Promise((resolve, reject) => {
      if (closed) return resolve();
      closed = true;
      clearInterval(auditPurgeTimer);
      const duplicateScanPromises = duplicatesRouter.abortAll();
      archiveRouter.abortAll();
      const closeServer = new Promise((done) => server.close(done));
      const lockPromises = vaultRouter.lockAllVaultKeys();
      server.closeAllConnections?.();
      void Promise.allSettled([
        ...duplicateScanPromises,
        ...lockPromises,
        closeServer,
      ]).then((results) => {
        db.close();
        const closeError = results.at(-1)?.status === 'fulfilled' ? results.at(-1).value : results.at(-1)?.reason;
        if (closeError) reject(closeError);
        else resolve();
      });
    }),
  };
}
