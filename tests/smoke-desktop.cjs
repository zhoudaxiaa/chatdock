// Real Electron smoke test in a disposable profile; never reads the user's cookies.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatdock-smoke-'));
process.env.CHATDOCK_USER_DATA_DIR = dir;
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ...require('../desktop/app-settings').defaultSettings(), alwaysOnTopOnShow: true }));
const timer = setTimeout(() => { console.error('Smoke test timed out'); app.isQuiting = true; app.exit(1); }, 40000);
// Bind the production bridge to an ephemeral port inside this disposable test
// process, leaving any running user's desktop bridge untouched.
const http = require('node:http');
const nativeCreateServer = http.createServer;
let bridge;
http.createServer = (...args) => {
  bridge = nativeCreateServer(...args);
  const nativeListen = bridge.listen;
  bridge.listen = function (_port, host, callback) { return nativeListen.call(this, 0, host, callback); };
  return bridge;
};
require(process.env.CHATDOCK_APP_ENTRY || '../desktop/main');
app.whenReady().then(async () => {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    assert.ok(win);
    let bar;
    for (let i = 0; i < 100; i++) {
      bar = win.contentView.children.find(v => v.webContents.getURL().endsWith('/bar.html'));
      if (bar && !bar.webContents.isLoading()) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(bar);
    const checkMacIdentity = () => {
      if (process.platform !== 'darwin') return;
      assert.equal(app.dock.isVisible(), true, 'Dock must stay visible');
      const policy = require('node:child_process').execFileSync('osascript', ['-l', 'JavaScript', '-e',
        `ObjC.import('AppKit'); Number($.NSRunningApplication.runningApplicationWithProcessIdentifier(${process.pid}).activationPolicy);`
      ], { encoding: 'utf8' }).trim();
      assert.equal(policy, '0', 'AppKit must report regular activation policy');
    };
    checkMacIdentity();
    assert.equal(await bar.webContents.executeJavaScript('window.barApi.toggleTopmost(); window.barApi.getTopmost()'), false);
    checkMacIdentity();
    assert.equal(await bar.webContents.executeJavaScript('window.barApi.toggleTopmost(); window.barApi.getTopmost()'), true);
    checkMacIdentity();
    const original = win.contentView.children.find(v => v !== bar);
    assert.equal(await bar.webContents.executeJavaScript('window.barApi.getProvider()'), 'chatgpt');
    assert.equal((await bar.webContents.executeJavaScript('window.barApi.setProvider("claude")')).ok, true);
    const claude = win.contentView.children.find(v => v !== bar);
    assert.notEqual(claude, original);
    assert.equal(win.getTitle(), 'ChatDock · Claude');
    assert.equal((await bar.webContents.executeJavaScript('window.barApi.setProvider("chatgpt")')).ok, true);
    assert.equal(win.contentView.children.find(v => v !== bar), original);
    assert.equal((await bar.webContents.executeJavaScript('window.barApi.setProvider("not-a-service")')).ok, false);
    await original.webContents.loadURL('data:text/html,<p>ChatGPT smoke page</p>');
    await claude.webContents.loadURL('data:text/html,<p>Claude smoke page</p>');
    let chatgptLoads = 0, claudeLoads = 0;
    original.webContents.on('did-start-navigation', () => { chatgptLoads++; });
    claude.webContents.on('did-start-navigation', () => { claudeLoads++; });
    const waitFor = async predicate => {
      for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(predicate());
    };
    assert.equal((await bar.webContents.executeJavaScript('window.barApi.refresh()')).ok, true);
    await waitFor(() => chatgptLoads === 1);
    assert.equal(claudeLoads, 0);
    const importCookies = async (provider, cookies) => {
      const response = await fetch(`http://127.0.0.1:${bridge.address().port}/import-cookies`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bridge-token': 'dsh-chatgpt-bridge-2026' }, body: JSON.stringify({ provider, cookies })
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const imported = await Promise.all(['chatgpt', 'claude'].map(provider => importCookies(provider, [{
      name: 'chatdock-smoke-cookie', value: provider, domain: provider === 'chatgpt' ? '.chatgpt.com' : '.claude.ai', path: '/', secure: true
    }])));
    assert.ok(imported.every(result => result.ok && result.count === 1 && result.refreshed));
    await waitFor(() => chatgptLoads === 2 && claudeLoads === 1);
    assert.equal((await original.webContents.session.cookies.get({ name: 'chatdock-smoke-cookie' }))[0].value, 'chatgpt');
    assert.equal((await claude.webContents.session.cookies.get({ name: 'chatdock-smoke-cookie' }))[0].value, 'claude');
    const empty = await importCookies('claude', []);
    assert.equal(empty.reason, 'empty');
    assert.equal(claudeLoads, 1);
    assert.equal((await claude.webContents.session.cookies.get({ name: 'chatdock-smoke-cookie' }))[0].value, 'claude');
    assert.equal(await bar.webContents.executeJavaScript('window.barApi.getProvider()'), 'chatgpt');

    await bar.webContents.executeJavaScript('window.barApi.openSettings()');
    for (let i = 0; i < 30 && BrowserWindow.getAllWindows().length < 2; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(BrowserWindow.getAllWindows().length, 2);
    const settings = BrowserWindow.getAllWindows().find(w => w !== win);
    for (let i = 0; i < 100 && settings.webContents.isLoading(); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(await settings.webContents.executeJavaScript('!!window.settingsApi'));
    checkMacIdentity();
    win.hide(); checkMacIdentity(); win.show(); checkMacIdentity();
    // Render the actual native toolbar for visual inspection.
    fs.writeFileSync('/tmp/chatdock-toolbar.png', (await bar.webContents.capturePage()).toPNG());
    console.log('PASS real Electron: initial service, both switches, retained WebContentsView, invalid service rejection, current-service refresh, real two-provider cookie import and reload, harmless empty jars, settings window, Dock visibility, AppKit regular policy through pin/settings/hide-show, toolbar render');
    clearTimeout(timer);
    app.isQuiting = true; app.exit(0);
  } catch (error) { console.error(error); app.isQuiting = true; app.exit(1); }
});
