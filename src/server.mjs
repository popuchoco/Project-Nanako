import { createServer } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, lstat, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createArchive, extractArchive } from './archives.mjs';
import { readWindowsSmbStatus } from './windows-smb-status.mjs';
import { isShareOperationAllowed } from './share-access.mjs';

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

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.svg', 'image/svg+xml'],
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
    CREATE INDEX IF NOT EXISTS operation_logs_occurred_at_idx ON operation_logs(occurred_at DESC);
  `);
  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
  if (!userColumns.has('is_active')) db.exec('ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
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
  for (const filename of ['metadata.sqlite', 'metadata.sqlite-wal', 'metadata.sqlite-shm']) {
    const info = await lstat(path.join(dataDir, filename)).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink() || info?.isDirectory()) throw new Error('Nanako 資料庫檔案不可使用符號連結、重新解析點或資料夾。');
  }
  const db = initDatabase(dataDir);
  const loginFailures = new Map();
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
    if (method === 'GET' && route === '/api/preview') return { action: '開啟媒體預覽', target: target(url.searchParams.get('path')) };
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

  async function currentUser(req) {
    const token = cookieValue(req, 'localnas_session');
    if (!token || token.length > 200) return null;
    const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(hashToken(token));
    if (!row || row.expires_at < Date.now()) return null;
    const user = getUserById.get(row.user_id) || null;
    return user?.isActive ? user : null;
  }

  const server = createServer(async (req, res) => {
    let auditEvent = null;
    let auditLogged = false;
    const setAudit = (actor, action, target) => {
      auditEvent = { actorId: actor?.id || null, actorName: String(actor?.username || '未知使用者').replace(/[\r\n\0]/gu, ' ').slice(0, 80), action: String(action).replace(/[\r\n\0]/gu, ' ').slice(0, 80), target: String(target || '').replace(/[\r\n\0]/gu, ' ').slice(0, 512) };
    };
    res.once('finish', () => {
      if (!auditEvent || auditLogged) return;
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
      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const method = req.method || 'GET';
      const route = url.pathname;
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
      if (mutating && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
        throw fail(403, 'origin_denied', '來源不符。');
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
          db.prepare('INSERT INTO users(id, username, password_salt, password_hash, role, created_at) VALUES(?,?,?,?,?,?)')
            .run(userId, username, pass.salt, pass.hash, 'admin', now);
          db.prepare('INSERT INTO shares(id, name, created_at) VALUES(?,?,?)').run(shareId, '主資料夾', now);
          db.prepare('INSERT INTO share_permissions(user_id, share_id, can_read, can_write) VALUES(?,?,1,1)').run(userId, shareId);
          const newShareRoot = path.join(dataDir, 'files', shareId);
          await rejectSymlinkTraversal(dataDir, dataDir, newShareRoot, false);
          await mkdir(newShareRoot);
          await rejectSymlinkTraversal(dataDir, dataDir, newShareRoot);
          const token = crypto.randomBytes(32).toString('base64url');
          db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)').run(hashToken(token), userId, Date.now() + SESSION_SECONDS * 1000);
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
          if (signedOutUser) setAudit(signedOutUser, '登出', signedOutUser.username);
          if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
          return json(res, 200, { ok: true }, { 'Set-Cookie': 'localnas_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
        }

        const user = await currentUser(req);
        if (!user) throw fail(401, 'authentication_required', '請先登入。');
        const inferredAudit = auditForRequest(user, method, route, url);
        if (inferredAudit) setAudit(user, inferredAudit.action, inferredAudit.target);

        if (route === '/api/activity' && method === 'POST') {
          const body = await readJson(req);
          const views = {
            files: '檔案管理', album: '相簿', player: '播放器', trash: '資源回收桶',
            users: '使用者與權限', computer: '我的電腦', system: '電腦資訊', settings: '系統設定與紀錄', network: '網路狀態',
          };
          if (!views[body.view] || (['users', 'system', 'settings'].includes(body.view) && user.role !== 'admin')) throw fail(400, 'invalid_activity', '操作紀錄類型不正確。');
          setAudit(user, '開啟畫面', views[body.view]);
          return json(res, 200, { ok: true });
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
        if ((route === '/api/archive/create' || route === '/api/archive/extract') && method === 'POST') {
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
            const result = await createArchive({ sourcePath: source.target, shareRoot: root, archivePath });
            return json(res, 201, { ok: true, name: archiveName, ...result });
          }
          if (sourceInfo.isDirectory() || path.extname(source.target).toLowerCase() !== '.zip') throw fail(400, 'invalid_archive_source', '請選取 ZIP 檔案進行解壓縮。');
          const destinationPath = path.join(path.dirname(source.target), path.basename(source.target, path.extname(source.target)));
          await rejectSymlinkTraversal(dataDir, root, destinationPath, false);
          if (auditEvent) auditEvent.target = parts.join('/');
          const result = await extractArchive({ archivePath: source.target, shareRoot: root, destinationPath });
          return json(res, 201, { ok: true, name: path.basename(destinationPath), ...result });
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

  const auditPurgeTimer = setInterval(purgeExpiredAuditLogs, 60 * 60 * 1000);
  auditPurgeTimer.unref();

  let closed = false;
  return {
    host,
    port: server.address().port,
    dataDir,
    close: () => new Promise((resolve, reject) => {
      if (closed) return resolve();
      closed = true;
      clearInterval(auditPurgeTimer);
      server.close((error) => {
        db.close();
        if (error) return reject(error);
        resolve();
      });
    }),
  };
}
