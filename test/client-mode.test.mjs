import test from 'node:test';
import assert from 'node:assert/strict';
import { isLanMobileClient } from '../public/client-mode.mjs';

const mobileSafari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const desktopChrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

test('mobile browsers on the secure LAN endpoint receive the LAN mobile layout', () => {
  assert.equal(isLanMobileClient({ protocol: 'https:', hostname: '192.168.1.25', userAgent: mobileSafari }), true);
});

test('desktop browsers on the secure LAN endpoint keep the existing desktop layout', () => {
  assert.equal(isLanMobileClient({ protocol: 'https:', hostname: '192.168.1.25', userAgent: desktopChrome }), false);
});

test('local app and loopback browser sessions never receive the LAN mobile layout', () => {
  for (const hostname of ['localhost', '127.0.0.1', '127.0.0.7', '::1', '[::1]']) {
    assert.equal(isLanMobileClient({ protocol: 'https:', hostname, userAgent: mobileSafari }), false, hostname);
  }
  assert.equal(isLanMobileClient({ protocol: 'http:', hostname: '127.0.0.1', userAgent: desktopChrome }), false);
});

test('mobile-looking Electron user agents do not change the local desktop app', () => {
  assert.equal(isLanMobileClient({ protocol: 'https:', hostname: '192.168.1.25', userAgent: `Electron/45.0 ${mobileSafari}` }), false);
});

test('mobile client hints and touch iPadOS are recognized', () => {
  assert.equal(isLanMobileClient({ protocol: 'https:', hostname: 'nanako.local', userAgent: desktopChrome, userAgentDataMobile: true }), true);
  assert.equal(isLanMobileClient({ protocol: 'https:', hostname: '192.168.1.25', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18 Safari/605.1.15', touchPoints: 5 }), true);
});
