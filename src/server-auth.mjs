import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { fail, json, readJson } from './http-utils.mjs';
import { rejectSymlinkTraversal } from './path-guards.mjs';
import { clearThrottle, getThrottle, recordFailure } from './throttle-store.mjs';

const scrypt = promisify(crypto.scrypt);
export const SESSION_SECONDS = 12 * 60 * 60;

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function cookieValue(req, name) {
  const raw = req.headers.cookie || '';
  for (const pair of raw.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    if (pair.slice(0, index).trim() === name) return decodeURIComponent(pair.slice(index + 1).trim());
  }
  return '';
}

export function validateUsername(value) {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}._-]{3,32}$/u.test(value)) {
    throw fail(400, 'invalid_username', '帳號請使用 3 至 32 個中文字、英文字母、數字、句點、底線或連字號。');
  }
  return value;
}

export async function passwordHash(password, salt = crypto.randomBytes(16)) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    throw fail(400, 'weak_password', '密碼長度須為 12 至 256 個字元。');
  }
  const derived = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt: salt.toString('hex'), hash: Buffer.from(derived).toString('hex') };
}

export async function verifyPassword(password, saltHex, expectedHex) {
  const salt = Buffer.from(saltHex, 'hex');
  const actual = Buffer.from(await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }));
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function createAuthRouter(ctx) {
  const {
    db, dataDir, now = () => Date.now(), dummyPassword, lockVaultKey,
    findUser, getUserById, findShare, getPerm, allShares,
  } = ctx;

  async function currentUser(req) {
    const token = cookieValue(req, 'localnas_session');
    if (!token || token.length > 200) return null;
    const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(hashToken(token));
    if (!row) return null;
    if (row.expires_at < now()) { await lockVaultKey(row.user_id); return null; }
    const user = getUserById.get(row.user_id) || null;
    return user?.isActive ? user : null;
  }

  async function handleBeforeAuthentication({ req, res, method, route, setAudit }) {
    if (route === '/api/setup-state' && method === 'GET') {
      json(res, 200, { needsSetup: Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n) === 0 });
      return true;
    }
    if (route === '/api/setup' && method === 'POST') {
      if (Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n) !== 0) throw fail(409, 'already_setup', '已完成初始設定。');
      const body = await readJson(req);
      const username = validateUsername(body.username);
      setAudit({ username }, '建立本機管理員', username);
      const pass = await passwordHash(body.password);
      const userId = crypto.randomUUID();
      const shareId = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const token = crypto.randomBytes(32).toString('base64url');
      db.exec('BEGIN IMMEDIATE');
      try {
        if (Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n) !== 0) {
          throw fail(409, 'already_setup', '已完成初始設定。');
        }
        db.prepare('INSERT INTO users(id, username, password_salt, password_hash, role, created_at) VALUES(?,?,?,?,?,?)')
          .run(userId, username, pass.salt, pass.hash, 'admin', createdAt);
        db.prepare('INSERT INTO shares(id, name, created_at) VALUES(?,?,?)').run(shareId, '主資料夾', createdAt);
        db.prepare('INSERT INTO share_permissions(user_id, share_id, can_read, can_write) VALUES(?,?,1,1)').run(userId, shareId);
        db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)').run(hashToken(token), userId, now() + SESSION_SECONDS * 1000);
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* transaction may not have begun */ }
        throw error;
      }
      const newShareRoot = path.join(dataDir, 'files', shareId);
      await rejectSymlinkTraversal(dataDir, dataDir, newShareRoot, false);
      await mkdir(newShareRoot);
      await rejectSymlinkTraversal(dataDir, dataDir, newShareRoot);
      json(res, 201, { user: getUserById.get(userId) }, { 'Set-Cookie': `localnas_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}` });
      return true;
    }
    if (route === '/api/login' && method === 'POST') {
      const body = await readJson(req);
      const attemptedUsername = String(body.username || '').slice(0, 80);
      setAudit({ username: attemptedUsername || '未知使用者' }, '登入', attemptedUsername);
      const accountKey = attemptedUsername.trim().toLocaleLowerCase('en-US');
      const sourceKey = req.socket.remoteAddress || 'local';
      const throttleKey = `${sourceKey}\0${accountKey}`;
      const timestamp = now();
      const attempt = getThrottle(db, 'login', throttleKey, timestamp);
      if (attempt?.lockedUntil > timestamp) throw fail(429, 'login_throttled', '登入嘗試次數過多，請 15 分鐘後再試。');
      const user = findUser.get(String(body.username || ''));
      const password = String(body.password || '');
      const validPassword = password.length <= 256
        && await verifyPassword(password, user?.password_salt || dummyPassword.salt, user?.password_hash || dummyPassword.hash);
      if (!user || !user.is_active || !validPassword) {
        recordFailure(db, 'login', throttleKey, timestamp);
        throw fail(401, 'invalid_login', '帳號或密碼不正確。');
      }
      clearThrottle(db, 'login', throttleKey);
      setAudit(user, '登入', user.username);
      const token = crypto.randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)').run(hashToken(token), user.id, now() + SESSION_SECONDS * 1000);
      json(res, 200, { user: getUserById.get(user.id) }, { 'Set-Cookie': `localnas_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}` });
      return true;
    }
    if (route === '/api/logout' && method === 'POST') {
      const token = cookieValue(req, 'localnas_session');
      const session = token ? db.prepare('SELECT user_id FROM sessions WHERE token_hash = ?').get(hashToken(token)) : null;
      const signedOutUser = session ? getUserById.get(session.user_id) : null;
      if (signedOutUser) { setAudit(signedOutUser, '登出', signedOutUser.username); await lockVaultKey(signedOutUser.id); }
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
      json(res, 200, { ok: true }, { 'Set-Cookie': 'localnas_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      return true;
    }
    return false;
  }

  async function handleAccountRoute({ req, res, method, route, user }) {
    if (route === '/api/me' && method === 'GET') {
      json(res, 200, { user });
      return true;
    }
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
      db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?,?,?)').run(hashToken(token), user.id, now() + SESSION_SECONDS * 1000);
      json(res, 200, { ok: true }, { 'Set-Cookie': `localnas_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}` });
      return true;
    }
    return false;
  }

  async function handleUsersRoute({ req, res, method, route, user, setAuditTarget }) {
    if (route === '/api/users' && method === 'GET') {
      if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以管理使用者。');
      const users = db.prepare('SELECT id, username, role, created_at AS createdAt, is_active AS isActive FROM users ORDER BY username COLLATE NOCASE').all();
      for (const listedUser of users) {
        listedUser.permissions = allShares.all().map((share) => {
          const grant = getPerm.get(listedUser.id, share.id) || { can_read: 0, can_write: 0 };
          return { shareId: share.id, canRead: Boolean(grant.can_read), canWrite: Boolean(grant.can_write) };
        });
      }
      json(res, 200, { users });
      return true;
    }
    if (route === '/api/users' && method === 'POST') {
      if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以管理使用者。');
      const body = await readJson(req);
      const username = validateUsername(body.username);
      setAuditTarget(username);
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
      json(res, 201, { user: getUserById.get(userId) });
      return true;
    }
    if (route.startsWith('/api/users/') && method === 'PATCH') {
      if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以管理使用者。');
      const targetId = route.slice('/api/users/'.length);
      if (!/^[0-9a-f-]{36}$/iu.test(targetId)) throw fail(404, 'user_not_found', '找不到這個使用者。');
      if (targetId === user.id) throw fail(400, 'cannot_edit_self', '不能透過此畫面停用或修改自己的帳號權限。');
      const targetUser = db.prepare('SELECT id, username, role, is_active FROM users WHERE id = ?').get(targetId);
      if (!targetUser || targetUser.role !== 'user') throw fail(404, 'user_not_found', '找不到可管理的使用者。');
      setAuditTarget(targetUser.username);
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
      json(res, 200, { user: { ...getUserById.get(targetId), permissions: allShares.all().map((share) => {
        const grant = getPerm.get(targetId, share.id) || { can_read: 0, can_write: 0 };
        return { shareId: share.id, canRead: Boolean(grant.can_read), canWrite: Boolean(grant.can_write) };
      }) } });
      return true;
    }
    return false;
  }

  return { currentUser, handleBeforeAuthentication, handleAccountRoute, handleUsersRoute };
}
