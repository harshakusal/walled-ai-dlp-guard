// Security policy of the main process: who may ask for DLP decisions, pop-ups, permissions, CSS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { browserUserAgent, parseFilesRequest, parsePromptRequest, permissionAllowed, popupPolicy, trustedSite } from '../dist/app/main/policy.js';
import { responseColorCss, lighten } from '../dist/app/main/response-color.js';
import { siteOfUrl } from '../dist/core/sites.js';

test('only top-level ChatGPT / Perplexity pages in our own views may request decisions', () => {
  assert.equal(trustedSite('https://chatgpt.com/c/1', true, true), 'chatgpt');
  assert.equal(trustedSite('https://chat.openai.com/', true, true), 'chatgpt');
  assert.equal(trustedSite('https://www.perplexity.ai/search/x', true, true), 'perplexity');
  assert.equal(trustedSite('https://evil.example/', true, true), null);
  assert.equal(trustedSite('https://chatgpt.com.evil.example/', true, true), null);
  assert.equal(trustedSite('http://chatgpt.com/', true, true), null);
  assert.equal(trustedSite('https://chatgpt.com/', false, true), null, 'iframes are not trusted');
  assert.equal(trustedSite('https://chatgpt.com/', true, false), null, 'other webContents are not trusted');
  assert.equal(siteOfUrl('not a url'), 'unknown');
});

test('renderer input is validated', () => {
  assert.equal(parsePromptRequest({ text: 'hi' }).text, 'hi');
  assert.equal(parsePromptRequest({ text: 5 }), null);
  assert.equal(parsePromptRequest(null), null);
  const ok = parseFilesRequest({ via: 'paste', files: [{ name: 'a.txt', mime: 'text/plain', size: 2, bytes: new Uint8Array([104, 105]) }] });
  assert.equal(ok.files[0].skipped, false);
  assert.equal(parseFilesRequest({ via: 'paste', files: [{ name: 'a', size: 9 }] }).files[0].skipped, true, 'no bytes -> treated as not inspected');
  assert.equal(parseFilesRequest({ via: 'teleport', files: [{ name: 'a', size: 1 }] }), null);
  assert.equal(parseFilesRequest({ via: 'paste', files: [] }), null);
});

test('pop-ups: sign-in providers in-app, other links in the system browser, odd schemes denied', () => {
  assert.equal(popupPolicy('https://accounts.google.com/o/oauth2'), 'in-app');
  assert.equal(popupPolicy('https://auth.openai.com/authorize'), 'in-app');
  assert.equal(popupPolicy('https://en.wikipedia.org/wiki/DLP'), 'external');
  assert.equal(popupPolicy('file:///etc/passwd'), 'deny');
  assert.equal(popupPolicy('javascript:alert(1)'), 'deny');
});

test('permissions: only clipboard / fullscreen / notifications', () => {
  assert.ok(permissionAllowed('clipboard-sanitized-write'));
  for (const p of ['media', 'geolocation', 'usb', 'hid', 'serial', 'openExternal']) assert.equal(permissionAllowed(p), false, p);
});

test('user agent looks like Chrome (no Electron token)', () => {
  const ua = browserUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) walled-ai-dlp-guard/2.0.0 Chrome/142.0.0.0 Electron/45.4.1 Safari/537.36');
  assert.equal(ua, 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36');
});

test('response colour CSS targets AI answers only and sanitises colours', () => {
  const css = responseColorCss({ light: '#123456', dark: 'red;}body{display:none' });
  assert.match(css, /#123456/);
  assert.doesNotMatch(css, /display:none/);
  assert.match(css, /data-message-author-role="assistant"/);
  assert.match(css, /:not\(\[data-message-bubble\] \*\)/);
  assert.match(css, /:not\(pre, pre \*\)/);
  assert.equal(lighten('#000000', 0.5), '#808080');
});
