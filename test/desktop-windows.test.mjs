import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  for (const category of ['image', 'video', 'audio', 'document']) assert.ok(html.includes(`data-file-category="${category}"`));
  assert.match(app, /windows:\s*new Map\(\)/);
  assert.match(app, /function createAppWindow\(view\)/);
  assert.match(app, /function focusWindow\(view/);
  assert.match(app, /function minimizeWindow\(view\)/);
  assert.match(app, /function closeWindow\(view\)/);
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

