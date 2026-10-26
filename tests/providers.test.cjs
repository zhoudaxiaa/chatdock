const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { providers, getProvider, ownsDomain } = require('../shared/providers');
const settings = require('../desktop/app-settings');
test('unknown provider falls back, and cookie domains cannot cross service boundaries', () => {
  assert.equal(getProvider('bad').id, 'chatgpt');
  assert.equal(getProvider('claude').url, 'https://claude.ai/new');
  for (const domain of ['claude.ai.evil.test', 'evilclaude.ai', 'openai.com']) assert.equal(ownsDomain('claude', domain), false);
  assert.equal(ownsDomain('claude', '.claude.ai'), true);
  assert.equal(ownsDomain('chatgpt', 'auth.openai.com'), true);
  assert.equal(ownsDomain('chatgpt', 'claude.ai'), false);
  assert.ok(providers.claude.composers.includes('[data-testid="chat-input"][contenteditable="true"]'));
});
test('settings retain provider across save/load and tolerate old profiles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatdock-test-'));
  const file = path.join(dir, 'settings.json');
  try {
    const initial = settings.defaultSettings();
    assert.equal(initial.provider, 'chatgpt');
    assert.equal(settings.saveSettings(file, { ...initial, provider: 'claude' }).ok, true);
    assert.equal(settings.loadSettings(file).provider, 'claude');
    delete initial.provider;
    fs.writeFileSync(file, JSON.stringify(initial));
    assert.equal(settings.loadSettings(file).provider, 'chatgpt');
    assert.equal(settings.validateSettings({ ...initial, provider: 'evil' }).value.provider, 'chatgpt');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('extension package has the unified version, references and providers', () => {
  const pkg = require('../package.json');
  const manifest = require('../dist/extension/manifest.json');
  assert.equal(manifest.version, pkg.version);
  for (const match of ['https://chatgpt.com/*', 'https://claude.ai/*']) {
    assert.ok(manifest.host_permissions.includes(match));
    assert.ok(manifest.content_scripts.find(s => s.all_frames).matches.includes(match));
  }
  assert.equal(manifest.declarative_net_request.rule_resources[0].enabled, false);
  assert.equal(fs.readFileSync(path.join(__dirname, '../dist/extension/shared/providers.js'), 'utf8'), fs.readFileSync(path.join(__dirname, '../shared/providers.js'), 'utf8'));
});
