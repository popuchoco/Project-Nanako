import { createServer } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, lstat, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(crypto.scrypt);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');
const SESSION_SECONDS = 12 * 60 * 60;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.svg', 'image/svg+xml'],
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
  if (!name || name.length > 180 || name === '.' || name === '..' || /[\\/\0<>:"|?*]/u.test(name)) {
    throw fail(400, 'invalid_name', '名稱不可空白，也不能包含路徑或 Windows 保留字元。');
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

async function rejectSymlinkTraversal(root, target, includeLeaf = true) {
  const rootInfo = await lstat(path.resolve(root)).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (rootInfo?.isSymbolicLink()) throw fail(400, 'symlink_not_allowed', '目前不支援符號連結。');
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw fail(400, 'invalid_path', '路徑超出分享範圍。');
  const parts = relative ? relative.split(path.sep) : [];
  let current = path.resolve(root);
  const count = includeLeaf ? parts.length : Math.max(0, parts.length - 1);
  for (const part of parts.slice(0, count)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw fail(400, 'symlink_not_allowed', '目前不支援符號連結。');
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
      role TEXT NOT NULL CHECK(role IN ('admin','user')), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
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
  `);
  return db;
}

export async function startServer({ dataDir, host = '127.0.0.1', port = 8765 } = {}) {
  if (!dataDir) dataDir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'LocalNAS', 'data');
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error('此原型僅允許本機連線；區域網路連線尚未開放。');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('連接埠必須介於 0 至 65535。');
  await mkdir(dataDir, { recursive: true });
  await mkdir(path.join(dataDir, 'files'), { recursive: true });
  await mkdir(path.join(dataDir, 'trash'), { recursive: true });
  const db = initDatabase(dataDir);

  const findUser = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE');
  const getUserById = db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?');
  const findShare = db.prepare('SELECT * FROM shares WHERE id = ?');
  const getPerm = db.prepare(`SELECT can_read, can_write FROM share_permissions WHERE user_id = ? AND share_id = ?`);
  const allShares = db.prepare('SELECT id, name, created_at FROM shares ORDER BY name COLLATE NOCASE');

  function shareRoot(shareId) {
    if (!/^[0-9a-f-]{36}$/iu.test(shareId || '')) throw fail(400, 'invalid_share', '分享資料夾不正確。');
    const share = findShare.get(shareId);
    if (!share) throw fail(404, 'share_not_found', '找不到分享資料夾。');
    return { share, root: path.join(dataDir, 'files', share.id) };
  }

  function permission(user, shareId) {
    if (user.role === 'admin') return { can_read: 1, can_write: 1 };
    return getPerm.get(user.id, shareId) || { can_read: 0, can_write: 0 };
  }

  function requirePermission(user, shareId, write = false) {
    const perm = permission(user, shareId);
    if (!perm.can_read || (write && !perm.can_write)) throw fail(403, 'permission_denied', '你沒有這項操作的權限。');
  }

  async function currentUser(req) {
    const token = cookieValue(req, 'localnas_session');
    if (!token || token.length > 200) return null;
    const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(hashToken(token));
    if (!row || row.expires_at < Date.now()) return null;
    return getUserById.get(row.user_id) || null;
  }

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
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
          const pass = await passwordHash(body.password);
          const userId = crypto.randomUUID();
          const shareId = crypto.randomUUID();
          const now = new Date().toISOString();
          db.prepare('INSERT INTO users(id, username, password_salt, password_hash, role, created_at) VALUES(?,?,?,?,?,?)')
            .run(userId, username, pass.salt, pass.hash, 'admin', now);
          db.prepare('INSERT INTO shares(id, name, created_at) VALUES(?,?,?)').run(shareId, '主資料夾', now);
          db.prepare('INSERT INTO share_permissions(user_id, share_id, can_read, can_write) VALUES(?,?,1,1)').run(userId, shareId);
          await mkdir(path.join(dataDir, 'files', shareId), { recursive: true });
          const token = crypto.randomBytes(32).toString('base64url');
          db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)').run(hashToken(token), userId, Date.now() + SESSION_SECONDS * 1000);
          return json(res, 201, { user: getUserById.get(userId) }, { 'Set-Cookie': `localnas_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}` });
        }
        if (route === '/api/login' && method === 'POST') {
          const body = await readJson(req);
          const user = findUser.get(String(body.username || ''));
          const valid = user && await verifyPassword(String(body.password || ''), user.password_salt, user.password_hash);
          if (!valid) throw fail(401, 'invalid_login', '帳號或密碼不正確。');
          const token = crypto.randomBytes(32).toString('base64url');
          db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)').run(hashToken(token), user.id, Date.now() + SESSION_SECONDS * 1000);
          return json(res, 200, { user: getUserById.get(user.id) }, { 'Set-Cookie': `localnas_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}` });
        }
        if (route === '/api/logout' && method === 'POST') {
          const token = cookieValue(req, 'localnas_session');
          if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
          return json(res, 200, { ok: true }, { 'Set-Cookie': 'localnas_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
        }

        const user = await currentUser(req);
        if (!user) throw fail(401, 'authentication_required', '請先登入。');

        if (route === '/api/me' && method === 'GET') return json(res, 200, { user });
        if (route === '/api/shares' && method === 'GET') {
          const shares = allShares.all().filter((share) => permission(user, share.id).can_read).map((share) => ({ ...share, canWrite: Boolean(permission(user, share.id).can_write) }));
          return json(res, 200, { shares });
        }
        if (route === '/api/files' && method === 'GET') {
          const shareId = url.searchParams.get('shareId') || '';
          requirePermission(user, shareId);
          const { root } = shareRoot(shareId);
          const { target } = resolveInside(root, url.searchParams.get('path') || '');
          await rejectSymlinkTraversal(root, target);
          const info = await stat(target).catch(() => null);
          if (!info?.isDirectory()) throw fail(404, 'folder_not_found', '找不到資料夾。');
          const entries = await readdir(target, { withFileTypes: true });
          const items = [];
          for (const entry of entries) {
            if (entry.name.startsWith('.localnas-')) continue;
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
          const shareId = String(body.shareId || '');
          requirePermission(user, shareId, true);
          const { root } = shareRoot(shareId);
          const parent = resolveInside(root, body.path || '');
          await rejectSymlinkTraversal(root, parent.target);
          if (!(await stat(parent.target).catch(() => null))?.isDirectory()) throw fail(404, 'folder_not_found', '找不到上層資料夾。');
          const name = safeName(body.name);
          const target = path.join(parent.target, name);
          await mkdir(target).catch((error) => { if (error.code === 'EEXIST') throw fail(409, 'already_exists', '同名項目已存在。'); throw error; });
          return json(res, 201, { ok: true });
        }
        if (route === '/api/upload' && method === 'POST') {
          const shareId = url.searchParams.get('shareId') || '';
          requirePermission(user, shareId, true);
          const { root } = shareRoot(shareId);
          const parent = resolveInside(root, url.searchParams.get('path') || '');
          const name = safeName(url.searchParams.get('name') || '');
          await rejectSymlinkTraversal(root, parent.target);
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
            await rename(tempPath, target);
          } catch (error) {
            await rm(tempPath, { force: true }).catch(() => {});
            throw error;
          }
          return json(res, 201, { ok: true, size });
        }
        if (route === '/api/download' && method === 'GET') {
          const shareId = url.searchParams.get('shareId') || '';
          requirePermission(user, shareId);
          const { root } = shareRoot(shareId);
          const { target, parts } = resolveInside(root, url.searchParams.get('path') || '');
          await rejectSymlinkTraversal(root, target);
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
          const { target, parts } = resolveInside(root, url.searchParams.get('path') || '');
          if (!parts.length) throw fail(400, 'cannot_delete_root', '不能刪除分享資料夾本身。');
          await rejectSymlinkTraversal(root, target);
          const info = await lstat(target).catch(() => null);
          if (!info || info.isSymbolicLink()) throw fail(404, 'file_not_found', '找不到項目。');
          const id = crypto.randomUUID();
          const storedPath = path.join(dataDir, 'trash', share.id, id);
          await mkdir(path.dirname(storedPath), { recursive: true });
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
          const rows = db.prepare(`SELECT id, item_name AS name, is_directory AS isDirectory, deleted_at AS deletedAt FROM trash_items WHERE share_id = ? ORDER BY deleted_at DESC`).all(shareId);
          return json(res, 200, { items: rows.map((row) => ({ ...row, isDirectory: Boolean(row.isDirectory) })) });
        }
        if (route === '/api/trash/restore' && method === 'POST') {
          const body = await readJson(req);
          const row = db.prepare('SELECT * FROM trash_items WHERE id = ?').get(String(body.id || ''));
          if (!row) throw fail(404, 'trash_item_not_found', '找不到資源回收桶項目。');
          requirePermission(user, row.share_id, true);
          const { root } = shareRoot(row.share_id);
          const destination = resolveInside(root, row.original_path);
          await rejectSymlinkTraversal(root, destination.target, false);
          const parentInfo = await stat(path.dirname(destination.target)).catch(() => null);
          if (!parentInfo?.isDirectory()) throw fail(409, 'restore_parent_missing', '原本的資料夾已不存在，請先建立資料夾。');
          if (await stat(destination.target).catch(() => null)) throw fail(409, 'restore_conflict', '原位置已有同名項目，請先重新命名或移動該項目。');
          await rename(row.stored_path, destination.target);
          db.prepare('DELETE FROM trash_items WHERE id = ?').run(row.id);
          return json(res, 200, { ok: true });
        }
        if (route === '/api/trash' && method === 'DELETE') {
          if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以永久刪除項目。');
          const id = url.searchParams.get('id') || '';
          const row = db.prepare('SELECT * FROM trash_items WHERE id = ?').get(id);
          if (!row) throw fail(404, 'trash_item_not_found', '找不到資源回收桶項目。');
          await rm(row.stored_path, { recursive: true, force: true });
          db.prepare('DELETE FROM trash_items WHERE id = ?').run(id);
          return json(res, 200, { ok: true });
        }
        if (route === '/api/users' && method === 'GET') {
          if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以管理使用者。');
          const users = db.prepare('SELECT id, username, role, created_at AS createdAt FROM users ORDER BY username COLLATE NOCASE').all();
          return json(res, 200, { users });
        }
        if (route === '/api/users' && method === 'POST') {
          if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以管理使用者。');
          const body = await readJson(req);
          const username = validateUsername(body.username);
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
        if (route === '/api/network' && method === 'GET') {
          return json(res, 200, { host: '127.0.0.1', port: server.address()?.port, localOnly: true, interfaces: Object.entries(os.networkInterfaces()).flatMap(([name, addresses]) => (addresses || []).filter((item) => !item.internal).map((item) => ({ name, address: item.address, family: item.family }))) });
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

  let closed = false;
  return {
    host,
    port: server.address().port,
    dataDir,
    close: () => new Promise((resolve, reject) => {
      if (closed) return resolve();
      closed = true;
      server.close((error) => {
        db.close();
        if (error) return reject(error);
        resolve();
      });
    }),
  };
}
