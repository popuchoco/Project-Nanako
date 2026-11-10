import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { startServer } from '../src/server.mjs';
import { generateLanCertificate } from '../src/lan-certificate.mjs';
import { isPrivateIpv4 } from '../src/network-access.mjs';

async function reservePort(address) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, address, resolve); });
  const { port } = server.address();
  await promisify(server.close.bind(server))();
  return port;
}

function tlsFetch({ address, port, pathname, method = 'GET', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: address, port, path: pathname, method, headers, rejectUnauthorized: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const payload = Buffer.concat(chunks).toString('utf8');
        const bodyValue = (response.headers['content-type'] || '').includes('application/json') ? JSON.parse(payload) : payload;
        resolve({ status: response.statusCode, headers: response.headers, body: bodyValue });
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}

test('opt-in LAN server serves login only over TLS and can be stopped locally', async (t) => {
  const adapter = Object.values(os.networkInterfaces()).flatMap((items) => items || [])
    .find((item) => item.family === 'IPv4' && !item.internal && isPrivateIpv4(item.address));
  if (!adapter) return t.skip('This host has no private IPv4 interface to bind for an integration test.');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nanako-lan-server-'));
  let server;
  t.after(async () => { await server?.close(); await rm(dataDir, { recursive: true, force: true }); });
  const networkInterfaceProvider = () => [{ name: 'test-adapter', ...adapter, private: true }];
  const serverOptions = {
    dataDir,
    host: '127.0.0.1',
    port: 0,
    networkInterfaceProvider,
    lanCertificateProvider: (address) => generateLanCertificate(address),
  };
  server = await startServer(serverOptions);
  let localOrigin = `http://127.0.0.1:${server.port}`;
  const setupResponse = await fetch(`${localOrigin}/api/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: localOrigin },
    body: JSON.stringify({ username: 'admin', password: 'lan-integration-passphrase' }),
  });
  assert.equal(setupResponse.status, 201);
  const localCookie = setupResponse.headers.get('set-cookie').split(';')[0];
  const createdUser = await fetch(`${localOrigin}/api/users`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: localOrigin, Cookie: localCookie },
    body: JSON.stringify({ username: 'regular-user', password: 'regular-user-passphrase', permissions: [] }),
  });
  assert.equal(createdUser.status, 201);
  const userLogin = await fetch(`${localOrigin}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: localOrigin },
    body: JSON.stringify({ username: 'regular-user', password: 'regular-user-passphrase' }),
  });
  const userCookie = userLogin.headers.get('set-cookie').split(';')[0];
  const closedStatus = await fetch(`${localOrigin}/api/network`, { headers: { Cookie: localCookie } }).then((response) => response.json());
  assert.equal(closedStatus.lan.enabled, false);

  const address = adapter.address;
  const port = await reservePort(address);
  const invalidPort = await fetch(`${localOrigin}/api/network/lan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: localOrigin, Cookie: localCookie },
    body: JSON.stringify({ enabled: true, address, port: 443 }),
  });
  assert.equal(invalidPort.status, 400);
  const publicAddress = await fetch(`${localOrigin}/api/network/lan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: localOrigin, Cookie: localCookie },
    body: JSON.stringify({ enabled: true, address: '8.8.8.8', port }),
  });
  assert.equal(publicAddress.status, 400);
  const deniedEnable = await fetch(`${localOrigin}/api/network/lan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: localOrigin, Cookie: userCookie },
    body: JSON.stringify({ enabled: true, address, port }),
  });
  assert.equal(deniedEnable.status, 403);

  const enableResponse = await fetch(`${localOrigin}/api/network/lan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: localOrigin, Cookie: localCookie },
    body: JSON.stringify({ enabled: true, address, port }),
  });
  const enableText = await enableResponse.text();
  assert.equal(enableResponse.status, 200, enableText);
  const enabledStatus = JSON.parse(enableText);
  assert.equal(enabledStatus.lan.listening, true);
  assert.equal(enabledStatus.lan.url, `https://${address}:${port}`);
  assert.match(enabledStatus.lan.tlsFingerprint, /^[A-F0-9:]+$/u);

  const page = await tlsFetch({ address, port, pathname: '/', headers: { Host: `${address}:${port}` } });
  assert.equal(page.status, 200);
  const foreignOrigin = await tlsFetch({
    address, port, pathname: '/api/login', method: 'POST',
    headers: { Host: `${address}:${port}`, Origin: 'https://untrusted.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'lan-integration-passphrase' }),
  });
  assert.equal(foreignOrigin.status, 403);

  const login = await tlsFetch({
    address, port, pathname: '/api/login', method: 'POST',
    headers: { Host: `${address}:${port}`, Origin: `https://${address}:${port}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'lan-integration-passphrase' }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /; Secure(?:;|$)/u);
  const lanCookie = login.headers['set-cookie'][0].split(';')[0];
  const me = await tlsFetch({ address, port, pathname: '/api/me', headers: { Host: `${address}:${port}`, Cookie: lanCookie } });
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, 'admin');

  await server.close();
  server = await startServer(serverOptions);
  localOrigin = `http://127.0.0.1:${server.port}`;
  const restored = await fetch(`${localOrigin}/api/network`, { headers: { Cookie: localCookie } }).then((response) => response.json());
  assert.equal(restored.lan.listening, true);
  assert.equal(restored.lan.url, `https://${address}:${port}`);
  const restoredLogin = await tlsFetch({ address, port, pathname: '/api/me', headers: { Host: `${address}:${port}`, Cookie: lanCookie } });
  assert.equal(restoredLogin.status, 200);

  const disableResponse = await fetch(`${localOrigin}/api/network/lan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: localOrigin, Cookie: localCookie },
    body: JSON.stringify({ enabled: false, port }),
  });
  assert.equal(disableResponse.status, 200);
  assert.equal((await disableResponse.json()).lan.listening, false);
  await assert.rejects(() => tlsFetch({ address, port, pathname: '/', headers: { Host: `${address}:${port}` } }));
});
