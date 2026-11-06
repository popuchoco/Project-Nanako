import { createReadStream, createWriteStream, openAsBlob } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { BlobReader, ZipReader, ZipWriter } from '@zip.js/zip.js';

const MAX_ENTRIES = 10_000;
const MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 21 * 1024 * 1024 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;

function archiveError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateName(value) {
  if (!value || value.length > 180 || value === '.' || value === '..'
    || /[\\/\0<>:"|?*]/u.test(value) || /[. ]$/u.test(value)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu.test(value)) {
    throw archiveError(400, 'invalid_archive_path', 'ZIP 內含 Windows 不支援的檔名。');
  }
}

function validatedEntryPath(entry) {
  const raw = entry.filename;
  if (typeof raw !== 'string' || !raw || raw.length > 2048 || raw.includes('\\') || raw.includes('\0')
    || raw.startsWith('/') || /^[a-zA-Z]:/u.test(raw) || raw.startsWith('//')) {
    throw archiveError(400, 'invalid_archive_path', 'ZIP 內含不安全的路徑。');
  }
  const directory = Boolean(entry.directory);
  if (directory !== raw.endsWith('/')) throw archiveError(400, 'invalid_archive_path', 'ZIP 內含不一致的資料夾路徑。');
  const pathValue = directory ? raw.slice(0, -1) : raw;
  const parts = pathValue.split('/');
  if (!parts.length || parts.length > 64 || parts.some((part) => !part || part === '.' || part === '..')) {
    throw archiveError(400, 'invalid_archive_path', 'ZIP 內含不安全的路徑。');
  }
  parts.forEach(validateName);
  return { parts, directory, relative: parts.join('/') };
}

async function walk(source, base, rows, totals, depth = 0, signal, onProgress) {
  if (signal?.aborted) throw archiveError(499, 'archive_cancelled', 'ZIP 作業已取消。');
  if (depth > 64) throw archiveError(413, 'archive_limit_exceeded', '資料夾層數超過 ZIP 上限。');
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-TW', { numeric: true }));
  for (const entry of entries) {
    if (signal?.aborted) throw archiveError(499, 'archive_cancelled', 'ZIP 作業已取消。');
    if (entry.name.startsWith('.localnas-')) continue;
    const target = path.join(source, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw archiveError(400, 'unsupported_archive_source', 'ZIP 不能包含符號連結或特殊檔案。');
    }
    const relative = path.relative(base, target).split(path.sep).join('/');
    const parts = relative.split('/');
    if (parts.length > 64) throw archiveError(413, 'archive_limit_exceeded', '資料夾層數超過 ZIP 上限。');
    parts.forEach(validateName);
    rows.push({ target, relative, directory: info.isDirectory(), size: info.size, mtime: info.mtime, mtimeMs: info.mtimeMs });
    if (rows.length > MAX_ENTRIES) throw archiveError(413, 'archive_limit_exceeded', 'ZIP 項目數不得超過 10,000 個。');
    if (info.isFile()) {
      totals.bytes += info.size;
      if (totals.bytes > MAX_UNCOMPRESSED_BYTES) throw archiveError(413, 'archive_limit_exceeded', 'ZIP 內容總大小不得超過 20 GiB。');
    } else {
      await walk(target, base, rows, totals, depth + 1, signal, onProgress);
    }
    onProgress?.({ phase: '掃描檔案清單', bytesRead: totals.bytes, totalBytes: totals.bytes, entriesDone: rows.length, totalEntries: null });
  }
}

export async function createArchive({ sourcePath, shareRoot, archivePath, signal, onProgress }) {
  if (!inside(shareRoot, sourcePath) || !inside(shareRoot, archivePath)) throw archiveError(400, 'invalid_path', 'ZIP 路徑必須位於 Nanako 資料空間內。');
  const sourceInfo = await lstat(sourcePath).catch(() => null);
  if (!sourceInfo || sourceInfo.isSymbolicLink() || (!sourceInfo.isFile() && !sourceInfo.isDirectory())) {
    throw archiveError(404, 'archive_source_not_found', '找不到要壓縮的檔案或資料夾。');
  }
  if (await lstat(archivePath).catch(() => null)) throw archiveError(409, 'already_exists', '同名 ZIP 檔案已存在。');
  const rootName = path.basename(sourcePath);
  validateName(rootName);
  const rows = [];
  const totals = { bytes: 0 };
  if (sourceInfo.isDirectory()) {
    rows.push({ target: sourcePath, relative: '', directory: true, size: 0, mtime: sourceInfo.mtime });
    await walk(sourcePath, sourcePath, rows, totals, 0, signal, onProgress);
  } else {
    totals.bytes = sourceInfo.size;
    if (totals.bytes > MAX_UNCOMPRESSED_BYTES) throw archiveError(413, 'archive_limit_exceeded', 'ZIP 內容總大小不得超過 20 GiB。');
    rows.push({ target: sourcePath, relative: rootName, directory: false, size: sourceInfo.size, mtime: sourceInfo.mtime, mtimeMs: sourceInfo.mtimeMs });
  }
  if (rows.length > MAX_ENTRIES) throw archiveError(413, 'archive_limit_exceeded', 'ZIP 項目數不得超過 10,000 個。');

  const temporaryPath = path.join(path.dirname(archivePath), `.localnas-archive-${randomUUID()}.tmp`);
  let writer;
  let completedBytes = 0;
  try {
    const output = Writable.toWeb(createWriteStream(temporaryPath, { flags: 'wx' }));
    writer = new ZipWriter(output, { zip64: true, bufferedWrite: false, useWebWorkers: false });
    for (const row of rows) {
      if (signal?.aborted) throw archiveError(499, 'archive_cancelled', 'ZIP 作業已取消。');
      const entryName = sourceInfo.isDirectory()
        ? (row.relative ? `${rootName}/${row.relative}` : `${rootName}/`)
        : rootName;
      if (row.directory) {
        await writer.add(entryName.endsWith('/') ? entryName : `${entryName}/`, null, { lastModDate: row.mtime });
      } else {
        const before = await lstat(row.target);
        if (!before.isFile() || before.size !== row.size || before.mtimeMs !== row.mtimeMs) throw archiveError(409, 'source_changed', '壓縮期間來源檔案有所變更，請重新操作。');
        await writer.add(entryName, Readable.toWeb(createReadStream(row.target, { signal })), {
          level: 6,
          lastModDate: row.mtime,
          signal,
          onprogress: (progress) => onProgress?.({
            phase: '建立 ZIP', bytesRead: Math.min(totals.bytes, completedBytes + progress), totalBytes: totals.bytes,
            entriesDone: rows.indexOf(row), totalEntries: rows.length,
          }),
        });
        completedBytes += row.size;
        const after = await lstat(row.target);
        if (!after.isFile() || after.size !== row.size || after.mtimeMs !== row.mtimeMs) throw archiveError(409, 'source_changed', '壓縮期間來源檔案有所變更，請重新操作。');
      }
    }
    if (signal?.aborted) throw archiveError(499, 'archive_cancelled', 'ZIP 作業已取消。');
    onProgress?.({ phase: '完成 ZIP 索引', bytesRead: totals.bytes, totalBytes: totals.bytes, entriesDone: rows.length, totalEntries: rows.length });
    await writer.close();
    if (signal?.aborted) throw archiveError(499, 'archive_cancelled', 'ZIP 作業已取消。');
    const outputInfo = await stat(temporaryPath);
    if (!outputInfo.isFile() || outputInfo.size === 0) throw archiveError(500, 'archive_write_failed', 'ZIP 檔案建立失敗。');
    onProgress?.({ phase: '發佈 ZIP 成品', bytesRead: totals.bytes, totalBytes: totals.bytes, entriesDone: rows.length, totalEntries: rows.length });
    if (signal?.aborted) throw archiveError(499, 'archive_cancelled', 'ZIP 作業已取消。');
    await rename(temporaryPath, archivePath);
    return { size: outputInfo.size, entryCount: rows.length, sourceBytes: totals.bytes };
  } catch (error) {
    try { await writer?.close(); } catch { /* remove partial output below */ }
    await rm(temporaryPath, { force: true }).catch(() => {});
    if (signal?.aborted || error.code === 'ABORT_ERR') throw archiveError(499, 'archive_cancelled', 'ZIP 作業已取消；暫存檔已清除。');
    throw error;
  }
}

async function preflightCentralDirectory(archivePath, archiveSize) {
  if (archiveSize > MAX_ARCHIVE_BYTES) throw archiveError(413, 'archive_limit_exceeded', 'ZIP 檔案不得大於 21 GiB。');
  const handle = await (await import('node:fs/promises')).open(archivePath, 'r');
  try {
    const tailLength = Math.min(archiveSize, 22 + 65_535 + 20 + 56);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, archiveSize - tailLength);
    let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === 0x06054b50) {
        const commentLength = tail.readUInt16LE(index + 20);
        if (index + 22 + commentLength === tail.length) { eocd = index; break; }
      }
    }
    if (eocd < 0) throw archiveError(400, 'invalid_archive', 'ZIP 中央目錄不完整或檔案已損毀。');
    const eocdOffset = archiveSize - tailLength + eocd;
    let disk = tail.readUInt16LE(eocd + 4);
    let centralDisk = tail.readUInt16LE(eocd + 6);
    let entriesOnDisk = tail.readUInt16LE(eocd + 8);
    let entries = tail.readUInt16LE(eocd + 10);
    let centralSize = tail.readUInt32LE(eocd + 12);
    let centralOffset = tail.readUInt32LE(eocd + 16);
    const zip64 = disk === 0xffff || centralDisk === 0xffff || entriesOnDisk === 0xffff || entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff;
    if (!zip64 && (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries)) throw archiveError(400, 'unsupported_archive', '不支援跨磁碟 ZIP。');
    if (zip64) {
      const locatorOffset = eocdOffset - 20;
      const locator = Buffer.alloc(20);
      if (locatorOffset < 0) throw archiveError(400, 'invalid_archive', 'ZIP64 中央目錄不完整。');
      await handle.read(locator, 0, locator.length, locatorOffset);
      if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) throw archiveError(400, 'unsupported_archive', '不支援多磁碟 ZIP64。');
      const recordOffsetBig = locator.readBigUInt64LE(8);
      if (recordOffsetBig > BigInt(Number.MAX_SAFE_INTEGER)) throw archiveError(413, 'archive_limit_exceeded', 'ZIP64 中央目錄位置超出支援範圍。');
      const record = Buffer.alloc(56);
      await handle.read(record, 0, record.length, Number(recordOffsetBig));
      if (record.readUInt32LE(0) !== 0x06064b50 || record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) throw archiveError(400, 'unsupported_archive', 'ZIP64 中央目錄格式不支援。');
      disk = record.readUInt32LE(16); centralDisk = record.readUInt32LE(20);
      const entriesOnDiskBig = record.readBigUInt64LE(24);
      const entriesBig = record.readBigUInt64LE(32);
      const centralSizeBig = record.readBigUInt64LE(40);
      const centralOffsetBig = record.readBigUInt64LE(48);
      if ([entriesOnDiskBig, entriesBig, centralSizeBig, centralOffsetBig].some((value) => value > BigInt(Number.MAX_SAFE_INTEGER))) throw archiveError(413, 'archive_limit_exceeded', 'ZIP64 中央目錄超出支援範圍。');
      entriesOnDisk = Number(entriesOnDiskBig);
      entries = Number(entriesBig); centralSize = Number(centralSizeBig); centralOffset = Number(centralOffsetBig);
    }
    if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries) throw archiveError(400, 'unsupported_archive', '不支援跨磁碟 ZIP。');
    if (entries > MAX_ENTRIES || centralSize > MAX_CENTRAL_DIRECTORY_BYTES || centralOffset + centralSize > eocdOffset) {
      throw archiveError(413, 'archive_limit_exceeded', 'ZIP 項目數或中央目錄大小超過上限。');
    }
    const centralDirectory = Buffer.alloc(centralSize);
    let bytesRead = 0;
    while (bytesRead < centralSize) {
      const result = await handle.read(centralDirectory, bytesRead, centralSize - bytesRead, centralOffset + bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== centralSize) throw archiveError(400, 'invalid_archive', 'ZIP 中央目錄不完整或檔案已損毀。');
    const filenames = new Set();
    let centralPosition = 0;
    for (let index = 0; index < entries; index += 1) {
      if (centralPosition + 46 > centralDirectory.length || centralDirectory.readUInt32LE(centralPosition) !== 0x02014b50) {
        throw archiveError(400, 'invalid_archive', 'ZIP 中央目錄不完整或檔案已損毀。');
      }
      const filenameLength = centralDirectory.readUInt16LE(centralPosition + 28);
      const extraLength = centralDirectory.readUInt16LE(centralPosition + 30);
      const commentLength = centralDirectory.readUInt16LE(centralPosition + 32);
      const filenameStart = centralPosition + 46;
      const nextPosition = filenameStart + filenameLength + extraLength + commentLength;
      if (nextPosition > centralDirectory.length) throw archiveError(400, 'invalid_archive', 'ZIP 中央目錄不完整或檔案已損毀。');
      const filename = centralDirectory.subarray(filenameStart, filenameStart + filenameLength).toString('hex');
      if (filenames.has(filename)) throw archiveError(400, 'archive_path_conflict', 'ZIP 內含重複或大小寫衝突的路徑。');
      filenames.add(filename);
      centralPosition = nextPosition;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

function validateEntries(entries) {
  if (!entries.length || entries.length > MAX_ENTRIES) throw archiveError(400, 'invalid_archive', 'ZIP 沒有項目或項目數超過上限。');
  let expanded = 0;
  const nodes = new Map();
  for (const entry of entries) {
    if (entry.encrypted || entry.symlink) throw archiveError(400, 'unsupported_archive', '不支援加密 ZIP 或符號連結項目。');
    const parsed = validatedEntryPath(entry);
    if (entry.uncompressedSize > MAX_UNCOMPRESSED_BYTES || entry.compressedSize < 0) throw archiveError(413, 'archive_limit_exceeded', 'ZIP 項目大小超過上限。');
    expanded += entry.uncompressedSize;
    if (expanded > MAX_UNCOMPRESSED_BYTES) throw archiveError(413, 'archive_limit_exceeded', 'ZIP 解壓縮後總大小不得超過 20 GiB。');
    if (entry.uncompressedSize > 1024 * 1024 && entry.uncompressedSize / Math.max(entry.compressedSize, 1) > 1000) throw archiveError(413, 'archive_limit_exceeded', 'ZIP 壓縮比過高，已拒絕解壓縮。');
    const key = parsed.relative.normalize('NFC').toLocaleLowerCase('en-US');
    const existing = nodes.get(key);
    if (existing && !(existing.directory && parsed.directory)) throw archiveError(400, 'archive_path_conflict', 'ZIP 內含重複或大小寫衝突的路徑。');
    if (existing?.directory && parsed.directory) throw archiveError(400, 'archive_path_conflict', 'ZIP 內含重複的資料夾項目。');
    nodes.set(key, { directory: parsed.directory, parts: parsed.parts });
    for (let index = 1; index < parsed.parts.length; index += 1) {
      const parent = parsed.parts.slice(0, index).join('/').normalize('NFC').toLocaleLowerCase('en-US');
      if (nodes.has(parent) && !nodes.get(parent).directory) throw archiveError(400, 'archive_path_conflict', 'ZIP 檔案路徑互相衝突。');
    }
    for (const [existingKey, node] of nodes) {
      if (existingKey !== key && existingKey.startsWith(`${key}/`) && !parsed.directory) throw archiveError(400, 'archive_path_conflict', 'ZIP 檔案路徑互相衝突。');
      if (key.startsWith(`${existingKey}/`) && !node.directory) throw archiveError(400, 'archive_path_conflict', 'ZIP 檔案路徑互相衝突。');
    }
  }
  return { expandedBytes: expanded, entryCount: entries.length };
}

export async function extractArchive({ archivePath, shareRoot, destinationPath, signal, onProgress }) {
  if (!inside(shareRoot, archivePath) || !inside(shareRoot, destinationPath)) throw archiveError(400, 'invalid_path', 'ZIP 路徑必須位於 Nanako 資料空間內。');
  const archiveInfo = await lstat(archivePath).catch(() => null);
  if (!archiveInfo?.isFile() || archiveInfo.isSymbolicLink()) throw archiveError(404, 'archive_not_found', '找不到 ZIP 檔案。');
  if (await lstat(destinationPath).catch(() => null)) throw archiveError(409, 'already_exists', '同名解壓縮資料夾已存在。');
  const expectedCount = await preflightCentralDirectory(archivePath, archiveInfo.size);
  const stagingPath = path.join(path.dirname(destinationPath), `.localnas-extract-${randomUUID()}`);
  let reader;
  try {
    reader = new ZipReader(new BlobReader(await openAsBlob(archivePath)), { strictness: 'strict', checkCrc32: true, checkOverlappingEntry: true, useWebWorkers: false });
    const entries = await reader.getEntries({ strictness: 'strict', filenameValidation: 'strict', includeDirectories: true });
    if (entries.length !== expectedCount) throw archiveError(400, 'invalid_archive', 'ZIP 中央目錄項目數不一致。');
    const summary = validateEntries(entries);
    await mkdir(stagingPath, { recursive: false });
    const rootName = path.basename(destinationPath);
    validateName(rootName);
    let completedBytes = 0; let completedEntries = 0;
    for (const entry of entries) {
      if (signal?.aborted) throw archiveError(499, 'archive_cancelled', 'ZIP 作業已取消。');
      const { parts, directory } = validatedEntryPath(entry);
      const relativeParts = entry.filename.startsWith(`${rootName}/`) ? parts.slice(1) : parts;
      if (!relativeParts.length) continue;
      const target = path.resolve(stagingPath, ...relativeParts);
      if (!inside(stagingPath, target)) throw archiveError(400, 'invalid_archive_path', 'ZIP 路徑超出解壓縮範圍。');
      if (directory) {
        await mkdir(target, { recursive: true });
        completedEntries += 1;
        onProgress?.({ phase: '解壓 ZIP', bytesRead: completedBytes, totalBytes: summary.expandedBytes, entriesDone: completedEntries, totalEntries: entries.length });
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      const output = Writable.toWeb(createWriteStream(target, { flags: 'wx', mode: 0o600, signal }));
      await entry.getData(output, {
        checkCrc32: true,
        checkOverlappingEntry: true,
        useWebWorkers: false,
        signal,
        onprogress: (progress) => onProgress?.({
          phase: '解壓 ZIP', bytesRead: Math.min(summary.expandedBytes, completedBytes + progress),
          totalBytes: summary.expandedBytes, entriesDone: completedEntries, totalEntries: entries.length,
        }),
      });
      completedBytes += entry.uncompressedSize;
      completedEntries += 1;
    }
    if (signal?.aborted) throw archiveError(499, 'archive_cancelled', 'ZIP 作業已取消。');
    await reader.close();
    reader = null;
    onProgress?.({ phase: '發佈解壓內容', bytesRead: summary.expandedBytes, totalBytes: summary.expandedBytes, entriesDone: entries.length, totalEntries: entries.length });
    if (signal?.aborted) throw archiveError(499, 'archive_cancelled', 'ZIP 作業已取消。');
    await rename(stagingPath, destinationPath);
    return summary;
  } catch (error) {
    await reader?.close().catch(() => {});
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    if (signal?.aborted || error.code === 'ABORT_ERR') throw archiveError(499, 'archive_cancelled', 'ZIP 作業已取消；暫存項目已清除。');
    if (error.status) throw error;
    throw archiveError(400, 'invalid_archive', 'ZIP 無法解壓縮，可能已損毀或使用不支援的格式。');
  }
}
