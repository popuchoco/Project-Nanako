import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_DUPLICATE_SCAN_ENTRIES = 100_000;

function abortError() {
  const error = new Error('掃描已取消。');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function sameFileSnapshot(before, after, bytesRead) {
  return before.isFile()
    && after.isFile()
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs
    && before.dev === after.dev
    && before.ino === after.ino
    && bytesRead === before.size;
}

export async function hashManagedFile(filePath, { signal } = {}) {
  throwIfAborted(signal);
  const before = await lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    const error = new Error('不是可掃描的一般檔案。');
    error.code = 'UNSUPPORTED_FILE';
    throw error;
  }
  const hash = crypto.createHash('sha256');
  let bytesRead = 0;
  for await (const chunk of createReadStream(filePath, { signal })) {
    throwIfAborted(signal);
    bytesRead += chunk.length;
    hash.update(chunk);
  }
  throwIfAborted(signal);
  const after = await lstat(filePath);
  if (after.isSymbolicLink() || !sameFileSnapshot(before, after, bytesRead)) {
    const error = new Error('掃描期間檔案有所變動，已略過此項目。');
    error.code = 'FILE_CHANGED';
    throw error;
  }
  return {
    digest: hash.digest('hex'),
    size: before.size,
    modifiedAt: before.mtime.toISOString(),
    mtimeMs: before.mtimeMs,
    ctimeMs: before.ctimeMs,
    dev: before.dev,
    ino: before.ino,
  };
}

export async function scanManagedDuplicates({
  root,
  signal,
  onProgress = () => {},
  shouldContinue = () => true,
  maxEntries = MAX_DUPLICATE_SCAN_ENTRIES,
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('掃描根目錄必須是絕對路徑。');
  const absoluteRoot = path.resolve(root);
  const rootInfo = await lstat(absoluteRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    const error = new Error('Nanako 管理的資料空間目前無法安全掃描。');
    error.code = 'UNSAFE_SCAN_ROOT';
    throw error;
  }

  const files = [];
  let visitedEntries = 0;
  let skippedFiles = 0;
  const report = (progress) => onProgress({
    phase: progress.phase,
    visitedEntries,
    scannedFiles: files.length,
    skippedFiles,
    ...progress,
  });

  async function visit(directory, relativeDirectory = '') {
    throwIfAborted(signal);
    if (!shouldContinue()) throw abortError();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      throwIfAborted(signal);
      if (!shouldContinue()) throw abortError();
      const lowerName = entry.name.toLocaleLowerCase('en-US');
      if (lowerName === '.nanako-trash' || lowerName.startsWith('.localnas-')) continue;
      visitedEntries += 1;
      if (visitedEntries > maxEntries) {
        const error = new Error(`單次掃描最多可檢查 ${maxEntries.toLocaleString('zh-TW')} 個項目。`);
        error.code = 'SCAN_TOO_MANY_ENTRIES';
        throw error;
      }
      const absolutePath = path.join(directory, entry.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const info = await lstat(absolutePath).catch((error) => {
        if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM') return null;
        throw error;
      });
      if (!info || info.isSymbolicLink()) {
        skippedFiles += Number(Boolean(info?.isFile()));
        report({ phase: 'enumerating' });
        continue;
      }
      if (info.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (info.isFile()) {
        files.push({ path: relativePath, size: info.size });
        report({ phase: 'enumerating' });
      } else {
        skippedFiles += 1;
        report({ phase: 'enumerating' });
      }
    }
  }

  report({ phase: 'enumerating' });
  await visit(absoluteRoot);
  const bySize = new Map();
  for (const item of files) {
    if (!bySize.has(item.size)) bySize.set(item.size, []);
    bySize.get(item.size).push(item);
  }
  const candidates = [...bySize.values()].filter((items) => items.length > 1).flat();
  const candidatePaths = new Set(candidates.map((item) => item.path));
  const hashedGroups = new Map();
  let comparedFiles = 0;
  let bytesHashed = 0;
  report({ phase: 'hashing', totalFiles: candidates.length, comparedFiles, bytesHashed });

  for (const item of candidates) {
    throwIfAborted(signal);
    if (!shouldContinue()) throw abortError();
    try {
      const fingerprint = await hashManagedFile(path.join(absoluteRoot, ...item.path.split('/')), { signal });
      bytesHashed += fingerprint.size;
      const key = `${fingerprint.size}\0${fingerprint.digest}`;
      if (!hashedGroups.has(key)) hashedGroups.set(key, { digest: fingerprint.digest, size: fingerprint.size, items: [] });
      hashedGroups.get(key).items.push({
        path: item.path,
        name: path.posix.basename(item.path),
        size: fingerprint.size,
        modifiedAt: fingerprint.modifiedAt,
        mtimeMs: fingerprint.mtimeMs,
        ctimeMs: fingerprint.ctimeMs,
        dev: fingerprint.dev,
        ino: fingerprint.ino,
      });
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw abortError();
      if (['FILE_CHANGED', 'UNSUPPORTED_FILE', 'ENOENT', 'EACCES', 'EPERM'].includes(error.code)) skippedFiles += 1;
      else throw error;
    }
    comparedFiles += 1;
    report({ phase: 'hashing', totalFiles: candidates.length, comparedFiles, bytesHashed });
  }

  const groups = [...hashedGroups.values()]
    .filter((group) => group.items.length > 1)
    .map((group) => ({ ...group, id: crypto.randomUUID(), items: group.items.sort((a, b) => a.path.localeCompare(b.path, 'zh-TW', { numeric: true })) }))
    .sort((a, b) => a.size - b.size || a.items[0].path.localeCompare(b.items[0].path, 'zh-TW', { numeric: true }));

  return {
    groups,
    visitedEntries,
    scannedFiles: files.length,
    comparedFiles,
    skippedFiles,
    bytesHashed,
    candidateFiles: candidatePaths.size,
  };
}
