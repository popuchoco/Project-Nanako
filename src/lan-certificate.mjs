import { X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import net from 'node:net';
import selfsigned from 'selfsigned';
import { isPrivateIpv4 } from './network-access.mjs';

export async function generateLanCertificate(address, now = new Date()) {
  if (!net.isIPv4(address) || !isPrivateIpv4(address)) throw new TypeError('區域網路憑證只接受私有 IPv4 位址。');
  const notBeforeDate = new Date(now.getTime() - 5 * 60 * 1000);
  const notAfterDate = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  const material = await selfsigned.generate([{ name: 'commonName', value: 'Nanako Local Network' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyAgreement: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 7, ip: address }] },
    ],
  });
  const certificate = new X509Certificate(material.cert);
  if (!certificate.checkIP(address)) throw new Error('區域網路憑證缺少選定 IP 的 SAN。');
  const credentials = { key: material.private, cert: material.cert, fingerprint: certificate.fingerprint256 };
  // Validate the keypair before it is used by an HTTPS listener.
  createSecureContext({ key: credentials.key, cert: credentials.cert });
  return credentials;
}
