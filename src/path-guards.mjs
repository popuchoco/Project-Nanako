import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fail } from './http-utils.mjs';

export function safeName(value) {
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

export function relativeParts(value) {
  if (typeof value !== 'string' || value.length > 2048) throw fail(400, 'invalid_path', '路徑不正確。');
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/u.test(normalized)) throw fail(400, 'invalid_path', '不能使用絕對路徑。');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) throw fail(400, 'invalid_path', '路徑不正確。');
  return parts;
}

export function resolveInside(root, relative = '') {
  const parts = relativeParts(relative);
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts);
  const rel = path.relative(base, target);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw fail(400, 'invalid_path', '路徑超出分享範圍。');
  return { target, parts };
}

export function resolveShareInside(root, relative = '') {
  const resolved = resolveInside(root, relative);
  if (resolved.parts.some((part) => part.toLocaleLowerCase('en-US') === '.nanako-trash')
    || resolved.parts.some((part) => part.toLocaleLowerCase('en-US').startsWith('.localnas-'))) {
    throw fail(404, 'not_found', '找不到這個項目。');
  }
  return resolved;
}

const MAX_COPY_ENTRIES = 100_000;

export async function measureCopyTree(source, totals = { bytes: 0, entries: 0 }) {
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

export async function copyManagedTree(source, destination, totals = { entries: 0 }) {
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

export async function itemExists(target) {
  try { await lstat(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export function createPathLockManager() {
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
  return { withPathLockKey, withPathLocks, withPathLock };
}

export async function rejectSymlinkTraversal(managedRoot, root, target, includeLeaf = true) {
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
