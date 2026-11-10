import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTERNAL_NETWORK_TEST_URL, probeExternalNetwork } from '../src/network-probe.mjs';

test('external network probe reports a successful Microsoft connectivity check without sending file data', async () => {
  const calls = [];
  const result = await probeExternalNetwork({
    now: (() => { let time = 100; return () => (time += 18); })(),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response('Microsoft Connect Test', { status: 200 });
    },
  });
  assert.equal(result.status, 'connected');
  assert.equal(result.latencyMs, 18);
  assert.equal(EXTERNAL_NETWORK_TEST_URL, 'http://www.msftconnecttest.com/connecttest.txt');
  assert.equal(result.endpoint, EXTERNAL_NETWORK_TEST_URL);
  assert.equal(calls[0].url, EXTERNAL_NETWORK_TEST_URL);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'manual');
});

test('external network probe distinguishes captive-portal redirects and unreachable endpoints', async () => {
  const redirected = await probeExternalNetwork({ fetchImpl: async () => new Response('', { status: 302 }) });
  assert.equal(redirected.status, 'redirected');
  const unreachable = await probeExternalNetwork({ fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(unreachable.status, 'unreachable');
});
