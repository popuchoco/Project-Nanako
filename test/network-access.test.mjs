import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isIpv4InSubnet,
  isLanPeerAllowed,
  isLanPort,
  isPrivateIpv4,
  normalizeIpv4,
  publicLanStatus,
  selectLanInterface,
} from '../src/network-access.mjs';

test('LAN listeners accept only usable private IPv4 addresses and non-privileged ports', () => {
  for (const address of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.10']) assert.equal(isPrivateIpv4(address), true);
  for (const address of ['127.0.0.1', '169.254.1.1', '172.32.0.1', '8.8.8.8', '::1', '192.168.1.999']) assert.equal(isPrivateIpv4(address), false);
  for (const port of [1024, 8765, 65535]) assert.equal(isLanPort(port), true);
  for (const port of [0, 80, 443, 65536, 8765.5, '8765']) assert.equal(isLanPort(port), false);
});

test('LAN interface selection requires a live, non-loopback private IPv4 interface', () => {
  const interfaces = [
    { name: 'loopback', family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true },
    { name: 'wifi', family: 'IPv4', address: '192.168.1.25', netmask: '255.255.255.0', internal: false },
    { name: 'public', family: 'IPv4', address: '8.8.8.8', netmask: '255.255.255.0', internal: false },
  ];
  assert.equal(selectLanInterface(interfaces, '192.168.1.25').name, 'wifi');
  assert.equal(selectLanInterface(interfaces, '127.0.0.1'), null);
  assert.equal(selectLanInterface(interfaces, '8.8.8.8'), null);
});

test('LAN peer checks require HTTPS origin, selected local interface and same private subnet', () => {
  const interfaceInfo = { name: 'wifi', family: 'IPv4', address: '192.168.1.25', netmask: '255.255.255.0', internal: false };
  const base = {
    localAddress: '192.168.1.25', host: '192.168.1.25:8765', port: 8765,
    interfaceInfo, enabled: true,
  };
  assert.equal(isLanPeerAllowed({ ...base, peerAddress: '192.168.1.45', origin: 'https://192.168.1.25:8765' }), true);
  assert.equal(isLanPeerAllowed({ ...base, peerAddress: '::ffff:192.168.1.45', origin: 'https://192.168.1.25:8765' }), true);
  assert.equal(isLanPeerAllowed({ ...base, peerAddress: '192.168.2.45', origin: 'https://192.168.1.25:8765' }), false);
  assert.equal(isLanPeerAllowed({ ...base, peerAddress: '10.1.2.3', origin: 'https://192.168.1.25:8765' }), false);
  assert.equal(isLanPeerAllowed({ ...base, peerAddress: '192.168.1.45', origin: 'http://192.168.1.25:8765' }), false);
  assert.equal(isLanPeerAllowed({ ...base, peerAddress: '192.168.1.45', origin: 'https://evil.test' }), false);
  assert.equal(isLanPeerAllowed({ ...base, peerAddress: '192.168.1.45', origin: '', enabled: false }), false);
  assert.equal(isIpv4InSubnet('192.168.1.99', '192.168.1.25', '255.255.255.0'), true);
  assert.equal(normalizeIpv4('::ffff:192.168.1.99'), '192.168.1.99');
  assert.equal(isIpv4InSubnet('192.168.1.3', '10.0.0.1', '0.0.0.0'), false, 'subnet math cannot widen a private LAN into other private network ranges');
  assert.equal(isIpv4InSubnet('192.168.1.3', '192.168.1.25', '255.0.255.0'), false, 'non-contiguous netmasks are rejected');
});

test('public LAN state never leaks a URL or fingerprint while listener is stopped', () => {
  assert.deepEqual(publicLanStatus({ enabled: false, address: '192.168.1.25', port: 8765, fingerprint: 'secret-public-info' }), {
    enabled: false, listening: false, address: '', port: 8765, url: '', tlsFingerprint: '', error: '',
  });
  assert.deepEqual(publicLanStatus({ enabled: true, listening: true, address: '192.168.1.25', port: 8765, fingerprint: 'AA:BB' }), {
    enabled: true, listening: true, address: '192.168.1.25', port: 8765, url: 'https://192.168.1.25:8765', tlsFingerprint: 'AA:BB', error: '',
  });
});
