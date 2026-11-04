import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { startServer } from '../src/server.mjs';

let service;
let windowRef;
let closing = false;

async function createWindow() {
  service ??= await startServer({
    dataDir: path.join(app.getPath('userData'), 'data'),
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

app.whenReady().then(createWindow).catch((error) => {
  console.error('LocalNAS 啟動失敗。', error);
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
