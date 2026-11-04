import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageRoot = path.join(projectRoot, 'NanakoData');
const dataDir = path.join(storageRoot, 'data');
const host = process.env.LOCALNAS_HOST || '127.0.0.1';
const port = Number(process.env.LOCALNAS_PORT || 8765);

const server = await startServer({ dataDir, storageRoot, host, port });
console.log(`Nanako 已啟動：http://${host}:${server.port}`);
console.log(`資料目錄：${dataDir}`);

const stop = async () => {
  await server.close();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
