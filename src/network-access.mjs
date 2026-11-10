import net from 'node:net';

export function isPrivateIpv4(address) {
  if (!net.isIPv4(address)) return false;
  const octets = address.split('.').map(Number);
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

export function isLanPort(port) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

export function normalizeIpv4(address) {
  if (typeof address !== 'string') return '';
  const mapped = address.startsWith('::ffff:') ? address.slice(7) : address;
  return net.isIPv4(mapped) ? mapped : '';
}

function ipv4Number(address) {
  return address.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function ipv4PrefixLength(netmask) {
  if (!net.isIPv4(netmask)) return -1;
  const value = ipv4Number(netmask);
  let prefix = 0;
  let foundZero = false;
  for (let bit = 31; bit >= 0; bit -= 1) {
    const set = Boolean((value >>> bit) & 1);
    if (set && foundZero) return -1;
    if (set) prefix += 1;
    else foundZero = true;
  }
  return prefix;
}

function privateNetworkPrefix(address) {
  const octets = address.split('.').map(Number);
  if (octets[0] === 10) return 8;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return 12;
  if (octets[0] === 192 && octets[1] === 168) return 16;
  return 32;
}

export function isIpv4InSubnet(address, subnetAddress, netmask) {
  const candidate = normalizeIpv4(address);
  const interfaceAddress = normalizeIpv4(subnetAddress);
  const maskPrefix = ipv4PrefixLength(netmask);
  if (!candidate || !interfaceAddress || maskPrefix < 0 || !isPrivateIpv4(candidate) || !isPrivateIpv4(interfaceAddress)) return false;
  const effectivePrefix = Math.max(maskPrefix, privateNetworkPrefix(interfaceAddress));
  const mask = effectivePrefix === 0 ? 0 : (0xffff_ffff << (32 - effectivePrefix)) >>> 0;
  const host = ipv4Number(candidate);
  const subnet = ipv4Number(interfaceAddress);
  return (host & mask) === (subnet & mask);
}

export function selectLanInterface(interfaces, address) {
  if (typeof address !== 'string' || !net.isIPv4(address) || !isPrivateIpv4(address)) return null;
  return interfaces.find((item) => item.family === 'IPv4'
    && item.address === address
    && !item.internal
    && isPrivateIpv4(item.address)
    && ipv4PrefixLength(item.netmask) >= 0) || null;
}

export function isLanPeerAllowed({ peerAddress, localAddress, host, port, origin, interfaceInfo, enabled }) {
  if (!enabled || !interfaceInfo) return false;
  if (normalizeIpv4(localAddress) !== interfaceInfo.address) return false;
  if (!isPrivateIpv4(normalizeIpv4(peerAddress))) return false;
  if (!isIpv4InSubnet(peerAddress, interfaceInfo.address, interfaceInfo.netmask)) return false;
  return host === `${interfaceInfo.address}:${port}`
    && (!origin || origin === `https://${interfaceInfo.address}:${port}`);
}

export function publicLanStatus({ enabled = false, address = '', port = 8765, listening = false, fingerprint = '', error = '' } = {}) {
  return {
    enabled: Boolean(enabled),
    listening: Boolean(listening),
    address: enabled && address ? address : '',
    port,
    url: listening ? `https://${address}:${port}` : '',
    tlsFingerprint: listening ? fingerprint : '',
    error: error || '',
  };
}
