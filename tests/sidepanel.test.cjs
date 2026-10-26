const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function panel(initial = {}, configuration = {}) {
  class Element {
    constructor() { this.classes = new Set(); this.classList = { add: c => this.classes.add(c), remove: c => this.classes.delete(c), toggle: (c, v) => v ? this.classes.add(c) : this.classes.delete(c) }; this.listeners = {}; this.attributes = {}; this.contentWindow = {}; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    setAttribute(key, value) { this.attributes[key] = value; }
  }
  const ids = Object.fromEntries(['container', 'loading-overlay', 'loading-text', 'loading-retry', 'notification', 'notification-text', 'dismiss-notification', 'loading-version'].map(id => [id, new Element()]));
  const buttons = ['chatgpt', 'claude'].map(id => Object.assign(new Element(), { dataset: { provider: id } }));
  const openButtons = ['chatgpt', 'claude'].map(id => Object.assign(new Element(), { dataset: { openProvider: id } }));
  const opened = [];
  const frames = [], listeners = [], messages = {}, store = { ...initial }, syncStore = { ...configuration };
  let rules;
  ids.container.insertBefore = frame => frames.push(frame);
  const context = {
    document: { getElementById: id => ids[id], createElement: () => new Element(), querySelectorAll: selector => selector === '[data-open-provider]' ? openButtons : buttons, documentElement: { dataset: {} } },
    window: { addEventListener: (type, fn) => { messages[type] = fn; } },
    chrome: {
      runtime: { id: 'test-extension', getURL: p => p, getManifest: () => ({ version: '1.3.1' }), openOptionsPage() {} },
      tabs: { create: async item => { opened.push(item.url); } },
      declarativeNetRequest: { updateDynamicRules: async patch => { rules = patch.addRules; } },
      storage: { local: { get: async key => key === null ? { ...store } : { [key]: store[key] }, set: async patch => {
        Object.assign(store, patch);
        for (const fn of listeners) fn(Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { newValue: v }])), 'local');
      } }, sync: { get: async key => Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, syncStore[k]])) }, onChanged: { addListener: fn => listeners.push(fn) } }
    },
    fetch: async () => ({ json: async () => JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/rules.json'))) }),
    setTimeout, clearTimeout, Date, URL, console
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/providers.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/sidepanel.js'), 'utf8'), context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  return { ids, buttons, openButtons, opened, frames, store, rules, messages, settle, setFullUi: value => { syncStore.claudeFullUi = value; for (const fn of listeners) fn({ claudeFullUi: { newValue: value } }, 'sync'); }, setUrls: value => { syncStore.providerUrls = value; for (const fn of listeners) fn({ providerUrls: { newValue: value } }, 'sync'); }, close: () => vm.runInContext('clearTimeout(slowTimer); clearTimeout(ackTimer); clearTimeout(notificationTimer)', context) };
}
test('side panel restores selection and retains visited frames', async () => {
  const p = await panel({ activeProvider: 'claude' });
  try {
    assert.equal(p.frames.length, 1);
    assert.equal(p.frames[0].src, 'https://claude.ai/new');
    const claude = p.frames[0];
    p.buttons[0].listeners.click(); await p.settle();
    assert.equal(p.store.activeProvider, 'chatgpt');
    assert.equal(p.frames.length, 2);
    assert.equal(claude.hidden, true);
    p.buttons[1].listeners.click(); await p.settle();
    assert.equal(claude.hidden, false);
    assert.equal(p.frames.length, 2);
    assert.ok(p.rules.every(r => r.condition.initiatorDomains.includes('test-extension') && r.condition.resourceTypes.join() === 'sub_frame'));
  } finally { p.close(); }
});
test('only readiness from the selected iframe may reveal the page', async () => {
  const p = await panel();
  try {
    const data = { type: 'PROVIDER_READY', provider: 'chatgpt' };
    p.messages.message({ data, source: {}, origin: 'https://chatgpt.com' });
    assert.equal(p.ids['loading-overlay'].classes.has('hidden'), false);
    p.messages.message({ data, source: p.frames[0].contentWindow, origin: 'https://evil.test' });
    assert.equal(p.ids['loading-overlay'].classes.has('hidden'), false);
    p.messages.message({ data, source: p.frames[0].contentWindow, origin: 'https://chatgpt.com' });
    assert.equal(p.ids['loading-overlay'].classes.has('hidden'), true);
  } finally { p.close(); }
});

test('configured URLs are used per service and new-tab buttons do not change selection', async () => {
  const p = await panel({ activeProvider: 'chatgpt' }, { providerUrls: { claude: 'https://claude.ai/', chatgpt: 'https://chatgpt.com/?temporary-chat=true' } });
  try {
    assert.equal(p.frames[0].src, 'https://chatgpt.com/?temporary-chat=true');
    p.openButtons[1].listeners.click(); await p.settle();
    assert.equal(p.opened[0], 'https://claude.ai/');
    assert.equal(p.frames.length, 1);
    assert.equal(p.frames[0].hidden, false);
    p.buttons[1].listeners.click(); await p.settle();
    assert.equal(p.frames[1].src, 'https://claude.ai/');
    p.setUrls({ claude: 'https://claude.ai/new?source=sidebar', chatgpt: 'https://chatgpt.com/?temporary-chat=true' });
    assert.equal(p.frames[1].src, 'https://claude.ai/new?source=sidebar');
    assert.equal(p.frames[0].src, 'https://chatgpt.com/?temporary-chat=true');
    assert.equal(p.ids['loading-overlay'].classes.has('hidden'), false);
    p.setUrls(undefined);
    assert.equal(p.frames[1].src, 'https://claude.ai/new');
  } finally { p.close(); }
});

test('Claude full-navigation preference is placed on the frame before navigation and can be disabled', async () => {
  const p = await panel({ activeProvider: 'claude' });
  try {
    assert.equal(p.frames[0].name, 'chatdock-claude:test-extension:full');
    p.setFullUi(false);
    assert.equal(p.frames[0].name, 'chatdock-claude:test-extension:native');
    assert.equal(p.frames[0].src, 'https://claude.ai/new');
    p.setFullUi(true);
    assert.equal(p.frames[0].name, 'chatdock-claude:test-extension:full');
    assert.equal(p.store.activeProvider, 'claude');
  } finally { p.close(); }
  const disabled = await panel({ activeProvider: 'claude' }, { claudeFullUi: false });
  try { assert.equal(disabled.frames[0].name, 'chatdock-claude:test-extension:native'); }
  finally { disabled.close(); }
});
