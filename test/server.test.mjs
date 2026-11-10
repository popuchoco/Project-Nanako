import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import { startServer } from '../src/server.mjs';
import { isWindows11_24H2OrLater, readWindowsSmbStatus } from '../src/windows-smb-status.mjs';

const execFileAsync = promisify(execFile);

async function setupServer(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'localnas-test-'));
  const serverOptions = { dataDir, host: '127.0.0.1', port: 0, ...options };
  let server = await startServer(serverOptions);
  let base = `http://127.0.0.1:${server.port}`;
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  async function request(url, options = {}) {
    const { omitOrigin = false, ...fetchOptions } = options;
    const method = String(fetchOptions.method || 'GET').toUpperCase();
    const headers = new Headers(fetchOptions.headers || {});
    if (!omitOrigin && !['GET', 'HEAD', 'OPTIONS'].includes(method) && !headers.has('origin')) headers.set('Origin', base);
    const response = await fetch(`${base}${url}`, { ...fetchOptions, headers, redirect: 'manual' });
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();
    return { response, body };
  }
  async function setup(displayName) {
    const setupPayload = { username: 'admin', password: 'local-test-passphrase-2026' };
    if (displayName !== undefined) setupPayload.displayName = displayName;
    const { response, body } = await request('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(setupPayload) });
    assert.equal(response.status, 201);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const shares = await request('/api/shares', { headers: { Cookie: cookie } });
    return { cookie, shareId: shares.body.shares[0].id, user: body.user };
  }
  async function restart() {
    await server.close();
    server = await startServer(serverOptions);
    base = `http://127.0.0.1:${server.port}`;
    return server;
  }
  return { get base() { return base; }, dataDir, get server() { return server; }, request, restart, setup };
}

function requestRaw(port, pathname, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname: '127.0.0.1', port, path: pathname, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf8');
        resolve({
          response: { status: response.statusCode, headers: response.headers },
          body: (response.headers['content-type'] || '').includes('application/json') ? JSON.parse(responseBody) : responseBody,
        });
      });
    });
    outgoing.once('error', reject);
    outgoing.end(body);
  });
}

test('renderer ES modules are served with a JavaScript MIME type', async (t) => {
  const { request } = await setupServer(t);
  const moduleFile = await request('/file-listing.mjs');
  assert.equal(moduleFile.response.status, 200);
  assert.match(moduleFile.response.headers.get('content-type'), /^text\/javascript\b/u);
  assert.match(moduleFile.body, /filterAndSortFiles/u);
  const clientMode = await request('/client-mode.mjs');
  assert.equal(clientMode.response.status, 200);
  assert.match(clientMode.response.headers.get('content-type'), /^text\/javascript\b/u);
  assert.match(clientMode.body, /isLanMobileClient/u);
});

test('requests require a loopback peer, bound Host, and allowed Origin for mutations', async (t) => {
  const { server, request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const port = server.port;
  const authHeaders = { Cookie: cookie, 'Content-Type': 'application/json' };

  for (const [index, origin] of [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ].entries()) {
    const allowed = await request('/api/folders', {
      method: 'POST',
      headers: { ...authHeaders, Origin: origin },
      body: JSON.stringify({ shareId, path: '', name: `allowed-origin-${index}` }),
    });
    assert.equal(allowed.response.status, 201, `${origin} should be allowed`);
  }

  for (const [index, hostHeader] of [`localhost:${port}`, `[::1]:${port}`].entries()) {
    const allowedHost = await requestRaw(port, '/api/folders', {
      method: 'POST',
      headers: {
        ...authHeaders,
        Host: hostHeader,
        Origin: `http://${hostHeader}`,
      },
      body: JSON.stringify({ shareId, path: '', name: `allowed-host-${index}` }),
    });
    assert.equal(allowedHost.response.status, 201, `${hostHeader} should be allowed`);
  }

  const missingOrigin = await request('/api/folders', {
    method: 'POST',
    headers: authHeaders,
    omitOrigin: true,
    body: JSON.stringify({ shareId, path: '', name: 'missing-origin' }),
  });
  assert.equal(missingOrigin.response.status, 403);
  assert.equal(missingOrigin.body.error, 'origin_denied');

  const emptyOrigin = await request('/api/folders', {
    method: 'POST',
    headers: { ...authHeaders, Origin: '' },
    body: JSON.stringify({ shareId, path: '', name: 'empty-origin' }),
  });
  assert.equal(emptyOrigin.response.status, 403);
  assert.equal(emptyOrigin.body.error, 'origin_denied');

  for (const origin of [
    `http://127.0.0.1:${port + 1}`,
    `http://evil.example:${port}`,
  ]) {
    const rejected = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ username: 'admin', password: 'local-test-passphrase-2026' }),
    });
    assert.equal(rejected.response.status, 403, `${origin} should be rejected`);
    assert.equal(rejected.body.error, 'origin_denied');
  }

  const spoofedHost = await requestRaw(port, '/api/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Host: 'evil.com',
      Origin: 'http://evil.com',
    },
    body: JSON.stringify({ username: 'admin', password: 'local-test-passphrase-2026' }),
  });
  assert.equal(spoofedHost.response.status, 403);
  assert.equal(spoofedHost.body.error, 'host_denied');

  const foreignOriginGet = await request('/api/setup-state', {
    headers: { Origin: `http://evil.example:${port}` },
  });
  assert.equal(foreignOriginGet.response.status, 200);
  const invalidHostAlone = await requestRaw(port, '/api/setup-state', {
    headers: { Host: 'evil.com' },
  });
  assert.equal(invalidHostAlone.response.status, 403);
  assert.equal(invalidHostAlone.body.error, 'host_denied');

  // This helper binds to 127.0.0.1, so a non-loopback remoteAddress cannot be injected reliably without a socket hack.
});

test('display names are separate from login accounts and can be updated by each user', async (t) => {
  const { request, setup } = await setupServer(t);
  const { cookie, user: initialAdmin } = await setup('初始管理員');
  assert.equal(initialAdmin.displayName, '初始管理員');
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  const updated = await request('/api/me', {
    method: 'PATCH', headers: auth, body: JSON.stringify({ displayName: '  小夏 🌸  ' }),
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.user.displayName, '小夏 🌸');
  assert.equal(updated.body.user.username, 'admin');

  const current = await request('/api/me', { headers: { Cookie: cookie } });
  assert.equal(current.body.user.displayName, '小夏 🌸');
  assert.equal(current.body.user.username, 'admin');

  const tooLong = await request('/api/me', {
    method: 'PATCH', headers: auth, body: JSON.stringify({ displayName: '名'.repeat(41) }),
  });
  assert.equal(tooLong.response.status, 400);
  assert.equal(tooLong.body.error, 'invalid_display_name');

  const created = await request('/api/users', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ username: 'family-member', displayName: '家人', password: 'family-member-passphrase-2026', permissions: [] }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.user.username, 'family-member');
  assert.equal(created.body.user.displayName, '家人');
  const listed = await request('/api/users', { headers: { Cookie: cookie } });
  assert.equal(listed.body.users.find((item) => item.username === 'family-member').displayName, '家人');
});

test('network diagnostics probe the outside only on request and return local-only details', async (t) => {
  let probes = 0;
  const { request, setup } = await setupServer(t, {
    externalNetworkProbe: async () => { probes += 1; return { status: 'connected', latencyMs: 12, endpoint: 'test.invalid', httpStatus: 200 }; },
  });
  const { cookie } = await setup();
  const initial = await request('/api/network', { headers: { Cookie: cookie } });
  assert.equal(initial.body.localOnly, true);
  assert.equal(probes, 0, 'opening network information must not contact the external test endpoint');
  const checked = await request('/api/network/test', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(checked.response.status, 200);
  assert.equal(checked.body.internal.localOnly, true);
  assert.equal(checked.body.internal.host, '127.0.0.1');
  assert.equal(checked.body.external.status, 'connected');
  assert.equal(checked.body.external.latencyMs, 12);
  assert.equal(probes, 1);
});

test('task endpoint reports concurrent uploads and recent transfer rates for the signed-in user', async (t) => {
  const { request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(64 * 1024));
      setTimeout(() => { controller.enqueue(new Uint8Array(64 * 1024)); controller.close(); }, 350);
    },
  });
  const uploadPromise = request(`/api/upload?${new URLSearchParams({ shareId, path: '', name: 'task-monitor.bin' })}`, {
    method: 'POST', headers: { Cookie: cookie }, body: stream, duplex: 'half',
  });
  let active;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    active = await request('/api/tasks', { headers: { Cookie: cookie } });
    if (active.body.counts?.upload === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(active.body.counts.upload, 1);
  assert.equal(active.body.counts.total, 1);
  assert.equal(active.body.transfers[0].name, 'task-monitor.bin');
  assert.ok(active.body.transfers[0].bytesTransferred > 0);
  await uploadPromise;
  const idle = await request('/api/tasks', { headers: { Cookie: cookie } });
  assert.deepEqual(idle.body.counts, { upload: 0, download: 0, total: 0 });
});

test('concurrent initial setup creates exactly one admin', async (t) => {
  const { base, dataDir, request } = await setupServer(t);
  const attempts = await Promise.all(['admin-one', 'admin-two'].map((username) => request('/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username, password: 'local-test-passphrase-2026' }),
  })));
  const statuses = attempts.map(({ response }) => response.status).sort((a, b) => a - b);
  assert.deepEqual(statuses, [201, 409]);
  assert.equal(attempts.find(({ response }) => response.status === 409).body.error, 'already_setup');

  const db = new DatabaseSync(path.join(dataDir, 'metadata.sqlite'), { readOnly: true });
  try {
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n), 1);
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n), 1);
  } finally {
    db.close();
  }
});

test('setup, login, file transfer, recycle bin and restore work locally', async (t) => {
  const { request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const auth = { Cookie: cookie };
  const folder = await request('/api/folders', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ shareId, path: '', name: '測試資料夾' }) });
  assert.equal(folder.response.status, 201);
  const reservedName = await request('/api/folders', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ shareId, path: '', name: 'CON.txt' }) });
  assert.equal(reservedName.response.status, 400);
  assert.equal(reservedName.body.error, 'invalid_name');
  const uploadQuery = new URLSearchParams({ shareId, path: '測試資料夾', name: '測試.txt' });
  const upload = await request(`/api/upload?${uploadQuery}`, { method: 'POST', headers: auth, body: Buffer.from('本機測試內容') });
  assert.equal(upload.response.status, 201);
  const downloadQuery = new URLSearchParams({ shareId, path: '測試資料夾/測試.txt' });
  const download = await request(`/api/download?${downloadQuery}`, { headers: auth });
  assert.equal(download.response.status, 200);
  assert.equal(download.body, '本機測試內容');

  const deletion = await request(`/api/files?${downloadQuery}`, { method: 'DELETE', headers: auth });
  assert.equal(deletion.response.status, 200);
  const trash = await request(`/api/trash?shareId=${shareId}`, { headers: auth });
  assert.equal(trash.body.items.length, 1);
  const restore = await request('/api/trash/restore', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: trash.body.items[0].id }) });
  assert.equal(restore.response.status, 200);
  const restored = await request(`/api/download?${downloadQuery}`, { headers: auth });
  assert.equal(restored.body, '本機測試內容');
});

test('vault imports only Nanako files, stores opaque ciphertext and serves authenticated byte ranges', async (t) => {
  const { base, dataDir, request, setup } = await setupServer(t);
  const { cookie, shareId, user } = await setup();
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  const sourceBytes = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251));
  const upload = await request(`/api/upload?${new URLSearchParams({ shareId, path: '', name: 'vault-check.png' })}`, {
    method: 'POST', headers: { Cookie: cookie }, body: sourceBytes,
  });
  assert.equal(upload.response.status, 201);
  const setupVault = await request('/api/vault/setup', {
    method: 'POST', headers: auth, body: JSON.stringify({ password: 'vault-test-password-2026' }),
  });
  assert.equal(setupVault.response.status, 201);

  const outside = await request('/api/vault/objects/import', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ shareId, path: '../outside.png' }),
  });
  assert.equal(outside.response.status, 400);
  const imported = await request('/api/vault/objects/import', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ shareId, path: 'vault-check.png' }),
  });
  assert.equal(imported.response.status, 201, imported.body.message);
  const { id, name, size } = imported.body.item;
  assert.equal(name, 'vault-check.png');
  assert.equal(size, sourceBytes.length);
  assert.equal(imported.body.item.mediaType, 'image/png');
  assert.equal(imported.body.item.sourceRemovalPending, false);

  const sourcePath = path.join(dataDir, 'files', shareId, 'vault-check.png');
  await assert.rejects(readFile(sourcePath), { code: 'ENOENT' });
  const encryptedPath = path.join(dataDir, '.nanako-vault', user.id, `${id}.nkv`);
  const sidecarPath = path.join(dataDir, '.nanako-vault', user.id, `${id}.nkm`);
  const ciphertext = await readFile(encryptedPath);
  const sidecar = await readFile(sidecarPath, 'utf8');
  assert.equal(sidecar.includes('vault-check.png'), false);
  assert.equal(ciphertext.includes(sourceBytes), false);
  assert.equal(ciphertext.subarray(0, 8).toString('ascii'), 'NKVLT01\0');
  const indexDb = new DatabaseSync(path.join(dataDir, 'metadata.sqlite'), { readOnly: true });
  try {
    const index = indexDb.prepare('SELECT metadata_json FROM vault_objects WHERE id = ?').get(id);
    assert.equal(index.metadata_json.includes('vault-check.png'), false);
    assert.equal(index.metadata_json.includes('vault-test-password-2026'), false);
  } finally { indexDb.close(); }

  const list = await request('/api/vault/objects', { headers: { Cookie: cookie } });
  assert.equal(list.response.status, 200);
  assert.equal(list.body.items[0].name, 'vault-check.png');
  const contentUrl = `/api/vault/objects/${id}/content`;
  const fullResponse = await fetch(`${base}${contentUrl}`, { headers: { Cookie: cookie } });
  assert.equal(fullResponse.status, 200);
  assert.deepEqual(Buffer.from(await fullResponse.arrayBuffer()), sourceBytes);
  const rangeResponse = await fetch(`${base}${contentUrl}`, { headers: { Cookie: cookie, Range: 'bytes=300-599' } });
  assert.equal(rangeResponse.status, 206);
  const rangeBytes = Buffer.from(await rangeResponse.arrayBuffer());
  assert.equal(rangeResponse.headers.get('content-range'), `bytes 300-599/${sourceBytes.length}`);
  assert.deepEqual(rangeBytes, sourceBytes.subarray(300, 600));
  const concurrentRanges = await Promise.all([
    fetch(`${base}${contentUrl}`, { headers: { Cookie: cookie, Range: 'bytes=0-255' } }),
    fetch(`${base}${contentUrl}`, { headers: { Cookie: cookie, Range: `bytes=${sourceBytes.length - 256}-${sourceBytes.length - 1}` } }),
  ]);
  assert.ok(concurrentRanges.every((response) => response.status === 206));
  assert.deepEqual(Buffer.from(await concurrentRanges[0].arrayBuffer()), sourceBytes.subarray(0, 256));
  assert.deepEqual(Buffer.from(await concurrentRanges[1].arrayBuffer()), sourceBytes.subarray(-256));

  await request(`/api/upload?${new URLSearchParams({ shareId, path: '', name: 'read-only.png' })}`, {
    method: 'POST', headers: { Cookie: cookie }, body: Buffer.from('read only source'),
  });
  await request('/api/users', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ username: 'vault-reader', password: 'vault-reader-password-2026', permissions: [{ shareId, canRead: true, canWrite: false }] }),
  });
  const readerLogin = await request('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'vault-reader', password: 'vault-reader-password-2026' }),
  });
  const readerCookie = readerLogin.response.headers.get('set-cookie').split(';')[0];
  const otherUserContent = await request(contentUrl, { headers: { Cookie: readerCookie } });
  assert.equal(otherUserContent.response.status, 404);
  const deniedImport = await request('/api/vault/objects/import', {
    method: 'POST', headers: { Cookie: readerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ shareId, path: 'read-only.png' }),
  });
  assert.equal(deniedImport.response.status, 403);
  assert.equal(await readFile(path.join(dataDir, 'files', shareId, 'read-only.png'), 'utf8'), 'read only source');

  const unconfirmedDelete = await request(`/api/vault/objects/${id}`, { method: 'DELETE', headers: auth, body: JSON.stringify({}) });
  assert.equal(unconfirmedDelete.response.status, 400);
  const wrongDeleteConfirmation = await request(`/api/vault/objects/${id}`, { method: 'DELETE', headers: auth, body: JSON.stringify({ confirmText: '永久刪除' }) });
  assert.equal(wrongDeleteConfirmation.response.status, 400);
  const deleted = await request(`/api/vault/objects/${id}`, { method: 'DELETE', headers: auth, body: JSON.stringify({ confirmText: '移至資源回收筒' }) });
  assert.equal(deleted.response.status, 200);
  assert.equal((await readFile(encryptedPath)).subarray(0, 8).toString('ascii'), 'NKVLT01\0');
  const hiddenFromActive = await request('/api/vault/objects', { headers: { Cookie: cookie } });
  assert.equal(hiddenFromActive.body.items.some((item) => item.id === id), false);
  assert.equal((await request('/api/vault/trash', { headers: { Cookie: cookie } })).body.items.some((item) => item.id === id), true);
  const missingContent = await request(contentUrl, { headers: { Cookie: cookie } });
  assert.equal(missingContent.response.status, 404);
  const restored = await request(`/api/vault/trash/${id}/restore`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(restored.response.status, 200);
  assert.equal((await request('/api/vault/objects', { headers: { Cookie: cookie } })).body.items.some((item) => item.id === id), true);
  await request(`/api/vault/objects/${id}`, { method: 'DELETE', headers: auth, body: JSON.stringify({ confirmText: '移至資源回收筒' }) });
  const permanentlyDeleted = await request(`/api/vault/trash/${id}`, { method: 'DELETE', headers: auth, body: JSON.stringify({ confirmText: '永久刪除' }) });
  assert.equal(permanentlyDeleted.response.status, 200);
  await assert.rejects(readFile(encryptedPath), { code: 'ENOENT' });
  await assert.rejects(readFile(sidecarPath), { code: 'ENOENT' });

  await request('/api/logout', { method: 'POST', headers: { Cookie: cookie } });
  const adminLogin = await request('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'local-test-passphrase-2026' }),
  });
  const reauthenticatedCookie = adminLogin.response.headers.get('set-cookie').split(';')[0];
  const relocked = await request('/api/vault/status', { headers: { Cookie: reauthenticatedCookie } });
  assert.equal(relocked.body.unlocked, false);
  const wrongPasswords = await Promise.all(Array.from({ length: 5 }, () => request('/api/vault/unlock', {
    method: 'POST', headers: { Cookie: reauthenticatedCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'incorrect-vault-password-2026' }),
  })));
  assert.ok(wrongPasswords.every((result) => result.response.status === 401));
  const throttled = await request('/api/vault/unlock', {
    method: 'POST', headers: { Cookie: reauthenticatedCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'vault-test-password-2026' }),
  });
  assert.equal(throttled.response.status, 429);

  const lockedList = await request('/api/vault/objects', { headers: { Cookie: reauthenticatedCookie } });
  assert.equal(lockedList.response.status, 423);
});

test('vault is locked again after server shutdown and restart', async (t) => {
  const { base, dataDir, server, request, setup } = await setupServer(t);
  const { cookie } = await setup();
  const created = await request('/api/vault/setup', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'vault-restart-password-2026' }),
  });
  assert.equal(created.response.status, 201);
  await server.close();

  const restarted = await startServer({ dataDir, host: '127.0.0.1', port: 0 });
  try {
    const restartedBase = `http://127.0.0.1:${restarted.port}`;
    const login = await fetch(`${restartedBase}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: restartedBase },
      body: JSON.stringify({ username: 'admin', password: 'local-test-passphrase-2026' }),
    });
    assert.equal(login.status, 200);
    const restartedCookie = login.headers.get('set-cookie').split(';')[0];
    const status = await fetch(`${restartedBase}/api/vault/status`, { headers: { Cookie: restartedCookie } });
    assert.deepEqual(await status.json(), { configured: true, unlocked: false });
  } finally { await restarted.close(); }
});

test('vault recovery key unlocks the vault, can re-wrap the password, and can be rotated', async (t) => {
  const { base, dataDir, request, setup } = await setupServer(t);
  const { cookie, user } = await setup();
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  const created = await request('/api/vault/setup', {
    method: 'POST', headers: auth, body: JSON.stringify({ password: 'vault-original-password-2026' }),
  });
  assert.equal(created.response.status, 201);
  assert.match(created.body.recoveryCode, /^[a-f0-9]{64}$/u);
  const db = new DatabaseSync(path.join(dataDir, 'metadata.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT envelope_json, recovery_json FROM vaults WHERE user_id = ?').get(user.id);
    assert.equal(row.recovery_json.includes(created.body.recoveryCode), false);
    assert.equal(row.envelope_json.includes(created.body.recoveryCode), false);
  } finally { db.close(); }

  await request('/api/vault/lock', { method: 'POST', headers: auth, body: '{}' });
  const recovered = await request('/api/vault/recover', {
    method: 'POST', headers: auth, body: JSON.stringify({ recoveryCode: created.body.recoveryCode.match(/.{1,4}/gu).join('-') }),
  });
  assert.equal(recovered.response.status, 200, recovered.body.message);
  assert.equal((await request('/api/vault/status', { headers: auth })).body.unlocked, true);

  const changed = await request('/api/vault/password', {
    method: 'POST', headers: auth, body: JSON.stringify({ password: 'vault-new-password-2026' }),
  });
  assert.equal(changed.response.status, 200);
  await request('/api/vault/lock', { method: 'POST', headers: auth, body: '{}' });
  const oldPassword = await request('/api/vault/unlock', {
    method: 'POST', headers: auth, body: JSON.stringify({ password: 'vault-original-password-2026' }),
  });
  assert.equal(oldPassword.response.status, 401);
  const newPassword = await request('/api/vault/unlock', {
    method: 'POST', headers: auth, body: JSON.stringify({ password: 'vault-new-password-2026' }),
  });
  assert.equal(newPassword.response.status, 200);

  const rotated = await request('/api/vault/recovery-key', { method: 'POST', headers: auth, body: '{}' });
  assert.equal(rotated.response.status, 200);
  assert.notEqual(rotated.body.recoveryCode, created.body.recoveryCode);
  await request('/api/vault/lock', { method: 'POST', headers: auth, body: '{}' });
  const staleRecovery = await request('/api/vault/recover', {
    method: 'POST', headers: auth, body: JSON.stringify({ recoveryCode: created.body.recoveryCode }),
  });
  assert.equal(staleRecovery.response.status, 401);
  const newRecovery = await request('/api/vault/recover', {
    method: 'POST', headers: auth, body: JSON.stringify({ recoveryCode: rotated.body.recoveryCode }),
  });
  assert.equal(newRecovery.response.status, 200);
});

test('vault reconciliation adopts authenticated sidecar orphans, removes incomplete temps, and gates unknown orphan cleanup', async (t) => {
  const { dataDir, request, setup } = await setupServer(t);
  const { cookie, shareId, user } = await setup();
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  await request('/api/vault/setup', { method: 'POST', headers: auth, body: JSON.stringify({ password: 'vault-orphan-password-2026' }) });
  const content = Buffer.from('orphan reconciliation source payload');
  await request(`/api/upload?${new URLSearchParams({ shareId, path: '', name: 'orphan-recovery.txt' })}`, { method: 'POST', headers: { Cookie: cookie }, body: content });
  const imported = await request('/api/vault/objects/import', {
    method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: 'orphan-recovery.txt' }),
  });
  assert.equal(imported.response.status, 201);
  const objectId = imported.body.item.id;
  const directory = path.join(dataDir, '.nanako-vault', user.id);
  const encryptedPath = path.join(directory, `${objectId}.nkv`);
  const sidecarPath = path.join(directory, `${objectId}.nkm`);
  const sourcePath = path.join(dataDir, 'files', shareId, 'orphan-recovery.txt');
  const database = new DatabaseSync(path.join(dataDir, 'metadata.sqlite'));
  try { database.prepare('DELETE FROM vault_objects WHERE id = ?').run(objectId); }
  finally { database.close(); }
  await writeFile(sourcePath, content);

  const reconciled = await request('/api/vault/recovery', { headers: { Cookie: cookie } });
  assert.equal(reconciled.response.status, 200, reconciled.body.message);
  assert.equal(reconciled.body.items.some((item) => item.id === objectId && item.sourceState === 'unchanged'), true);
  assert.equal((await request('/api/vault/objects', { headers: { Cookie: cookie } })).body.items.some((item) => item.id === objectId), true);
  const completed = await request(`/api/vault/recovery/${objectId}`, {
    method: 'POST', headers: auth, body: JSON.stringify({ action: 'complete' }),
  });
  assert.equal(completed.response.status, 200);
  await assert.rejects(readFile(sourcePath), { code: 'ENOENT' });
  assert.equal((await stat(sidecarPath)).isFile(), true);
  assert.equal((await stat(encryptedPath)).isFile(), true);

  const incompleteId = randomUUID();
  const incompleteTemp = path.join(directory, `${incompleteId}.nkv.tmp`);
  await writeFile(incompleteTemp, Buffer.from('partial encrypted stream'));
  const unknownId = randomUUID();
  const unknownFinal = path.join(directory, `${unknownId}.nkv`);
  await writeFile(unknownFinal, Buffer.from('unknown legacy ciphertext'));
  const orphanReport = await request('/api/vault/recovery', { headers: { Cookie: cookie } });
  assert.equal(orphanReport.response.status, 200);
  assert.equal(orphanReport.body.orphans.some((item) => item.id === unknownId), true);
  await assert.rejects(readFile(incompleteTemp), { code: 'ENOENT' });
  const refused = await request(`/api/vault/orphans/${unknownId}`, {
    method: 'POST', headers: auth, body: JSON.stringify({ confirmText: '刪除' }),
  });
  assert.equal(refused.response.status, 400);
  const discarded = await request(`/api/vault/orphans/${unknownId}`, {
    method: 'POST', headers: auth, body: JSON.stringify({ confirmText: '永久刪除孤兒密文' }),
  });
  assert.equal(discarded.response.status, 200);
  await assert.rejects(readFile(unknownFinal), { code: 'ENOENT' });
});

test('vault import reports streaming progress and cancellation keeps the original source', async (t) => {
  const { dataDir, request, setup } = await setupServer(t);
  const { cookie, shareId, user } = await setup();
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  await request('/api/vault/setup', { method: 'POST', headers: auth, body: JSON.stringify({ password: 'vault-cancel-password-2026' }) });
  const source = Buffer.alloc(64 * 1024 * 1024, 0x61);
  const uploaded = await request(`/api/upload?${new URLSearchParams({ shareId, path: '', name: 'cancel-large.bin' })}`, {
    method: 'POST', headers: { Cookie: cookie }, body: source,
  });
  assert.equal(uploaded.response.status, 201);
  const sourcePath = path.join(dataDir, 'files', shareId, 'cancel-large.bin');
  const importRequest = request('/api/vault/objects/import', {
    method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: 'cancel-large.bin' }),
  });
  let observed = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const progress = await request('/api/vault/objects/import/status', { headers: { Cookie: cookie } });
    if (progress.body.active && progress.body.bytesRead > 0) { observed = progress.body; break; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(observed, 'streaming progress should become visible before the 64 MiB import finishes');
  assert.ok(observed.bytesRead < observed.totalBytes);
  const cancelled = await request('/api/vault/objects/import/cancel', { method: 'POST', headers: auth, body: '{}' });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.cancelling, true);
  const result = await importRequest;
  assert.equal(result.response.status, 499);
  assert.equal(result.body.error, 'vault_import_cancelled');
  assert.equal((await stat(sourcePath)).size, source.length);
  const vaultDirectory = path.join(dataDir, '.nanako-vault', user.id);
  assert.deepEqual((await readdir(vaultDirectory)).filter((name) => name.endsWith('.tmp')), []);
  assert.equal((await request('/api/vault/objects/import/status', { headers: { Cookie: cookie } })).body.active, false);
});

test('large vault import streams a 96 MiB file without buffering the whole payload', async (t) => {
  const { dataDir, request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  await request('/api/vault/setup', { method: 'POST', headers: auth, body: JSON.stringify({ password: 'vault-memory-password-2026' }) });
  const sourcePath = path.join(dataDir, 'files', shareId, 'large-vault.bin');
  const handle = await open(sourcePath, 'wx');
  const blockBytes = 1024 * 1024;
  try { await handle.truncate(96 * blockBytes); }
  finally { await handle.close(); }
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  let peakUsage = process.memoryUsage();
  let peakArrayBuffers = peakUsage.arrayBuffers;
  const sample = setInterval(() => {
    const usage = process.memoryUsage();
    peakArrayBuffers = Math.max(peakArrayBuffers, usage.arrayBuffers);
    if (usage.rss > peakRss) { peakRss = usage.rss; peakUsage = usage; }
  }, 10);
  sample.unref();
  try {
    const result = await request('/api/vault/objects/import', {
      method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: 'large-vault.bin' }),
    });
    assert.equal(result.response.status, 201, result.body.message);
    assert.equal(result.body.item.size, 96 * blockBytes);
    assert.equal(await readFile(sourcePath).catch(() => null), null);
  } finally {
    clearInterval(sample);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  assert.ok(peakRss - baselineRss < 96 * blockBytes,
    `96 MiB 加密移入的 peak RSS 增量應小於來源檔大小；實測 ${((peakRss - baselineRss) / 1024 / 1024).toFixed(1)} MiB，peak ArrayBuffer=${(peakArrayBuffers / 1024 / 1024).toFixed(1)} MiB，peak external=${(peakUsage.external / 1024 / 1024).toFixed(1)} MiB`);
});

test('vault backups stay in NanakoData, authenticate manifests and restore encrypted objects', async (t) => {
  const { base, dataDir, request, setup } = await setupServer(t);
  const { cookie, shareId, user } = await setup();
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  await request('/api/vault/setup', { method: 'POST', headers: auth, body: JSON.stringify({ password: 'vault-backup-password-2026' }) });
  const sourceFiles = [
    ['備份甲.png', Buffer.from('backup payload alpha')],
    ['備份乙.png', Buffer.from('backup payload beta')],
  ];
  for (const [name, bytes] of sourceFiles) {
    const upload = await request(`/api/upload?${new URLSearchParams({ shareId, path: '', name })}`, { method: 'POST', headers: { Cookie: cookie }, body: bytes });
    assert.equal(upload.response.status, 201);
    const imported = await request('/api/vault/objects/import', { method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: name }) });
    assert.equal(imported.response.status, 201);
  }
  const objects = (await request('/api/vault/objects', { headers: { Cookie: cookie } })).body.items;
  const damagedBackup = await request('/api/vault/backups', { method: 'POST', headers: auth, body: '{}' });
  const goodBackup = await request('/api/vault/backups', { method: 'POST', headers: auth, body: '{}' });
  assert.equal(damagedBackup.response.status, 201, damagedBackup.body.message);
  assert.equal(goodBackup.response.status, 201, goodBackup.body.message);
  const backupDirectory = path.join(dataDir, '.nanako-vault', user.id, 'backups');
  assert.equal((await request('/api/vault/backups', { headers: { Cookie: cookie } })).body.items.length, 2);
  const backupObjectPath = path.join(backupDirectory, damagedBackup.body.backup.id, 'objects', `${objects[0].id}.nkv`);
  const backupCiphertext = await readFile(backupObjectPath);
  assert.equal(backupCiphertext.includes(Buffer.from('backup payload')), false);
  assert.equal((await readFile(path.join(backupDirectory, damagedBackup.body.backup.id, 'manifest.json'), 'utf8')).includes('備份甲.txt'), false);

  for (const item of objects) {
    await request(`/api/vault/objects/${item.id}`, { method: 'DELETE', headers: auth, body: JSON.stringify({ confirmText: '移至資源回收筒' }) });
    await request(`/api/vault/trash/${item.id}`, { method: 'DELETE', headers: auth, body: JSON.stringify({ confirmText: '永久刪除' }) });
  }
  assert.equal((await request('/api/vault/objects', { headers: { Cookie: cookie } })).body.items.length, 0);
  const corrupted = Buffer.from(backupCiphertext); corrupted[20] ^= 0x04; await writeFile(backupObjectPath, corrupted);
  const refused = await request(`/api/vault/backups/${damagedBackup.body.backup.id}/restore`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(refused.response.status, 409);
  assert.equal((await request('/api/vault/objects', { headers: { Cookie: cookie } })).body.items.length, 0);

  const restored = await request(`/api/vault/backups/${goodBackup.body.backup.id}/restore`, { method: 'POST', headers: auth, body: '{}' });
  assert.equal(restored.response.status, 200, restored.body.message);
  assert.equal(restored.body.restored, 2);
  const restoredObjects = (await request('/api/vault/objects', { headers: { Cookie: cookie } })).body.items;
  assert.equal(restoredObjects.length, 2);
  for (const item of restoredObjects) {
    const response = await fetch(`${base}/api/vault/objects/${item.id}/content`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const source = sourceFiles.find(([name]) => name === item.name);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), source[1]);
  }
});

test('vault import recovery removes only unchanged plaintext and can preserve changed sources', async (t) => {
  const { dataDir, request, setup } = await setupServer(t);
  const { cookie, shareId, user } = await setup();
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  const upload = async (name, bytes) => request(`/api/upload?${new URLSearchParams({ shareId, path: '', name })}`, {
    method: 'POST', headers: { Cookie: cookie }, body: bytes,
  });
  const original = Buffer.from('recovery source contents');
  assert.equal((await upload('recovery.txt', original)).response.status, 201);
  assert.equal((await request('/api/vault/setup', {
    method: 'POST', headers: auth, body: JSON.stringify({ password: 'vault-recovery-password-2026' }),
  })).response.status, 201);
  const imported = await request('/api/vault/objects/import', {
    method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: 'recovery.txt' }),
  });
  assert.equal(imported.response.status, 201, imported.body.message);
  const objectId = imported.body.item.id;
  const sourcePath = path.join(dataDir, 'files', shareId, 'recovery.txt');
  await writeFile(sourcePath, original);
  const recoveryDb = new DatabaseSync(path.join(dataDir, 'metadata.sqlite'));
  try { recoveryDb.prepare('INSERT INTO vault_pending_imports(object_id, user_id, created_at) VALUES(?,?,?)').run(objectId, user.id, new Date().toISOString()); }
  finally { recoveryDb.close(); }

  const pending = await request('/api/vault/recovery', { headers: { Cookie: cookie } });
  assert.equal(pending.response.status, 200);
  assert.deepEqual(pending.body.items.map(({ id, sourceState }) => ({ id, sourceState })), [{ id: objectId, sourceState: 'unchanged' }]);
  const encryptedPath = path.join(dataDir, '.nanako-vault', user.id, `${objectId}.nkv`);
  const validCiphertext = await readFile(encryptedPath);
  const corruptedCiphertext = Buffer.from(validCiphertext);
  corruptedCiphertext[corruptedCiphertext.length - 1] ^= 0x01;
  await writeFile(encryptedPath, corruptedCiphertext);
  const refusedCorrupt = await request(`/api/vault/recovery/${objectId}`, {
    method: 'POST', headers: auth, body: JSON.stringify({ action: 'complete' }),
  });
  assert.equal(refusedCorrupt.response.status, 409);
  assert.deepEqual(await readFile(sourcePath), original);
  await writeFile(encryptedPath, validCiphertext);
  const completed = await request(`/api/vault/recovery/${objectId}`, {
    method: 'POST', headers: auth, body: JSON.stringify({ action: 'complete' }),
  });
  assert.equal(completed.response.status, 200);
  await assert.rejects(readFile(sourcePath), { code: 'ENOENT' });
  assert.equal((await request('/api/vault/recovery', { headers: { Cookie: cookie } })).body.items.length, 0);

  const changedOriginal = Buffer.from('second source content');
  assert.equal((await upload('changed.txt', changedOriginal)).response.status, 201);
  const changedImport = await request('/api/vault/objects/import', {
    method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: 'changed.txt' }),
  });
  assert.equal(changedImport.response.status, 201, changedImport.body.message);
  const changedPath = path.join(dataDir, 'files', shareId, 'changed.txt');
  const modified = Buffer.from('replacement source data');
  await writeFile(changedPath, modified);
  const changedDb = new DatabaseSync(path.join(dataDir, 'metadata.sqlite'));
  try { changedDb.prepare('INSERT INTO vault_pending_imports(object_id, user_id, created_at) VALUES(?,?,?)').run(changedImport.body.item.id, user.id, new Date().toISOString()); }
  finally { changedDb.close(); }
  const changedPending = await request('/api/vault/recovery', { headers: { Cookie: cookie } });
  assert.equal(changedPending.body.items[0].sourceState, 'changed');
  const refused = await request(`/api/vault/recovery/${changedImport.body.item.id}`, {
    method: 'POST', headers: auth, body: JSON.stringify({ action: 'complete' }),
  });
  assert.equal(refused.response.status, 409);
  assert.deepEqual(await readFile(changedPath), modified);
  const kept = await request(`/api/vault/recovery/${changedImport.body.item.id}`, {
    method: 'POST', headers: auth, body: JSON.stringify({ action: 'keep' }),
  });
  assert.equal(kept.response.status, 200);
  assert.deepEqual(await readFile(changedPath), modified);

  const lastSource = Buffer.from('keep original if encrypted data is absent');
  assert.equal((await upload('missing-ciphertext.txt', lastSource)).response.status, 201);
  const lastImport = await request('/api/vault/objects/import', {
    method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: 'missing-ciphertext.txt' }),
  });
  assert.equal(lastImport.response.status, 201, lastImport.body.message);
  const lastPath = path.join(dataDir, 'files', shareId, 'missing-ciphertext.txt');
  await writeFile(lastPath, lastSource);
  const lastDb = new DatabaseSync(path.join(dataDir, 'metadata.sqlite'));
  try { lastDb.prepare('INSERT INTO vault_pending_imports(object_id, user_id, created_at) VALUES(?,?,?)').run(lastImport.body.item.id, user.id, new Date().toISOString()); }
  finally { lastDb.close(); }
  await rm(path.join(dataDir, '.nanako-vault', user.id, `${lastImport.body.item.id}.nkv`));
  const missingCiphertext = await request('/api/vault/recovery', { headers: { Cookie: cookie } });
  assert.equal(missingCiphertext.body.items.find((item) => item.id === lastImport.body.item.id).sourceState, 'ciphertext-missing');
  const unsafeComplete = await request(`/api/vault/recovery/${lastImport.body.item.id}`, {
    method: 'POST', headers: auth, body: JSON.stringify({ action: 'complete' }),
  });
  assert.equal(unsafeComplete.response.status, 409);
  assert.deepEqual(await readFile(lastPath), lastSource);
  const clearBrokenIndex = await request(`/api/vault/recovery/${lastImport.body.item.id}`, {
    method: 'POST', headers: auth, body: JSON.stringify({ action: 'keep' }),
  });
  assert.equal(clearBrokenIndex.response.status, 200);
  const verifyDb = new DatabaseSync(path.join(dataDir, 'metadata.sqlite'), { readOnly: true });
  try { assert.equal(verifyDb.prepare('SELECT id FROM vault_objects WHERE id = ?').get(lastImport.body.item.id), undefined); }
  finally { verifyDb.close(); }
  assert.deepEqual(await readFile(lastPath), lastSource);
  const history = await request('/api/audit-logs', { headers: { Cookie: cookie } });
  const recoveryAudits = history.body.logs.filter((entry) => entry.action === '檢視加密空間復原狀態' || entry.action === '處理加密空間復原');
  assert.ok(recoveryAudits.length >= 5);
  assert.ok(recoveryAudits.every((entry) => entry.target === '待確認移入作業'));
  assert.ok(!recoveryAudits.some((entry) => /recovery\.txt|changed\.txt|missing-ciphertext/u.test(entry.target)));
});

test('pending vault import survives restart and recovery requires a fresh unlock', async (t) => {
  const { dataDir, server, setup, request } = await setupServer(t);
  const { cookie, shareId, user } = await setup();
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  const bytes = Buffer.from('restart recovery source');
  const uploaded = await request(`/api/upload?${new URLSearchParams({ shareId, path: '', name: 'restart.txt' })}`, {
    method: 'POST', headers: { Cookie: cookie }, body: bytes,
  });
  assert.equal(uploaded.response.status, 201);
  assert.equal((await request('/api/vault/setup', {
    method: 'POST', headers: auth, body: JSON.stringify({ password: 'vault-restart-recovery-2026' }),
  })).response.status, 201);
  const imported = await request('/api/vault/objects/import', {
    method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: 'restart.txt' }),
  });
  assert.equal(imported.response.status, 201);
  const sourcePath = path.join(dataDir, 'files', shareId, 'restart.txt');
  await writeFile(sourcePath, bytes);
  const journalDb = new DatabaseSync(path.join(dataDir, 'metadata.sqlite'));
  try { journalDb.prepare('INSERT INTO vault_pending_imports(object_id, user_id, created_at) VALUES(?,?,?)').run(imported.body.item.id, user.id, new Date().toISOString()); }
  finally { journalDb.close(); }

  await server.close();
  const restarted = await startServer({ dataDir, host: '127.0.0.1', port: 0 });
  try {
  const base = `http://127.0.0.1:${restarted.port}`;
  const login = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username: 'admin', password: 'local-test-passphrase-2026' }),
  });
  assert.equal(login.status, 200);
  await login.text();
  const restartedCookie = login.headers.get('set-cookie').split(';')[0];
  const relocked = await fetch(`${base}/api/vault/status`, { headers: { Cookie: restartedCookie } });
  assert.deepEqual(await relocked.json(), { configured: true, unlocked: false });
  const lockedRecovery = await fetch(`${base}/api/vault/recovery`, { headers: { Cookie: restartedCookie } });
  assert.equal(lockedRecovery.status, 423);
  await lockedRecovery.text();
  const unlock = await fetch(`${base}/api/vault/unlock`, {
    method: 'POST', headers: { Cookie: restartedCookie, 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ password: 'vault-restart-recovery-2026' }),
  });
  assert.equal(unlock.status, 200);
  await unlock.text();
  const recovery = await fetch(`${base}/api/vault/recovery`, { headers: { Cookie: restartedCookie } });
  const recoveryBody = await recovery.json();
  assert.equal(recoveryBody.items[0].sourceState, 'unchanged');
  const complete = await fetch(`${base}/api/vault/recovery/${imported.body.item.id}`, {
    method: 'POST', headers: { Cookie: restartedCookie, 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ action: 'complete' }),
  });
  assert.equal(complete.status, 200);
  await complete.text();
  await assert.rejects(readFile(sourcePath), { code: 'ENOENT' });
  } finally { await restarted.close(); }
});

test('locking the vault cancels an in-flight media stream before clearing the key', async (t) => {
  const { base, request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  const upload = await request(`/api/upload?${new URLSearchParams({ shareId, path: '', name: 'lock-stream.mp4' })}`, {
    method: 'POST', headers: { Cookie: cookie }, body: Buffer.alloc(8 * 1024 * 1024, 0x52),
  });
  assert.equal(upload.response.status, 201);
  const created = await request('/api/vault/setup', {
    method: 'POST', headers: auth, body: JSON.stringify({ password: 'vault-lock-password-2026' }),
  });
  assert.equal(created.response.status, 201);
  const imported = await request('/api/vault/objects/import', {
    method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: 'lock-stream.mp4' }),
  });
  assert.equal(imported.response.status, 201, imported.body.message);

  const streaming = await fetch(`${base}/api/vault/objects/${imported.body.item.id}/content`, { headers: { Cookie: cookie } });
  assert.equal(streaming.status, 200);
  const lockPromise = request('/api/vault/lock', { method: 'POST', headers: auth, body: '{}' });
  let timeout;
  const locked = await Promise.race([
    lockPromise,
    new Promise((resolve) => { timeout = setTimeout(() => resolve(null), 3000); }),
  ]);
  clearTimeout(timeout);
  if (!locked) {
    await streaming.body.cancel().catch(() => {});
    await lockPromise;
  }
  assert.ok(locked, '手動鎖定應中止進行中的媒體串流，而非無限等待用戶端讀取');
  assert.equal(locked.response.status, 200);
  const status = await request('/api/vault/status', { headers: { Cookie: cookie } });
  assert.equal(status.body.unlocked, false);
  await streaming.body.cancel().catch(() => {});
});

test('file category search covers one Nanako share recursively and honours read permissions', async (t) => {
  const { dataDir, request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  for (const name of ['相簿', '相簿/旅行']) {
    const [parent, folder] = name.includes('/') ? name.split(/\/(?=[^/]+$)/u) : ['', name];
    const created = await request('/api/folders', { method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: parent, name: folder }) });
    assert.equal(created.response.status, 201);
  }
  const upload = async (folder, name, contents) => request(`/api/upload?${new URLSearchParams({ shareId, path: folder, name })}`, { method: 'POST', headers: { Cookie: cookie }, body: Buffer.from(contents) });
  assert.equal((await upload('相簿/旅行', '海邊.JPG', 'image')).response.status, 201);
  assert.equal((await upload('相簿/旅行', '海邊.mp4', 'video')).response.status, 201);
  const categoryQuery = new URLSearchParams({ shareId, category: 'image' });
  const images = await request(`/api/files/search?${categoryQuery}`, { headers: { Cookie: cookie } });
  assert.equal(images.response.status, 200);
  assert.deepEqual(images.body.items.map((item) => item.path), ['相簿/旅行/海邊.JPG']);
  assert.equal(images.body.canWrite, true);
  assert.equal(images.body.share.id, shareId);
  assert.ok(images.body.scannedEntries >= 4);

  const media = await request(`/api/files/search?${new URLSearchParams({ shareId, category: 'media' })}`, { headers: { Cookie: cookie } });
  assert.deepEqual(media.body.items.map((item) => item.path), ['相簿/旅行/海邊.mp4']);

  categoryQuery.set('search', '私人查詢字串');
  const noMatch = await request(`/api/files/search?${categoryQuery}`, { headers: { Cookie: cookie } });
  assert.deepEqual(noMatch.body.items, []);
  const history = await request('/api/audit-logs', { headers: { Cookie: cookie } });
  assert.ok(history.body.logs.some((log) => log.action === '搜尋資料空間分類' && log.target === '圖片'));
  assert.equal(JSON.stringify(history.body).includes('私人查詢字串'), false);

  const created = await request('/api/users', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ username: 'catalog-reader', password: 'catalog-reader-passphrase-2026', permissions: [{ shareId, canRead: true, canWrite: false }] }),
  });
  assert.equal(created.response.status, 201);
  const login = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'catalog-reader', password: 'catalog-reader-passphrase-2026' }) });
  const reader = { Cookie: login.response.headers.get('set-cookie').split(';')[0] };
  const readerSearch = await request(`/api/files/search?${new URLSearchParams({ shareId, category: 'image' })}`, { headers: reader });
  assert.equal(readerSearch.response.status, 200);
  assert.equal(readerSearch.body.canWrite, false);

  const invalid = await request(`/api/files/search?${new URLSearchParams({ shareId, category: 'all' })}`, { headers: { Cookie: cookie } });
  assert.equal(invalid.response.status, 400);
  const outsideRoot = await request(`/api/files/search?${new URLSearchParams({ shareId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', category: 'image' })}`, { headers: { Cookie: cookie } });
  assert.equal(outsideRoot.response.status, 404);
  assert.equal(await readFile(path.join(dataDir, 'files', shareId, '相簿', '旅行', '海邊.JPG'), 'utf8'), 'image');
});

test('rename, move, copy and batch-operation APIs stay inside NanakoData', async (t) => {
  const { request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  const post = (route, body) => request(route, { method: 'POST', headers: auth, body: JSON.stringify({ shareId, ...body }) });
  for (const [parent, name] of [['', 'Source'], ['', 'Destination'], ['', 'Destination2'], ['Source', 'Nested'], ['Source', 'Empty']]) {
    const created = await post('/api/folders', { path: parent, name });
    assert.equal(created.response.status, 201);
  }
  const upload = async (folder, name, contents) => request(`/api/upload?${new URLSearchParams({ shareId, path: folder, name })}`, { method: 'POST', headers: { Cookie: cookie }, body: Buffer.from(contents) });
  assert.equal((await upload('', 'draft.txt', '移動測試')).response.status, 201);
  assert.equal((await upload('Source', 'inside.txt', '複製測試')).response.status, 201);
  assert.equal((await upload('Source/Nested', 'nested.txt', '巢狀內容')).response.status, 201);

  const renamed = await post('/api/files/rename', { path: 'draft.txt', newName: 'renamed.txt' });
  assert.equal(renamed.response.status, 200);
  const badRename = await post('/api/files/rename', { path: 'renamed.txt', newName: 'CON.txt' });
  assert.equal(badRename.response.status, 400);
  const reservedRename = await post('/api/files/rename', { path: 'renamed.txt', newName: '.localnas-temp' });
  assert.equal(reservedRename.response.status, 400);
  const reservedFolder = await post('/api/folders', { path: 'Source', name: '.nanako-trash' });
  assert.equal(reservedFolder.response.status, 400);
  const collisionRename = await post('/api/files/rename', { path: 'Source', newName: 'Destination' });
  assert.equal(collisionRename.response.status, 409);

  const moved = await post('/api/files/move', { path: 'renamed.txt', destinationPath: 'Destination' });
  assert.equal(moved.response.status, 200);
  const movedContents = await request(`/api/download?${new URLSearchParams({ shareId, path: 'Destination/renamed.txt' })}`, { headers: { Cookie: cookie } });
  assert.equal(movedContents.body, '移動測試');
  const moveIntoChild = await post('/api/files/move', { path: 'Source', destinationPath: 'Source/Nested' });
  assert.equal(moveIntoChild.response.status, 400);

  const copied = await post('/api/files/copy', { path: 'Source', destinationPath: 'Destination' });
  assert.equal(copied.response.status, 201);
  assert.equal(copied.body.entries, 5);
  assert.equal(copied.body.bytes, Buffer.byteLength('複製測試巢狀內容'));
  const copiedContents = await request(`/api/download?${new URLSearchParams({ shareId, path: 'Destination/Source/Nested/nested.txt' })}`, { headers: { Cookie: cookie } });
  assert.equal(copiedContents.body, '巢狀內容');
  const copiedFolder = await request(`/api/files?${new URLSearchParams({ shareId, path: 'Destination/Source' })}`, { headers: { Cookie: cookie } });
  assert.equal(copiedFolder.body.items.some((item) => item.name === 'Empty' && item.isDirectory), true);
  const copyCollisions = await Promise.all([
    post('/api/files/copy', { path: 'Source', destinationPath: 'Destination2' }),
    post('/api/files/copy', { path: 'Source', destinationPath: 'Destination2' }),
  ]);
  assert.deepEqual(copyCollisions.map((result) => result.response.status).sort(), [201, 409]);
  const copyIntoChild = await post('/api/files/copy', { path: 'Source', destinationPath: 'Source/Nested' });
  assert.equal(copyIntoChild.response.status, 400);
  const hiddenTemp = await request(`/api/files?${new URLSearchParams({ shareId, path: 'Destination' })}`, { headers: { Cookie: cookie } });
  assert.equal(hiddenTemp.body.items.some((item) => item.name.startsWith('.localnas-')), false);
  const reservedPath = await request(`/api/files?${new URLSearchParams({ shareId, path: '.localnas-copy-test' })}`, { headers: { Cookie: cookie } });
  assert.equal(reservedPath.response.status, 404);
  const audit = await request('/api/audit-logs', { headers: { Cookie: cookie } });
  for (const action of ['重新命名檔案', '移動檔案', '複製檔案']) assert.equal(audit.body.logs.some((log) => log.action === action), true);

  const addViewer = await request('/api/users', { method: 'POST', headers: auth, body: JSON.stringify({ username: 'readonly', password: 'readonly-test-passphrase-2026', permissions: [{ shareId, canRead: true, canWrite: false }] }) });
  assert.equal(addViewer.response.status, 201);
  const login = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'readonly', password: 'readonly-test-passphrase-2026' }) });
  const denied = await request('/api/files/rename', { method: 'POST', headers: { Cookie: login.response.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' }, body: JSON.stringify({ shareId, path: 'Source/inside.txt', newName: 'denied.txt' }) });
  assert.equal(denied.response.status, 403);
});

test('duplicate scan is NanakoData-only and moves verified copies to the recycle bin', async (t) => {
  const { dataDir, request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const auth = { Cookie: cookie };
  const upload = (name, contents) => request(`/api/upload?${new URLSearchParams({ shareId, path: '', name })}`, { method: 'POST', headers: auth, body: Buffer.from(contents) });
  assert.equal((await upload('keeper.txt', 'same content')).response.status, 201);
  assert.equal((await upload('copy.txt', 'same content')).response.status, 201);
  assert.equal((await upload('same-size.txt', 'Same content')).response.status, 201);

  const scan = await request('/api/duplicates/scan', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ shareId }),
  });
  assert.equal(scan.response.status, 202);
  let result;
  const deadline = Date.now() + 5000;
  do {
    result = await request(`/api/duplicates/scan?${new URLSearchParams({ scanId: scan.body.scanId })}`, { headers: auth });
    if (result.body.status !== 'scanning') break;
    await new Promise((resolve) => setTimeout(resolve, 15));
  } while (Date.now() < deadline);
  assert.equal(result.body.status, 'completed');
  assert.equal(result.body.groups.length, 1);
  assert.equal(result.body.groups[0].duplicateCount, 2);
  assert.deepEqual(result.body.groups[0].items.map((item) => item.path).sort(), ['copy.txt', 'keeper.txt']);

  const maliciousSelection = await request('/api/duplicates/cleanup', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scanId: scan.body.scanId, groups: [{ groupId: result.body.groups[0].id, keepPath: '../outside.txt' }] }),
  });
  assert.equal(maliciousSelection.response.status, 400);
  const cleanup = await request('/api/duplicates/cleanup', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scanId: scan.body.scanId, groups: [{ groupId: result.body.groups[0].id, keepPath: 'keeper.txt' }] }),
  });
  assert.equal(cleanup.response.status, 200);
  assert.equal(cleanup.body.moved.length, 1);
  assert.equal(cleanup.body.failed.length, 0);
  assert.equal(await readFile(path.join(dataDir, 'files', shareId, 'keeper.txt'), 'utf8'), 'same content');
  await assert.rejects(readFile(path.join(dataDir, 'files', shareId, 'copy.txt')));
  const trash = await request(`/api/trash?shareId=${shareId}`, { headers: auth });
  assert.equal(trash.body.items.some((item) => item.name === 'copy.txt'), true);
  const restore = await request('/api/trash/restore', {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: cleanup.body.moved[0].trashId }),
  });
  assert.equal(restore.response.status, 200);
  assert.equal(await readFile(path.join(dataDir, 'files', shareId, 'copy.txt'), 'utf8'), 'same content');
});

test('duplicate cleanup enforces per-user write access and does not accept unmanaged shares', async (t) => {
  const { request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const admin = { Cookie: cookie };
  for (const name of ['one.txt', 'two.txt']) {
    await request(`/api/upload?${new URLSearchParams({ shareId, path: '', name })}`, { method: 'POST', headers: admin, body: Buffer.from('duplicate') });
  }
  const created = await request('/api/users', {
    method: 'POST', headers: { ...admin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'reader', password: 'reader-test-passphrase-2026', permissions: [{ shareId, canRead: true, canWrite: false }] }),
  });
  assert.equal(created.response.status, 201);
  const login = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'reader', password: 'reader-test-passphrase-2026' }) });
  const reader = { Cookie: login.response.headers.get('set-cookie').split(';')[0] };
  const scan = await request('/api/duplicates/scan', {
    method: 'POST', headers: { ...reader, 'Content-Type': 'application/json' }, body: JSON.stringify({ shareId }),
  });
  assert.equal(scan.response.status, 202);
  let result;
  const deadline = Date.now() + 5000;
  do {
    result = await request(`/api/duplicates/scan?${new URLSearchParams({ scanId: scan.body.scanId })}`, { headers: reader });
    if (result.body.status !== 'scanning') break;
    await new Promise((resolve) => setTimeout(resolve, 15));
  } while (Date.now() < deadline);
  assert.equal(result.body.status, 'completed');
  const denied = await request('/api/duplicates/cleanup', {
    method: 'POST', headers: { ...reader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scanId: scan.body.scanId, groups: [{ groupId: result.body.groups[0].id, keepPath: 'one.txt' }] }),
  });
  assert.equal(denied.response.status, 403);
  const unmanaged = await request('/api/duplicates/scan', {
    method: 'POST', headers: { ...admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ shareId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
  });
  assert.equal(unmanaged.response.status, 404);
});

test('users without an explicit share grant cannot read files', async (t) => {
  const { request, setup } = await setupServer(t);
  const { cookie: adminCookie, shareId } = await setup();
  const addUser = await request('/api/users', { method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'guest', password: 'guest-test-passphrase-2026', permissions: [] }) });
  assert.equal(addUser.response.status, 201);
  const login = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'guest', password: 'guest-test-passphrase-2026' }) });
  assert.equal(login.response.status, 200);
  const guestCookie = login.response.headers.get('set-cookie').split(';')[0];
  const files = await request(`/api/files?shareId=${shareId}`, { headers: { Cookie: guestCookie } });
  assert.equal(files.response.status, 403);
  assert.equal(files.body.error, 'permission_denied');
});

test('media preview enforces permissions and serves byte ranges for playback', async (t) => {
  const { request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const auth = { Cookie: cookie };
  const uploadQuery = new URLSearchParams({ shareId, path: '', name: 'clip.mp4' });
  const upload = await request(`/api/upload?${uploadQuery}`, { method: 'POST', headers: auth, body: Buffer.from('abcdef') });
  assert.equal(upload.response.status, 201);

  const previewQuery = new URLSearchParams({ shareId, path: 'clip.mp4' });
  const partial = await request(`/api/preview?${previewQuery}`, { headers: { ...auth, Range: 'bytes=1-3' } });
  assert.equal(partial.response.status, 206);
  assert.equal(partial.response.headers.get('content-type'), 'video/mp4');
  assert.equal(partial.response.headers.get('content-range'), 'bytes 1-3/6');
  assert.equal(partial.response.headers.get('accept-ranges'), 'bytes');
  assert.equal(partial.body, 'bcd');

  const suffix = await request(`/api/preview?${previewQuery}`, { headers: { ...auth, Range: 'bytes=-2' } });
  assert.equal(suffix.response.status, 206);
  assert.equal(suffix.response.headers.get('content-range'), 'bytes 4-5/6');
  assert.equal(suffix.body, 'ef');

  const invalidRange = await request(`/api/preview?${previewQuery}`, { headers: { ...auth, Range: 'bytes=9-' } });
  assert.equal(invalidRange.response.status, 416);
  assert.equal(invalidRange.response.headers.get('content-range'), 'bytes */6');

  const textUploadQuery = new URLSearchParams({ shareId, path: '', name: 'notes.txt' });
  await request(`/api/upload?${textUploadQuery}`, { method: 'POST', headers: auth, body: Buffer.from('plain text') });
  const unsupported = await request(`/api/preview?${new URLSearchParams({ shareId, path: 'notes.txt' })}`, { headers: auth });
  assert.equal(unsupported.response.status, 415);

  const addUser = await request('/api/users', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'viewer', password: 'viewer-test-passphrase-2026', permissions: [] }) });
  assert.equal(addUser.response.status, 201);
  const login = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'viewer', password: 'viewer-test-passphrase-2026' }) });
  const viewerCookie = login.response.headers.get('set-cookie').split(';')[0];
  const denied = await request(`/api/preview?${previewQuery}`, { headers: { Cookie: viewerCookie } });
  assert.equal(denied.response.status, 403);
});

test('playback resume is user-scoped, permission-checked, file-version-aware and persistent without audit entries', async (t) => {
  const { dataDir, request, setup } = await setupServer(t);
  const { cookie: adminCookie, shareId } = await setup();
  const auth = { Cookie: adminCookie, 'Content-Type': 'application/json' };
  await request(`/api/upload?${new URLSearchParams({ shareId, path: '', name: 'resume.mp3' })}`, {
    method: 'POST', headers: { Cookie: adminCookie }, body: Buffer.from('media bytes'),
  });
  const added = await request('/api/users', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ username: 'resume-reader', password: 'resume-reader-passphrase-2026', permissions: [{ shareId, canRead: true, canWrite: false }] }),
  });
  assert.equal(added.response.status, 201);
  const login = await request('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'resume-reader', password: 'resume-reader-passphrase-2026' }),
  });
  const readerCookie = login.response.headers.get('set-cookie').split(';')[0];
  const readerAuth = { Cookie: readerCookie, 'Content-Type': 'application/json' };
  const query = new URLSearchParams({ shareId });

  const unauthorised = await request(`/api/playback-progress?${query}`, { headers: { Cookie: 'invalid' } });
  assert.equal(unauthorised.response.status, 401);
  const initial = await request(`/api/playback-progress?${query}`, { headers: { Cookie: readerCookie } });
  assert.equal(initial.response.status, 200);
  assert.deepEqual(initial.body.progress, []);

  const traversal = await request('/api/playback-progress', {
    method: 'POST', headers: readerAuth,
    body: JSON.stringify({ shareId, path: '../outside.mp3', position: 40, duration: 100 }),
  });
  assert.equal(traversal.response.status, 400);
  const invalid = await request('/api/playback-progress', {
    method: 'POST', headers: readerAuth,
    body: JSON.stringify({ shareId, path: 'resume.mp3', position: 40, duration: 0 }),
  });
  assert.equal(invalid.response.status, 400);

  const saved = await request('/api/playback-progress', {
    method: 'POST', headers: readerAuth,
    body: JSON.stringify({ shareId, path: 'resume.mp3', position: 40, duration: 100 }),
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.saved, true);
  const progressDb = new DatabaseSync(path.join(dataDir, 'metadata.sqlite'));
  try {
    const insertProgress = progressDb.prepare(`INSERT INTO playback_progress(
      user_id, share_id, relative_path, file_size, modified_at, position, duration, updated_at
    ) VALUES(?,?,?,?,?,?,?,?)`);
    const now = Date.now();
    for (let index = 0; index < 500; index += 1) {
      insertProgress.run(added.body.user.id, shareId, `stale-${index}.mp3`, 1, 1, 10, 100, now - 1_000 - index);
    }
    assert.equal(progressDb.prepare('SELECT COUNT(*) AS count FROM playback_progress WHERE user_id = ?').get(added.body.user.id).count, 501);
  } finally { progressDb.close(); }
  const capped = await request('/api/playback-progress', {
    method: 'POST', headers: readerAuth,
    body: JSON.stringify({ shareId, path: 'resume.mp3', position: 42, duration: 100 }),
  });
  assert.equal(capped.body.saved, true);
  const cappedDb = new DatabaseSync(path.join(dataDir, 'metadata.sqlite'), { readOnly: true });
  try {
    assert.equal(cappedDb.prepare('SELECT COUNT(*) AS count FROM playback_progress WHERE user_id = ?').get(added.body.user.id).count, 500);
  } finally { cappedDb.close(); }
  const readerList = await request(`/api/playback-progress?${query}`, { headers: { Cookie: readerCookie } });
  assert.deepEqual(readerList.body.progress.map(({ path: filePath, position }) => [filePath, position]), [['resume.mp3', 42]]);
  const adminList = await request(`/api/playback-progress?${query}`, { headers: { Cookie: adminCookie } });
  assert.deepEqual(adminList.body.progress, [], 'another Nanako user cannot read this user’s resume point');

  const completed = await request('/api/playback-progress', {
    method: 'POST', headers: readerAuth,
    body: JSON.stringify({ shareId, path: 'resume.mp3', position: 96, duration: 100 }),
  });
  assert.equal(completed.body.saved, false);
  assert.deepEqual((await request(`/api/playback-progress?${query}`, { headers: { Cookie: readerCookie } })).body.progress, []);

  await request('/api/playback-progress', {
    method: 'POST', headers: readerAuth,
    body: JSON.stringify({ shareId, path: 'resume.mp3', position: 40, duration: 100 }),
  });
  const mediaFile = path.join(dataDir, 'files', shareId, 'resume.mp3');
  const changedTime = new Date((await stat(mediaFile)).mtimeMs + 2_000);
  await writeFile(mediaFile, 'new bytes!!');
  await utimes(mediaFile, changedTime, changedTime);
  const stale = await request(`/api/playback-progress?${query}`, { headers: { Cookie: readerCookie } });
  assert.deepEqual(stale.body.progress, [], 'changed file versions discard obsolete resume points');

  await request('/api/playback-progress', {
    method: 'POST', headers: readerAuth,
    body: JSON.stringify({ shareId, path: 'resume.mp3', position: 40, duration: 100 }),
  });
  const deleted = await request(`/api/playback-progress?${new URLSearchParams({ shareId, path: 'resume.mp3' })}`, {
    method: 'DELETE', headers: { Cookie: readerCookie },
  });
  assert.equal(deleted.response.status, 200);
  assert.deepEqual((await request(`/api/playback-progress?${query}`, { headers: { Cookie: readerCookie } })).body.progress, []);
  const logs = await request('/api/audit-logs', { headers: { Cookie: adminCookie } });
  assert.equal(logs.body.logs.some((entry) => /播放進度|續播/u.test(entry.action)), false);
});

test('path traversal and LAN binding are rejected in this prototype', async (t) => {
  const { request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const traversal = await request(`/api/files?shareId=${shareId}&path=..`, { headers: { Cookie: cookie } });
  assert.equal(traversal.response.status, 400);
  await assert.rejects(() => startServer({ dataDir: path.join(os.tmpdir(), `localnas-lan-${Date.now()}`), host: '0.0.0.0', port: 0 }), /僅允許本機連線/u);
});

test('file, album, media and recycle-bin APIs stay inside Nanako managed storage', async (t) => {
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'nanako-outside-'));
  const outsideFile = path.join(outsideRoot, 'must-not-delete.txt');
  await writeFile(outsideFile, '不應被 Nanako 讀取或刪除');
  t.after(async () => { await rm(outsideRoot, { recursive: true, force: true }); });
  const { dataDir, request, setup } = await setupServer(t);
  const { cookie } = await setup();
  const auth = { Cookie: cookie };
  const externalShareId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const externalTrashId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const db = new DatabaseSync(path.join(dataDir, 'metadata.sqlite'));
  db.prepare('INSERT INTO shares(id, name, created_at, storage_path, source_type) VALUES(?,?,?,?,?)')
    .run(externalShareId, '舊版外部來源', new Date().toISOString(), outsideRoot, 'external');
  db.prepare(`INSERT INTO trash_items(id, share_id, original_path, stored_path, item_name, is_directory, deleted_by, deleted_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run(externalTrashId, externalShareId, 'secret.txt', outsideFile, 'must-not-delete.txt', 0, 'legacy', new Date().toISOString());
  db.close();

  const shares = await request('/api/shares', { headers: auth });
  assert.equal(shares.response.status, 200);
  assert.equal(shares.body.shares.some((share) => share.id === externalShareId), false);
  const externalFiles = await request(`/api/files?shareId=${externalShareId}`, { headers: auth });
  assert.equal(externalFiles.response.status, 404);
  const externalDownload = await request(`/api/download?${new URLSearchParams({ shareId: externalShareId, path: 'must-not-delete.txt' })}`, { headers: auth });
  assert.equal(externalDownload.response.status, 404);
  const externalPreview = await request(`/api/preview?${new URLSearchParams({ shareId: externalShareId, path: 'must-not-delete.txt' })}`, { headers: auth });
  assert.equal(externalPreview.response.status, 404);
  const externalTrash = await request(`/api/trash?shareId=${externalShareId}`, { headers: auth });
  assert.equal(externalTrash.response.status, 404);
  const deleteLegacyTrash = await request(`/api/trash?id=${externalTrashId}`, { method: 'DELETE', headers: auth });
  assert.equal(deleteLegacyTrash.response.status, 404);
  const noFolderPicker = await request('/api/library-roots', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: outsideRoot }) });
  assert.equal(noFolderPicker.response.status, 404);
  const noDriveListing = await request('/api/windows-drives', { headers: auth });
  assert.equal(noDriveListing.response.status, 404);
  assert.equal(await readFile(outsideFile, 'utf8'), '不應被 Nanako 讀取或刪除');
});

test('managed storage refuses a directory link that could redirect files outside NanakoData', async (t) => {
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'nanako-link-target-'));
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'nanako-storage-root-'));
  const dataDir = path.join(storageRoot, 'data');
  const filesLink = path.join(dataDir, 'files');
  await mkdir(dataDir, { recursive: true });
  t.after(async () => {
    await rm(filesLink, { recursive: false, force: true });
    await rm(storageRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });
  await symlink(outsideRoot, filesLink, 'junction');
  await assert.rejects(
    () => startServer({ dataDir, storageRoot, host: '127.0.0.1', port: 0 }),
    /不可使用符號連結/u,
  );
});

test('system information is restricted to the local administrator', async (t) => {
  const { request, setup } = await setupServer(t);
  const { cookie: adminCookie } = await setup();
  const adminInfo = await request('/api/system', { headers: { Cookie: adminCookie } });
  assert.equal(adminInfo.response.status, 200);
  assert.ok(adminInfo.body.computerName);
  assert.doesNotMatch(adminInfo.body.operatingSystem, /\uFFFD/u);
  assert.doesNotMatch(adminInfo.body.architecture, /\uFFFD/u);
  assert.ok(adminInfo.body.memory.totalBytes > 0);
  assert.equal(typeof adminInfo.body.windowsExecution.supported, 'boolean');
  assert.equal(typeof adminInfo.body.windowsExecution.isAdministrator, 'boolean');
  assert.equal(typeof adminInfo.body.windowsExecution.isElevated, 'boolean');
  if (process.platform === 'win32') {
    assert.equal(adminInfo.body.windowsExecution.supported, true);
    assert.equal(adminInfo.body.windowsExecution.checked, true);
    assert.ok(adminInfo.body.windowsExecution.identity);
  }
  const addUser = await request('/api/users', { method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sys-viewer', password: 'system-viewer-passphrase-2026', permissions: [] }) });
  assert.equal(addUser.response.status, 201);
  const login = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sys-viewer', password: 'system-viewer-passphrase-2026' }) });
  const denied = await request('/api/system', { headers: { Cookie: login.response.headers.get('set-cookie').split(';')[0] } });
  assert.equal(denied.response.status, 403);
});

test('operation history supports retention settings, automatic pruning and defensive clear confirmation', async (t) => {
  const { dataDir, request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  const defaults = await request('/api/audit-settings', { headers: { Cookie: cookie } });
  assert.equal(defaults.response.status, 200);
  assert.equal(defaults.body.retentionDays, 30);
  assert.deepEqual(defaults.body.options, [1, 3, 7, 30, 90, 180, 365]);

  await request('/api/activity', { method: 'POST', headers: auth, body: JSON.stringify({ view: 'album' }) });
  for (const action of ['focus', 'minimize', 'maximize', 'restore', 'move', 'close']) {
    const recorded = await request('/api/activity', { method: 'POST', headers: auth, body: JSON.stringify({ view: 'files', action }) });
    assert.equal(recorded.response.status, 200);
  }
  const invalidActivity = await request('/api/activity', { method: 'POST', headers: auth, body: JSON.stringify({ view: 'files', action: 'purge-everything' }) });
  assert.equal(invalidActivity.response.status, 400);
  await request('/api/folders', { method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: '', name: '紀錄測試' }) });
  const history = await request('/api/audit-logs', { headers: { Cookie: cookie } });
  assert.equal(history.response.status, 200);
  assert.ok(history.body.logs.some((item) => item.action === '開啟畫面' && item.target === '相簿'));
  for (const action of ['切換作用中視窗', '最小化視窗', '最大化視窗', '還原視窗', '移動視窗', '關閉視窗']) {
    assert.ok(history.body.logs.some((item) => item.action === action && item.target === '檔案管理視窗'));
  }
  assert.ok(history.body.logs.some((item) => item.action === '建立資料夾' && item.target === '紀錄測試'));
  assert.equal(JSON.stringify(history.body).includes('local-test-passphrase'), false);

  const invalidSetting = await request('/api/audit-settings', { method: 'POST', headers: auth, body: JSON.stringify({ retentionDays: 2 }) });
  assert.equal(invalidSetting.response.status, 400);
  const save = await request('/api/audit-settings', { method: 'POST', headers: auth, body: JSON.stringify({ retentionDays: 1 }) });
  assert.equal(save.response.status, 200);
  const db = new DatabaseSync(path.join(dataDir, 'metadata.sqlite'));
  db.prepare('UPDATE operation_logs SET occurred_at = ?').run(Date.now() - 2 * 24 * 60 * 60 * 1000);
  db.close();
  const afterPrune = await request('/api/audit-logs', { headers: { Cookie: cookie } });
  assert.equal(afterPrune.body.logs.length, 0);

  const notConfirmed = await request('/api/audit-logs', { method: 'DELETE', headers: auth, body: JSON.stringify({ confirmText: 'yes' }) });
  assert.equal(notConfirmed.response.status, 400);
  const cleared = await request('/api/audit-logs', { method: 'DELETE', headers: auth, body: JSON.stringify({ confirmText: '刪除所有紀錄' }) });
  assert.equal(cleared.response.status, 200);
  const empty = await request('/api/audit-logs', { headers: { Cookie: cookie } });
  assert.deepEqual(empty.body.logs, []);

  const addUser = await request('/api/users', { method: 'POST', headers: auth, body: JSON.stringify({ username: 'log-reader', password: 'log-reader-passphrase-2026', permissions: [{ shareId, canRead: true, canWrite: true }] }) });
  assert.equal(addUser.response.status, 201);
  const restartedHistory = await request('/api/audit-logs', { headers: { Cookie: cookie } });
  assert.ok(restartedHistory.body.logs.some((item) => item.action === '建立使用者' && item.target === 'log-reader'));
  const login = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'log-reader', password: 'log-reader-passphrase-2026' }) });
  const readerCookie = login.response.headers.get('set-cookie').split(';')[0];
  const forbidden = await request('/api/audit-logs', { headers: { Cookie: readerCookie } });
  assert.equal(forbidden.response.status, 403);
});

test('ZIP compression and extraction stream Nanako files without leaving partial outputs', async (t) => {
  const { request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  const uploadQuery = new URLSearchParams({ shareId, path: '', name: 'notes.txt' });
  const uploaded = await request(`/api/upload?${uploadQuery}`, { method: 'POST', headers: { Cookie: cookie }, body: Buffer.from('Nanako ZIP 串流測試') });
  assert.equal(uploaded.response.status, 201);

  const create = await request('/api/archive/create', { method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: 'notes.txt' }) });
  assert.equal(create.response.status, 201, JSON.stringify(create.body));
  assert.equal(create.body.name, 'notes.zip');
  assert.ok(create.body.size > 0);

  const extract = await request('/api/archive/extract', { method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: 'notes.zip' }) });
  assert.equal(extract.response.status, 201, JSON.stringify(extract.body));
  const restored = await request(`/api/download?${new URLSearchParams({ shareId, path: 'notes/notes.txt' })}`, { headers: { Cookie: cookie } });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body, 'Nanako ZIP 串流測試');
  const history = await request('/api/audit-logs', { headers: { Cookie: cookie } });
  assert.ok(history.body.logs.some((item) => item.action === '建立 ZIP 壓縮檔' && item.target === 'notes.txt'));
  assert.ok(history.body.logs.some((item) => item.action === '解壓縮 ZIP 檔案' && item.target === 'notes.zip'));
});

test('ZIP archives interoperate with Windows PowerShell archive tools', async (t) => {
  if (process.platform !== 'win32') { t.skip('Windows ZIP interoperability check'); return; }
  const { dataDir, request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const shareRoot = path.join(dataDir, 'files', shareId);
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  const powershellSource = path.join(shareRoot, 'powershell.txt');
  await writeFile(powershellSource, 'Windows PowerShell ZIP 互通測試');
  const powershellZip = path.join(shareRoot, 'powershell.zip');
  const compressScript = path.join(dataDir, 'compress-test.ps1');
  await writeFile(compressScript, [
    'param([string]$SourceFile, [string]$ArchiveFile)',
    "$ErrorActionPreference = 'Stop'",
    'Compress-Archive -LiteralPath $SourceFile -DestinationPath $ArchiveFile -Force',
  ].join('\n'));
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', compressScript, powershellSource, powershellZip]);
  const extracted = await request('/api/archive/extract', { method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: 'powershell.zip' }) });
  assert.equal(extracted.response.status, 201, extracted.body.message);
  assert.equal(await readFile(path.join(shareRoot, 'powershell', 'powershell.txt'), 'utf8'), 'Windows PowerShell ZIP 互通測試');

  const nanakoSource = path.join(shareRoot, 'nanako.txt');
  await writeFile(nanakoSource, 'Nanako ZIP to Windows archive tool');
  const created = await request('/api/archive/create', { method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: 'nanako.txt' }) });
  assert.equal(created.response.status, 201, created.body.message);
  const expandPath = path.join(shareRoot, 'expanded-by-powershell');
  const expandScript = path.join(dataDir, 'expand-test.ps1');
  await writeFile(expandScript, [
    'param([string]$ArchiveFile, [string]$DestinationPath)',
    "$ErrorActionPreference = 'Stop'",
    'Expand-Archive -LiteralPath $ArchiveFile -DestinationPath $DestinationPath -Force',
  ].join('\n'));
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', expandScript, path.join(shareRoot, 'nanako.zip'), expandPath]);
  assert.equal(await readFile(path.join(expandPath, 'nanako.txt'), 'utf8'), 'Nanako ZIP to Windows archive tool');
});

test('ZIP Slip entries are rejected before extraction writes outside Nanako storage', async (t) => {
  const { dataDir, request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const shareRoot = path.join(dataDir, 'files', shareId);
  const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false });
  await writer.add('../outside.txt', new TextReader('不應被寫出資料空間'));
  await writeFile(path.join(shareRoot, 'unsafe.zip'), Buffer.from(await (await writer.close()).arrayBuffer()));

  const result = await request('/api/archive/extract', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ shareId, path: 'unsafe.zip' }),
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error, 'invalid_archive');
  assert.equal(await readFile(path.join(dataDir, 'files', 'outside.txt')).catch(() => null), null);
  assert.equal(await readFile(path.join(shareRoot, 'unsafe', 'outside.txt')).catch(() => null), null);
});

test('ZIP CRC corruption is rejected and leaves no partial extraction directory', async (t) => {
  const { dataDir, request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const shareRoot = path.join(dataDir, 'files', shareId);
  const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false });
  await writer.add('payload.txt', new TextReader('CRC 驗證必須拒絕已修改的內容'));
  const archiveBlob = await writer.close();
  const bytes = Buffer.from(await archiveBlob.arrayBuffer());
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  const dataOffset = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
  bytes[dataOffset] ^= 0x01;
  await writeFile(path.join(shareRoot, 'corrupted.zip'), bytes);

  const result = await request('/api/archive/extract', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ shareId, path: 'corrupted.zip' }),
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error, 'invalid_archive');
  assert.equal(await readFile(path.join(shareRoot, 'corrupted', 'payload.txt')).catch(() => null), null);
  const entries = await readdir(shareRoot);
  assert.ok(!entries.some((name) => name.startsWith('.localnas-extract-')));
});

test('ZIP exact duplicate entry names surface archive_path_conflict on extract', async (t) => {
  const { dataDir, request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const shareRoot = path.join(dataDir, 'files', shareId);
  // Two stored central entries with identical raw names (ZipWriter normalizes duplicates away).
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function storedEntry(name, data) {
    const nameBytes = Buffer.from(name, 'utf8');
    const payload = Buffer.from(data);
    const checksum = crc32(payload);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(payload.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    return { local: Buffer.concat([local, nameBytes, payload]), central: Buffer.concat([central, nameBytes]), size: local.length + nameBytes.length + payload.length };
  }
  const first = storedEntry('same.txt', 'one');
  const second = storedEntry('same.txt', 'two');
  second.central.writeUInt32LE(first.size, 42);
  const centralDirectory = Buffer.concat([first.central, second.central]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(2, 8);
  eocd.writeUInt16LE(2, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(first.size + second.size, 16);
  await writeFile(path.join(shareRoot, 'duplicates.zip'), Buffer.concat([first.local, second.local, centralDirectory, eocd]));

  const result = await request('/api/archive/extract', {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ shareId, path: 'duplicates.zip' }),
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.body.error, 'archive_path_conflict');
  assert.equal(result.body.message, 'ZIP 內含重複或大小寫衝突的路徑。');
  assert.equal(await readFile(path.join(shareRoot, 'duplicates', 'same.txt')).catch(() => null), null);
  const entries = await readdir(shareRoot);
  assert.ok(!entries.some((name) => name.startsWith('.localnas-extract-')));
});

test('ZIP progress is observable and cancellation removes staging data without changing the source', async (t) => {
  const { dataDir, request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const sourcePath = path.join(dataDir, 'files', shareId, 'cancel-zip.bin');
  const file = await open(sourcePath, 'wx');
  try {
    for (let index = 0; index < 48; index += 1) await file.write(randomBytes(1024 * 1024));
  } finally { await file.close(); }
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
  const createRequest = request('/api/archive/create', { method: 'POST', headers, body: JSON.stringify({ shareId, path: 'cancel-zip.bin' }) });
  let progress;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await request('/api/archive/status', { headers: { Cookie: cookie } });
    if (status.body.active && status.body.bytesRead > 0) { progress = status.body; break; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(progress, 'ZIP compression progress should be visible while processing a 48 MiB file');
  assert.equal(progress.operation, 'create');
  assert.ok(progress.bytesRead < progress.totalBytes);
  const cancel = await request('/api/archive/cancel', { method: 'POST', headers, body: '{}' });
  assert.equal(cancel.response.status, 200);
  assert.equal(cancel.body.cancelling, true);
  const result = await createRequest;
  assert.equal(result.response.status, 499);
  assert.equal(result.body.error, 'archive_cancelled');
  assert.equal((await stat(sourcePath)).size, 48 * 1024 * 1024);
  assert.equal((await readFile(path.join(path.dirname(sourcePath), 'cancel-zip.zip')).catch(() => null)), null);
  assert.equal((await readdir(path.dirname(sourcePath))).some((name) => name.startsWith('.localnas-archive-')), false);
  assert.equal((await request('/api/archive/status', { headers: { Cookie: cookie } })).body.active, false);
});

test('large ZIP create and extract stream file data with bounded RSS growth', async (t) => {
  const { dataDir, request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  const sourcePath = path.join(dataDir, 'files', shareId, 'large-random.bin');
  const file = await open(sourcePath, 'wx');
  const blockBytes = 1024 * 1024;
  try {
    for (let index = 0; index < 64; index += 1) {
      let block = randomBytes(blockBytes);
      let offset = 0;
      while (offset < block.length) {
        const { bytesWritten } = await file.write(block, offset, block.length - offset);
        offset += bytesWritten;
      }
      block = null;
    }
  } finally { await file.close(); }

  const measurePeakMemory = async (operation) => {
    global.gc?.();
    await new Promise((resolve) => setImmediate(resolve));
    const baselineUsage = process.memoryUsage();
    let peakRss = baselineUsage.rss;
    let peakArrayBuffers = baselineUsage.arrayBuffers;
    const sample = setInterval(() => {
      const usage = process.memoryUsage();
      peakRss = Math.max(peakRss, usage.rss);
      peakArrayBuffers = Math.max(peakArrayBuffers, usage.arrayBuffers);
    }, 10);
    sample.unref();
    try { await operation(); }
    finally {
      clearInterval(sample);
      const finalUsage = process.memoryUsage();
      peakRss = Math.max(peakRss, finalUsage.rss);
      peakArrayBuffers = Math.max(peakArrayBuffers, finalUsage.arrayBuffers);
    }
    return {
      rssDelta: peakRss - baselineUsage.rss,
      arrayBufferDelta: peakArrayBuffers - baselineUsage.arrayBuffers,
    };
  };

  const createMemory = await measurePeakMemory(async () => {
    const created = await request('/api/archive/create', {
      method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: 'large-random.bin' }),
    });
    assert.equal(created.response.status, 201, created.body.message);
    assert.ok(created.body.size > 62 * 1024 * 1024);
  });
  const extractMemory = await measurePeakMemory(async () => {
    const extracted = await request('/api/archive/extract', {
      method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: 'large-random.zip' }),
    });
    assert.equal(extracted.response.status, 201, extracted.body.message);
    assert.equal((await stat(path.join(dataDir, 'files', shareId, 'large-random', 'large-random.bin'))).size, 64 * blockBytes);
  });
  for (const [phase, memory] of [['建立', createMemory], ['解壓', extractMemory]]) {
    // ArrayBuffer accounting can spike above the former 48 MiB threshold for transient zip.js
    // chunks. Keep a strict ceiling below the full 64 MiB payload to catch materializing it at once.
    assert.ok(memory.rssDelta < 96 * 1024 * 1024 && memory.arrayBufferDelta < 64 * 1024 * 1024,
      `64 MiB ZIP ${phase}串流應保持有界；RSS 增量實測 ${(memory.rssDelta / 1024 / 1024).toFixed(1)} MiB（限 96 MiB），ArrayBuffer 增量實測 ${(memory.arrayBufferDelta / 1024 / 1024).toFixed(1)} MiB（限 64 MiB）`);
  }
});

test('directory ZIP archives preserve nested files and empty directories', async (t) => {
  const { request, setup } = await setupServer(t);
  const { cookie, shareId } = await setup();
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  const createFolder = await request('/api/folders', { method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: '', name: 'collection' }) });
  assert.equal(createFolder.response.status, 201);
  const createEmptyFolder = await request('/api/folders', { method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: 'collection', name: 'empty' }) });
  assert.equal(createEmptyFolder.response.status, 201);
  const upload = await request(`/api/upload?${new URLSearchParams({ shareId, path: 'collection', name: 'inside.txt' })}`, { method: 'POST', headers: { Cookie: cookie }, body: Buffer.from('nested archive item') });
  assert.equal(upload.response.status, 201);
  const archive = await request('/api/archive/create', { method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: 'collection' }) });
  assert.equal(archive.response.status, 201, JSON.stringify(archive.body));

  await request(`/api/files?${new URLSearchParams({ shareId, path: 'collection' })}`, { method: 'DELETE', headers: { Cookie: cookie } });
  const extraction = await request('/api/archive/extract', { method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: 'collection.zip' }) });
  assert.equal(extraction.response.status, 201, JSON.stringify(extraction.body));
  const nested = await request(`/api/download?${new URLSearchParams({ shareId, path: 'collection/inside.txt' })}`, { headers: { Cookie: cookie } });
  assert.equal(nested.body, 'nested archive item');
  const listing = await request(`/api/files?${new URLSearchParams({ shareId, path: 'collection' })}`, { headers: { Cookie: cookie } });
  assert.ok(listing.body.items.some((item) => item.name === 'empty' && item.isDirectory));
});

test('administrators can update share grants and deactivate accounts', async (t) => {
  const { request, setup } = await setupServer(t);
  const { cookie: adminCookie, shareId, user: adminUser } = await setup();
  const adminAuth = { Cookie: adminCookie, 'Content-Type': 'application/json' };
  const created = await request('/api/users', {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({ username: 'managed-user', password: 'managed-user-passphrase-2026', permissions: [{ shareId, canRead: true, canWrite: true }] }),
  });
  assert.equal(created.response.status, 201);
  const userId = created.body.user.id;
  const login = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'managed-user', password: 'managed-user-passphrase-2026' }) });
  assert.equal(login.response.status, 200);
  const userCookie = login.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/shares', { headers: { Cookie: userCookie } })).body.shares.length, 1);

  const renamed = await request(`/api/users/${userId}`, { method: 'PATCH', headers: adminAuth, body: JSON.stringify({ displayName: '家庭成員' }) });
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.body.user.displayName, '家庭成員');
  assert.equal(renamed.body.user.username, 'managed-user');
  assert.equal(renamed.body.user.permissions[0].canWrite, true, 'editing a display name should preserve access grants');
  const resetPassword = await request(`/api/users/${userId}`, { method: 'PATCH', headers: adminAuth, body: JSON.stringify({ password: 'managed-user-new-passphrase-2026' }) });
  assert.equal(resetPassword.response.status, 200);
  assert.equal((await request('/api/me', { headers: { Cookie: userCookie } })).response.status, 401, 'password reset should revoke the user session');
  const oldPasswordLogin = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'managed-user', password: 'managed-user-passphrase-2026' }) });
  assert.equal(oldPasswordLogin.response.status, 401);
  const newPasswordLogin = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'managed-user', password: 'managed-user-new-passphrase-2026' }) });
  assert.equal(newPasswordLogin.response.status, 200);
  const updatedUserCookie = newPasswordLogin.response.headers.get('set-cookie').split(';')[0];

  const revoked = await request(`/api/users/${userId}`, { method: 'PATCH', headers: adminAuth, body: JSON.stringify({ isActive: true, permissions: [] }) });
  assert.equal(revoked.response.status, 200);
  const denied = await request('/api/shares', { headers: { Cookie: updatedUserCookie } });
  assert.equal(denied.response.status, 200);
  assert.deepEqual(denied.body.shares, []);

  const deactivated = await request(`/api/users/${userId}`, { method: 'PATCH', headers: adminAuth, body: JSON.stringify({ isActive: false, permissions: [{ shareId, canRead: true, canWrite: false }] }) });
  assert.equal(deactivated.response.status, 200);
  assert.equal((await request('/api/me', { headers: { Cookie: updatedUserCookie } })).response.status, 401);
  const blockedLogin = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'managed-user', password: 'managed-user-passphrase-2026' }) });
  assert.equal(blockedLogin.response.status, 401);

  const reactivated = await request(`/api/users/${userId}`, { method: 'PATCH', headers: adminAuth, body: JSON.stringify({ isActive: true, permissions: [{ shareId, canRead: true, canWrite: false }] }) });
  assert.equal(reactivated.response.status, 200);
  assert.equal(reactivated.body.user.isActive, 1);
  assert.equal(reactivated.body.user.permissions[0].canRead, true);
  assert.equal(reactivated.body.user.permissions[0].canWrite, false);
  const refreshedLogin = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'managed-user', password: 'managed-user-new-passphrase-2026' }) });
  assert.equal(refreshedLogin.response.status, 200);

  const selfEdit = await request(`/api/users/${adminUser.id}`, { method: 'PATCH', headers: adminAuth, body: JSON.stringify({ isActive: false, permissions: [] }) });
  assert.equal(selfEdit.response.status, 400);
  const history = await request('/api/audit-logs', { headers: { Cookie: adminCookie } });
  assert.ok(history.body.logs.filter((item) => item.action === '更新使用者設定').length >= 5);
});

test('users can change their own password and other sessions are revoked', async (t) => {
  const { request, setup } = await setupServer(t);
  const { cookie: originalCookie } = await setup();
  const vaultCreated = await request('/api/vault/setup', {
    method: 'POST', headers: { Cookie: originalCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'admin-vault-password-2026' }),
  });
  assert.equal(vaultCreated.response.status, 201);
  const secondLogin = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'local-test-passphrase-2026' }) });
  const secondCookie = secondLogin.response.headers.get('set-cookie').split(';')[0];
  const changed = await request('/api/password', {
    method: 'POST', headers: { Cookie: originalCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'local-test-passphrase-2026', newPassword: 'admin-new-passphrase-2026' }),
  });
  assert.equal(changed.response.status, 200);
  const renewedCookie = changed.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/me', { headers: { Cookie: originalCookie } })).response.status, 401);
  assert.equal((await request('/api/me', { headers: { Cookie: secondCookie } })).response.status, 401);
  assert.equal((await request('/api/me', { headers: { Cookie: renewedCookie } })).response.status, 200);
  const vaultStatus = await request('/api/vault/status', { headers: { Cookie: renewedCookie } });
  assert.equal(vaultStatus.response.status, 200);
  assert.equal(vaultStatus.body.unlocked, false);
  const oldPassword = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'local-test-passphrase-2026' }) });
  assert.equal(oldPassword.response.status, 401);
  const newPassword = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin-new-passphrase-2026' }) });
  assert.equal(newPassword.response.status, 200);
  const history = await request('/api/audit-logs', { headers: { Cookie: renewedCookie } });
  assert.ok(history.body.logs.some((item) => item.action === '變更密碼'));
  assert.equal(JSON.stringify(history.body).includes('admin-new-passphrase-2026'), false);
});

test('repeated failed local logins are temporarily throttled', async (t) => {
  const { request, setup } = await setupServer(t);
  await setup();
  for (let index = 0; index < 5; index += 1) {
    const failed = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: `wrong-passphrase-${index}-2026` }) });
    assert.equal(failed.response.status, 401);
  }
  const limited = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'local-test-passphrase-2026' }) });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.body.error, 'login_throttled');
});

test('manual vault lock preserves the session and logout clears the session and vault key', async (t) => {
  const { request, setup } = await setupServer(t);
  const { cookie } = await setup();
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  const created = await request('/api/vault/setup', {
    method: 'POST', headers: auth, body: JSON.stringify({ password: 'vault-session-lock-password-2026' }),
  });
  assert.equal(created.response.status, 201);

  const manuallyLocked = await request('/api/vault/lock', { method: 'POST', headers: auth, body: '{}' });
  assert.equal(manuallyLocked.response.status, 200);
  assert.equal((await request('/api/me', { headers: { Cookie: cookie } })).response.status, 200);
  const lockedStatus = await request('/api/vault/status', { headers: { Cookie: cookie } });
  assert.equal(lockedStatus.response.status, 200);
  assert.equal(lockedStatus.body.unlocked, false);

  const unlocked = await request('/api/vault/unlock', {
    method: 'POST', headers: auth, body: JSON.stringify({ password: 'vault-session-lock-password-2026' }),
  });
  assert.equal(unlocked.response.status, 200);
  const loggedOut = await request('/api/logout', { method: 'POST', headers: auth, body: '{}' });
  assert.equal(loggedOut.response.status, 200);
  assert.equal((await request('/api/me', { headers: { Cookie: cookie } })).response.status, 401);

  const login = await request('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'local-test-passphrase-2026' }),
  });
  assert.equal(login.response.status, 200);
  const newCookie = login.response.headers.get('set-cookie').split(';')[0];
  const afterLogout = await request('/api/vault/status', { headers: { Cookie: newCookie } });
  assert.equal(afterLogout.response.status, 200);
  assert.equal(afterLogout.body.unlocked, false);
});

test('login throttle lockout persists across restart and expires with the injected clock', async (t) => {
  let timestamp = Date.UTC(2026, 10, 6);
  const { request, restart, setup } = await setupServer(t, { now: () => timestamp });
  await setup();
  for (let index = 0; index < 5; index += 1) {
    const failed = await request('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: `wrong-login-password-${index}-2026` }),
    });
    assert.equal(failed.response.status, 401);
  }
  const locked = await request('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'local-test-passphrase-2026' }),
  });
  assert.equal(locked.response.status, 429);
  assert.equal(locked.body.error, 'login_throttled');

  await restart();
  const afterRestart = await request('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'local-test-passphrase-2026' }),
  });
  assert.equal(afterRestart.response.status, 429);
  assert.equal(afterRestart.body.error, 'login_throttled');

  timestamp += 15 * 60 * 1000;
  const afterExpiry = await request('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'local-test-passphrase-2026' }),
  });
  assert.equal(afterExpiry.response.status, 200);
});

test('vault unlock throttle persists across restart and expires with the injected clock', async (t) => {
  let timestamp = Date.UTC(2026, 10, 6);
  const { request, restart, setup } = await setupServer(t, { now: () => timestamp });
  const { cookie } = await setup();
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  const password = 'vault-persist-password-2026';
  const created = await request('/api/vault/setup', {
    method: 'POST', headers: auth, body: JSON.stringify({ password }),
  });
  assert.equal(created.response.status, 201);
  await request('/api/vault/lock', { method: 'POST', headers: auth, body: '{}' });

  for (let index = 0; index < 5; index += 1) {
    const failed = await request('/api/vault/unlock', {
      method: 'POST', headers: auth, body: JSON.stringify({ password: `wrong-vault-password-${index}-2026` }),
    });
    assert.equal(failed.response.status, 401);
  }
  const locked = await request('/api/vault/unlock', { method: 'POST', headers: auth, body: JSON.stringify({ password }) });
  assert.equal(locked.response.status, 429);
  assert.equal(locked.body.error, 'vault_unlock_throttled');

  await restart();
  const vaultStatus = await request('/api/vault/status', { headers: { Cookie: cookie } });
  assert.equal(vaultStatus.response.status, 200);
  assert.equal(vaultStatus.body.unlocked, false);
  const afterRestart = await request('/api/vault/unlock', { method: 'POST', headers: auth, body: JSON.stringify({ password }) });
  assert.equal(afterRestart.response.status, 429);
  assert.equal(afterRestart.body.error, 'vault_unlock_throttled');

  timestamp += 15 * 60 * 1000;
  const afterExpiry = await request('/api/vault/unlock', { method: 'POST', headers: auth, body: JSON.stringify({ password }) });
  assert.equal(afterExpiry.response.status, 200);
});

test('login and vault unlock throttles stay isolated for the same user', async (t) => {
  let timestamp = Date.UTC(2026, 10, 6);
  const { request, setup } = await setupServer(t, { now: () => timestamp });
  const { cookie } = await setup();
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };
  const password = 'vault-isolation-password-2026';
  const created = await request('/api/vault/setup', {
    method: 'POST', headers: auth, body: JSON.stringify({ password }),
  });
  assert.equal(created.response.status, 201);
  await request('/api/vault/lock', { method: 'POST', headers: auth, body: '{}' });

  for (let index = 0; index < 5; index += 1) {
    const failed = await request('/api/vault/unlock', {
      method: 'POST', headers: auth, body: JSON.stringify({ password: `wrong-vault-isolation-${index}-2026` }),
    });
    assert.equal(failed.response.status, 401);
  }
  const vaultLimited = await request('/api/vault/unlock', { method: 'POST', headers: auth, body: JSON.stringify({ password }) });
  assert.equal(vaultLimited.response.status, 429);
  assert.equal(vaultLimited.body.error, 'vault_unlock_throttled');

  const loginDuringVaultLock = await request('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'local-test-passphrase-2026' }),
  });
  assert.equal(loginDuringVaultLock.response.status, 200);

  timestamp += 15 * 60 * 1000;
  const unlockAfterVaultExpiry = await request('/api/vault/unlock', { method: 'POST', headers: auth, body: JSON.stringify({ password }) });
  assert.equal(unlockAfterVaultExpiry.response.status, 200);
  await request('/api/vault/lock', { method: 'POST', headers: auth, body: '{}' });

  for (let index = 0; index < 5; index += 1) {
    const failed = await request('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: `wrong-login-isolation-${index}-2026` }),
    });
    assert.equal(failed.response.status, 401);
  }
  const loginLimited = await request('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'local-test-passphrase-2026' }),
  });
  assert.equal(loginLimited.response.status, 429);
  assert.equal(loginLimited.body.error, 'login_throttled');

  const unlockDuringLoginLock = await request('/api/vault/unlock', { method: 'POST', headers: auth, body: JSON.stringify({ password }) });
  assert.equal(unlockDuringLoginLock.response.status, 200);
});

test('SMB status is admin-only and never claims Nanako sharing is ready', async (t) => {
  let probeCount = 0;
  const { request, setup } = await setupServer(t, {
    smbStatusProbe: async () => {
      probeCount += 1;
      return { supported: true, detected: true, serverService: 'Running', port445Listening: true, shareManagementAvailable: true, message: null };
    },
  });
  const { cookie, shareId } = await setup();
  const adminStatus = await request('/api/smb/status', { headers: { Cookie: cookie } });
  assert.equal(adminStatus.response.status, 200);
  assert.equal(adminStatus.body.serverService, 'Running');
  assert.equal(adminStatus.body.port445Listening, true);
  assert.equal(adminStatus.body.nanakoSmbReady, false);
  assert.equal(adminStatus.body.experimentalSmb.enabled, false);
  assert.equal(adminStatus.body.experimentalSmb.serviceReady, false);
  assert.equal(probeCount, 1);

  const created = await request('/api/users', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'regular', password: 'regular-test-passphrase-2026', permissions: [{ shareId, canRead: true, canWrite: false }] }),
  });
  assert.equal(created.response.status, 201);
  const login = await request('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'regular', password: 'regular-test-passphrase-2026' }),
  });
  const denied = await request('/api/smb/status', { headers: { Cookie: login.response.headers.get('set-cookie').split(';')[0] } });
  assert.equal(denied.response.status, 403);
  assert.equal(probeCount, 1);
});

test('Windows SMB status probe validates the host response and avoids invoking PowerShell off Windows', async () => {
  let called = false;
  const unsupported = await readWindowsSmbStatus({ platform: 'linux', run: async () => { called = true; } });
  assert.equal(unsupported.supported, false);
  assert.equal(called, false);

  const detected = await readWindowsSmbStatus({
    platform: 'win32',
    run: async (file, args) => {
      assert.equal(file, 'powershell.exe');
      assert.equal(args.includes('-NoProfile'), true);
      return { stdout: JSON.stringify({
        serverService: 'Running', port445Listening: true, shareManagementAvailable: true,
        productName: 'Windows 11 Pro', displayVersion: '24H2', currentBuild: 26100, supportsExperimentalSmb: true,
      }) };
    },
  });
  assert.equal(detected.detected, true);
  assert.equal(detected.serverService, 'Running');
  assert.equal(detected.port445Listening, true);
  assert.deepEqual(detected.windowsVersion, { productName: 'Windows 11 Pro', displayVersion: '24H2', currentBuild: 26100, supportsExperimentalSmb: true });

  const malformed = await readWindowsSmbStatus({ platform: 'win32', run: async () => ({ stdout: '{"serverService":"Running"}' }) });
  assert.equal(malformed.detected, false);
  assert.equal(malformed.serverService, 'Unknown');
  assert.equal(malformed.windowsVersion.supportsExperimentalSmb, false);
});

test('experimental SMB is restricted to Windows 11 24H2+, defaults off and clears after a downgrade', async (t) => {
  assert.equal(isWindows11_24H2OrLater({ productName: 'Windows 11 Pro', currentBuild: 26100 }), true);
  assert.equal(isWindows11_24H2OrLater({ productName: 'Windows 11 Pro', currentBuild: 22631 }), false);
  assert.equal(isWindows11_24H2OrLater({ productName: 'Windows Server 2025 Standard', currentBuild: 26100 }), false);
  const versionStatus = (productName, displayVersion, currentBuild) => ({
    supported: true,
    detected: true,
    serverService: 'Stopped',
    port445Listening: false,
    shareManagementAvailable: true,
    message: null,
    windowsVersion: {
      productName,
      displayVersion,
      currentBuild,
      supportsExperimentalSmb: isWindows11_24H2OrLater({ productName, currentBuild }),
    },
  });
  let smbStatus = versionStatus('Windows 10 Pro', '22H2', 19045);
  const harness = await setupServer(t, { smbStatusProbe: async () => smbStatus });
  const { cookie } = await harness.setup();
  const auth = { Cookie: cookie, 'Content-Type': 'application/json' };

  const windows10 = await harness.request('/api/smb/status', { headers: { Cookie: cookie } });
  assert.equal(windows10.body.experimentalSmb.supportedOs, false);
  assert.equal(windows10.body.experimentalSmb.enabled, false);
  const rejected = await harness.request('/api/smb/experimental', {
    method: 'POST', headers: auth, body: JSON.stringify({ enabled: true }),
  });
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.error, 'smb_os_not_supported');

  smbStatus = versionStatus('Windows 11 Pro', '23H2', 22631);
  const windows11_23h2 = await harness.request('/api/smb/status', { headers: { Cookie: cookie } });
  assert.equal(windows11_23h2.body.experimentalSmb.supportedOs, false);

  smbStatus = versionStatus('Windows 11 Pro', '24H2', 26100);
  const supported = await harness.request('/api/smb/status', { headers: { Cookie: cookie } });
  assert.equal(supported.body.experimentalSmb.supportedOs, true);
  assert.equal(supported.body.experimentalSmb.enabled, false, 'the supported OS default is still disabled');
  const enabled = await harness.request('/api/smb/experimental', {
    method: 'POST', headers: auth, body: JSON.stringify({ enabled: true }),
  });
  assert.equal(enabled.response.status, 200);
  assert.equal(enabled.body.experimentalSmb.enabled, true);
  assert.equal(enabled.body.experimentalSmb.serviceReady, false, 'the option does not claim a running server');

  await harness.restart();
  const persisted = await harness.request('/api/smb/status', { headers: { Cookie: cookie } });
  assert.equal(persisted.body.experimentalSmb.enabled, true);

  smbStatus = versionStatus('Windows 10 Pro', '22H2', 19045);
  const downgraded = await harness.request('/api/smb/status', { headers: { Cookie: cookie } });
  assert.equal(downgraded.body.experimentalSmb.enabled, false);
  smbStatus = versionStatus('Windows 11 Pro', '24H2', 26100);
  const upgradedAgain = await harness.request('/api/smb/status', { headers: { Cookie: cookie } });
  assert.equal(upgradedAgain.body.experimentalSmb.enabled, false, 'a stale enabled preference is cleared on unsupported OS');

  const regularUser = await harness.request('/api/users', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ username: 'regular-smb', password: 'regular-smb-passphrase-2026', permissions: [] }),
  });
  assert.equal(regularUser.response.status, 201);
  const login = await harness.request('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'regular-smb', password: 'regular-smb-passphrase-2026' }),
  });
  const denied = await harness.request('/api/smb/experimental', {
    method: 'POST', headers: { Cookie: login.response.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(denied.response.status, 403);
});
