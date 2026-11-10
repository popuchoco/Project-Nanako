import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID, X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { generateLanCertificate } from '../src/lan-certificate.mjs';

export function createLanCertificateProvider({ filename, safeStorage, now = () => new Date() }) {
  let cachedAddress = '';
  let cachedCredentials = null;

  return async function getLanCertificate(address) {
    if (cachedAddress === address && cachedCredentials) return cachedCredentials;
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Windows 安全儲存目前無法使用，已停止啟用區域網路服務。');
    const backend = safeStorage.getSelectedStorageBackend?.();
    if (backend === 'basic_text') throw new Error('安全儲存目前使用未加密模式，已停止啟用區域網路服務。');

    let saved = null;
    const info = await lstat(filename).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (info?.isSymbolicLink() || info?.isDirectory() || (info && !info.isFile())) {
      throw new Error('Nanako 網路憑證檔案狀態不安全。');
    }
    if (info) {
      try { saved = JSON.parse(await readFile(filename, 'utf8')); }
      catch { saved = null; }
    }
    if (saved?.address === address && typeof saved.cert === 'string' && typeof saved.encryptedKey === 'string') {
      try {
        const decrypted = await safeStorage.decryptStringAsync(Buffer.from(saved.encryptedKey, 'base64'));
        const key = decrypted.result;
        const certificate = new X509Certificate(saved.cert);
        const expiresAt = Date.parse(certificate.validTo);
        const stillValid = Number.isFinite(expiresAt) && expiresAt > now().getTime() + 14 * 24 * 60 * 60 * 1000;
        if (stillValid && certificate.checkIP(address)) {
          createSecureContext({ key, cert: saved.cert });
          cachedCredentials = { key, cert: saved.cert, fingerprint: certificate.fingerprint256 };
          cachedAddress = address;
          if (decrypted.shouldReEncrypt) await saveCredential(address, saved.cert, key);
          return cachedCredentials;
        }
      } catch { /* Invalid/expired/corrupt credentials are replaced below. */ }
    }

    const fresh = await generateLanCertificate(address, now());
    await saveCredential(address, fresh.cert, fresh.key);
    cachedAddress = address;
    cachedCredentials = fresh;
    return fresh;
  };

  async function saveCredential(address, cert, key) {
    const encryptedKey = await safeStorage.encryptStringAsync(key);
    const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ address, cert, encryptedKey: encryptedKey.toString('base64') }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const tempInfo = await lstat(temporary);
    if (tempInfo.isSymbolicLink() || !tempInfo.isFile()) throw new Error('Nanako 網路憑證暫存檔案狀態不安全。');
    await rename(temporary, filename);
  }
}
