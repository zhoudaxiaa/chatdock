const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const settingsLib = require('../desktop/app-settings');

function boot() {
  const handlers = new Map(), events = new Map(), writes = [], views = [];
  let saved, failSave = false, serverHandler;
  class WC extends EventEmitter {
    constructor() { super(); this.debugger = new EventEmitter(); this.debugger.attach = () => {}; this.debugger.sendCommand = () => Promise.resolve(); this.url = ''; this.destroyed = false; }
    isDestroyed() { return this.destroyed; }
    setWindowOpenHandler() {}
    loadURL(url) { this.url = url; return Promise.resolve(); }
    loadFile() { return Promise.resolve(); }
    insertCSS() { return Promise.resolve(); }
    focus() {}
    send() {}
    reload() { this.reloaded = true; this.reloadCount = (this.reloadCount || 0) + 1; }
    close() { this.destroyed = true; }
  }
  class View {
    constructor(opts) { this.options = opts; this.webContents = new WC(); views.push(this); }
    setBounds(bounds) { this.bounds = bounds; }
  }
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = new WC(); this.children = []; this.contentView = {
      addChildView: view => { this.children = this.children.filter(x => x !== view); this.children.push(view); },
      removeChildView: view => { this.children = this.children.filter(x => x !== view); }
    }; }
    isDestroyed() { return false; }
    getContentBounds() { return { width: 1000, height: 700 }; }
    setMenuBarVisibility() {}
    setTitle(title) { this.title = title; }
    isMaximized() { return false; }
    isMinimized() { return false; }
    isVisible() { return true; }
    show() { this.emit('show'); }
    focus() {}
    moveTop() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces(visible, options) { this.workspaces = { visible, options }; }
  }
  const sessionFor = id => ({ cookies: { set: async cookie => { writes.push({ id, cookie }); } } });
  const sessions = { default: sessionFor('default'), claude: sessionFor('claude') };
  const app = new EventEmitter();
  Object.assign(app, { setPath: (_k, p) => { app.profile = p; }, getPath: () => '/tmp/chatdock-profile', requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), isReady: () => true });
  const electron = { app, BrowserWindow: Window, WebContentsView: View,
    globalShortcut: {}, session: { defaultSession: sessions.default, fromPartition: id => { assert.equal(id, 'persist:chatdock-claude'); return sessions.claude; } },
    ipcMain: { on: (id, fn) => events.set(id, fn), handle: (id, fn) => handlers.set(id, fn) },
    Menu: { buildFromTemplate: template => ({ template, popup() {} }), setApplicationMenu() {} }, shell: {} };
  const sandbox = { require: id => {
    if (id === 'electron') return electron;
    if (id === './app-settings') return { ...settingsLib, saveSettings: (_file, value) => { if (failSave) return { ok: false, error: 'disk full' }; saved = value; return { ok: true }; } };
    if (id === '../shared/providers') return require('../shared/providers');
    if (id === 'http') return { createServer: handler => { serverHandler = handler; return { on() {}, unref() {}, listen(_port, _host, done) { done(); } }; } };
    return require(id);
  }, __dirname: path.join(__dirname, '../desktop'), console, setTimeout, clearTimeout, setImmediate, process: { platform: process.platform, env: {}, on() {} } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../desktop/main.js'), 'utf8') + '\nglobalThis.api = { createWindow, switchProvider, startCookieBridge, getSettings: () => settings, getViews: () => providerViews, getBar: () => barView };', sandbox);
  return { ...sandbox.api, handlers, writes, views, app, saved: () => saved, setFailSave: v => { failSave = v; }, bridge: async payload => {
    const req = new EventEmitter(); req.method = 'POST'; req.url = '/import-cookies'; req.headers = { 'x-bridge-token': 'dsh-chatgpt-bridge-2026' };
    let status;
    const done = new Promise(resolve => serverHandler(req, { writeHead(code) { status = code; }, end(body) { resolve({ status, body: JSON.parse(body) }); } }));
    req.emit('data', JSON.stringify(payload)); req.emit('end'); return done;
  } };
}
test('desktop switches lazily, keeps service pages and uses the old profile', () => {
  const app = boot(), win = app.createWindow();
  assert.match(app.app.profile, /chatgpt-electron$/);
  const original = app.getViews().get('chatgpt');
  original.webContents.url = 'https://chatgpt.com/c/retained';
  assert.equal(app.getViews().size, 1);
  assert.equal(app.switchProvider('claude').ok, true);
  const claude = app.getViews().get('claude');
  assert.equal(claude.webContents.url, 'https://claude.ai/new');
  assert.equal(app.saved().provider, 'claude');
  assert.equal(win.title, 'ChatDock · Claude');
  assert.equal(app.switchProvider('chatgpt').ok, true);
  assert.equal(app.getViews().get('chatgpt'), original);
  assert.equal(original.webContents.url, 'https://chatgpt.com/c/retained');
  assert.equal(app.getViews().size, 2);
  assert.equal(win.children.length, 2);
  app.setFailSave(true);
  assert.equal(app.switchProvider('claude').ok, false);
  assert.equal(app.getSettings().provider, 'chatgpt');
  assert.equal(app.switchProvider('evil').ok, false);
  win.emit('closed');
  assert.ok(original.webContents.destroyed && claude.webContents.destroyed);
});
test('bridge imports only declared service cookies and never switches the active service', async () => {
  const app = boot(); app.createWindow(); app.switchProvider('claude'); app.startCookieBridge();
  const cookie = (domain, name) => ({ domain, name, value: 'test', secure: true });
  const result = await app.bridge({ cookies: [cookie('.chatgpt.com', '__Host-session'), cookie('claude.ai', 'wrong'), cookie('chatgpt.com.evil.test', 'evil')] });
  assert.equal(result.status, 200);
  assert.equal(app.writes.length, 1);
  assert.equal(app.writes[0].id, 'default');
  assert.equal(app.writes[0].cookie.domain, undefined);
  assert.equal(app.getSettings().provider, 'claude');
  assert.equal((await app.bridge({ provider: 'claude', cookies: [cookie('.claude.ai', 'sessionKey')] })).status, 200);
  assert.equal(app.writes[1].id, 'claude');
  assert.equal((await app.bridge({ provider: 'unknown', cookies: [] })).status, 400);
});

test('manual refresh targets only the active service and rejects a remote sender', () => {
  const app = boot(), win = app.createWindow();
  const chatgpt = app.getViews().get('chatgpt');
  app.switchProvider('claude');
  const claude = app.getViews().get('claude');
  const event = { sender: app.getBar().webContents };
  assert.equal(app.handlers.get('bar:refresh')({ sender: claude.webContents }).ok, false);
  assert.equal(app.handlers.get('bar:refresh')(event).ok, true);
  assert.equal(claude.webContents.reloadCount, 1);
  assert.equal(chatgpt.webContents.reloadCount, undefined);
  app.switchProvider('chatgpt');
  app.handlers.get('bar:refresh')(event);
  assert.equal(chatgpt.webContents.reloadCount, 1);
  assert.equal(claude.webContents.reloadCount, 1);
  if (process.platform === 'darwin') {
    assert.equal(win.workspaces.visible, true);
    assert.equal(win.workspaces.options.skipTransformProcessType, true);
    assert.equal(win.workspaces.options.visibleOnFullScreen, true);
  }
});
test('successful imports refresh the matching page, while empty jars preserve desktop sessions', async () => {
  const app = boot(); app.createWindow(); app.switchProvider('claude'); app.startCookieBridge();
  const chatgpt = app.getViews().get('chatgpt').webContents;
  const claude = app.getViews().get('claude').webContents;
  const cookie = { domain: '.chatgpt.com', name: 'session', value: 'test', secure: true };
  const imported = await app.bridge({ provider: 'chatgpt', cookies: [cookie] });
  assert.equal(imported.body.refreshed, true);
  assert.equal(chatgpt.reloadCount, 1);
  assert.equal(claude.reloadCount, undefined);
  const empty = await app.bridge({ provider: 'claude', cookies: [] });
  assert.equal(empty.status, 200);
  assert.equal(empty.body.ok, true);
  assert.equal(empty.body.reason, 'empty');
  assert.equal(app.writes.length, 1);
  assert.equal(claude.reloadCount, undefined);
  assert.equal(app.getSettings().provider, 'claude');
});
