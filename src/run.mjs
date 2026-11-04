import os from 'node:os';
import path from 'node:path';
import { startServer } from './server.mjs';

const dataDir = process.env.LOCALNAS_DATA_DIR || path.join(process.env.LOCALAPPDATA || os.homedir(), 'LocalNAS', 'data');
const host = process.env.LOCALNAS_HOST || '127.0.0.1';
const port = Number(process.env.LOCALNAS_PORT || 8765);

const server = await startServer({ dataDir, host, port });
console.log(`LocalNAS 已啟動：http://${host}:${server.port}`);
console.log(`資料目錄：${dataDir}`);

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
