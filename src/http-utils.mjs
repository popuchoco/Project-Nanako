import { Server as HttpsServer } from 'node:https';

const MAX_JSON_BYTES = 64 * 1024;

export function buildLoopbackOriginAllowlist(server) {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Nanako 伺服器尚未繫結有效的本機位址。');
  }
  const scheme = server instanceof HttpsServer ? 'https' : 'http';
  const port = address.port;
  return {
    origins: new Set([
      `${scheme}://127.0.0.1:${port}`,
      `${scheme}://localhost:${port}`,
      `${scheme}://[::1]:${port}`,
    ]),
    hosts: new Set([
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ]),
  };
}

function parseIpv4(address) {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return null;
  return octets;
}

function parseIpv6(address) {
  let value = address.toLowerCase().split('%', 1)[0];
  if (value.includes('.')) {
    const ipv4Start = value.lastIndexOf(':') + 1;
    const ipv4 = parseIpv4(value.slice(ipv4Start));
    if (ipv4Start === 0 || !ipv4) return null;
    const first = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const second = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    value = `${value.slice(0, ipv4Start)}${first}:${second}`;
  }

  const compression = value.indexOf('::');
  if (compression !== -1 && compression !== value.lastIndexOf('::')) return null;
  let words;
  if (compression === -1) {
    words = value.split(':');
    if (words.length !== 8) return null;
  } else {
    const left = value.slice(0, compression).split(':').filter(Boolean);
    const right = value.slice(compression + 2).split(':').filter(Boolean);
    const zeroCount = 8 - left.length - right.length;
    if (zeroCount < 1) return null;
    words = [...left, ...Array(zeroCount).fill('0'), ...right];
  }
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/u.test(word))) return null;
  return words.map((word) => Number.parseInt(word, 16));
}

export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const ipv4 = parseIpv4(address);
  if (ipv4) return ipv4[0] === 127;

  const words = parseIpv6(address);
  if (!words) return false;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  return words.slice(0, 5).every((word) => word === 0)
    && words[5] === 0xffff
    && (words[6] >> 8) === 127;
}

export const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'], ['.svg', 'image/svg+xml'],
]);

export const mediaTypes = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.bmp', 'image/bmp'],
  ['.mp4', 'video/mp4'], ['.m4v', 'video/x-m4v'], ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'], ['.ogv', 'video/ogg'],
  ['.mp3', 'audio/mpeg'], ['.m4a', 'audio/mp4'], ['.aac', 'audio/aac'],
  ['.wav', 'audio/wav'], ['.oga', 'audio/ogg'], ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/ogg'], ['.flac', 'audio/flac'],
]);

export function json(res, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function fail(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function parseByteRange(header, size) {
  if (!header) return null;
  const invalid = () => fail(416, 'invalid_range', '要求的影音播放範圍不正確。');
  if (typeof header !== 'string' || header.length > 128 || size <= 0 || header.includes(',')) throw invalid();
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || (!match[1] && !match[2])) throw invalid();
  let start; let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw invalid();
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) throw invalid();
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export function writeResponseChunk(res, chunk) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      res.off('drain', onDrain);
      res.off('close', onClose);
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => finish();
    const onClose = () => finish();
    res.once('close', onClose);
    if (res.write(chunk)) finish();
    else res.once('drain', onDrain);
  });
}

export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw fail(413, 'request_too_large', '資料太大。');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'invalid_json', '資料格式不正確。'); }
}
