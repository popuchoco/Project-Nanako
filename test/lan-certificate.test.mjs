import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { createLanCertificateProvider } from '../electron/lan-certificate-store.mjs';
import { generateLanCertificate } from '../src/lan-certificate.mjs';

test('LAN TLS certificate is an IP-SAN server certificate with a matching key', async () => {
  const credentials = await generateLanCertificate('192.168.10.3', new Date('2026-11-10T00:00:00Z'));
  const certificate = new X509Certificate(credentials.cert);
  assert.ok(certificate.checkIP('192.168.10.3'));
  assert.equal(certificate.checkIP('192.168.10.4'), undefined);
  assert.match(credentials.fingerprint, /^[A-F0-9:]+$/u);
  assert.ok(credentials.key.includes('PRIVATE KEY'));
});

test('Electron LAN certificate store reuses the certificate while encrypting its private key at rest', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nanako-lan-cert-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'lan-certificate.json');
  let generationTime = new Date('2026-11-10T00:00:00Z');
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'dpapi',
    encryptStringAsync: async (plain) => Buffer.from(plain, 'utf8'),
    decryptStringAsync: async (encrypted) => ({ result: encrypted.toString('utf8'), shouldReEncrypt: false }),
  };
  const getCertificate = createLanCertificateProvider({ filename, safeStorage, now: () => generationTime });
  const first = await getCertificate('192.168.10.3');
  generationTime = new Date('2027-01-10T00:00:00Z');
  const second = await getCertificate('192.168.10.3');
  assert.equal(second.fingerprint, first.fingerprint);
  const stored = await readFile(filename, 'utf8');
  assert.ok(!stored.includes('PRIVATE KEY'));
  assert.ok(JSON.parse(stored).encryptedKey);
  const afterRestart = await createLanCertificateProvider({ filename, safeStorage, now: () => generationTime })('192.168.10.3');
  assert.equal(afterRestart.fingerprint, first.fingerprint);
});

test('LAN certificate creation refuses public and loopback addresses', async () => {
  await assert.rejects(() => generateLanCertificate('8.8.8.8'), /私有 IPv4/u);
  await assert.rejects(() => generateLanCertificate('127.0.0.1'), /私有 IPv4/u);
});

test('LAN certificate store refuses unavailable or plaintext fallback storage', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nanako-lan-cert-unavailable-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const getCertificate = createLanCertificateProvider({
    filename: path.join(directory, 'lan-certificate.json'),
    safeStorage: {
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => 'basic_text',
      encryptStringAsync: async () => { throw new Error('must not encrypt through fallback'); },
      decryptStringAsync: async () => { throw new Error('must not decrypt through fallback'); },
    },
  });
  await assert.rejects(() => getCertificate('192.168.1.20'), /未加密模式/u);
});
