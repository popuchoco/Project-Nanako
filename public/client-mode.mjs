const LOOPBACK_HOSTS = new Set(['localhost', '::1']);

function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/gu, '');
  return LOOPBACK_HOSTS.has(host)
    || /^127(?:\.\d{1,3}){3}$/u.test(host)
    || /^::ffff:127(?:\.\d{1,3}){3}$/u.test(host);
}

function hasMobileUserAgent(userAgent, userAgentDataMobile, touchPoints) {
  if (userAgentDataMobile === true) return true;
  if (/(?:Android|iPhone|iPad|iPod|IEMobile|Windows Phone|Mobile|Tablet)/iu.test(userAgent)) return true;
  // iPadOS can request desktop Safari's Macintosh user agent while still using touch input.
  return /Macintosh/iu.test(userAgent) && Number(touchPoints) > 1;
}

export function isLanMobileClient({ protocol, hostname, userAgent = '', userAgentDataMobile = false, touchPoints = 0 } = {}) {
  return protocol === 'https:'
    && !isLoopbackHost(hostname)
    && !/Electron\//iu.test(userAgent)
    && hasMobileUserAgent(userAgent, userAgentDataMobile, touchPoints);
}
