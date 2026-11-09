import crypto from 'node:crypto';

const RATE_WINDOW_MS = 1_000;
const SAMPLE_BUCKET_MS = 100;

export function createTransferMonitor({ now = () => Date.now() } = {}) {
  const active = new Map();
  const samplesByUser = new Map();

  function recordRate(userId, direction, bytes, at) {
    let samples = samplesByUser.get(userId);
    if (!samples) {
      samples = { upload: new Map(), download: new Map() };
      samplesByUser.set(userId, samples);
    }
    const bucket = Math.floor(at / SAMPLE_BUCKET_MS) * SAMPLE_BUCKET_MS;
    const directionSamples = samples[direction];
    directionSamples.set(bucket, (directionSamples.get(bucket) || 0) + bytes);
    for (const timestamp of directionSamples.keys()) {
      if (timestamp < at - RATE_WINDOW_MS - SAMPLE_BUCKET_MS) directionSamples.delete(timestamp);
    }
  }

  function begin(userId, direction, name, totalBytes = null) {
    if (!['upload', 'download'].includes(direction)) throw new TypeError('Unsupported transfer direction.');
    const id = crypto.randomUUID();
    const transfer = {
      id, userId, direction, name: String(name || '檔案').slice(0, 180),
      totalBytes: Number.isSafeInteger(totalBytes) && totalBytes >= 0 ? totalBytes : null,
      bytesTransferred: 0, startedAt: now(),
    };
    active.set(id, transfer);
    let finished = false;
    return {
      record(bytes) {
        if (finished || !Number.isSafeInteger(bytes) || bytes <= 0) return;
        const at = now();
        transfer.bytesTransferred += bytes;
        recordRate(userId, direction, bytes, at);
      },
      finish() {
        if (finished) return;
        finished = true;
        active.delete(id);
      },
    };
  }

  function rateFor(userId, direction, at) {
    const samples = samplesByUser.get(userId)?.[direction];
    if (!samples) return 0;
    const cutoff = at - RATE_WINDOW_MS;
    let bytes = 0;
    let firstBucket = at;
    for (const [timestamp, value] of samples) {
      if (timestamp < cutoff) { samples.delete(timestamp); continue; }
      bytes += value;
      firstBucket = Math.min(firstBucket, timestamp);
    }
    const elapsed = Math.max(SAMPLE_BUCKET_MS, Math.min(RATE_WINDOW_MS, at - firstBucket));
    return bytes === 0 ? 0 : Math.round(bytes * 1_000 / elapsed);
  }

  function snapshot(userId) {
    const at = now();
    const transfers = [...active.values()]
      .filter((transfer) => transfer.userId === userId)
      .sort((left, right) => left.startedAt - right.startedAt)
      .map(({ id, direction, name, totalBytes, bytesTransferred, startedAt }) => ({
        id, direction, name, totalBytes, bytesTransferred, startedAt: new Date(startedAt).toISOString(),
      }));
    const uploads = transfers.filter((transfer) => transfer.direction === 'upload').length;
    const downloads = transfers.filter((transfer) => transfer.direction === 'download').length;
    return {
      transfers,
      counts: { upload: uploads, download: downloads, total: transfers.length },
      rates: { uploadBytesPerSecond: rateFor(userId, 'upload', at), downloadBytesPerSecond: rateFor(userId, 'download', at) },
    };
  }

  return { begin, snapshot };
}
