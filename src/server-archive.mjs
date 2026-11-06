import crypto from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { createArchive, extractArchive } from './archives.mjs';
import { fail, json, readJson } from './http-utils.mjs';
import { rejectSymlinkTraversal, relativeParts, resolveShareInside } from './path-guards.mjs';

export function createArchiveRouter(ctx) {
  const { dataDir, requirePermission, shareRoot } = ctx;
  const activeArchiveJobs = new Map();


  function matchesArchiveRoute(method, route) {
    return route === '/api/archive/status' && method === 'GET'
      || route === '/api/archive/cancel' && method === 'POST'
      || ['/api/archive/create', '/api/archive/extract'].includes(route) && method === 'POST';
  }

  async function dispatchArchiveRoute({ req, res, method, route, user, setAuditTarget }) {
    if (route === '/api/archive/status' && method === 'GET') {
      const job = activeArchiveJobs.get(user.id);
      return json(res, 200, { active: Boolean(job), ...(job ? {
        id: job.id, operation: job.operation, phase: job.phase, bytesRead: job.bytesRead,
        totalBytes: job.totalBytes, entriesDone: job.entriesDone, totalEntries: job.totalEntries,
      } : {}) });
    }
    if (route === '/api/archive/cancel' && method === 'POST') {
      const job = activeArchiveJobs.get(user.id);
      if (!job) return json(res, 200, { active: false });
      if (job.phase === '發佈 ZIP 成品' || job.phase === '發佈解壓內容') throw fail(409, 'archive_too_late_to_cancel', 'ZIP 成品發佈階段已開始，無法安全取消；請等待作業完成。');
      job.controller.abort();
      return json(res, 200, { active: true, cancelling: true });
    }
    if ((route === '/api/archive/create' || route === '/api/archive/extract') && method === 'POST') {
      if (activeArchiveJobs.has(user.id)) throw fail(409, 'archive_job_busy', '此帳號已有 ZIP 作業進行中；請先完成或取消後再試。');
      const body = await readJson(req);
      const shareId = String(body.shareId || '');
      requirePermission(user, shareId, true);
      const { root } = shareRoot(shareId);
      const parts = relativeParts(body.path || '');
      if (!parts.length) throw fail(400, 'invalid_path', '請先選取要處理的檔案或資料夾。');
      const source = resolveShareInside(root, parts.join('/'));
      await rejectSymlinkTraversal(dataDir, root, source.target);
      const sourceInfo = await lstat(source.target).catch(() => null);
      if (!sourceInfo) throw fail(404, 'file_not_found', '找不到要處理的檔案或資料夾。');
      if (route === '/api/archive/create') {
        const archiveName = `${path.parse(source.target).name || path.basename(source.target)}.zip`;
        const archivePath = path.join(path.dirname(source.target), archiveName);
        await rejectSymlinkTraversal(dataDir, root, archivePath, false);
        setAuditTarget(parts.join('/'));
        const controller = new AbortController();
        const job = { id: crypto.randomUUID(), operation: 'create', phase: '準備 ZIP', bytesRead: 0, totalBytes: 0, entriesDone: 0, totalEntries: 0, controller };
        activeArchiveJobs.set(user.id, job);
        try {
          const result = await createArchive({
            sourcePath: source.target, shareRoot: root, archivePath, signal: controller.signal,
            onProgress: (progress) => Object.assign(job, progress),
          });
          return json(res, 201, { ok: true, name: archiveName, ...result });
        } finally { if (activeArchiveJobs.get(user.id) === job) activeArchiveJobs.delete(user.id); }
      }
      if (sourceInfo.isDirectory() || path.extname(source.target).toLowerCase() !== '.zip') throw fail(400, 'invalid_archive_source', '請選取 ZIP 檔案進行解壓縮。');
      const destinationPath = path.join(path.dirname(source.target), path.basename(source.target, path.extname(source.target)));
      await rejectSymlinkTraversal(dataDir, root, destinationPath, false);
      setAuditTarget(parts.join('/'));
      const controller = new AbortController();
      const job = { id: crypto.randomUUID(), operation: 'extract', phase: '檢查 ZIP', bytesRead: 0, totalBytes: 0, entriesDone: 0, totalEntries: 0, controller };
      activeArchiveJobs.set(user.id, job);
      try {
        const result = await extractArchive({
          archivePath: source.target, shareRoot: root, destinationPath, signal: controller.signal,
          onProgress: (progress) => Object.assign(job, progress),
        });
        return json(res, 201, { ok: true, name: path.basename(destinationPath), ...result });
      } finally { if (activeArchiveJobs.get(user.id) === job) activeArchiveJobs.delete(user.id); }
    }

  }

  async function handleArchiveRoute(args) {
    if (!matchesArchiveRoute(args.method, args.route)) return false;
    await dispatchArchiveRoute(args);
    return true;
  }

  function abortAll() {
    for (const job of activeArchiveJobs.values()) job.controller.abort();
  }

  return { handleArchiveRoute, abortAll };
}
