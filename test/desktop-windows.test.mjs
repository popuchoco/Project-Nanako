import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('window-all-closed keeps the process alive while the tray is active', async () => {
  const main = await readFile(path.join(root, 'electron', 'main.mjs'), 'utf8');
  const handler = main.match(/app\.on\('window-all-closed',\s*\(\)\s*=>\s*\{([\s\S]*?)\n\}\);/);

  assert.ok(handler, 'window-all-closed handler should exist');
  assert.match(handler[1], /trayRef\s*&&\s*!trayRef\.isDestroyed\(\)\s*&&\s*!closing/);
  assert.match(handler[1], /if\s*\(trayKeepsAlive\)\s*return;/);
  assert.match(handler[1], /if\s*\(os\.platform\(\)\s*!==\s*'darwin'\)\s*app\.quit\(\);/);
  assert.doesNotMatch(handler[1], /app\.quit\(\);\s*\n\s*\}/, 'quit should remain gated by the tray and platform conditions');
});

test('Windows desktop chrome is integrated with the app bar and hides the native app menu', async () => {
  const main = await readFile(path.join(root, 'electron', 'main.mjs'), 'utf8');
  const app = await readFile(path.join(root, 'public', 'app.js'), 'utf8');
  const styles = await readFile(path.join(root, 'public', 'styles.css'), 'utf8');

  assert.match(main, /titleBarStyle:\s*'hidden'/);
  assert.match(main, /titleBarOverlay:\s*\{\s*color:\s*'#114167'/);
  assert.match(main, /Menu\.setApplicationMenu\(null\)/);
  assert.match(app, /electron-windows-titlebar/);
  assert.match(styles, /\.electron-windows-titlebar \.system-bar\s*\{[^}]*-webkit-app-region:\s*drag/s);
  assert.match(styles, /\.electron-windows-titlebar \.system-bar :is\([^{}]*\)\s*\{[^}]*-webkit-app-region:\s*no-drag/s);
  assert.match(styles, /\.desktop-shortcuts\{overflow-x:hidden;overflow-y:auto\}/);
  assert.match(styles, /\.desktop-shortcuts\{scrollbar-width:none;-ms-overflow-style:none\}/);
  assert.match(styles, /\.desktop-shortcuts::-webkit-scrollbar\{display:none;width:0;height:0\}/);
  assert.match(styles, /@media\(hover:hover\) and \(pointer:fine\)\{\.desktop-icon:hover\{[^}]*transition-delay:130ms\}/);
  assert.match(styles, /\.desktop-icon:focus-visible\{transition-delay:0ms\}/);
});

test('desktop shell contains independent Nanako application-window regions and switchers', async () => {
  const html = await readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const app = await readFile(path.join(root, 'public', 'app.js'), 'utf8');
  const fileListing = await readFile(path.join(root, 'public', 'file-listing.mjs'), 'utf8');
  const styles = await readFile(path.join(root, 'public', 'styles.css'), 'utf8');

  assert.match(html, /id="window-layer"/);
  assert.match(html, /id="app-window-template"/);
  assert.match(html, /id="taskbar-windows"/);
  assert.match(html, /id="dock-windows"/);
  assert.match(html, /class="desktop-status-widget"/);
  assert.match(html, /id="desktop-widget-time"/);
  assert.match(html, /id="desktop-widget-share-count"/);
  assert.match(html, /class="launcher-quick-access"/);
  assert.match(html, /id="launcher-quick-title"/);
  assert.match(html, /data-window-action="minimize"/);
  assert.match(html, /data-window-action="maximize"/);
  assert.match(html, /data-window-action="close"/);
  assert.match(html, /class="file-manager-sidebar"/);
  assert.match(html, /id="file-search"/);
  assert.match(html, /id="file-sort"/);
  assert.match(html, /id="view-tasks"/);
  assert.match(html, /id="network-test-button"/);
  assert.match(html, /http:\/\/www\.msftconnecttest\.com\/connecttest\.txt/);
  assert.match(html, /不是網站首頁/);
  assert.match(html, /不保證所有網站都能連線/);
  assert.match(html, /id="display-name-form"/);
  for (const category of ['image', 'video', 'audio', 'document']) assert.ok(html.includes(`data-file-category="${category}"`));
  assert.match(app, /windows:\s*new Map\(\)/);
  assert.match(app, /function createAppWindow\(view\)/);
  assert.match(app, /function focusWindow\(view/);
  assert.match(app, /function minimizeWindow\(view\)/);
  assert.match(app, /function closeWindow\(view\)/);
  assert.match(app, /api\('\/api\/tasks'\)/);
  assert.match(app, /api\('\/api\/network\/test'/);
  assert.match(app, /function updateAccountIdentity\(\)/);
  assert.match(app, /function setFileCategory\(category\)/);
  assert.match(app, /filterAndSortFiles\(items/);
  assert.match(fileListing, /item\.name\.toLocaleLowerCase\('zh-TW'\)\.includes\(query\)/);
  assert.match(styles, /\.window-layer\s*\{/);
  assert.match(styles, /\.app-window\.is-active/);
  assert.match(styles, /\.desktop-status-widget/);
  assert.match(styles, /\.launcher-quick-list/);
  assert.match(styles, /prefers-reduced-motion:reduce/);

  const appDefinitionSource = app.slice(app.indexOf('const appDefinitions = {'), app.indexOf('const mediaExtensions ='));
  const definitions = [...appDefinitionSource.matchAll(/\b([a-z]+): \{ name:/g)].map((match) => match[1]);
  assert.ok(definitions.length >= 10, 'every shipped Nanako app should have a definition');
  for (const view of definitions) assert.ok(html.includes(`id="view-${view}"`), `${view} must have its own content panel`);
  assert.doesNotMatch(html, /id="app-window"|id="dock-app"/, 'legacy shared-window shell should be removed');
});

test('experimental SMB checkbox starts locked and follows the verified Windows 11 24H2 gate', async () => {
  const html = await readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const app = await readFile(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(html, /id="smb-experimental-enabled" type="checkbox" disabled/);
  assert.match(html, /僅限 Windows 11 24H2 以上|Windows 11 24H2 以上/);
  assert.match(app, /checkbox\.disabled = !supported/);
  assert.match(app, /api\('\/api\/smb\/experimental'/);
  assert.match(app, /SMB 伺服器尚未整合/);
});

