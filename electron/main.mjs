import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
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
const traySmokeTest = process.argv.includes('--tray-smoke-test');
if (compatibilityTest) app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let service;
let windowRef;
let trayRef;
let windowCreation;
let closing = false;

const smokeTest = process.env.NANAKO_DESKTOP_SMOKE_TEST === '1';

function showWindow() {
  if (!windowRef || windowRef.isDestroyed()) {
    void createWindow();
    return;
  }
  if (windowRef.isMinimized()) windowRef.restore();
  windowRef.show();
  windowRef.focus();
}

function createTray() {
  if (smokeTest || trayRef) return;
  const icon = nativeImage.createFromBuffer(readFileSync(path.join(currentDir, 'assets', 'nanako-tray.png')))
    .resize({ width: 32, height: 32 });
  if (icon.isEmpty()) throw new Error('Nanako 系統匣圖示無法載入。');
  trayRef = new Tray(icon);
  trayRef.setToolTip('Project Nanako｜本機檔案空間');
  trayRef.setContextMenu(Menu.buildFromTemplate([
    { label: '開啟 Nanako', click: showWindow },
    { type: 'separator' },
    { label: '退出 Nanako', click: () => app.quit() },
  ]));
  trayRef.on('click', showWindow);
  trayRef.on('double-click', showWindow);
}

async function createWindow() {
  if (windowRef && !windowRef.isDestroyed()) {
    showWindow();
    return;
  }
  if (windowCreation) return windowCreation;
  windowCreation = createWindowInstance();
  try { await windowCreation; }
  finally { windowCreation = null; }
}

async function createWindowInstance() {
  service ??= await startServer({
    dataDir: dataDirectory,
    storageRoot: appDataDirectory,
    host: '127.0.0.1',
    port: 0,
  });
  windowRef = new BrowserWindow({
    width: 1280,
    height: 820,
    show: process.env.NANAKO_DESKTOP_SMOKE_TEST !== '1',
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
  windowRef.on('close', (event) => {
    if (!closing && !smokeTest && trayRef) {
      event.preventDefault();
      windowRef.hide();
    }
  });
  windowRef.on('closed', () => { windowRef = null; });
  await windowRef.loadURL(origin);
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

async function runTraySmokeTest() {
  createTray();
  await createWindow();
  windowRef.close();
  const hiddenToTray = !windowRef.isVisible() && !windowRef.isDestroyed();
  showWindow();
  if (!trayRef || trayRef.isDestroyed() || !hiddenToTray || !windowRef.isVisible()) {
    throw new Error('系統匣圖示或視窗還原流程未成功。');
  }
  const report = { trayCreated: true, closeHidesToTray: hiddenToTray, windowRestored: true };
  await writeFile(path.join(appDataDirectory, 'tray-smoke-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report));
  app.quit();
}

app.whenReady().then(async () => {
  if (compatibilityTest) return runMediaCompatibilityTest();
  if (traySmokeTest) return runTraySmokeTest();
  createTray();
  return createWindow();
}).catch((error) => {
  console.error('Nanako 啟動失敗。', error);
  if (traySmokeTest) { app.exit(2); return; }
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
