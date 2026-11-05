import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { searchManagedFiles } from '../src/file-catalog.mjs';

async function withRoot(run) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'nanako-catalog-'));
  const root = path.join(parent, 'share');
  await mkdir(root);
  try { await run({ parent, root }); }
  finally { await rm(parent, { recursive: true, force: true }); }
}

test('category catalog searches nested files, filters by name and skips Nanako internals', async () => {
  await withRoot(async ({ root }) => {
    await mkdir(path.join(root, '相簿', '旅行'), { recursive: true });
    await mkdir(path.join(root, '.nanako-trash'));
    await mkdir(path.join(root, '.localnas-upload-temp'));
    await writeFile(path.join(root, '封面.JPG'), 'image');
    await writeFile(path.join(root, '相簿', '旅行', '海邊.png'), 'nested image');
    await writeFile(path.join(root, '相簿', '旅行', '海邊.mp4'), 'video');
    await writeFile(path.join(root, '.nanako-trash', 'removed.jpg'), 'trash');
    await writeFile(path.join(root, '.localnas-upload-temp', 'partial.jpg'), 'temp');

    const result = await searchManagedFiles({ root, category: 'image', search: '海邊' });
    assert.deepEqual(result.items.map((item) => item.path), ['相簿/旅行/海邊.png']);
    assert.equal(result.items[0].size, Buffer.byteLength('nested image'));
    assert.equal(result.items[0].isDirectory, false);
    assert.equal(result.truncated, false);
    assert.equal(result.skippedEntries, 0);
  });
});

test('category catalog does not follow symlinks and verifies every visited path', async (t) => {
  await withRoot(async ({ parent, root }) => {
    const outside = path.join(parent, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'outside.jpg'), 'outside');
    try { await symlink(outside, path.join(root, 'junction'), 'junction'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) return t.skip('目前 Windows 環境不允許建立測試用符號連結。');
      throw error;
    }
    const checked = [];
    const result = await searchManagedFiles({ root, category: 'image', verifyPath: async (target) => checked.push(target) });
    assert.deepEqual(result.items, []);
    assert.equal(result.skippedEntries, 1);
    assert.ok(checked.every((target) => target.startsWith(root)));
  });
});

test('category catalog enforces scan and result limits', async () => {
  await withRoot(async ({ root }) => {
    await writeFile(path.join(root, 'one.jpg'), '1');
    await writeFile(path.join(root, 'two.jpg'), '2');
    await assert.rejects(searchManagedFiles({ root, category: 'image', maxEntries: 1 }), { code: 'file_catalog_too_many_entries', status: 413 });
    const limited = await searchManagedFiles({ root, category: 'image', maxResults: 1 });
    assert.equal(limited.items.length, 1);
    assert.equal(limited.truncated, true);
  });
});

test('category catalog validates query and category', async () => {
  await withRoot(async ({ root }) => {
    await assert.rejects(searchManagedFiles({ root, category: 'all' }), { code: 'invalid_file_category', status: 400 });
    await assert.rejects(searchManagedFiles({ root, category: 'image', search: 'x'.repeat(181) }), { code: 'search_query_too_long', status: 400 });
  });
});
