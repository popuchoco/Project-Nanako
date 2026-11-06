import crypto from 'node:crypto';
import { lstat, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { hashManagedFile, scanManagedDuplicates } from './duplicates.mjs';
import { fail, json, readJson } from './http-utils.mjs';
import { rejectSymlinkTraversal, resolveShareInside } from './path-guards.mjs';
import { isShareOperationAllowed } from './share-access.mjs';

const DUPLICATE_SCAN_TTL_MS = 30 * 60 * 1000;
const MAX_DUPLICATE_SCAN_JOBS = 2;
const MAX_DUPLICATE_SELECTIONS = 200;
const MAX_DUPLICATE_CLEANUP_ITEMS = 1000;

export function createDuplicatesRouter(ctx) {
  const {
    db, dataDir, requirePermission, shareRoot, permission, getUserById,
    withPathLocks, managedTrashPath, writeOperationLog,
  } = ctx;
  const duplicateScans = new Map();

    function pruneDuplicateScans(now = Date.now()) {
      for (const [id, job] of duplicateScans) {
        if (job.status !== 'scanning' && job.status !== 'cancelling' && now - job.updatedAt > DUPLICATE_SCAN_TTL_MS) duplicateScans.delete(id);
      }
      if (duplicateScans.size < 32) return;
      const completed = [...duplicateScans.values()]
        .filter((job) => !['scanning', 'cancelling'].includes(job.status))
        .sort((a, b) => a.updatedAt - b.updatedAt);
      while (duplicateScans.size >= 32 && completed.length) duplicateScans.delete(completed.shift().id);
    }

    function duplicateScanForUser(scanId, user) {
      if (!/^[0-9a-f-]{36}$/iu.test(String(scanId || ''))) throw fail(404, 'duplicate_scan_not_found', '找不到這次掃描。');
      pruneDuplicateScans();
      const job = duplicateScans.get(String(scanId));
      if (!job || job.userId !== user.id) throw fail(404, 'duplicate_scan_not_found', '找不到這次掃描。');
      requirePermission(user, job.shareId);
      return job;
    }

    async function runDuplicateScan(job, root) {
      try {
        const result = await scanManagedDuplicates({
          root,
          signal: job.controller.signal,
          shouldContinue: () => {
            const current = getUserById.get(job.userId);
            const canStillRead = current?.isActive && isShareOperationAllowed(current, permission(current, job.shareId), 'read');
            if (!canStillRead) job.controller.abort();
            return Boolean(canStillRead);
          },
          onProgress: (progress) => { job.progress = progress; job.updatedAt = Date.now(); },
        });
        if (job.controller.signal.aborted) {
          job.status = 'cancelled';
        } else {
          job.groups = result.groups;
          job.statistics = {
            visitedEntries: result.visitedEntries,
            scannedFiles: result.scannedFiles,
            comparedFiles: result.comparedFiles,
            skippedFiles: result.skippedFiles,
            bytesHashed: result.bytesHashed,
          };
          job.status = 'completed';
        }
      } catch (error) {
        if (job.controller.signal.aborted || error.name === 'AbortError') job.status = 'cancelled';
        else {
          job.status = 'failed';
          job.error = error.status ? error.message : error.code === 'SCAN_TOO_MANY_ENTRIES'
            ? error.message
            : '掃描失敗。請確認資料空間可讀取後再試一次。';
        }
      } finally {
        job.updatedAt = Date.now();
      }
    }

  function matchesDuplicatesRoute(method, route) {
    return route === '/api/duplicates/scan' && ['GET', 'POST', 'DELETE'].includes(method)
      || route === '/api/duplicates/cleanup' && method === 'POST';
  }

  async function dispatchDuplicatesRoute({ req, res, method, route, url, user, setAudit }) {
    if (route === '/api/duplicates/scan' && method === 'POST') {
      const body = await readJson(req);
      const shareId = String(body.shareId || '');
      requirePermission(user, shareId);
      const { share, root } = shareRoot(shareId);
      await rejectSymlinkTraversal(dataDir, dataDir, root);
      const rootInfo = await lstat(root).catch(() => null);
      if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) throw fail(404, 'share_not_found', '找不到可掃描的 Nanako 資料空間。');
      pruneDuplicateScans();
      if ([...duplicateScans.values()].some((job) => job.userId === user.id && ['scanning', 'cancelling'].includes(job.status))) {
        throw fail(409, 'duplicate_scan_in_progress', '你已有一項重複檔案掃描正在進行。');
      }
      if ([...duplicateScans.values()].filter((job) => ['scanning', 'cancelling'].includes(job.status)).length >= MAX_DUPLICATE_SCAN_JOBS) {
        throw fail(429, 'duplicate_scan_limit', '目前掃描工作較多，請稍後再試。');
      }
      const scanId = crypto.randomUUID();
      const job = {
        id: scanId,
        userId: user.id,
        shareId,
        shareName: share.name,
        status: 'scanning',
        progress: { phase: 'starting', visitedEntries: 0, scannedFiles: 0, skippedFiles: 0 },
        statistics: null,
        groups: [],
        controller: new AbortController(),
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
      duplicateScans.set(scanId, job);
      setAudit(user, '開始重複檔案掃描', share.name);
      job.promise = runDuplicateScan(job, root);
      return json(res, 202, { scanId, status: job.status });
    }

    if (route === '/api/duplicates/scan' && method === 'GET') {
      const job = duplicateScanForUser(url.searchParams.get('scanId'), user);
      return json(res, 200, {
        scanId: job.id,
        status: job.status,
        shareName: job.shareName,
        progress: job.progress,
        statistics: job.statistics,
        error: job.error || null,
        groups: job.status === 'completed' ? job.groups.map((group) => ({
          id: group.id,
          size: group.size,
          duplicateCount: group.items.length,
          items: group.items.map(({ path: itemPath, name, size, modifiedAt }) => ({ path: itemPath, name, size, modifiedAt })),
        })) : [],
      });
    }

    if (route === '/api/duplicates/scan' && method === 'DELETE') {
      const job = duplicateScanForUser(url.searchParams.get('scanId'), user);
      if (!['scanning', 'cancelling'].includes(job.status)) throw fail(409, 'duplicate_scan_not_running', '目前沒有進行中的掃描。');
      job.status = 'cancelling';
      job.controller.abort();
      job.updatedAt = Date.now();
      setAudit(user, '取消重複檔案掃描', job.shareName);
      return json(res, 202, { scanId: job.id, status: job.status });
    }

    if (route === '/api/duplicates/cleanup' && method === 'POST') {
      const body = await readJson(req);
      const job = duplicateScanForUser(body.scanId, user);
      if (job.status !== 'completed') throw fail(409, 'duplicate_scan_not_ready', '掃描結果已失效，請重新掃描。');
      requirePermission(user, job.shareId, true);
      if (!Array.isArray(body.groups) || body.groups.length === 0 || body.groups.length > MAX_DUPLICATE_SELECTIONS) {
        throw fail(400, 'invalid_duplicate_selection', `請選擇 1 至 ${MAX_DUPLICATE_SELECTIONS} 組重複檔案。`);
      }
      const seenGroupIds = new Set();
      const selections = [];
      let duplicateItemCount = 0;
      for (const selection of body.groups) {
        const group = job.groups.find((item) => item.id === selection?.groupId);
        if (!group || seenGroupIds.has(group.id) || typeof selection.keepPath !== 'string') throw fail(400, 'invalid_duplicate_selection', '重複檔案選擇內容不正確。');
        seenGroupIds.add(group.id);
        const keeper = group.items.find((item) => item.path === selection.keepPath);
        if (!keeper) throw fail(400, 'invalid_duplicate_selection', '保留項目不屬於這組重複檔案。');
        const copies = group.items.filter((item) => item !== keeper);
        duplicateItemCount += copies.length;
        selections.push({ group, keeper, copies });
      }
      if (duplicateItemCount > MAX_DUPLICATE_CLEANUP_ITEMS) throw fail(413, 'too_many_duplicate_items', `單次最多可整理 ${MAX_DUPLICATE_CLEANUP_ITEMS} 個副本，請分批處理。`);
      if (duplicateItemCount === 0) throw fail(400, 'no_duplicate_copies', '沒有可整理的副本。');

      const { share, root } = shareRoot(job.shareId);
      const allSelectedItems = selections.flatMap(({ group }) => group.items.map((item) => ({ group, item })));
      const targetByItem = new Map();
      for (const { group, item } of allSelectedItems) {
        const { target } = resolveShareInside(root, item.path);
        await rejectSymlinkTraversal(dataDir, root, target);
        targetByItem.set(`${group.id}\0${item.path}`, target);
      }

      const outcomes = await withPathLocks([...targetByItem.values()], async () => {
        const verified = new Map();
        for (const { group, item } of allSelectedItems) {
          const target = targetByItem.get(`${group.id}\0${item.path}`);
          let fingerprint;
          try { fingerprint = await hashManagedFile(target); }
          catch { throw fail(409, 'duplicate_file_changed', `「${item.path}」已變更或無法讀取，請重新掃描。`); }
          if (fingerprint.size !== group.size || fingerprint.digest !== group.digest) {
            throw fail(409, 'duplicate_file_changed', `「${item.path}」已變更，請重新掃描。`);
          }
          verified.set(`${group.id}\0${item.path}`, fingerprint);
        }

        const moved = [];
        const failed = [];
        for (const { group, keeper, copies } of selections) {
          const keeperPath = targetByItem.get(`${group.id}\0${keeper.path}`);
          const keeperFingerprint = verified.get(`${group.id}\0${keeper.path}`);
          const keeperInfo = await lstat(keeperPath).catch(() => null);
          let keeperStillMatches = Boolean(keeperInfo?.isFile() && !keeperInfo.isSymbolicLink()
            && keeperInfo.size === keeperFingerprint.size && keeperInfo.mtimeMs === keeperFingerprint.mtimeMs
            && keeperInfo.ctimeMs === keeperFingerprint.ctimeMs && keeperInfo.dev === keeperFingerprint.dev
            && keeperInfo.ino === keeperFingerprint.ino);
          if (keeperStillMatches) {
            try {
              const currentKeeper = await hashManagedFile(keeperPath);
              keeperStillMatches = currentKeeper.size === group.size && currentKeeper.digest === group.digest;
            } catch { keeperStillMatches = false; }
          }
          if (!keeperStillMatches) {
            for (const item of copies) {
              failed.push({ path: item.path, ok: false, message: '保留檔案在整理期間有所變動，未整理此組副本；請重新掃描。' });
              writeOperationLog(user, '整理重複檔案副本', item.path, '失敗');
            }
            continue;
          }
          for (const item of copies) {
            const source = targetByItem.get(`${group.id}\0${item.path}`);
            const fingerprint = verified.get(`${group.id}\0${item.path}`);
            const currentInfo = await lstat(source).catch(() => null);
            if (!currentInfo?.isFile() || currentInfo.isSymbolicLink()
              || currentInfo.size !== fingerprint.size || currentInfo.mtimeMs !== fingerprint.mtimeMs
              || currentInfo.ctimeMs !== fingerprint.ctimeMs || currentInfo.dev !== fingerprint.dev || currentInfo.ino !== fingerprint.ino) {
              const outcome = { path: item.path, ok: false, message: '檔案在整理前再次變動，已略過；請重新掃描。' };
              failed.push(outcome);
              writeOperationLog(user, '整理重複檔案副本', item.path, '失敗');
              continue;
            }
            const id = crypto.randomUUID();
            const storedPath = managedTrashPath(share.id, id);
            await rejectSymlinkTraversal(dataDir, dataDir, path.dirname(storedPath), false);
            await mkdir(path.dirname(storedPath), { recursive: true });
            await rejectSymlinkTraversal(dataDir, dataDir, storedPath, false);
            try {
              await rename(source, storedPath);
              try {
                db.prepare(`INSERT INTO trash_items(id, share_id, original_path, stored_path, item_name, is_directory, deleted_by, deleted_at) VALUES(?,?,?,?,?,?,?,?)`)
                  .run(id, share.id, item.path, storedPath, path.posix.basename(item.path), 0, user.id, new Date().toISOString());
              } catch (error) {
                await rename(storedPath, source).catch(() => {});
                throw error;
              }
              moved.push({ path: item.path, trashId: id });
              writeOperationLog(user, '整理重複檔案副本', item.path, '成功');
            } catch (error) {
              const outcome = { path: item.path, ok: false, message: error.code === 'ENOENT' ? '檔案已不存在，請重新掃描。' : '無法移至資源回收桶。' };
              failed.push(outcome);
              writeOperationLog(user, '整理重複檔案副本', item.path, '失敗');
            }
          }
        }
        return { moved, failed };
      });

      job.status = outcomes.failed.length ? 'stale' : 'cleaned';
      job.updatedAt = Date.now();
      setAudit(user, '整理重複檔案副本', `${share.name}：已移至資源回收桶 ${outcomes.moved.length} 個`);
      return json(res, 200, { ok: outcomes.failed.length === 0, moved: outcomes.moved, failed: outcomes.failed });
    }


  }

  async function handleDuplicatesRoute(args) {
    if (!matchesDuplicatesRoute(args.method, args.route)) return false;
    await dispatchDuplicatesRoute(args);
    return true;
  }

  function abortAll() {
    for (const job of duplicateScans.values()) {
      if (['scanning', 'cancelling'].includes(job.status)) job.controller.abort();
    }
    return [...duplicateScans.values()].map((job) => job.promise).filter(Boolean);
  }

  return { handleDuplicatesRoute, abortAll };
}
