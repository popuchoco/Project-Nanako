export const EXTERNAL_NETWORK_TEST_URL = 'https://www.msftconnecttest.com/connecttest.txt';

async function readPrefix(response, maxBytes = 128) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let length = 0;
  try {
    while (length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value.subarray(0, maxBytes - length);
      chunks.push(chunk);
      length += chunk.length;
      if (chunk.length < value.length) { await reader.cancel(); break; }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export async function probeExternalNetwork({ fetchImpl = globalThis.fetch, now = () => Date.now(), timeoutMs = 5_000 } = {}) {
  const startedAt = now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(EXTERNAL_NETWORK_TEST_URL, {
      method: 'GET',
      headers: { Accept: 'text/plain' },
      cache: 'no-store',
      redirect: 'manual',
      signal: controller.signal,
    });
    const body = await readPrefix(response);
    const latencyMs = Math.max(0, now() - startedAt);
    if (response.status === 200 && body.trim() === 'Microsoft Connect Test') {
      return { status: 'connected', latencyMs, endpoint: new URL(EXTERNAL_NETWORK_TEST_URL).hostname, httpStatus: response.status };
    }
    if (response.status >= 300 && response.status < 400) {
      return { status: 'redirected', latencyMs, endpoint: new URL(EXTERNAL_NETWORK_TEST_URL).hostname, httpStatus: response.status };
    }
    return { status: 'limited', latencyMs, endpoint: new URL(EXTERNAL_NETWORK_TEST_URL).hostname, httpStatus: response.status };
  } catch (error) {
    return {
      status: controller.signal.aborted ? 'timeout' : 'unreachable',
      latencyMs: Math.max(0, now() - startedAt),
      endpoint: new URL(EXTERNAL_NETWORK_TEST_URL).hostname,
    };
  } finally {
    clearTimeout(timeout);
  }
}
