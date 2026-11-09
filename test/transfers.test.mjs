import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransferMonitor } from '../src/transfers.mjs';

test('transfer monitor reports per-user active counts, progress and recent byte rates', () => {
  let timestamp = 1_000;
  const monitor = createTransferMonitor({ now: () => timestamp });
  const upload = monitor.begin('user-a', 'upload', '檔案.bin', 2_000);
  const download = monitor.begin('user-a', 'download', '照片.jpg', 5_000);
  const privateUpload = monitor.begin('user-b', 'upload', 'private.txt', 100);
  timestamp = 1_100; upload.record(800); download.record(1_000);
  timestamp = 1_200; upload.record(200);

  const ownTasks = monitor.snapshot('user-a');
  assert.deepEqual(ownTasks.counts, { upload: 1, download: 1, total: 2 });
  assert.deepEqual(ownTasks.transfers.map((item) => item.name), ['檔案.bin', '照片.jpg']);
  assert.equal(ownTasks.transfers.find((item) => item.direction === 'upload').bytesTransferred, 1_000);
  assert.ok(ownTasks.rates.uploadBytesPerSecond > 0);
  assert.ok(ownTasks.rates.downloadBytesPerSecond > 0);
  assert.deepEqual(monitor.snapshot('user-b').counts, { upload: 1, download: 0, total: 1 });

  upload.finish(); download.finish(); privateUpload.finish();
  assert.deepEqual(monitor.snapshot('user-a').counts, { upload: 0, download: 0, total: 0 });
  timestamp = 2_300;
  assert.equal(monitor.snapshot('user-a').rates.uploadBytesPerSecond, 0);
});

test('transfer monitor handles unknown and zero-length transfer sizes', () => {
  let timestamp = 0;
  const monitor = createTransferMonitor({ now: () => timestamp });
  const transfer = monitor.begin('user-a', 'download', 'stream.bin', null);
  assert.equal(monitor.snapshot('user-a').transfers[0].totalBytes, null);
  transfer.record(0);
  assert.equal(monitor.snapshot('user-a').transfers[0].bytesTransferred, 0);
  transfer.finish();
});
