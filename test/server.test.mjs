import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../src/server.mjs';

async function setupServer(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'localnas-test-'));
  const server = await startServer({ dataDir, host: '127.0.0.1', port: 0, ...options });
  t.after(async () => { await server.close(); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.port}`;
  async function request(url, options = {}) {
    const response = await fetch(`${base}${url}`, { ...options, redirect: 'manual' });
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();
    return { response, body };
  }
  async function setup() {
    const { response, body } = await request('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ username: 'admin', password: 'local-test-passphrase-2026' }) });
    assert.equal(response.status, 201);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const shares = await request('/api/shares', { headers: { Cookie: cookie } });
    return { cookie, shareId: shares.body.shares[0].id, user: body.user };
  }
  return { base, dataDir, request, setup };
}

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
  assert.ok(adminInfo.body.memory.totalBytes > 0);
  const addUser = await request('/api/users', { method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sys-viewer', password: 'system-viewer-passphrase-2026', permissions: [] }) });
  assert.equal(addUser.response.status, 201);
  const login = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sys-viewer', password: 'system-viewer-passphrase-2026' }) });
  const denied = await request('/api/system', { headers: { Cookie: login.response.headers.get('set-cookie').split(';')[0] } });
  assert.equal(denied.response.status, 403);
});
