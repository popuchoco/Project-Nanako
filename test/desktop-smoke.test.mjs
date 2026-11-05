import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const projectRoot = path.resolve(import.meta.dirname, '..');
const adminUsername = 'desktop-smoke-admin';
const adminPassword = 'desktop-smoke-passphrase-2026';
const userUsername = 'desktop-smoke-user';
const userPassword = 'desktop-smoke-user-passphrase-2026';
const folderName = 'desktop-smoke-persisted';

async function getFreePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForTarget(debugPort, processRef) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (processRef.exitCode !== null) {
      throw new Error(`Electron exited before exposing DevTools (code ${processRef.exitCode}).`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((item) => item.type === 'page' && item.url.startsWith('http://127.0.0.1:'));
        if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
      }
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for the Nanako Electron page${lastError ? `: ${lastError.message}` : '.'}`);
}

async function connectDevTools(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const events = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data));
    if (!message.id) { events.push(message); return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) entry.reject(new Error('Electron DevTools connection closed.'));
    pending.clear();
  });

  function send(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result?.value;
  }

  await send('Runtime.enable');
  await send('Log.enable');

  return { evaluate, send, events, close: () => socket.close() };
}

async function launchNanako(dataRoot) {
  const debugPort = await getFreePort();
  const child = spawn(electronPath, [
    `--remote-debugging-port=${debugPort}`,
    '--remote-allow-origins=*',
    'electron/main.mjs',
  ], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORTABLE_EXECUTABLE_DIR: dataRoot,
      NANAKO_DESKTOP_SMOKE_TEST: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.logs = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { child.logs = `${child.logs}${chunk}`.slice(-8_000); });
  }
  const webSocketUrl = await waitForTarget(debugPort, child);
  const devtools = await connectDevTools(webSocketUrl);
  return { child, devtools };
}

async function waitForValue(devtools, expression, predicate, label) {
  const deadline = Date.now() + 20_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await devtools.evaluate(expression);
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(latest)}`);
}

async function submitCredentials(devtools, mode) {
  const state = await devtools.evaluate(`(async () => {
    const title = document.querySelector('#auth-title')?.textContent?.trim();
    const shell = document.querySelector('#app-shell');
    if (!shell?.hidden) return { screen: 'app', title };
    const username = document.querySelector('#auth-username');
    const password = document.querySelector('#auth-password');
    if (!username || !password) return { screen: 'missing-auth-form', title };
    username.value = ${JSON.stringify(adminUsername)};
    password.value = ${JSON.stringify(adminPassword)};
    document.querySelector('#auth-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!shell.hidden) return { screen: 'app', title };
      const error = document.querySelector('#auth-error');
      if (!error.hidden) return { screen: 'auth-error', message: error.textContent };
    }
    return { screen: 'timeout', title };
  })()`);
  assert.equal(state.screen, 'app', `${mode}: app shell did not open (${JSON.stringify(state)})`);
}

async function closeNanako({ child, devtools }) {
  try { await devtools.send('Browser.close'); } catch { /* Electron may close the channel before replying. */ }
  devtools.close();
  if (child.exitCode === null) {
    let timeout;
    try {
      await Promise.race([
        once(child, 'exit'),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Electron did not close cleanly.')), 10_000);
          timeout.unref?.();
        }),
      ]);
    } finally { clearTimeout(timeout); }
  }
  assert.equal(child.exitCode, 0, 'Electron should finish its normal close path.');
}

test('Electron desktop setup, restart and local media resume preserve Nanako state', {
  skip: process.platform !== 'win32',
  timeout: 120_000,
}, async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'nanako-desktop-smoke-'));
  let running;
  t.after(async () => {
    if (running?.child.exitCode === null) {
      running.child.kill();
      let timeout;
      try {
        await Promise.race([
          once(running.child, 'exit'),
          new Promise((resolve) => { timeout = setTimeout(resolve, 2_000); timeout.unref?.(); }),
        ]);
      } finally { clearTimeout(timeout); }
    }
    await rm(dataRoot, { recursive: true, force: true });
  });

  running = await launchNanako(dataRoot);
  let firstRun;
  try {
    firstRun = await waitForValue(
      running.devtools,
      `({ title: document.querySelector('#auth-title')?.textContent?.trim(), mode: document.querySelector('#auth-form')?.dataset.mode })`,
      (value) => value?.mode === 'setup',
      'first-run administrator setup',
    );
  } catch (error) {
    const diagnostics = await running.devtools.evaluate(`(async () => ({ ready: document.readyState, authHidden: document.querySelector('#auth-screen').hidden, shellHidden: document.querySelector('#app-shell').hidden, formMode: document.querySelector('#auth-form').dataset.mode, setupState: await fetch('/api/setup-state').then((response) => response.text()).catch((fetchError) => fetchError.message), appImport: await import('/app.js').then(() => 'loaded').catch((importError) => importError.message), resources: performance.getEntriesByType('resource').map((entry) => ({ name: entry.name, duration: entry.duration })) }))()`).catch(() => null);
    throw new Error(`${error.message}\nRenderer diagnostics: ${JSON.stringify(diagnostics)}\nBrowser events: ${JSON.stringify(running.devtools.events.slice(-20))}\nElectron logs: ${running.child.logs}`);
  }
  assert.equal(firstRun.title, '設定本機管理員');
  await submitCredentials(running.devtools, 'first run');

  await waitForValue(
    running.devtools,
    `({ visible: !document.querySelector('#app-shell').hidden, writable: !document.querySelector('#new-folder').disabled })`,
    (value) => value?.visible && value?.writable,
    'the initial writable file view',
  );
  await running.devtools.evaluate(`(() => {
    window.prompt = () => ${JSON.stringify(folderName)};
    document.querySelector('#new-folder').click();
    return true;
  })()`);
  await waitForValue(
    running.devtools,
    `document.querySelector('#file-list')?.innerText || ''`,
    (text) => text.includes(folderName),
    'the newly created folder in the file list',
  );
  const uploadedMedia = await running.devtools.evaluate(`(async () => {
    const sampleRate = 8_000;
    const dataBytes = sampleRate * 2 * 30;
    const bytes = new Uint8Array(44 + dataBytes);
    const view = new DataView(bytes.buffer);
    const writeText = (offset, value) => { for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index); };
    writeText(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); writeText(8, 'WAVE');
    writeText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); writeText(36, 'data'); view.setUint32(40, dataBytes, true);
    const shareId = document.querySelector('#share-select').value;
    const query = new URLSearchParams({ shareId, path: '', name: 'desktop-smoke-resume.wav' });
    const response = await fetch('/api/upload?' + query, { method: 'POST', body: new Blob([bytes], { type: 'audio/wav' }) });
    return { status: response.status, shareId, message: response.ok ? '' : await response.text() };
  })()`);
  assert.equal(uploadedMedia.status, 201, `media fixture upload failed: ${uploadedMedia.message}`);
  await running.devtools.evaluate(`(() => {
    document.querySelector('#launcher-toggle').click();
    document.querySelector('#launcher-menu [data-open-view="player"]').click();
    return true;
  })()`);
  await waitForValue(
    running.devtools,
    `!!document.querySelector('#player-queue .queue-track[data-track-path="desktop-smoke-resume.wav"]')`,
    Boolean,
    'the uploaded media in the player queue',
  );
  await running.devtools.evaluate(`(() => { document.querySelector('#player-queue .queue-track[data-track-path="desktop-smoke-resume.wav"]').click(); return true; })()`);
  await waitForValue(
    running.devtools,
    `document.querySelector('#audio-player')?.readyState >= 1`,
    Boolean,
    'media metadata before saving a resume point',
  );
  await running.devtools.evaluate(`(() => { const player = document.querySelector('#audio-player'); player.pause(); player.currentTime = 12; return true; })()`);
  const savedProgress = await waitForValue(
    running.devtools,
    `fetch('/api/playback-progress?' + new URLSearchParams({ shareId: ${JSON.stringify(uploadedMedia.shareId)} })).then((response) => response.json()).then((result) => result.progress.find((item) => item.path === 'desktop-smoke-resume.wav')?.position ?? null)`,
    (value) => Number.isFinite(value) && value >= 11.9,
    'the local playback resume point',
  );
  assert.ok(savedProgress >= 11.9 && savedProgress <= 12.1);
  await running.devtools.evaluate(`(() => {
    document.querySelector('#launcher-toggle').click();
    document.querySelector('#launcher-menu [data-open-view="users"]').click();
    return true;
  })()`);
  await waitForValue(
    running.devtools,
    `({ visible: !document.querySelector('#view-users').hidden, username: !!document.querySelector('#user-form input[name="username"]') })`,
    (value) => value?.visible && value?.username,
    'the user-management form',
  );
  await running.devtools.evaluate(`(() => {
    const form = document.querySelector('#user-form');
    form.elements.username.value = ${JSON.stringify(userUsername)};
    form.elements.password.value = ${JSON.stringify(userPassword)};
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  const createdUser = await waitForValue(
    running.devtools,
    `({ message: document.querySelector('#user-message').textContent, username: document.querySelector('#user-form input[name="username"]').value })`,
    (value) => value?.message === '使用者已建立。',
    'successful user creation feedback',
  );
  assert.equal(createdUser.username, '', 'the user form should reset only after successful creation.');
  await closeNanako(running);
  running = null;

  running = await launchNanako(dataRoot);
  const restarted = await waitForValue(
    running.devtools,
    `({ title: document.querySelector('#auth-title')?.textContent?.trim(), shell: !document.querySelector('#app-shell')?.hidden, account: document.querySelector('#account-name')?.textContent?.trim() })`,
    (value) => value?.title === '登入 Nanako' || value?.shell,
    'the restarted app session',
  );
  if (!restarted.shell) await submitCredentials(running.devtools, 'restart');
  const retained = await waitForValue(
    running.devtools,
    `({ account: document.querySelector('#account-name')?.textContent?.trim(), files: document.querySelector('#file-list')?.innerText || '' })`,
    (value) => value?.files.includes(folderName),
    'the persisted folder after restart',
  );
  assert.equal(retained.account, adminUsername);
  await running.devtools.evaluate(`(() => {
    document.querySelector('#launcher-toggle').click();
    document.querySelector('#launcher-menu [data-open-view="player"]').click();
    return true;
  })()`);
  await waitForValue(
    running.devtools,
    `!!document.querySelector('#player-queue .queue-track[data-track-path="desktop-smoke-resume.wav"]')`,
    Boolean,
    'the persisted media in the restarted player queue',
  );
  await running.devtools.evaluate(`(() => { document.querySelector('#player-queue .queue-track[data-track-path="desktop-smoke-resume.wav"]').click(); return true; })()`);
  const resumed = await running.devtools.evaluate(`(async () => {
    const player = document.querySelector('#audio-player');
    if (player.readyState < 1) await new Promise((resolve) => player.addEventListener('loadedmetadata', resolve, { once: true }));
    player.pause();
    return { ready: player.readyState >= 1, currentTime: player.currentTime, message: document.querySelector('#player-message')?.textContent };
  })()`);
  assert.equal(resumed.ready, true, 'media metadata should reload after restart');
  assert.ok(resumed.currentTime >= 11.9 && resumed.currentTime <= 12.5, `expected resume near 12 seconds, got ${resumed.currentTime}`);
  assert.match(resumed.message, /0:12/u);
  await closeNanako(running);
  running = null;
});
