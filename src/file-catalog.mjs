import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import { fileCategory } from '../public/file-listing.mjs';

export const MAX_FILE_CATALOG_ENTRIES = 100_000;
export const MAX_FILE_CATALOG_RESULTS = 1_000;

function isSkippableFsError(error) {
  return ['ENOENT', 'EACCES', 'EPERM'].includes(error.code);
}

function catalogError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export async function searchManagedFiles({
  root,
  category,
  search = '',
  maxEntries = MAX_FILE_CATALOG_ENTRIES,
  maxResults = MAX_FILE_CATALOG_RESULTS,
  verifyPath = async () => {},
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('資料空間根目錄必須是絕對路徑。');
  if (!['image', 'video', 'audio', 'document', 'media'].includes(category)) throw catalogError(400, 'invalid_file_category', '檔案分類不正確。');
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || !Number.isInteger(maxResults) || maxResults < 1) throw new TypeError('檔案搜尋上限不正確。');

  const absoluteRoot = path.resolve(root);
  const rootInfo = await lstat(absoluteRoot).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw catalogError(404, 'share_not_found', '找不到可搜尋的 Nanako 資料空間。');
  }

  const rawQuery = String(search).trim();
  if (rawQuery.length > 180) throw catalogError(400, 'search_query_too_long', '搜尋文字最多 180 個字元。');
  const query = rawQuery.toLocaleLowerCase('zh-TW');
  const pending = [{ directory: absoluteRoot, relativeDirectory: '' }];
  const items = [];
  let scannedEntries = 0;
  let skippedEntries = 0;
  let truncated = false;

  while (pending.length && !truncated) {
    const current = pending.pop();
    await verifyPath(current.directory);
    const currentInfo = await lstat(current.directory).catch((error) => {
      if (isSkippableFsError(error)) return null;
      throw error;
    });
    if (!currentInfo || currentInfo.isSymbolicLink() || !currentInfo.isDirectory()) {
      skippedEntries += 1;
      continue;
    }

    let directory;
    try { directory = await opendir(current.directory); }
    catch (error) {
      if (!isSkippableFsError(error)) throw error;
      skippedEntries += 1;
      continue;
    }

    try {
      for await (const entry of directory) {
        const lowerName = entry.name.toLocaleLowerCase('en-US');
        if (lowerName === '.nanako-trash' || lowerName.startsWith('.localnas-')) continue;
        scannedEntries += 1;
        if (scannedEntries > maxEntries) {
          throw catalogError(413, 'file_catalog_too_many_entries', `單次分類搜尋最多可檢查 ${maxEntries.toLocaleString('zh-TW')} 個項目。`);
        }

        const absolutePath = path.join(current.directory, entry.name);
        const relativePath = current.relativeDirectory ? `${current.relativeDirectory}/${entry.name}` : entry.name;
        await verifyPath(absolutePath);
        const info = await lstat(absolutePath).catch((error) => {
          if (isSkippableFsError(error)) return null;
          throw error;
        });
        if (!info || info.isSymbolicLink()) {
          skippedEntries += 1;
          continue;
        }
        if (info.isDirectory()) {
          pending.push({ directory: absolutePath, relativeDirectory: relativePath });
          continue;
        }
        const kind = fileCategory(entry.name);
        if (!info.isFile() || (category === 'media' ? !['audio', 'video'].includes(kind) : kind !== category)) continue;
        if (query && !entry.name.toLocaleLowerCase('zh-TW').includes(query)) continue;
        if (items.length === maxResults) { truncated = true; break; }
        items.push({ name: entry.name, path: relativePath, isDirectory: false, size: info.size, modifiedAt: info.mtime.toISOString() });
      }
    } catch (error) {
      if (!isSkippableFsError(error)) throw error;
      skippedEntries += 1;
    } finally {
      await directory.close().catch(() => {});
    }
  }

  items.sort((a, b) => a.path.localeCompare(b.path, 'zh-TW', { numeric: true }));
  return { items, scannedEntries, skippedEntries, truncated };
}
