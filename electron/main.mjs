import { app, BrowserWindow } from 'electron';
import { lstatSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.mjs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const portableDirectory = process.env.PORTABLE_EXECUTABLE_DIR;
const applicationDirectory = portableDirectory
  || (app.isPackaged ? path.dirname(process.execPath) : path.resolve(currentDir, '..'));
const appDataDirectory = path.join(applicationDirectory, 'NanakoData');
function ensurePortableDirectory(directory) {
  let info;
  try { info = lstatSync(directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (info?.isSymbolicLink() || (info && !info.isDirectory())) {
    throw new Error('Nanako 可攜式資料目錄不可使用符號連結、重新解析點或非資料夾項目。');
  }
  if (!info) mkdirSync(directory);
  info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('Nanako 可攜式資料目錄不可使用符號連結、重新解析點或非資料夾項目。');
  }
}
for (const directory of [appDataDirectory, path.join(appDataDirectory, 'profile'), path.join(appDataDirectory, 'session'), path.join(appDataDirectory, 'data')]) {
  ensurePortableDirectory(directory);
}
app.setPath('userData', path.join(appDataDirectory, 'profile'));
app.setPath('sessionData', path.join(appDataDirectory, 'session'));
const dataDirectory = path.join(appDataDirectory, 'data');
const compatibilityTest = process.argv.includes('--media-compatibility-test');
if (compatibilityTest) app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let service;
let windowRef;
let closing = false;

async function createWindow() {
  service ??= await startServer({
    dataDir: dataDirectory,
    storageRoot: appDataDirectory,
    host: '127.0.0.1',
    port: 0,
  });
  windowRef = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 600,
    title: 'Nanako｜本機檔案空間',
    backgroundColor: '#f4f6f7',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const origin = `http://127.0.0.1:${service.port}`;
  windowRef.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  windowRef.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(`${origin}/`)) event.preventDefault();
  });
  await windowRef.loadURL(origin);
  windowRef.on('closed', () => { windowRef = null; });
}

async function runMediaCompatibilityTest() {
  const testWindow = new BrowserWindow({
    show: false,
    width: 640,
    height: 480,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await testWindow.loadFile(path.join(currentDir, 'media-compatibility-harness.html'));
    const suite = await testWindow.webContents.executeJavaScript('window.runMediaCompatibilitySuite()');
    const report = {
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
      ...suite,
    };
    const reportPath = path.join(appDataDirectory, 'media-compatibility-report.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(report, null, 2));
    console.log(`媒體相容性報告已存至：${reportPath}`);
    await testWindow.destroy();
    // Unsupported codecs are valid compatibility findings, not harness crashes.
    app.exit(0);
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, electron: process.versions.electron, chromium: process.versions.chrome }, null, 2));
    if (!testWindow.isDestroyed()) await testWindow.destroy();
    app.exit(2);
  }
}

app.whenReady().then(() => compatibilityTest ? runMediaCompatibilityTest() : createWindow()).catch((error) => {
  console.error('Nanako 啟動失敗。', error);
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', (event) => {
  if (!service || closing) return;
  event.preventDefault();
  closing = true;
  service.close().finally(() => app.quit());
});

app.on('window-all-closed', () => {
  if (os.platform() !== 'darwin') app.quit();
});
