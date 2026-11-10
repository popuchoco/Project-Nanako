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
  const accountMenu = await running.devtools.evaluate(`(() => {
    document.querySelector('#desktop-account').click();
    const menu = document.querySelector('#account-menu');
    return {
      visible: !menu.hidden,
      expanded: document.querySelector('#desktop-account').getAttribute('aria-expanded'),
      quickLinks: [...menu.querySelectorAll('[data-open-view]')].map((item) => item.dataset.openView),
    };
  })()`);
  assert.equal(accountMenu.visible, true);
  assert.equal(accountMenu.expanded, 'true');
  assert.deepEqual(accountMenu.quickLinks.sort(), ['network', 'system', 'users']);
  await running.devtools.evaluate(`(() => { document.querySelector('#desktop-home').click(); return true; })()`);
  await waitForValue(running.devtools, `!document.querySelector('#view-tasks').hidden`, Boolean, 'the top-left Nanako logo opening Task Manager');
  await running.devtools.evaluate(`(() => { document.querySelector('.desktop-icon[data-open-view="files"]').click(); return true; })()`);
  await waitForValue(running.devtools, `!document.querySelector('#view-files').hidden`, Boolean, 'returning to File Manager');
  await running.devtools.evaluate(`(() => {
    document.querySelector('#desktop-account').click();
    document.querySelector('#display-name-button').click();
    const form = document.querySelector('#display-name-form');
    form.elements.displayName.value = 'Nanako 管理員';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  const customIdentity = await waitForValue(
    running.devtools,
    `fetch('/api/me').then((response) => response.json()).then(({ user }) => ({ account: document.querySelector('#account-name')?.textContent?.trim(), username: user.username, displayName: user.displayName }))`,
    (value) => value?.displayName === 'Nanako 管理員',
    'saving a separate display name without changing the login account',
  );
  assert.equal(customIdentity.account, 'Nanako 管理員');
  assert.equal(customIdentity.username, adminUsername);
  await running.devtools.evaluate(`(() => document.querySelector('#dock-launcher').click())()`);
  await running.devtools.evaluate(`new Promise((resolve) => setTimeout(resolve, 200))`);
  const visualConsistency = await running.devtools.evaluate(`(() => {
    const area = document.querySelector('#desktop-area').getBoundingClientRect();
    const menu = document.querySelector('#launcher-menu').getBoundingClientRect();
    const dock = document.querySelector('.desktop-dock').getBoundingClientRect();
    return {
      menuCentered: Math.abs((menu.left + menu.width / 2) - (area.left + area.width / 2)) < 2,
      dockCentered: Math.abs((dock.left + dock.width / 2) - (area.left + area.width / 2)) < 2,
      positions: { area: { left: area.left, width: area.width }, menu: { left: menu.left, width: menu.width }, dock: { left: dock.left, width: dock.width }, menuStyle: { left: getComputedStyle(document.querySelector('#launcher-menu')).left, translate: getComputedStyle(document.querySelector('#launcher-menu')).translate } },
      menuIconCount: document.querySelectorAll('#launcher-menu .launcher-grid > button .desktop-icon-art').length,
      menuIcons: document.querySelectorAll('#launcher-menu .launcher-grid > button').length,
      sharedDesktopArtwork: ['files', 'computer', 'trash', 'album', 'player', 'vault', 'duplicates'].every((view) => document.querySelector('.desktop-shortcuts [data-open-view="' + view + '"] .desktop-icon-art')?.className === document.querySelector('#launcher-menu .launcher-grid [data-open-view="' + view + '"] .desktop-icon-art')?.className),
      quickArtwork: ['files', 'album', 'player'].every((view) => document.querySelector('#launcher-menu .launcher-quick-list [data-open-view="' + view + '"] .desktop-icon-art')?.className === document.querySelector('#launcher-menu .launcher-grid [data-open-view="' + view + '"] .desktop-icon-art')?.className),
      shortcutColumns: new Set([...document.querySelectorAll('.desktop-shortcuts>.desktop-icon')].map((item) => Math.round(item.getBoundingClientRect().left))).size,
      shortcutInset: document.querySelector('.desktop-shortcuts').firstElementChild.getBoundingClientRect().left - document.querySelector('.desktop-shortcuts').getBoundingClientRect().left,
      dialogsConsistent: [...document.querySelectorAll('dialog')].every((dialog) => dialog.classList.contains('confirm-dialog') || dialog.classList.contains('photo-dialog')),
    };
  })()`);
  assert.equal(visualConsistency.menuCentered, true, `the dock launcher should open its menu in the desktop center (${JSON.stringify(visualConsistency)})`);
  assert.equal(visualConsistency.dockCentered, true, 'the dock itself should remain centered');
  assert.equal(visualConsistency.menuIconCount, visualConsistency.menuIcons, 'all launcher applications should use a desktop-style icon');
  assert.equal(visualConsistency.sharedDesktopArtwork, true, 'launcher icons already present on the desktop should reuse the same artwork');
  assert.equal(visualConsistency.quickArtwork, true, 'quick-launch icons should reuse the same desktop artwork');
  assert.equal(visualConsistency.shortcutColumns, 2, `the default window should place the overflow shortcut in the second column (${JSON.stringify(visualConsistency)})`);
  assert.ok(visualConsistency.shortcutInset >= 4, 'desktop shortcut focus ring should have room inside its rail');
  assert.equal(visualConsistency.dialogsConsistent, true, 'every app dialog should use the themed dialog style');
  const responsiveShortcuts = await running.devtools.evaluate(`(() => {
    const rail = document.querySelector('.desktop-shortcuts');
    const countColumns = () => new Set([...rail.children].map((item) => Math.round(item.getBoundingClientRect().left))).size;
    const initial = countColumns();
    rail.style.bottom = '400px';
    const compact = countColumns();
    rail.style.bottom = '';
    const restored = countColumns();
    return { initial, compact, restored };
  })()`);
  assert.ok(responsiveShortcuts.compact > responsiveShortcuts.initial, 'reducing available desktop height should flow shortcuts into additional columns');
  assert.equal(responsiveShortcuts.restored, responsiveShortcuts.initial, 'restoring desktop height should restore the previous shortcut columns');
  await running.devtools.evaluate(`(() => document.querySelector('#dock-launcher').click())()`);
  const shellLayout = await running.devtools.evaluate(`(() => {
    const bar = document.querySelector('.system-bar');
    const launcher = document.querySelector('#launcher-toggle');
    const shortcuts = document.querySelector('.desktop-shortcuts');
    return {
      integratedTitlebar: document.documentElement.classList.contains('electron-windows-titlebar'),
      barRegion: getComputedStyle(bar).webkitAppRegion,
      launcherRegion: getComputedStyle(launcher).webkitAppRegion,
      shortcutsOverflowX: getComputedStyle(shortcuts).overflowX,
      shortcutsScrollWidth: shortcuts.scrollWidth,
      shortcutsClientWidth: shortcuts.clientWidth,
    };
  })()`);
  assert.equal(shellLayout.integratedTitlebar, true);
  assert.equal(shellLayout.barRegion, 'drag');
  assert.equal(shellLayout.launcherRegion, 'no-drag');
  assert.equal(shellLayout.shortcutsOverflowX, 'hidden');
  assert.ok(shellLayout.shortcutsScrollWidth <= shellLayout.shortcutsClientWidth, 'desktop shortcuts should not overflow horizontally');
  await running.devtools.evaluate(`(() => {
    document.querySelector('#new-folder').click();
    return true;
  })()`);
  await waitForValue(running.devtools, `document.querySelector('#app-action-dialog').open`, Boolean, 'the branded create-folder prompt');
  await running.devtools.evaluate(`(() => {
    const input = document.querySelector('#app-action-input'); input.value = ${JSON.stringify(folderName)};
    document.querySelector('#app-action-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
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
  await waitForValue(
    running.devtools,
    `document.querySelector('#user-list')?.innerText || ''`,
    (text) => text.includes(userUsername),
    'the newly created account in the user list',
  );
  const managedControls = await running.devtools.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#user-list .user-card')];
    const managed = rows.find((row) => row.innerText.includes(${JSON.stringify(userUsername)}));
    const self = rows.find((row) => row.innerText.includes(${JSON.stringify(adminUsername)}));
    return {
      managed: [...managed.querySelectorAll('button')].map((button) => button.textContent.trim()),
      self: [...self.querySelectorAll('button')].map((button) => button.textContent.trim()),
    };
  })()`);
  assert.ok(managedControls.managed.includes('編輯名稱'));
  assert.ok(managedControls.managed.includes('重設密碼'));
  assert.ok(managedControls.self.includes('編輯名稱'), 'admin can manage their own display name from the user screen');
  assert.ok(managedControls.self.includes('變更密碼'), 'admin can manage their own password from the user screen');
  await running.devtools.evaluate(`(() => {
    const row = [...document.querySelectorAll('#user-list .user-card')].find((item) => item.innerText.includes(${JSON.stringify(userUsername)}));
    row.querySelector('.user-edit-name-button').click();
    const dialog = document.querySelector('#app-action-dialog');
    document.querySelector('#app-action-input').value = '家庭成員';
    document.querySelector('#app-action-input').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#app-action-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  await waitForValue(running.devtools, `document.querySelector('#app-action-dialog').open`, (open) => !open, 'saving a managed user display name');
  const managedName = await waitForValue(
    running.devtools,
    `fetch('/api/users').then((response) => response.json()).then(({ users }) => users.find((user) => user.username === ${JSON.stringify(userUsername)})?.displayName)` ,
    (value) => value === '家庭成員',
    'the managed user display name update',
  );
  assert.equal(managedName, '家庭成員');
  await running.devtools.evaluate(`(() => {
    const row = [...document.querySelectorAll('#user-list .user-card')].find((item) => item.innerText.includes(${JSON.stringify(userUsername)}));
    row.querySelector('.user-reset-password-button').click();
    const form = document.querySelector('#reset-user-password-form');
    form.elements.newPassword.value = ${JSON.stringify(`${userPassword}-reset`)};
    form.elements.confirmPassword.value = ${JSON.stringify(`${userPassword}-reset`)};
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  await waitForValue(running.devtools, `document.querySelector('#reset-user-password-dialog').open`, (open) => !open, 'resetting a managed user password');
  await running.devtools.evaluate(`(() => {
    document.querySelector('#launcher-toggle').click();
    document.querySelector('#launcher-menu [data-open-view="tasks"]').click();
    return true;
  })()`);
  const taskView = await waitForValue(
    running.devtools,
    `({ visible: !document.querySelector('#view-tasks').hidden, total: document.querySelector('#task-total-count').textContent, status: document.querySelector('#task-poll-status').textContent })`,
    (value) => value?.visible && value?.status.includes('自動更新'),
    'the task manager live transfer summary',
  );
  assert.equal(taskView.total, '0');
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
  assert.equal(retained.account, 'Nanako 管理員');
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
