import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { scanManagedDuplicates } from '../src/duplicates.mjs';

async function withTempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nanako-dedupe-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

test('duplicate scanner groups identical bytes, not matching names or sizes', async (t) => {
  const root = await withTempRoot(t);
  await mkdir(path.join(root, 'nested'));
  await mkdir(path.join(root, '.nanako-trash'));
  await mkdir(path.join(root, '.localnas-stage'));
  await writeFile(path.join(root, 'one.txt'), 'same bytes');
  await writeFile(path.join(root, 'nested', 'renamed.bin'), 'same bytes');
  await writeFile(path.join(root, 'same-size.txt'), 'same byteS');
  await writeFile(path.join(root, 'one.txt.copy'), 'different size');
  await writeFile(path.join(root, '.nanako-trash', 'trashed.txt'), 'same bytes');
  await writeFile(path.join(root, '.localnas-stage', 'temporary.txt'), 'same bytes');

  const progress = [];
  const result = await scanManagedDuplicates({ root, onProgress: (value) => progress.push(value) });
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].items.map((item) => item.path), ['nested/renamed.bin', 'one.txt']);
  assert.equal(result.groups[0].size, Buffer.byteLength('same bytes'));
  assert.equal(result.scannedFiles, 4);
  assert.equal(result.comparedFiles, 3);
  assert.equal(result.candidateFiles, 3);
  assert.ok(progress.some((item) => item.phase === 'hashing'));
});

test('duplicate scanner ignores symbolic links and never follows them', async (t) => {
  const root = await withTempRoot(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'nanako-dedupe-outside-'));
  t.after(async () => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'outside.txt'), 'private external file');
  try {
    await symlink(outside, path.join(root, 'external-link'), 'junction');
  } catch (error) {
    t.skip(`Symbolic link creation is unavailable: ${error.code}`);
  }
  const result = await scanManagedDuplicates({ root });
  assert.equal(result.scannedFiles, 0);
  assert.equal(result.groups.length, 0);
  await assert.rejects(
    scanManagedDuplicates({ root: path.join(root, 'external-link') }),
    (error) => error.code === 'UNSAFE_SCAN_ROOT',
  );
});

test('duplicate scanner requires an absolute managed root', async () => {
  await assert.rejects(scanManagedDuplicates({ root: 'relative-folder' }), /絕對路徑/u);
  await assert.rejects(scanManagedDuplicates(), /絕對路徑/u);
});

test('duplicate scanner supports cancellation and entry-count limits', async (t) => {
  const root = await withTempRoot(t);
  await writeFile(path.join(root, 'one'), 'content');
  await writeFile(path.join(root, 'two'), 'content');
  await assert.rejects(
    scanManagedDuplicates({ root, shouldContinue: () => false }),
    (error) => error.name === 'AbortError',
  );
  await assert.rejects(
    scanManagedDuplicates({ root, maxEntries: 1 }),
    (error) => error.code === 'SCAN_TOO_MANY_ENTRIES',
  );
});
