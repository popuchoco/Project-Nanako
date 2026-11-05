import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  decryptVaultMetadata,
  decryptVaultStream,
  deriveVaultObjectKey,
  encryptVaultMetadata,
} from './vault-crypto.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_BACKUP_OBJECTS = 10_000;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

function backupError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = code === 'vault_backup_cancelled' ? 499 : code === 'vault_backup_limit_exceeded' ? 413 : 409;
  return error;
}

async function verifyCiphertext(filename, metadata, masterKey, userId, objectId, signal) {
  const objectKey = deriveVaultObjectKey(masterKey, userId, objectId);
  const digest = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of decryptVaultStream(createReadStream(filename, { signal }), { key: objectKey, objectId })) {
      digest.update(chunk);
      size += chunk.length;
    }
  } catch (error) {
    if (signal?.aborted || error.code === 'ABORT_ERR') throw backupError('vault_backup_cancelled', '加密備份因加密空間鎖定而取消。');
    throw backupError('vault_backup_integrity_failed', '加密備份檔案驗證失敗；未還原這筆資料。');
  } finally { objectKey.fill(0); }
  const hash = digest.digest('hex');
  if (size !== metadata.size || hash !== metadata.sourceDigest) throw backupError('vault_backup_integrity_failed', '加密備份檔案驗證失敗；未還原這筆資料。');
}

export async function createVaultBackup({ backupRoot, sourceRoot, userId, masterKey, vaultEnvelope, recoveryEnvelope, objects, signal }) {
  if (objects.length > MAX_BACKUP_OBJECTS) throw backupError('vault_backup_limit_exceeded', '加密備份最多支援 10,000 個檔案。');
  const backupId = randomUUID();
  const stage = path.join(backupRoot, `.localnas-backup-${backupId}.tmp`);
  const destination = path.join(backupRoot, backupId);
  await mkdir(stage, { mode: 0o700 });
  await mkdir(path.join(stage, 'objects'), { mode: 0o700 });
  let totalEncryptedBytes = 0;
  const records = [];
  try {
    for (const object of objects) {
      if (signal?.aborted) throw backupError('vault_backup_cancelled', '加密備份因加密空間鎖定而取消。');
      if (!UUID_PATTERN.test(object.id)) throw backupError('vault_backup_invalid', '加密備份索引識別碼不正確。');
      let metadata;
      try { metadata = decryptVaultMetadata(JSON.parse(object.metadata_json), masterKey, userId, object.id); }
      catch { throw backupError('vault_metadata_corrupt', '加密空間索引無法驗證；已停止建立備份。'); }
      const source = path.join(sourceRoot, `${object.id}.nkv`);
      const sourceInfo = await lstat(source).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (!sourceInfo?.isFile() || sourceInfo.isSymbolicLink()) throw backupError('vault_object_missing', '有加密空間檔案本體不存在；備份未完成。');
      await verifyCiphertext(source, metadata, masterKey, userId, object.id, signal);
      const output = path.join(stage, 'objects', `${object.id}.nkv`);
      await pipeline(createReadStream(source, { signal }), createWriteStream(output, { flags: 'wx', mode: 0o600 }), { signal });
      await writeFile(path.join(stage, 'objects', `${object.id}.nkm`), object.metadata_json, { flag: 'wx', mode: 0o600 });
      totalEncryptedBytes += sourceInfo.size;
      records.push({ id: object.id, metadata: JSON.parse(object.metadata_json), deletedAt: object.deleted_at || null, pendingCreatedAt: object.pending_created_at || null });
    }
    const manifestBody = {
      formatVersion: 1,
      backupId,
      userId,
      createdAt: new Date().toISOString(),
      vaultEnvelope,
      recoveryEnvelope,
      objects: records,
      totalEncryptedBytes,
    };
    const manifestDigest = createHash('sha256').update(JSON.stringify(manifestBody)).digest('hex');
    const manifest = {
      ...manifestBody,
      manifestDigest,
      verifier: encryptVaultMetadata({ backupId, purpose: 'Project Nanako encrypted vault backup', manifestDigest }, masterKey, userId, backupId),
    };
    await writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    await rename(stage, destination);
    return { id: backupId, createdAt: manifest.createdAt, itemCount: records.length, encryptedBytes: totalEncryptedBytes };
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    if (error.code === 'ABORT_ERR' || signal?.aborted) throw backupError('vault_backup_cancelled', '加密備份因加密空間鎖定而取消。');
    throw error;
  }
}

export async function readVaultBackup({ backupRoot, backupId, userId, masterKey }) {
  if (typeof backupId !== 'string' || !UUID_PATTERN.test(backupId)) throw backupError('vault_backup_not_found', '找不到加密備份。');
  const directory = path.join(backupRoot, backupId);
  const info = await lstat(directory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info?.isDirectory() || info.isSymbolicLink()) throw backupError('vault_backup_not_found', '找不到加密備份。');
  const manifestPath = path.join(directory, 'manifest.json');
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > MAX_MANIFEST_BYTES) throw backupError('vault_backup_invalid', '加密備份索引格式不正確或超過大小限制。');
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch { throw backupError('vault_backup_invalid', '加密備份索引已損毀。'); }
  if (manifest?.formatVersion !== 1 || manifest.backupId !== backupId || manifest.userId !== userId
    || !Array.isArray(manifest.objects) || manifest.objects.length > MAX_BACKUP_OBJECTS) {
    throw backupError('vault_backup_invalid', '加密備份不屬於目前帳號，或格式不支援。');
  }
  const manifestBody = {
    formatVersion: manifest.formatVersion,
    backupId: manifest.backupId,
    userId: manifest.userId,
    createdAt: manifest.createdAt,
    vaultEnvelope: manifest.vaultEnvelope,
    recoveryEnvelope: manifest.recoveryEnvelope,
    objects: manifest.objects,
    totalEncryptedBytes: manifest.totalEncryptedBytes,
  };
  const manifestDigest = createHash('sha256').update(JSON.stringify(manifestBody)).digest('hex');
  try {
    const verifier = decryptVaultMetadata(manifest.verifier, masterKey, userId, backupId);
    if (verifier.backupId !== backupId || verifier.purpose !== 'Project Nanako encrypted vault backup'
      || verifier.manifestDigest !== manifestDigest || manifest.manifestDigest !== manifestDigest) throw new Error('invalid verifier');
  } catch { throw backupError('vault_backup_key_mismatch', '這份備份不是由目前解鎖的加密空間金鑰建立。'); }
  return { directory, manifest };
}

export async function listVaultBackupDirectories(backupRoot) {
  const entries = await readdir(backupRoot, { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const ids = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink() && UUID_PATTERN.test(entry.name)) {
      const manifestPath = path.join(backupRoot, entry.name, 'manifest.json');
      const info = await lstat(manifestPath).catch(() => null);
      if (info?.isFile() && !info.isSymbolicLink() && info.size <= MAX_MANIFEST_BYTES) ids.push(entry.name);
    }
  }
  return ids.sort();
}

export async function validateVaultBackupObjects({ backup, userId, masterKey, signal }) {
  const { directory, manifest } = backup;
  const objectRoot = path.join(directory, 'objects');
  const validated = [];
  for (const record of manifest.objects) {
    if (signal?.aborted) throw backupError('vault_backup_cancelled', '加密備份還原因加密空間鎖定而取消。');
    if (!record || typeof record.id !== 'string' || !UUID_PATTERN.test(record.id)) throw backupError('vault_backup_invalid', '加密備份含有不正確的物件識別碼。');
    let metadata;
    try { metadata = decryptVaultMetadata(record.metadata, masterKey, userId, record.id); }
    catch { throw backupError('vault_backup_invalid', '加密備份中繼資料無法驗證。'); }
    if (typeof metadata.name !== 'string' || !Number.isSafeInteger(metadata.size) || metadata.size < 0
      || typeof metadata.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(metadata.sourceDigest)) {
      throw backupError('vault_backup_invalid', '加密備份中繼資料內容不正確。');
    }
    const content = path.join(objectRoot, `${record.id}.nkv`);
    const contentInfo = await lstat(content).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!contentInfo?.isFile() || contentInfo.isSymbolicLink()) throw backupError('vault_backup_invalid', '加密備份缺少檔案本體。');
    await verifyCiphertext(content, metadata, masterKey, userId, record.id, signal);
    const sidecarPath = path.join(objectRoot, `${record.id}.nkm`);
    const sidecarInfo = await lstat(sidecarPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!sidecarInfo?.isFile() || sidecarInfo.isSymbolicLink() || sidecarInfo.size > 96 * 1024) throw backupError('vault_backup_invalid', '加密備份中繼資料檔案不正確。');
    let sidecar;
    try { sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')); }
    catch { throw backupError('vault_backup_invalid', '加密備份中繼資料已損毀。'); }
    if (JSON.stringify(sidecar) !== JSON.stringify(record.metadata)) throw backupError('vault_backup_invalid', '加密備份中繼資料不一致。');
    validated.push({ record, metadata, content, encryptedSize: contentInfo.size });
  }
  return validated;
}

export async function copyVaultBackupObject(source, destination, signal) {
  await pipeline(createReadStream(source, { signal }), createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
}

export async function readVaultBackupSidecar(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 96 * 1024) throw backupError('vault_backup_invalid', '加密備份中繼資料檔案不正確。');
  return readFile(filename, 'utf8');
}
