const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SOURCE = fs.readFileSync(path.join(__dirname, '../extension/claude-frame-compat.js'), 'utf8');
const OWNER = 'a'.repeat(32);
function frame({ hostname = 'claude.ai', origin = `chrome-extension://${OWNER}`, name = `chatdock-claude:${OWNER}:full`, topLevel = false, configurable = true } = {}) {
  const win = { location: { hostname, ancestorOrigins: [origin] }, name, parent: {} };
  win.top = topLevel ? win : {};
  Object.defineProperty(win, 'self', { configurable, enumerable: true, get: () => win });
  return win;
}
// The alias reads the caller from the 4th stack line; feed it a fixed stack.
const APP = 'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/index-abc.js:1:1';
function run(win, callerFile) {
  class FakeError { constructor() { this.stack = `Error\n at wantsTop (x)\n at get (x)\n at f (${callerFile})`; } }
  vm.runInNewContext(SOURCE, { window: win, Error: FakeError });
}
test('compatibility changes the opted-in Claude page alias while retaining the real frame and parent', () => {
  const win = frame(), actualTop = win.top, parent = win.parent, location = win.location;
  run(win, APP);
  assert.equal(win.self, actualTop);
  assert.notEqual(win, actualTop);
  assert.equal(win.parent, parent);
  assert.equal(win.location, location);
  assert.equal(Object.getOwnPropertyDescriptor(win, 'self').enumerable, true);
});
test('Claude router, third-party scripts and unknown callers keep the real window', () => {
  for (const caller of [
    'https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/vendor-router-DOSq2hfa.js:1:80366',
    'https://challenges.cloudflare.com/turnstile/v0/api.js:1:1', 'chrome-extension://x/provider-inject.js:1:1', ''
  ]) {
    const win = frame();
    run(win, caller);
    assert.equal(win.self, win, caller);
  }
});
test('ordinary tabs, native mode, other extensions and non-extension hosts are untouched', () => {
  for (const options of [
    { topLevel: true }, { hostname: 'chatgpt.com' }, { origin: 'https://claude.ai' },
    { origin: 'https://example.com' }, { name: '' }, { name: `chatdock-claude:${OWNER}:native` },
    { name: `chatdock-claude:${'b'.repeat(32)}:full` }, { configurable: false }
  ]) {
    const win = frame(options);
    run(win, APP);
    assert.equal(win.self, win, JSON.stringify(options));
  }
});
test('main-world compatibility does not change the isolated-world delivery guard', () => {
  const main = frame(), isolated = frame();
  run(main, APP);
  assert.equal(isolated.self, isolated);
  assert.notEqual(isolated.top, isolated);
  const manifest = require('../dist/extension/manifest.json');
  const compat = manifest.content_scripts.find(script => script.js.includes('claude-frame-compat.js'));
  assert.equal(compat.world, 'MAIN');
  assert.equal(compat.run_at, 'document_start');
  assert.deepEqual(compat.matches, ['https://claude.ai/*']);
  const delivery = manifest.content_scripts.find(script => script.js.includes('provider-inject.js'));
  assert.equal(delivery.world, undefined);
});
