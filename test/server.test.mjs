import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import { startServer } from '../src/server.mjs';
import { readWindowsSmbStatus } from '../src/windows-smb-status.mjs';

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
  await request('/api/folders', { method: 'POST', headers: auth, body: JSON.stringify({ shareId, path: '', name: '紀錄測試' }) });
  const history = await request('/api/audit-logs', { headers: { Cookie: cookie } });
  assert.equal(history.response.status, 200);
  assert.ok(history.body.logs.some((item) => item.action === '開啟畫面' && item.target === '相簿'));
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

  const revoked = await request(`/api/users/${userId}`, { method: 'PATCH', headers: adminAuth, body: JSON.stringify({ isActive: true, permissions: [] }) });
  assert.equal(revoked.response.status, 200);
  const denied = await request('/api/shares', { headers: { Cookie: userCookie } });
  assert.equal(denied.response.status, 200);
  assert.deepEqual(denied.body.shares, []);

  const deactivated = await request(`/api/users/${userId}`, { method: 'PATCH', headers: adminAuth, body: JSON.stringify({ isActive: false, permissions: [{ shareId, canRead: true, canWrite: false }] }) });
  assert.equal(deactivated.response.status, 200);
  assert.equal((await request('/api/me', { headers: { Cookie: userCookie } })).response.status, 401);
  const blockedLogin = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'managed-user', password: 'managed-user-passphrase-2026' }) });
  assert.equal(blockedLogin.response.status, 401);

  const reactivated = await request(`/api/users/${userId}`, { method: 'PATCH', headers: adminAuth, body: JSON.stringify({ isActive: true, permissions: [{ shareId, canRead: true, canWrite: false }] }) });
  assert.equal(reactivated.response.status, 200);
  assert.equal(reactivated.body.user.isActive, 1);
  assert.equal(reactivated.body.user.permissions[0].canRead, true);
  assert.equal(reactivated.body.user.permissions[0].canWrite, false);
  const refreshedLogin = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'managed-user', password: 'managed-user-passphrase-2026' }) });
  assert.equal(refreshedLogin.response.status, 200);

  const selfEdit = await request(`/api/users/${adminUser.id}`, { method: 'PATCH', headers: adminAuth, body: JSON.stringify({ isActive: false, permissions: [] }) });
  assert.equal(selfEdit.response.status, 400);
  const history = await request('/api/audit-logs', { headers: { Cookie: adminCookie } });
  assert.ok(history.body.logs.filter((item) => item.action === '更新使用者權限').length >= 3);
});

test('users can change their own password and other sessions are revoked', async (t) => {
  const { request, setup } = await setupServer(t);
  const { cookie: originalCookie } = await setup();
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

test('SMB status is an administrator-only, read-only preflight and never claims Nanako sharing is ready', async (t) => {
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
      return { stdout: JSON.stringify({ serverService: 'Running', port445Listening: true, shareManagementAvailable: true }) };
    },
  });
  assert.equal(detected.detected, true);
  assert.equal(detected.serverService, 'Running');
  assert.equal(detected.port445Listening, true);

  const malformed = await readWindowsSmbStatus({ platform: 'win32', run: async () => ({ stdout: '{"serverService":"Running"}' }) });
  assert.equal(malformed.detected, false);
  assert.equal(malformed.serverService, 'Unknown');
});
