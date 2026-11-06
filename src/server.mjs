import { createServer } from 'node:http';
import { Server as HttpsServer } from 'node:https';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, lstat, readFile, readdir, rename, rm, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { finished, pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createArchive, extractArchive } from './archives.mjs';
import { readWindowsSmbStatus } from './windows-smb-status.mjs';
import { isShareOperationAllowed } from './share-access.mjs';
import { hashManagedFile, scanManagedDuplicates } from './duplicates.mjs';
import { searchManagedFiles } from './file-catalog.mjs';
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

const scrypt = promisify(crypto.scrypt);
const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');
const SESSION_SECONDS = 12 * 60 * 60;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const AUDIT_RETENTION_OPTIONS = Object.freeze([1, 3, 7, 30, 90, 180, 365]);
const DEFAULT_AUDIT_RETENTION_DAYS = 30;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const VAULT_UNLOCK_FAILURE_LIMIT = 5;
const VAULT_IDLE_LOCK_MS = 15 * 60 * 1000;
const DUPLICATE_SCAN_TTL_MS = 30 * 60 * 1000;
const MAX_DUPLICATE_SCAN_JOBS = 2;
const MAX_DUPLICATE_SELECTIONS = 200;
const MAX_DUPLICATE_CLEANUP_ITEMS = 1000;
const MAX_PLAYBACK_PROGRESS_ITEMS = 500;

function buildLoopbackOriginAllowlist(server) {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Nanako 伺服器尚未繫結有效的本機位址。');
  }
  const scheme = server instanceof HttpsServer ? 'https' : 'http';
  const port = address.port;
  return {
    origins: new Set([
      `${scheme}://127.0.0.1:${port}`,
      `${scheme}://localhost:${port}`,
      `${scheme}://[::1]:${port}`,
    ]),
    hosts: new Set([
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ]),
  };
}

function parseIpv4(address) {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return null;
  return octets;
}

function parseIpv6(address) {
  let value = address.toLowerCase().split('%', 1)[0];
  if (value.includes('.')) {
    const ipv4Start = value.lastIndexOf(':') + 1;
    const ipv4 = parseIpv4(value.slice(ipv4Start));
    if (ipv4Start === 0 || !ipv4) return null;
    const first = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const second = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    value = `${value.slice(0, ipv4Start)}${first}:${second}`;
  }

  const compression = value.indexOf('::');
  if (compression !== -1 && compression !== value.lastIndexOf('::')) return null;
  let words;
  if (compression === -1) {
    words = value.split(':');
    if (words.length !== 8) return null;
  } else {
    const left = value.slice(0, compression).split(':').filter(Boolean);
    const right = value.slice(compression + 2).split(':').filter(Boolean);
    const zeroCount = 8 - left.length - right.length;
    if (zeroCount < 1) return null;
    words = [...left, ...Array(zeroCount).fill('0'), ...right];
  }
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/u.test(word))) return null;
  return words.map((word) => Number.parseInt(word, 16));
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const ipv4 = parseIpv4(address);
  if (ipv4) return ipv4[0] === 127;

  const words = parseIpv6(address);
  if (!words) return false;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  return words.slice(0, 5).every((word) => word === 0)
    && words[5] === 0xffff
    && (words[6] >> 8) === 127;
}

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'], ['.svg', 'image/svg+xml'],
]);
const mediaTypes = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.bmp', 'image/bmp'],
  ['.mp4', 'video/mp4'], ['.m4v', 'video/x-m4v'], ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'], ['.ogv', 'video/ogg'],
  ['.mp3', 'audio/mpeg'], ['.m4a', 'audio/mp4'], ['.aac', 'audio/aac'],
  ['.wav', 'audio/wav'], ['.oga', 'audio/ogg'], ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/ogg'], ['.flac', 'audio/flac'],
]);

function json(res, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function parseByteRange(header, size) {
  if (!header) return null;
  const invalid = () => fail(416, 'invalid_range', '要求的影音播放範圍不正確。');
  if (typeof header !== 'string' || header.length > 128 || size <= 0 || header.includes(',')) throw invalid();
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || (!match[1] && !match[2])) throw invalid();
  let start; let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw invalid();
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) throw invalid();
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function writeResponseChunk(res, chunk) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      res.off('drain', onDrain);
      res.off('close', onClose);
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => finish();
    const onClose = () => finish();
    res.once('close', onClose);
    if (res.write(chunk)) finish();
    else res.once('drain', onDrain);
  });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw fail(413, 'request_too_large', '資料太大。');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'invalid_json', '資料格式不正確。'); }
}

function safeName(value) {
  if (typeof value !== 'string') throw fail(400, 'invalid_name', '名稱不正確。');
  const name = value.trim();
  if (!name || name.length > 180 || name === '.' || name === '..' || name.toLocaleLowerCase('en-US') === '.nanako-trash' || name.toLocaleLowerCase('en-US').startsWith('.localnas-') || /[\\/\0<>:"|?*]/u.test(name)) {
    throw fail(400, 'invalid_name', '名稱不可空白，也不能使用 Windows 或 Nanako 保留名稱。');
  }
  if (/[. ]$/u.test(name)) throw fail(400, 'invalid_name', '名稱不能以句點或空白結尾。');
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu.test(name)) {
    throw fail(400, 'invalid_name', '名稱不能使用 Windows 保留裝置名稱。');
  }
  return name;
}

function relativeParts(value) {
  if (typeof value !== 'string' || value.length > 2048) throw fail(400, 'invalid_path', '路徑不正確。');
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/u.test(normalized)) throw fail(400, 'invalid_path', '不能使用絕對路徑。');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) throw fail(400, 'invalid_path', '路徑不正確。');
  return parts;
}

function resolveInside(root, relative = '') {
  const parts = relativeParts(relative);
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts);
  const rel = path.relative(base, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw fail(400, 'invalid_path', '路徑超出分享範圍。');
  return { target, parts };
}

function resolveShareInside(root, relative = '') {
  const resolved = resolveInside(root, relative);
  if (resolved.parts.some((part) => part.toLocaleLowerCase('en-US') === '.nanako-trash')
    || resolved.parts.some((part) => part.toLocaleLowerCase('en-US').startsWith('.localnas-'))) {
    throw fail(404, 'not_found', '找不到這個項目。');
  }
  return resolved;
}

const MAX_COPY_ENTRIES = 100_000;

async function measureCopyTree(source, totals = { bytes: 0, entries: 0 }) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw fail(400, 'symlink_not_allowed', 'Nanako 資料範圍內不可使用符號連結或重新解析點。');
  if (info.isFile()) totals.bytes += info.size;
  else if (!info.isDirectory()) throw fail(400, 'unsupported_file_type', '只支援複製一般檔案與資料夾。');
  totals.entries += 1;
  if (totals.entries > MAX_COPY_ENTRIES) throw fail(413, 'copy_too_many_entries', '單次複製最多可處理 100,000 個項目。');
  if (info.isDirectory()) {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const normalizedName = entry.name.toLocaleLowerCase('en-US');
      if (normalizedName.startsWith('.localnas-') || normalizedName === '.nanako-trash') continue;
      await measureCopyTree(path.join(source, entry.name), totals);
    }
  }
  return totals;
}

async function copyManagedTree(source, destination, totals = { entries: 0 }) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw fail(400, 'symlink_not_allowed', 'Nanako 資料範圍內不可使用符號連結或重新解析點。');
  if (info.isFile()) {
    totals.entries += 1;
    if (totals.entries > MAX_COPY_ENTRIES) throw fail(413, 'copy_too_many_entries', '單次複製最多可處理 100,000 個項目。');
    await pipeline(createReadStream(source), createWriteStream(destination, { flags: 'wx' }));
    return totals;
  }
  if (!info.isDirectory()) throw fail(400, 'unsupported_file_type', '只支援複製一般檔案與資料夾。');
  totals.entries += 1;
  if (totals.entries > MAX_COPY_ENTRIES) throw fail(413, 'copy_too_many_entries', '單次複製最多可處理 100,000 個項目。');
  await mkdir(destination);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const normalizedName = entry.name.toLocaleLowerCase('en-US');
    if (normalizedName.startsWith('.localnas-') || normalizedName === '.nanako-trash') continue;
    await copyManagedTree(path.join(source, entry.name), path.join(destination, entry.name), totals);
  }
  return totals;
}

async function itemExists(target) {
  try { await lstat(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

const mutationLocks = new Map();
async function withPathLockKey(key, operation) {
  const previous = mutationLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  mutationLocks.set(key, current);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (mutationLocks.get(key) === current) mutationLocks.delete(key);
  }
}

async function withPathLocks(targets, operation) {
  const keys = [...new Set(targets.map((target) => path.resolve(target).toLocaleLowerCase('en-US')))].sort();
  const acquire = (index) => index === keys.length
    ? operation()
    : withPathLockKey(keys[index], () => acquire(index + 1));
  return acquire(0);
}

const withPathLock = (target, operation) => withPathLocks([target], operation);

async function rejectSymlinkTraversal(managedRoot, root, target, includeLeaf = true) {
  managedRoot = path.resolve(managedRoot);
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  const rootRelative = path.relative(managedRoot, absoluteRoot);
  const relative = path.relative(absoluteRoot, absoluteTarget);
  if ([rootRelative, relative].some((value) => value === '..' || value.startsWith(`..${path.sep}`) || path.isAbsolute(value))) {
    throw fail(400, 'invalid_path', '路徑超出 Nanako 資料範圍。');
  }
  const managedRelative = path.relative(managedRoot, absoluteTarget);
  const parts = managedRelative ? managedRelative.split(path.sep) : [];
  let current = managedRoot;
  const count = includeLeaf ? parts.length : Math.max(0, parts.length - 1);
  for (const part of parts.slice(0, count)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw fail(400, 'symlink_not_allowed', 'Nanako 資料範圍內不可使用符號連結或重新解析點。');
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function cookieValue(req, name) {
  const raw = req.headers.cookie || '';
  for (const pair of raw.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    if (pair.slice(0, index).trim() === name) return decodeURIComponent(pair.slice(index + 1).trim());
  }
  return '';
}

function validateUsername(value) {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}._-]{3,32}$/u.test(value)) {
    throw fail(400, 'invalid_username', '帳號請使用 3 至 32 個中文字、英文字母、數字、句點、底線或連字號。');
  }
  return value;
}

async function passwordHash(password, salt = crypto.randomBytes(16)) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw fail(400, 'weak_password', '密碼長度須為 12 至 256 個字元。');
  }
  const derived = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt: salt.toString('hex'), hash: Buffer.from(derived).toString('hex') };
}

async function verifyPassword(password, saltHex, expectedHex) {
  const salt = Buffer.from(saltHex, 'hex');
  const actual = Buffer.from(await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

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
        "Get-CimInstance -ClassName Win32_OperatingSystem | Select-Object Caption, Version, BuildNumber, OSArchitecture | ConvertTo-Json -Compress",
      ], { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 });
      const info = JSON.parse(stdout.trim());
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

export async function startServer({ dataDir, storageRoot, host = '127.0.0.1', port = 8765, smbStatusProbe = readWindowsSmbStatus } = {}) {
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
  const loginFailures = new Map();
  const vaultUnlockFailures = new Map();
  const unlockedVaultKeys = new Map();
  const activeVaultImports = new Map();
  const activeArchiveJobs = new Map();
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
  function assertVaultUnlockAllowed(key, now = Date.now()) {
    if (vaultUnlockFailures.size > 2048) {
      for (const [attemptKey, attempt] of vaultUnlockFailures) if (attempt.lockedUntil <= now && now - attempt.updatedAt > LOGIN_WINDOW_MS) vaultUnlockFailures.delete(attemptKey);
    }
    const attempt = vaultUnlockFailures.get(key);
    if (attempt?.lockedUntil > now) throw fail(429, 'vault_unlock_throttled', '嘗試次數過多，請稍後再解鎖加密空間。');
    if (attempt?.lockedUntil && attempt.lockedUntil <= now) vaultUnlockFailures.delete(key);
  }
  function recordVaultUnlockFailure(key, now = Date.now()) {
    const attempt = vaultUnlockFailures.get(key) || { count: 0, lockedUntil: 0, updatedAt: now };
    attempt.count += 1;
    attempt.updatedAt = now;
    if (attempt.count >= VAULT_UNLOCK_FAILURE_LIMIT) {
      attempt.count = 0;
      attempt.lockedUntil = now + LOGIN_WINDOW_MS;
    }
    vaultUnlockFailures.set(key, attempt);
  }
  const duplicateScans = new Map();
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

  function pruneDuplicateScans(now = Date.now()) {
    for (const [id, job] of duplicateScans) {
      if (job.status !== 'scanning' && job.status !== 'cancelling' && now - job.updatedAt > DUPLICATE_SCAN_TTL_MS) duplicateScans.delete(id);
    }
    if (duplicateScans.size < 32) return;
    const completed = [...duplicateScans.values()]
      .filter((job) => !['scanning', 'cancelling'].includes(job.status))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    while (duplicateScans.size >= 32 && completed.length) duplicateScans.delete(completed.shift().id);
  }

  function duplicateScanForUser(scanId, user) {
    if (!/^[0-9a-f-]{36}$/iu.test(String(scanId || ''))) throw fail(404, 'duplicate_scan_not_found', '找不到這次掃描。');
    pruneDuplicateScans();
    const job = duplicateScans.get(String(scanId));
    if (!job || job.userId !== user.id) throw fail(404, 'duplicate_scan_not_found', '找不到這次掃描。');
    requirePermission(user, job.shareId);
    return job;
  }

  async function runDuplicateScan(job, root) {
    try {
      const result = await scanManagedDuplicates({
        root,
        signal: job.controller.signal,
        shouldContinue: () => {
          const current = getUserById.get(job.userId);
          const canStillRead = current?.isActive && isShareOperationAllowed(current, permission(current, job.shareId), 'read');
          if (!canStillRead) job.controller.abort();
          return Boolean(canStillRead);
        },
        onProgress: (progress) => { job.progress = progress; job.updatedAt = Date.now(); },
      });
      if (job.controller.signal.aborted) {
        job.status = 'cancelled';
      } else {
        job.groups = result.groups;
        job.statistics = {
          visitedEntries: result.visitedEntries,
          scannedFiles: result.scannedFiles,
          comparedFiles: result.comparedFiles,
          skippedFiles: result.skippedFiles,
          bytesHashed: result.bytesHashed,
        };
        job.status = 'completed';
      }
    } catch (error) {
      if (job.controller.signal.aborted || error.name === 'AbortError') job.status = 'cancelled';
      else {
        job.status = 'failed';
        job.error = error.status ? error.message : error.code === 'SCAN_TOO_MANY_ENTRIES'
          ? error.message
          : '掃描失敗。請確認資料空間可讀取後再試一次。';
      }
    } finally {
      job.updatedAt = Date.now();
    }
  }

  function writeOperationLog(actor, action, target, outcome = '成功') {
    db.prepare('INSERT INTO operation_logs(id, occurred_at, actor_id, actor_name, action, target, outcome) VALUES(?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), Date.now(), actor?.id || null, String(actor?.username || '未知使用者').slice(0, 80), String(action).slice(0, 80), String(target || '').slice(0, 512), outcome);
  }

  async function currentUser(req) {
    const token = cookieValue(req, 'localnas_session');
    if (!token || token.length > 200) return null;
    const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(hashToken(token));
    if (!row) return null;
    if (row.expires_at < Date.now()) { await lockVaultKey(row.user_id); return null; }
    const user = getUserById.get(row.user_id) || null;
    return user?.isActive ? user : null;
  }

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
        if (route === '/api/setup-state' && method === 'GET') {
          return json(res, 200, { needsSetup: Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n) === 0 });
        }
        if (route === '/api/setup' && method === 'POST') {
          if (Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n) !== 0) throw fail(409, 'already_setup', '已完成初始設定。');
          const body = await readJson(req);
          const username = validateUsername(body.username);
          setAudit({ username }, '建立本機管理員', username);
          const pass = await passwordHash(body.password);
          const userId = crypto.randomUUID();
          const shareId = crypto.randomUUID();
          const now = new Date().toISOString();
          const token = crypto.randomBytes(32).toString('base64url');
          db.exec('BEGIN IMMEDIATE');
          try {
            if (Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n) !== 0) {
              throw fail(409, 'already_setup', '已完成初始設定。');
            }
            db.prepare('INSERT INTO users(id, username, password_salt, password_hash, role, created_at) VALUES(?,?,?,?,?,?)')
              .run(userId, username, pass.salt, pass.hash, 'admin', now);
            db.prepare('INSERT INTO shares(id, name, created_at) VALUES(?,?,?)').run(shareId, '主資料夾', now);
            db.prepare('INSERT INTO share_permissions(user_id, share_id, can_read, can_write) VALUES(?,?,1,1)').run(userId, shareId);
            db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)').run(hashToken(token), userId, Date.now() + SESSION_SECONDS * 1000);
            db.exec('COMMIT');
          } catch (error) {
            try { db.exec('ROLLBACK'); } catch { /* transaction may not have begun */ }
            throw error;
          }
          const newShareRoot = path.join(dataDir, 'files', shareId);
          await rejectSymlinkTraversal(dataDir, dataDir, newShareRoot, false);
          await mkdir(newShareRoot);
          await rejectSymlinkTraversal(dataDir, dataDir, newShareRoot);
          return json(res, 201, { user: getUserById.get(userId) }, { 'Set-Cookie': `localnas_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}` });
        }
        if (route === '/api/login' && method === 'POST') {
          const body = await readJson(req);
          const attemptedUsername = String(body.username || '').slice(0, 80);
          setAudit({ username: attemptedUsername || '未知使用者' }, '登入', attemptedUsername);
          const accountKey = attemptedUsername.trim().toLocaleLowerCase('en-US');
          const sourceKey = req.socket.remoteAddress || 'local';
          const throttleKey = `${sourceKey}\0${accountKey}`;
          const now = Date.now();
          if (loginFailures.size > 2048) {
            for (const [key, value] of loginFailures) {
              if (now - value.windowStartedAt >= LOGIN_WINDOW_MS) loginFailures.delete(key);
            }
          }
          let attempt = loginFailures.get(throttleKey);
          if (attempt && now - attempt.windowStartedAt >= LOGIN_WINDOW_MS) {
            loginFailures.delete(throttleKey);
            attempt = null;
          }
          if (attempt?.lockedUntil > now) throw fail(429, 'login_throttled', '登入嘗試次數過多，請 15 分鐘後再試。');
          const user = findUser.get(String(body.username || ''));
          const password = String(body.password || '');
          const validPassword = password.length <= 256
            && await verifyPassword(password, user?.password_salt || dummyPassword.salt, user?.password_hash || dummyPassword.hash);
          if (!user || !user.is_active || !validPassword) {
            const next = attempt || { count: 0, windowStartedAt: now, lockedUntil: 0 };
            next.count += 1;
            if (next.count >= LOGIN_FAILURE_LIMIT) next.lockedUntil = now + LOGIN_WINDOW_MS;
            loginFailures.set(throttleKey, next);
            throw fail(401, 'invalid_login', '帳號或密碼不正確。');
          }
          loginFailures.delete(throttleKey);
          setAudit(user, '登入', user.username);
          const token = crypto.randomBytes(32).toString('base64url');
          db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)').run(hashToken(token), user.id, Date.now() + SESSION_SECONDS * 1000);
          return json(res, 200, { user: getUserById.get(user.id) }, { 'Set-Cookie': `localnas_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}` });
        }
        if (route === '/api/logout' && method === 'POST') {
          const token = cookieValue(req, 'localnas_session');
          const session = token ? db.prepare('SELECT user_id FROM sessions WHERE token_hash = ?').get(hashToken(token)) : null;
          const signedOutUser = session ? getUserById.get(session.user_id) : null;
          if (signedOutUser) { setAudit(signedOutUser, '登出', signedOutUser.username); await lockVaultKey(signedOutUser.id); }
          if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
          return json(res, 200, { ok: true }, { 'Set-Cookie': 'localnas_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
        }

        const user = await currentUser(req);
        if (!user) throw fail(401, 'authentication_required', '請先登入。');
        const inferredAudit = auditForRequest(user, method, route, url);
        if (inferredAudit) setAudit(user, inferredAudit.action, inferredAudit.target);

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
          vaultUnlockFailures.delete(attemptKey);
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
          vaultUnlockFailures.delete(attemptKey);
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

        if (route === '/api/duplicates/scan' && method === 'POST') {
          const body = await readJson(req);
          const shareId = String(body.shareId || '');
          requirePermission(user, shareId);
          const { share, root } = shareRoot(shareId);
          await rejectSymlinkTraversal(dataDir, dataDir, root);
          const rootInfo = await lstat(root).catch(() => null);
          if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw fail(404, 'share_not_found', '找不到可掃描的 Nanako 資料空間。');
          pruneDuplicateScans();
          if ([...duplicateScans.values()].some((job) => job.userId === user.id && ['scanning', 'cancelling'].includes(job.status))) {
            throw fail(409, 'duplicate_scan_in_progress', '你已有一項重複檔案掃描正在進行。');
          }
          if ([...duplicateScans.values()].filter((job) => ['scanning', 'cancelling'].includes(job.status)).length >= MAX_DUPLICATE_SCAN_JOBS) {
            throw fail(429, 'duplicate_scan_limit', '目前掃描工作較多，請稍後再試。');
          }
          const scanId = crypto.randomUUID();
          const job = {
            id: scanId,
            userId: user.id,
            shareId,
            shareName: share.name,
            status: 'scanning',
            progress: { phase: 'starting', visitedEntries: 0, scannedFiles: 0, skippedFiles: 0 },
            statistics: null,
            groups: [],
            controller: new AbortController(),
            startedAt: Date.now(),
            updatedAt: Date.now(),
          };
          duplicateScans.set(scanId, job);
          setAudit(user, '開始重複檔案掃描', share.name);
          job.promise = runDuplicateScan(job, root);
          return json(res, 202, { scanId, status: job.status });
        }

        if (route === '/api/duplicates/scan' && method === 'GET') {
          const job = duplicateScanForUser(url.searchParams.get('scanId'), user);
          return json(res, 200, {
            scanId: job.id,
            status: job.status,
            shareName: job.shareName,
            progress: job.progress,
            statistics: job.statistics,
            error: job.error || null,
            groups: job.status === 'completed' ? job.groups.map((group) => ({
              id: group.id,
              size: group.size,
              duplicateCount: group.items.length,
              items: group.items.map(({ path: itemPath, name, size, modifiedAt }) => ({ path: itemPath, name, size, modifiedAt })),
            })) : [],
          });
        }

        if (route === '/api/duplicates/scan' && method === 'DELETE') {
          const job = duplicateScanForUser(url.searchParams.get('scanId'), user);
          if (!['scanning', 'cancelling'].includes(job.status)) throw fail(409, 'duplicate_scan_not_running', '目前沒有進行中的掃描。');
          job.status = 'cancelling';
          job.controller.abort();
          job.updatedAt = Date.now();
          setAudit(user, '取消重複檔案掃描', job.shareName);
          return json(res, 202, { scanId: job.id, status: job.status });
        }

        if (route === '/api/duplicates/cleanup' && method === 'POST') {
          const body = await readJson(req);
          const job = duplicateScanForUser(body.scanId, user);
          if (job.status !== 'completed') throw fail(409, 'duplicate_scan_not_ready', '掃描結果已失效，請重新掃描。');
          requirePermission(user, job.shareId, true);
          if (!Array.isArray(body.groups) || body.groups.length === 0 || body.groups.length > MAX_DUPLICATE_SELECTIONS) {
            throw fail(400, 'invalid_duplicate_selection', `請選擇 1 至 ${MAX_DUPLICATE_SELECTIONS} 組重複檔案。`);
          }
          const seenGroupIds = new Set();
          const selections = [];
          let duplicateItemCount = 0;
          for (const selection of body.groups) {
            const group = job.groups.find((item) => item.id === selection?.groupId);
            if (!group || seenGroupIds.has(group.id) || typeof selection.keepPath !== 'string') throw fail(400, 'invalid_duplicate_selection', '重複檔案選擇內容不正確。');
            seenGroupIds.add(group.id);
            const keeper = group.items.find((item) => item.path === selection.keepPath);
            if (!keeper) throw fail(400, 'invalid_duplicate_selection', '保留項目不屬於這組重複檔案。');
            const copies = group.items.filter((item) => item !== keeper);
            duplicateItemCount += copies.length;
            selections.push({ group, keeper, copies });
          }
          if (duplicateItemCount > MAX_DUPLICATE_CLEANUP_ITEMS) throw fail(413, 'too_many_duplicate_items', `單次最多可整理 ${MAX_DUPLICATE_CLEANUP_ITEMS} 個副本，請分批處理。`);
          if (duplicateItemCount === 0) throw fail(400, 'no_duplicate_copies', '沒有可整理的副本。');

          const { share, root } = shareRoot(job.shareId);
          const allSelectedItems = selections.flatMap(({ group }) => group.items.map((item) => ({ group, item })));
          const targetByItem = new Map();
          for (const { group, item } of allSelectedItems) {
            const { target } = resolveShareInside(root, item.path);
            await rejectSymlinkTraversal(dataDir, root, target);
            targetByItem.set(`${group.id}\0${item.path}`, target);
          }

          const outcomes = await withPathLocks([...targetByItem.values()], async () => {
            const verified = new Map();
            for (const { group, item } of allSelectedItems) {
              const target = targetByItem.get(`${group.id}\0${item.path}`);
              let fingerprint;
              try { fingerprint = await hashManagedFile(target); }
              catch { throw fail(409, 'duplicate_file_changed', `「${item.path}」已變更或無法讀取，請重新掃描。`); }
              if (fingerprint.size !== group.size || fingerprint.digest !== group.digest) {
                throw fail(409, 'duplicate_file_changed', `「${item.path}」已變更，請重新掃描。`);
              }
              verified.set(`${group.id}\0${item.path}`, fingerprint);
            }

            const moved = [];
            const failed = [];
            for (const { group, keeper, copies } of selections) {
              const keeperPath = targetByItem.get(`${group.id}\0${keeper.path}`);
              const keeperFingerprint = verified.get(`${group.id}\0${keeper.path}`);
              const keeperInfo = await lstat(keeperPath).catch(() => null);
              let keeperStillMatches = Boolean(keeperInfo?.isFile() && !keeperInfo.isSymbolicLink()
                && keeperInfo.size === keeperFingerprint.size && keeperInfo.mtimeMs === keeperFingerprint.mtimeMs
                && keeperInfo.ctimeMs === keeperFingerprint.ctimeMs && keeperInfo.dev === keeperFingerprint.dev
                && keeperInfo.ino === keeperFingerprint.ino);
              if (keeperStillMatches) {
                try {
                  const currentKeeper = await hashManagedFile(keeperPath);
                  keeperStillMatches = currentKeeper.size === group.size && currentKeeper.digest === group.digest;
                } catch { keeperStillMatches = false; }
              }
              if (!keeperStillMatches) {
                for (const item of copies) {
                  failed.push({ path: item.path, ok: false, message: '保留檔案在整理期間有所變動，未整理此組副本；請重新掃描。' });
                  writeOperationLog(user, '整理重複檔案副本', item.path, '失敗');
                }
                continue;
              }
              for (const item of copies) {
                const source = targetByItem.get(`${group.id}\0${item.path}`);
                const fingerprint = verified.get(`${group.id}\0${item.path}`);
                const currentInfo = await lstat(source).catch(() => null);
                if (!currentInfo?.isFile() || currentInfo.isSymbolicLink()
                  || currentInfo.size !== fingerprint.size || currentInfo.mtimeMs !== fingerprint.mtimeMs
                  || currentInfo.ctimeMs !== fingerprint.ctimeMs || currentInfo.dev !== fingerprint.dev || currentInfo.ino !== fingerprint.ino) {
                  const outcome = { path: item.path, ok: false, message: '檔案在整理前再次變動，已略過；請重新掃描。' };
                  failed.push(outcome);
                  writeOperationLog(user, '整理重複檔案副本', item.path, '失敗');
                  continue;
                }
                const id = crypto.randomUUID();
                const storedPath = managedTrashPath(share.id, id);
                await rejectSymlinkTraversal(dataDir, dataDir, path.dirname(storedPath), false);
                await mkdir(path.dirname(storedPath), { recursive: true });
                await rejectSymlinkTraversal(dataDir, dataDir, storedPath, false);
                try {
                  await rename(source, storedPath);
                  try {
                    db.prepare(`INSERT INTO trash_items(id, share_id, original_path, stored_path, item_name, is_directory, deleted_by, deleted_at) VALUES(?,?,?,?,?,?,?,?)`)
                      .run(id, share.id, item.path, storedPath, path.posix.basename(item.path), 0, user.id, new Date().toISOString());
                  } catch (error) {
                    await rename(storedPath, source).catch(() => {});
                    throw error;
                  }
                  moved.push({ path: item.path, trashId: id });
                  writeOperationLog(user, '整理重複檔案副本', item.path, '成功');
                } catch (error) {
                  const outcome = { path: item.path, ok: false, message: error.code === 'ENOENT' ? '檔案已不存在，請重新掃描。' : '無法移至資源回收桶。' };
                  failed.push(outcome);
                  writeOperationLog(user, '整理重複檔案副本', item.path, '失敗');
                }
              }
            }
            return { moved, failed };
          });

          job.status = outcomes.failed.length ? 'stale' : 'cleaned';
          job.updatedAt = Date.now();
          setAudit(user, '整理重複檔案副本', `${share.name}：已移至資源回收桶 ${outcomes.moved.length} 個`);
          return json(res, 200, { ok: outcomes.failed.length === 0, moved: outcomes.moved, failed: outcomes.failed });
        }

        if (route === '/api/me' && method === 'GET') return json(res, 200, { user });
        if (route === '/api/password' && method === 'POST') {
          const body = await readJson(req);
          const current = db.prepare('SELECT password_salt, password_hash FROM users WHERE id = ?').get(user.id);
          if (!await verifyPassword(String(body.currentPassword || ''), current.password_salt, current.password_hash)) {
            throw fail(400, 'current_password_incorrect', '目前密碼不正確。');
          }
          const nextPassword = await passwordHash(body.newPassword);
          db.prepare('UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?').run(nextPassword.salt, nextPassword.hash, user.id);
          db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
          await lockVaultKey(user.id);
          const token = crypto.randomBytes(32).toString('base64url');
          db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)').run(hashToken(token), user.id, Date.now() + SESSION_SECONDS * 1000);
          return json(res, 200, { ok: true }, { 'Set-Cookie': `localnas_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}` });
        }
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
        if (route === '/api/files' && method === 'GET') {
          const shareId = url.searchParams.get('shareId') || '';
          requirePermission(user, shareId);
          const { root } = shareRoot(shareId);
          const { target } = resolveShareInside(root, url.searchParams.get('path') || '');
          await rejectSymlinkTraversal(dataDir, root, target);
          const info = await stat(target).catch(() => null);
          if (!info?.isDirectory()) throw fail(404, 'folder_not_found', '找不到資料夾。');
          const entries = await readdir(target, { withFileTypes: true });
          const items = [];
          for (const entry of entries) {
            if (entry.name.toLocaleLowerCase('en-US').startsWith('.localnas-') || entry.name.toLocaleLowerCase('en-US') === '.nanako-trash') continue;
            const itemPath = path.join(target, entry.name);
            const itemInfo = await lstat(itemPath);
            if (itemInfo.isSymbolicLink()) continue;
            items.push({ name: entry.name, isDirectory: itemInfo.isDirectory(), size: itemInfo.isFile() ? itemInfo.size : null, modifiedAt: itemInfo.mtime.toISOString() });
          }
          items.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'zh-TW', { numeric: true }));
          return json(res, 200, { path: relativeParts(url.searchParams.get('path') || '').join('/'), items, canWrite: Boolean(permission(user, shareId).can_write) });
        }
        if (route === '/api/files/search' && method === 'GET') {
          const shareId = url.searchParams.get('shareId') || '';
          requirePermission(user, shareId);
          const { share, root } = shareRoot(shareId);
          await rejectSymlinkTraversal(dataDir, dataDir, root);
          const results = await searchManagedFiles({
            root,
            category: url.searchParams.get('category') || '',
            search: url.searchParams.get('search') || '',
            verifyPath: (target) => rejectSymlinkTraversal(dataDir, root, target),
          });
          return json(res, 200, {
            ...results,
            share: { id: share.id, name: share.name },
            canWrite: Boolean(permission(user, shareId).can_write),
          });
        }
        if (route === '/api/folders' && method === 'POST') {
          const body = await readJson(req);
          if (auditEvent) auditEvent.target = `${body.path ? `${String(body.path).slice(0, 256)}/` : ''}${String(body.name || '').slice(0, 180)}`.slice(0, 512);
          const shareId = String(body.shareId || '');
          requirePermission(user, shareId, true);
          const { root } = shareRoot(shareId);
          const parent = resolveShareInside(root, body.path || '');
          await rejectSymlinkTraversal(dataDir, root, parent.target);
          if (!(await stat(parent.target).catch(() => null))?.isDirectory()) throw fail(404, 'folder_not_found', '找不到上層資料夾。');
          const name = safeName(body.name);
          const target = path.join(parent.target, name);
          return await withPathLock(target, async () => {
            await mkdir(target).catch((error) => { if (error.code === 'EEXIST') throw fail(409, 'already_exists', '同名項目已存在。'); throw error; });
            return json(res, 201, { ok: true });
          });
        }
        if (route === '/api/files/rename' && method === 'POST') {
          const body = await readJson(req);
          const shareId = String(body.shareId || '');
          requirePermission(user, shareId, true);
          const { root } = shareRoot(shareId);
          const { target: source, parts } = resolveShareInside(root, body.path || '');
          if (!parts.length) throw fail(400, 'cannot_rename_root', '不能重新命名資料空間本身。');
          const name = safeName(body.newName);
          const parent = resolveShareInside(root, parts.slice(0, -1).join('/'));
          await rejectSymlinkTraversal(dataDir, root, source);
          await rejectSymlinkTraversal(dataDir, root, parent.target);
          const info = await lstat(source).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
          if (!info || info.isSymbolicLink()) throw fail(404, 'file_not_found', '找不到項目。');
          if (!info.isFile() && !info.isDirectory()) throw fail(400, 'unsupported_file_type', '只支援重新命名一般檔案與資料夾。');
          const destination = path.join(parent.target, name);
          if (destination === source) return json(res, 200, { ok: true, name: parts.at(-1), unchanged: true });
          if (auditEvent) auditEvent.target = `${parts.join('/')} → ${[...parts.slice(0, -1), name].join('/')}`;
          return await withPathLocks([source, destination], async () => {
            const exists = await itemExists(destination);
            const caseOnlyRename = process.platform === 'win32' && destination.toLocaleLowerCase('en-US') === source.toLocaleLowerCase('en-US');
            if (exists && !caseOnlyRename) throw fail(409, 'already_exists', '目的地已有同名項目。');
            if (caseOnlyRename) {
              const temporary = path.join(parent.target, `.localnas-rename-${crypto.randomUUID()}.tmp`);
              await rename(source, temporary);
              try { await rename(temporary, destination); }
              catch (error) { await rename(temporary, source).catch(() => {}); throw error; }
              return json(res, 200, { ok: true, name });
            }
            await rename(source, destination);
            return json(res, 200, { ok: true, name });
          });
        }
        if (route === '/api/files/move' && method === 'POST') {
          const body = await readJson(req);
          const shareId = String(body.shareId || '');
          requirePermission(user, shareId, true);
          const { root } = shareRoot(shareId);
          const { target: source, parts } = resolveShareInside(root, body.path || '');
          if (!parts.length) throw fail(400, 'cannot_move_root', '不能移動資料空間本身。');
          const destinationDirectory = resolveShareInside(root, body.destinationPath || '');
          await rejectSymlinkTraversal(dataDir, root, source);
          await rejectSymlinkTraversal(dataDir, root, destinationDirectory.target);
          const sourceInfo = await lstat(source).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
          if (!sourceInfo || sourceInfo.isSymbolicLink()) throw fail(404, 'file_not_found', '找不到項目。');
          if (!sourceInfo.isFile() && !sourceInfo.isDirectory()) throw fail(400, 'unsupported_file_type', '只支援移動一般檔案與資料夾。');
          if (!(await stat(destinationDirectory.target).catch(() => null))?.isDirectory()) throw fail(404, 'folder_not_found', '找不到目的地資料夾。');
          if (sourceInfo.isDirectory()) {
            const relativeDestination = path.relative(source, destinationDirectory.target);
            if (!relativeDestination || (relativeDestination !== '..' && !relativeDestination.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeDestination))) {
              throw fail(400, 'cannot_move_into_self', '資料夾不能移至自己或其子資料夾內。');
            }
          }
          const destination = path.join(destinationDirectory.target, parts.at(-1));
          if (destination === source) return json(res, 200, { ok: true, unchanged: true });
          if (auditEvent) auditEvent.target = `${parts.join('/')} → ${[...relativeParts(body.destinationPath || ''), parts.at(-1)].join('/')}`;
          return await withPathLocks([source, destination], async () => {
            if (await itemExists(destination)) throw fail(409, 'already_exists', '目的地已有同名項目。');
            await rename(source, destination);
            return json(res, 200, { ok: true });
          });
        }
        if (route === '/api/files/copy' && method === 'POST') {
          const body = await readJson(req);
          const shareId = String(body.shareId || '');
          requirePermission(user, shareId, true);
          const { root } = shareRoot(shareId);
          const { target: source, parts } = resolveShareInside(root, body.path || '');
          if (!parts.length) throw fail(400, 'cannot_copy_root', '不能複製資料空間本身。');
          const destinationDirectory = resolveShareInside(root, body.destinationPath || '');
          await rejectSymlinkTraversal(dataDir, root, source);
          await rejectSymlinkTraversal(dataDir, root, destinationDirectory.target);
          const sourceInfo = await lstat(source).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
          if (!sourceInfo || sourceInfo.isSymbolicLink()) throw fail(404, 'file_not_found', '找不到項目。');
          if (!(await stat(destinationDirectory.target).catch(() => null))?.isDirectory()) throw fail(404, 'folder_not_found', '找不到目的地資料夾。');
          if (sourceInfo.isDirectory()) {
            const relativeDestination = path.relative(source, destinationDirectory.target);
            if (!relativeDestination || (relativeDestination !== '..' && !relativeDestination.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeDestination))) {
              throw fail(400, 'cannot_copy_into_self', '資料夾不能複製至自己或其子資料夾內。');
            }
          }
          const destination = path.join(destinationDirectory.target, parts.at(-1));
          if (auditEvent) auditEvent.target = `${parts.join('/')} → ${[...relativeParts(body.destinationPath || ''), parts.at(-1)].join('/')}`;
          return await withPathLocks([source, destination], async () => {
            if (await itemExists(destination)) throw fail(409, 'already_exists', '目的地已有同名項目。');
            const measurement = await measureCopyTree(source);
            const free = await statfs(dataDir, { bigint: true });
            const availableBytes = free.bavail * free.bsize;
            if (measurement.bytes > availableBytes) throw fail(507, 'insufficient_storage', 'Nanako 資料空間所在磁碟容量不足。');
            const temporary = path.join(destinationDirectory.target, `.localnas-copy-${crypto.randomUUID()}.tmp`);
            try {
              await copyManagedTree(source, temporary);
              if (await itemExists(destination)) throw fail(409, 'already_exists', '目的地已有同名項目。');
              await rename(temporary, destination);
            } catch (error) {
              await rm(temporary, { recursive: true, force: true }).catch(() => {});
              throw error;
            }
            return json(res, 201, { ok: true, entries: measurement.entries, bytes: measurement.bytes });
          });
        }
        if (route === '/api/upload' && method === 'POST') {
          const shareId = url.searchParams.get('shareId') || '';
          requirePermission(user, shareId, true);
          const { root } = shareRoot(shareId);
          const parent = resolveShareInside(root, url.searchParams.get('path') || '');
          const name = safeName(url.searchParams.get('name') || '');
          if (auditEvent) auditEvent.target = `${url.searchParams.get('path') ? `${url.searchParams.get('path')}/` : ''}${name}`.slice(0, 512);
          await rejectSymlinkTraversal(dataDir, root, parent.target);
          if (!(await stat(parent.target).catch(() => null))?.isDirectory()) throw fail(404, 'folder_not_found', '找不到上層資料夾。');
          const target = path.join(parent.target, name);
          if (await stat(target).catch(() => null)) throw fail(409, 'already_exists', '同名項目已存在。');
          const tempPath = path.join(parent.target, `.localnas-upload-${crypto.randomUUID()}.tmp`);
          let size = 0;
          const limiter = new Transform({
            transform(chunk, encoding, callback) { size += chunk.length; callback(size > MAX_UPLOAD_BYTES ? fail(413, 'file_too_large', '單一檔案上限為 5 GiB。') : null, chunk); },
          });
          try {
            await pipeline(req, limiter, createWriteStream(tempPath, { flags: 'wx' }));
            await withPathLock(target, async () => {
              if (await itemExists(target)) throw fail(409, 'already_exists', '同名項目已存在。');
              await rename(tempPath, target);
            });
          } catch (error) {
            await rm(tempPath, { force: true }).catch(() => {});
            throw error;
          }
          return json(res, 201, { ok: true, size });
        }
        if (route === '/api/preview' && method === 'GET') {
          const shareId = url.searchParams.get('shareId') || '';
          requirePermission(user, shareId);
          const { root } = shareRoot(shareId);
          const { target, parts } = resolveShareInside(root, url.searchParams.get('path') || '');
          await rejectSymlinkTraversal(dataDir, root, target);
          const info = await stat(target).catch(() => null);
          if (!info?.isFile()) throw fail(404, 'file_not_found', '找不到檔案。');
          const contentType = mediaTypes.get(path.extname(target).toLowerCase());
          if (!contentType) throw fail(415, 'preview_not_supported', '目前不支援預覽或播放這個檔案格式，請下載查看。');

          const rangeHeader = req.headers.range;
          if (rangeHeader && auditEvent) auditEvent = null;
          let range = null;
          if (rangeHeader) {
            const match = /^bytes=(\d*)-(\d*)$/iu.exec(rangeHeader.trim());
            let start; let end;
            if (match && info.size > 0) {
              if (!match[1]) {
                const suffixLength = Number(match[2]);
                if (Number.isSafeInteger(suffixLength) && suffixLength > 0) {
                  start = Math.max(info.size - suffixLength, 0);
                  end = info.size - 1;
                }
              } else {
                start = Number(match[1]);
                end = match[2] ? Number(match[2]) : info.size - 1;
                if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && start < info.size) {
                  end = Math.min(end, info.size - 1);
                } else {
                  start = undefined;
                }
              }
            }
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= info.size) {
              return json(res, 416, { error: 'invalid_range', message: '無法讀取指定的檔案範圍。' }, {
                'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${info.size}`,
              });
            }
            range = { start, end };
          }

          const fileName = parts.at(-1) || 'media';
          const headers = {
            'Content-Type': contentType,
            'Content-Length': range ? range.end - range.start + 1 : info.size,
            'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
          };
          if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`;
          res.writeHead(range ? 206 : 200, headers);
          const stream = createReadStream(target, range || undefined);
          stream.on('error', () => res.destroy());
          stream.pipe(res);
          return;
        }
        if (route === '/api/download' && method === 'GET') {
          const shareId = url.searchParams.get('shareId') || '';
          requirePermission(user, shareId);
          const { root } = shareRoot(shareId);
          const { target, parts } = resolveShareInside(root, url.searchParams.get('path') || '');
          await rejectSymlinkTraversal(dataDir, root, target);
          const info = await stat(target).catch(() => null);
          if (!info?.isFile()) throw fail(404, 'file_not_found', '找不到檔案。');
          const name = parts.at(-1) || 'download';
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': info.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store' });
          return createReadStream(target).pipe(res);
        }
        if (route === '/api/files' && method === 'DELETE') {
          const shareId = url.searchParams.get('shareId') || '';
          requirePermission(user, shareId, true);
          const { share, root } = shareRoot(shareId);
          const { target, parts } = resolveShareInside(root, url.searchParams.get('path') || '');
          if (!parts.length) throw fail(400, 'cannot_delete_root', '不能刪除分享資料夾本身。');
          await rejectSymlinkTraversal(dataDir, root, target);
          const info = await lstat(target).catch(() => null);
          if (!info || info.isSymbolicLink()) throw fail(404, 'file_not_found', '找不到項目。');
          const id = crypto.randomUUID();
          const storedPath = managedTrashPath(share.id, id);
          await rejectSymlinkTraversal(dataDir, dataDir, path.dirname(storedPath), false);
          await mkdir(path.dirname(storedPath), { recursive: true });
          await rejectSymlinkTraversal(dataDir, dataDir, storedPath, false);
          await rename(target, storedPath);
          try {
            db.prepare(`INSERT INTO trash_items(id, share_id, original_path, stored_path, item_name, is_directory, deleted_by, deleted_at) VALUES(?,?,?,?,?,?,?,?)`)
              .run(id, share.id, parts.join('/'), storedPath, parts.at(-1), Number(info.isDirectory()), user.id, new Date().toISOString());
          } catch (error) {
            await rename(storedPath, target).catch(() => {});
            throw error;
          }
          return json(res, 200, { ok: true });
        }
        if (route === '/api/trash' && method === 'GET') {
          const shareId = url.searchParams.get('shareId') || '';
          requirePermission(user, shareId, true);
          shareRoot(shareId);
          const rows = db.prepare(`SELECT id, item_name AS name, is_directory AS isDirectory, deleted_at AS deletedAt FROM trash_items WHERE share_id = ? ORDER BY deleted_at DESC`).all(shareId);
          return json(res, 200, { items: rows.map((row) => ({ ...row, isDirectory: Boolean(row.isDirectory) })) });
        }
        if (route === '/api/trash/restore' && method === 'POST') {
          const body = await readJson(req);
          const row = db.prepare('SELECT * FROM trash_items WHERE id = ?').get(String(body.id || ''));
          if (!row) throw fail(404, 'trash_item_not_found', '找不到資源回收桶項目。');
          if (auditEvent) auditEvent.target = row.item_name;
          requirePermission(user, row.share_id, true);
          const { root } = shareRoot(row.share_id);
          const destination = resolveShareInside(root, row.original_path);
          await rejectSymlinkTraversal(dataDir, root, destination.target, false);
          const parentInfo = await stat(path.dirname(destination.target)).catch(() => null);
          if (!parentInfo?.isDirectory()) throw fail(409, 'restore_parent_missing', '原本的資料夾已不存在，請先建立資料夾。');
          if (await stat(destination.target).catch(() => null)) throw fail(409, 'restore_conflict', '原位置已有同名項目，請先重新命名或移動該項目。');
          const storedPath = managedTrashPath(row.share_id, row.id);
          await rejectSymlinkTraversal(dataDir, dataDir, storedPath);
          await rename(storedPath, destination.target);
          db.prepare('DELETE FROM trash_items WHERE id = ?').run(row.id);
          return json(res, 200, { ok: true });
        }
        if (route === '/api/trash' && method === 'DELETE') {
          if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以永久刪除項目。');
          const id = url.searchParams.get('id') || '';
          const row = db.prepare('SELECT * FROM trash_items WHERE id = ?').get(id);
          if (!row) throw fail(404, 'trash_item_not_found', '找不到資源回收桶項目。');
          if (auditEvent) auditEvent.target = row.item_name;
          shareRoot(row.share_id);
          const storedPath = managedTrashPath(row.share_id, row.id);
          await rejectSymlinkTraversal(dataDir, dataDir, storedPath);
          await rm(storedPath, { recursive: true, force: true });
          db.prepare('DELETE FROM trash_items WHERE id = ?').run(id);
          return json(res, 200, { ok: true });
        }
        if (route === '/api/users' && method === 'GET') {
          if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以管理使用者。');
          const users = db.prepare('SELECT id, username, role, created_at AS createdAt, is_active AS isActive FROM users ORDER BY username COLLATE NOCASE').all();
          for (const listedUser of users) {
            listedUser.permissions = allShares.all().map((share) => {
              const grant = getPerm.get(listedUser.id, share.id) || { can_read: 0, can_write: 0 };
              return { shareId: share.id, canRead: Boolean(grant.can_read), canWrite: Boolean(grant.can_write) };
            });
          }
          return json(res, 200, { users });
        }
        if (route === '/api/users' && method === 'POST') {
          if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以管理使用者。');
          const body = await readJson(req);
          const username = validateUsername(body.username);
          if (auditEvent) auditEvent.target = username;
          if (findUser.get(username)) throw fail(409, 'username_taken', '這個帳號已經有人使用。');
          const pass = await passwordHash(body.password);
          const userId = crypto.randomUUID();
          db.prepare('INSERT INTO users(id, username, password_salt, password_hash, role, created_at) VALUES(?,?,?,?,?,?)')
            .run(userId, username, pass.salt, pass.hash, 'user', new Date().toISOString());
          const grants = Array.isArray(body.permissions) ? body.permissions : [];
          const grant = db.prepare('INSERT INTO share_permissions(user_id, share_id, can_read, can_write) VALUES(?,?,?,?)');
          for (const item of grants) {
            if (!item || typeof item.shareId !== 'string' || !findShare.get(item.shareId)) continue;
            const canRead = Boolean(item.canRead);
            const canWrite = canRead && Boolean(item.canWrite);
            grant.run(userId, item.shareId, Number(canRead), Number(canWrite));
          }
          return json(res, 201, { user: getUserById.get(userId) });
        }
        if (route.startsWith('/api/users/') && method === 'PATCH') {
          if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以管理使用者。');
          const targetId = route.slice('/api/users/'.length);
          if (!/^[0-9a-f-]{36}$/iu.test(targetId)) throw fail(404, 'user_not_found', '找不到這個使用者。');
          if (targetId === user.id) throw fail(400, 'cannot_edit_self', '不能透過此畫面停用或修改自己的帳號權限。');
          const targetUser = db.prepare('SELECT id, username, role, is_active FROM users WHERE id = ?').get(targetId);
          if (!targetUser || targetUser.role !== 'user') throw fail(404, 'user_not_found', '找不到可管理的使用者。');
          if (auditEvent) auditEvent.target = targetUser.username;
          const body = await readJson(req);
          if (typeof body.isActive !== 'boolean' || !Array.isArray(body.permissions)) throw fail(400, 'invalid_user_update', '請提供帳號啟用狀態與資料空間權限。');
          const grants = new Map();
          for (const item of body.permissions) {
            if (!item || typeof item.shareId !== 'string' || !findShare.get(item.shareId)) throw fail(400, 'invalid_permission', '資料空間權限設定不正確。');
            const canRead = Boolean(item.canRead);
            grants.set(item.shareId, { canRead, canWrite: canRead && Boolean(item.canWrite) });
          }
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare('DELETE FROM share_permissions WHERE user_id = ?').run(targetId);
            const grantPermission = db.prepare('INSERT INTO share_permissions(user_id, share_id, can_read, can_write) VALUES(?,?,?,?)');
            for (const [shareId, grant] of grants) grantPermission.run(targetId, shareId, Number(grant.canRead), Number(grant.canWrite));
            db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(Number(body.isActive), targetId);
            if (!body.isActive) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
            db.exec('COMMIT');
            if (!body.isActive) await lockVaultKey(targetId);
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
          return json(res, 200, { user: { ...getUserById.get(targetId), permissions: allShares.all().map((share) => {
            const grant = getPerm.get(targetId, share.id) || { can_read: 0, can_write: 0 };
            return { shareId: share.id, canRead: Boolean(grant.can_read), canWrite: Boolean(grant.can_write) };
          }) } });
        }
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
        if (route === '/api/archive/status' && method === 'GET') {
          const job = activeArchiveJobs.get(user.id);
          return json(res, 200, { active: Boolean(job), ...(job ? {
            id: job.id, operation: job.operation, phase: job.phase, bytesRead: job.bytesRead,
            totalBytes: job.totalBytes, entriesDone: job.entriesDone, totalEntries: job.totalEntries,
          } : {}) });
        }
        if (route === '/api/archive/cancel' && method === 'POST') {
          const job = activeArchiveJobs.get(user.id);
          if (!job) return json(res, 200, { active: false });
          if (job.phase === '發佈 ZIP 成品' || job.phase === '發佈解壓內容') throw fail(409, 'archive_too_late_to_cancel', 'ZIP 成品發佈階段已開始，無法安全取消；請等待作業完成。');
          job.controller.abort();
          return json(res, 200, { active: true, cancelling: true });
        }
        if ((route === '/api/archive/create' || route === '/api/archive/extract') && method === 'POST') {
          if (activeArchiveJobs.has(user.id)) throw fail(409, 'archive_job_busy', '此帳號已有 ZIP 作業進行中；請先完成或取消後再試。');
          const body = await readJson(req);
          const shareId = String(body.shareId || '');
          requirePermission(user, shareId, true);
          const { root } = shareRoot(shareId);
          const parts = relativeParts(body.path || '');
          if (!parts.length) throw fail(400, 'invalid_path', '請先選取要處理的檔案或資料夾。');
          const source = resolveShareInside(root, parts.join('/'));
          await rejectSymlinkTraversal(dataDir, root, source.target);
          const sourceInfo = await lstat(source.target).catch(() => null);
          if (!sourceInfo) throw fail(404, 'file_not_found', '找不到要處理的檔案或資料夾。');
          if (route === '/api/archive/create') {
            const archiveName = `${path.parse(source.target).name || path.basename(source.target)}.zip`;
            const archivePath = path.join(path.dirname(source.target), archiveName);
            await rejectSymlinkTraversal(dataDir, root, archivePath, false);
            if (auditEvent) auditEvent.target = parts.join('/');
            const controller = new AbortController();
            const job = { id: crypto.randomUUID(), operation: 'create', phase: '準備 ZIP', bytesRead: 0, totalBytes: 0, entriesDone: 0, totalEntries: 0, controller };
            activeArchiveJobs.set(user.id, job);
            try {
              const result = await createArchive({
                sourcePath: source.target, shareRoot: root, archivePath, signal: controller.signal,
                onProgress: (progress) => Object.assign(job, progress),
              });
              return json(res, 201, { ok: true, name: archiveName, ...result });
            } finally { if (activeArchiveJobs.get(user.id) === job) activeArchiveJobs.delete(user.id); }
          }
          if (sourceInfo.isDirectory() || path.extname(source.target).toLowerCase() !== '.zip') throw fail(400, 'invalid_archive_source', '請選取 ZIP 檔案進行解壓縮。');
          const destinationPath = path.join(path.dirname(source.target), path.basename(source.target, path.extname(source.target)));
          await rejectSymlinkTraversal(dataDir, root, destinationPath, false);
          if (auditEvent) auditEvent.target = parts.join('/');
          const controller = new AbortController();
          const job = { id: crypto.randomUUID(), operation: 'extract', phase: '檢查 ZIP', bytesRead: 0, totalBytes: 0, entriesDone: 0, totalEntries: 0, controller };
          activeArchiveJobs.set(user.id, job);
          try {
            const result = await extractArchive({
              archivePath: source.target, shareRoot: root, destinationPath, signal: controller.signal,
              onProgress: (progress) => Object.assign(job, progress),
            });
            return json(res, 201, { ok: true, name: path.basename(destinationPath), ...result });
          } finally { if (activeArchiveJobs.get(user.id) === job) activeArchiveJobs.delete(user.id); }
        }
        if (route === '/api/network' && method === 'GET') {
          return json(res, 200, { host: '127.0.0.1', port: server.address()?.port, localOnly: true, interfaces: listNetworkInterfaces() });
        }
        if (route === '/api/smb/status' && method === 'GET') {
          if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以查看 SMB 伺服器狀態。');
          const [smb, execution] = await Promise.all([smbStatusProbe(), collectWindowsExecutionState()]);
          return json(res, 200, { ...smb, processElevated: execution.checked ? execution.isElevated : null, nanakoSmbReady: false });
        }
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
      for (const job of duplicateScans.values()) {
        if (['scanning', 'cancelling'].includes(job.status)) job.controller.abort();
      }
      for (const job of activeArchiveJobs.values()) job.controller.abort();
      const closeServer = new Promise((done) => server.close(done));
      const lockPromises = [...unlockedVaultKeys.keys()].map((userId) => lockVaultKey(userId));
      server.closeAllConnections?.();
      void Promise.allSettled([
        ...[...duplicateScans.values()].map((job) => job.promise).filter(Boolean),
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
