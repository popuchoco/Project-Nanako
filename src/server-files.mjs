import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, lstat, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { searchManagedFiles } from './file-catalog.mjs';
import { fail, json, mediaTypes, readJson } from './http-utils.mjs';
import {
  copyManagedTree,
  itemExists,
  measureCopyTree,
  rejectSymlinkTraversal,
  relativeParts,
  resolveShareInside,
  safeName,
} from './path-guards.mjs';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export function createFilesRouter(ctx) {
  const {
    db, dataDir, requirePermission, shareRoot, permission, managedTrashPath,
    withPathLock, withPathLocks,
  } = ctx;

  const fileRoutes = new Set([
    'GET /api/files', 'GET /api/files/search',
    'POST /api/folders', 'POST /api/files/rename', 'POST /api/files/move', 'POST /api/files/copy',
    'POST /api/upload', 'GET /api/preview', 'GET /api/download',
    'DELETE /api/files', 'GET /api/trash', 'POST /api/trash/restore', 'DELETE /api/trash',
  ]);

  async function dispatchFileRoute({ req, res, method, route, url, user, getAuditEvent, setAuditTarget, disableAudit }) {
        if (route === '/api/files' && method === 'GET') {
          const shareId = url.searchParams.get('shareId') || '';
          requirePermission(user, shareId);
          const { root } = shareRoot(shareId);
          const { target } = resolveShareInside(root, url.searchParams.get('path') || '');
          await rejectSymlinkTraversal(dataDir, root, target);
          const info = await stat(target).catch(() => null);
          if (!info?.isDirectory()) throw fail(404, 'folder_not_found', '找不到資料夾。');
          const entries = await readdir(target, { withFileTypes: true });
          const items = [];
          for (const entry of entries) {
            if (entry.name.toLocaleLowerCase('en-US').startsWith('.localnas-') || entry.name.toLocaleLowerCase('en-US') === '.nanako-trash') continue;
            const itemPath = path.join(target, entry.name);
            const itemInfo = await lstat(itemPath);
            if (itemInfo.isSymbolicLink()) continue;
            items.push({ name: entry.name, isDirectory: itemInfo.isDirectory(), size: itemInfo.isFile() ? itemInfo.size : null, modifiedAt: itemInfo.mtime.toISOString() });
          }
          items.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, 'zh-TW', { numeric: true }));
          return json(res, 200, { path: relativeParts(url.searchParams.get('path') || '').join('/'), items, canWrite: Boolean(permission(user, shareId).can_write) });
        }
        if (route === '/api/files/search' && method === 'GET') {
          const shareId = url.searchParams.get('shareId') || '';
          requirePermission(user, shareId);
          const { share, root } = shareRoot(shareId);
          await rejectSymlinkTraversal(dataDir, dataDir, root);
          const results = await searchManagedFiles({
            root,
            category: url.searchParams.get('category') || '',
            search: url.searchParams.get('search') || '',
            verifyPath: (target) => rejectSymlinkTraversal(dataDir, root, target),
          });
          return json(res, 200, {
            ...results,
            share: { id: share.id, name: share.name },
            canWrite: Boolean(permission(user, shareId).can_write),
          });
        }
        if (route === '/api/folders' && method === 'POST') {
          const body = await readJson(req);
          setAuditTarget(`${body.path ? `${String(body.path).slice(0, 256)}/` : ''}${String(body.name || '').slice(0, 180)}`.slice(0, 512));
          const shareId = String(body.shareId || '');
          requirePermission(user, shareId, true);
          const { root } = shareRoot(shareId);
          const parent = resolveShareInside(root, body.path || '');
          await rejectSymlinkTraversal(dataDir, root, parent.target);
          if (!(await stat(parent.target).catch(() => null))?.isDirectory()) throw fail(404, 'folder_not_found', '找不到上層資料夾。');
          const name = safeName(body.name);
          const target = path.join(parent.target, name);
          return await withPathLock(target, async () => {
            await mkdir(target).catch((error) => { if (error.code === 'EEXIST') throw fail(409, 'already_exists', '同名項目已存在。'); throw error; });
            return json(res, 201, { ok: true });
          });
        }
        if (route === '/api/files/rename' && method === 'POST') {
          const body = await readJson(req);
          const shareId = String(body.shareId || '');
          requirePermission(user, shareId, true);
          const { root } = shareRoot(shareId);
          const { target: source, parts } = resolveShareInside(root, body.path || '');
          if (!parts.length) throw fail(400, 'cannot_rename_root', '不能重新命名資料空間本身。');
          const name = safeName(body.newName);
          const parent = resolveShareInside(root, parts.slice(0, -1).join('/'));
          await rejectSymlinkTraversal(dataDir, root, source);
          await rejectSymlinkTraversal(dataDir, root, parent.target);
          const info = await lstat(source).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
          if (!info || info.isSymbolicLink()) throw fail(404, 'file_not_found', '找不到項目。');
          if (!info.isFile() && !info.isDirectory()) throw fail(400, 'unsupported_file_type', '只支援重新命名一般檔案與資料夾。');
          const destination = path.join(parent.target, name);
          if (destination === source) return json(res, 200, { ok: true, name: parts.at(-1), unchanged: true });
          setAuditTarget(`${parts.join('/')} → ${[...parts.slice(0, -1), name].join('/')}`);
          return await withPathLocks([source, destination], async () => {
            const exists = await itemExists(destination);
            const caseOnlyRename = process.platform === 'win32' && destination.toLocaleLowerCase('en-US') === source.toLocaleLowerCase('en-US');
            if (exists && !caseOnlyRename) throw fail(409, 'already_exists', '目的地已有同名項目。');
            if (caseOnlyRename) {
              const temporary = path.join(parent.target, `.localnas-rename-${crypto.randomUUID()}.tmp`);
              await rename(source, temporary);
              try { await rename(temporary, destination); }
              catch (error) { await rename(temporary, source).catch(() => {}); throw error; }
              return json(res, 200, { ok: true, name });
            }
            await rename(source, destination);
            return json(res, 200, { ok: true, name });
          });
        }
        if (route === '/api/files/move' && method === 'POST') {
          const body = await readJson(req);
          const shareId = String(body.shareId || '');
          requirePermission(user, shareId, true);
          const { root } = shareRoot(shareId);
          const { target: source, parts } = resolveShareInside(root, body.path || '');
          if (!parts.length) throw fail(400, 'cannot_move_root', '不能移動資料空間本身。');
          const destinationDirectory = resolveShareInside(root, body.destinationPath || '');
          await rejectSymlinkTraversal(dataDir, root, source);
          await rejectSymlinkTraversal(dataDir, root, destinationDirectory.target);
          const sourceInfo = await lstat(source).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
          if (!sourceInfo || sourceInfo.isSymbolicLink()) throw fail(404, 'file_not_found', '找不到項目。');
          if (!sourceInfo.isFile() && !sourceInfo.isDirectory()) throw fail(400, 'unsupported_file_type', '只支援移動一般檔案與資料夾。');
          if (!(await stat(destinationDirectory.target).catch(() => null))?.isDirectory()) throw fail(404, 'folder_not_found', '找不到目的地資料夾。');
          if (sourceInfo.isDirectory()) {
            const relativeDestination = path.relative(source, destinationDirectory.target);
            if (!relativeDestination || (relativeDestination !== '..' && !relativeDestination.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeDestination))) {
              throw fail(400, 'cannot_move_into_self', '資料夾不能移至自己或其子資料夾內。');
            }
          }
          const destination = path.join(destinationDirectory.target, parts.at(-1));
          if (destination === source) return json(res, 200, { ok: true, unchanged: true });
          setAuditTarget(`${parts.join('/')} → ${[...relativeParts(body.destinationPath || ''), parts.at(-1)].join('/')}`);
          return await withPathLocks([source, destination], async () => {
            if (await itemExists(destination)) throw fail(409, 'already_exists', '目的地已有同名項目。');
            await rename(source, destination);
            return json(res, 200, { ok: true });
          });
        }
        if (route === '/api/files/copy' && method === 'POST') {
          const body = await readJson(req);
          const shareId = String(body.shareId || '');
          requirePermission(user, shareId, true);
          const { root } = shareRoot(shareId);
          const { target: source, parts } = resolveShareInside(root, body.path || '');
          if (!parts.length) throw fail(400, 'cannot_copy_root', '不能複製資料空間本身。');
          const destinationDirectory = resolveShareInside(root, body.destinationPath || '');
          await rejectSymlinkTraversal(dataDir, root, source);
          await rejectSymlinkTraversal(dataDir, root, destinationDirectory.target);
          const sourceInfo = await lstat(source).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
          if (!sourceInfo || sourceInfo.isSymbolicLink()) throw fail(404, 'file_not_found', '找不到項目。');
          if (!(await stat(destinationDirectory.target).catch(() => null))?.isDirectory()) throw fail(404, 'folder_not_found', '找不到目的地資料夾。');
          if (sourceInfo.isDirectory()) {
            const relativeDestination = path.relative(source, destinationDirectory.target);
            if (!relativeDestination || (relativeDestination !== '..' && !relativeDestination.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeDestination))) {
              throw fail(400, 'cannot_copy_into_self', '資料夾不能複製至自己或其子資料夾內。');
            }
          }
          const destination = path.join(destinationDirectory.target, parts.at(-1));
          setAuditTarget(`${parts.join('/')} → ${[...relativeParts(body.destinationPath || ''), parts.at(-1)].join('/')}`);
          return await withPathLocks([source, destination], async () => {
            if (await itemExists(destination)) throw fail(409, 'already_exists', '目的地已有同名項目。');
            const measurement = await measureCopyTree(source);
            const free = await statfs(dataDir, { bigint: true });
            const availableBytes = free.bavail * free.bsize;
            if (measurement.bytes > availableBytes) throw fail(507, 'insufficient_storage', 'Nanako 資料空間所在磁碟容量不足。');
            const temporary = path.join(destinationDirectory.target, `.localnas-copy-${crypto.randomUUID()}.tmp`);
            try {
              await copyManagedTree(source, temporary);
              if (await itemExists(destination)) throw fail(409, 'already_exists', '目的地已有同名項目。');
              await rename(temporary, destination);
            } catch (error) {
              await rm(temporary, { recursive: true, force: true }).catch(() => {});
              throw error;
            }
            return json(res, 201, { ok: true, entries: measurement.entries, bytes: measurement.bytes });
          });
        }
        if (route === '/api/upload' && method === 'POST') {
          const shareId = url.searchParams.get('shareId') || '';
          requirePermission(user, shareId, true);
          const { root } = shareRoot(shareId);
          const parent = resolveShareInside(root, url.searchParams.get('path') || '');
          const name = safeName(url.searchParams.get('name') || '');
          setAuditTarget(`${url.searchParams.get('path') ? `${url.searchParams.get('path')}/` : ''}${name}`.slice(0, 512));
          await rejectSymlinkTraversal(dataDir, root, parent.target);
          if (!(await stat(parent.target).catch(() => null))?.isDirectory()) throw fail(404, 'folder_not_found', '找不到上層資料夾。');
          const target = path.join(parent.target, name);
          if (await stat(target).catch(() => null)) throw fail(409, 'already_exists', '同名項目已存在。');
          const tempPath = path.join(parent.target, `.localnas-upload-${crypto.randomUUID()}.tmp`);
          let size = 0;
          const limiter = new Transform({
            transform(chunk, encoding, callback) { size += chunk.length; callback(size > MAX_UPLOAD_BYTES ? fail(413, 'file_too_large', '單一檔案上限為 5 GiB。') : null, chunk); },
          });
          try {
            await pipeline(req, limiter, createWriteStream(tempPath, { flags: 'wx' }));
            await withPathLock(target, async () => {
              if (await itemExists(target)) throw fail(409, 'already_exists', '同名項目已存在。');
              await rename(tempPath, target);
            });
          } catch (error) {
            await rm(tempPath, { force: true }).catch(() => {});
            throw error;
          }
          return json(res, 201, { ok: true, size });
        }
        if (route === '/api/preview' && method === 'GET') {
          const shareId = url.searchParams.get('shareId') || '';
          requirePermission(user, shareId);
          const { root } = shareRoot(shareId);
          const { target, parts } = resolveShareInside(root, url.searchParams.get('path') || '');
          await rejectSymlinkTraversal(dataDir, root, target);
          const info = await stat(target).catch(() => null);
          if (!info?.isFile()) throw fail(404, 'file_not_found', '找不到檔案。');
          const contentType = mediaTypes.get(path.extname(target).toLowerCase());
          if (!contentType) throw fail(415, 'preview_not_supported', '目前不支援預覽或播放這個檔案格式，請下載查看。');

          const rangeHeader = req.headers.range;
          if (rangeHeader && getAuditEvent()) disableAudit();
          let range = null;
          if (rangeHeader) {
            const match = /^bytes=(\d*)-(\d*)$/iu.exec(rangeHeader.trim());
            let start; let end;
            if (match && info.size > 0) {
              if (!match[1]) {
                const suffixLength = Number(match[2]);
                if (Number.isSafeInteger(suffixLength) && suffixLength > 0) {
                  start = Math.max(info.size - suffixLength, 0);
                  end = info.size - 1;
                }
              } else {
                start = Number(match[1]);
                end = match[2] ? Number(match[2]) : info.size - 1;
                if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && start < info.size) {
                  end = Math.min(end, info.size - 1);
                } else {
                  start = undefined;
                }
              }
            }
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= info.size) {
              return json(res, 416, { error: 'invalid_range', message: '無法讀取指定的檔案範圍。' }, {
                'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${info.size}`,
              });
            }
            range = { start, end };
          }

          const fileName = parts.at(-1) || 'media';
          const headers = {
            'Content-Type': contentType,
            'Content-Length': range ? range.end - range.start + 1 : info.size,
            'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
          };
          if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`;
          res.writeHead(range ? 206 : 200, headers);
          const stream = createReadStream(target, range || undefined);
          stream.on('error', () => res.destroy());
          stream.pipe(res);
          return true;
        }
        if (route === '/api/download' && method === 'GET') {
          const shareId = url.searchParams.get('shareId') || '';
          requirePermission(user, shareId);
          const { root } = shareRoot(shareId);
          const { target, parts } = resolveShareInside(root, url.searchParams.get('path') || '');
          await rejectSymlinkTraversal(dataDir, root, target);
          const info = await stat(target).catch(() => null);
          if (!info?.isFile()) throw fail(404, 'file_not_found', '找不到檔案。');
          const name = parts.at(-1) || 'download';
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': info.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store' });
          return createReadStream(target).pipe(res);
        }
        if (route === '/api/files' && method === 'DELETE') {
          const shareId = url.searchParams.get('shareId') || '';
          requirePermission(user, shareId, true);
          const { share, root } = shareRoot(shareId);
          const { target, parts } = resolveShareInside(root, url.searchParams.get('path') || '');
          if (!parts.length) throw fail(400, 'cannot_delete_root', '不能刪除分享資料夾本身。');
          await rejectSymlinkTraversal(dataDir, root, target);
          const info = await lstat(target).catch(() => null);
          if (!info || info.isSymbolicLink()) throw fail(404, 'file_not_found', '找不到項目。');
          const id = crypto.randomUUID();
          const storedPath = managedTrashPath(share.id, id);
          await rejectSymlinkTraversal(dataDir, dataDir, path.dirname(storedPath), false);
          await mkdir(path.dirname(storedPath), { recursive: true });
          await rejectSymlinkTraversal(dataDir, dataDir, storedPath, false);
          await rename(target, storedPath);
          try {
            db.prepare(`INSERT INTO trash_items(id, share_id, original_path, stored_path, item_name, is_directory, deleted_by, deleted_at) VALUES(?,?,?,?,?,?,?,?)`)
              .run(id, share.id, parts.join('/'), storedPath, parts.at(-1), Number(info.isDirectory()), user.id, new Date().toISOString());
          } catch (error) {
            await rename(storedPath, target).catch(() => {});
            throw error;
          }
          return json(res, 200, { ok: true });
        }
        if (route === '/api/trash' && method === 'GET') {
          const shareId = url.searchParams.get('shareId') || '';
          requirePermission(user, shareId, true);
          shareRoot(shareId);
          const rows = db.prepare(`SELECT id, item_name AS name, is_directory AS isDirectory, deleted_at AS deletedAt FROM trash_items WHERE share_id = ? ORDER BY deleted_at DESC`).all(shareId);
          return json(res, 200, { items: rows.map((row) => ({ ...row, isDirectory: Boolean(row.isDirectory) })) });
        }
        if (route === '/api/trash/restore' && method === 'POST') {
          const body = await readJson(req);
          const row = db.prepare('SELECT * FROM trash_items WHERE id = ?').get(String(body.id || ''));
          if (!row) throw fail(404, 'trash_item_not_found', '找不到資源回收桶項目。');
          setAuditTarget(row.item_name);
          requirePermission(user, row.share_id, true);
          const { root } = shareRoot(row.share_id);
          const destination = resolveShareInside(root, row.original_path);
          await rejectSymlinkTraversal(dataDir, root, destination.target, false);
          const parentInfo = await stat(path.dirname(destination.target)).catch(() => null);
          if (!parentInfo?.isDirectory()) throw fail(409, 'restore_parent_missing', '原本的資料夾已不存在，請先建立資料夾。');
          if (await stat(destination.target).catch(() => null)) throw fail(409, 'restore_conflict', '原位置已有同名項目，請先重新命名或移動該項目。');
          const storedPath = managedTrashPath(row.share_id, row.id);
          await rejectSymlinkTraversal(dataDir, dataDir, storedPath);
          await rename(storedPath, destination.target);
          db.prepare('DELETE FROM trash_items WHERE id = ?').run(row.id);
          return json(res, 200, { ok: true });
        }
        if (route === '/api/trash' && method === 'DELETE') {
          if (user.role !== 'admin') throw fail(403, 'admin_required', '只有管理員可以永久刪除項目。');
          const id = url.searchParams.get('id') || '';
          const row = db.prepare('SELECT * FROM trash_items WHERE id = ?').get(id);
          if (!row) throw fail(404, 'trash_item_not_found', '找不到資源回收桶項目。');
          setAuditTarget(row.item_name);
          shareRoot(row.share_id);
          const storedPath = managedTrashPath(row.share_id, row.id);
          await rejectSymlinkTraversal(dataDir, dataDir, storedPath);
          await rm(storedPath, { recursive: true, force: true });
          db.prepare('DELETE FROM trash_items WHERE id = ?').run(id);
          return json(res, 200, { ok: true });
        }
    return false;
  }

  return async function handleFilesRoute(requestContext) {
    if (!fileRoutes.has(`${requestContext.method} ${requestContext.route}`)) return false;
    await dispatchFileRoute(requestContext);
    return true;
  };
}
