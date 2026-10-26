// Real Electron smoke test in a disposable profile; never reads the user's cookies.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatdock-smoke-'));
process.env.CHATDOCK_USER_DATA_DIR = dir;
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ...require('../desktop/app-settings').defaultSettings(), alwaysOnTopOnShow: false }));
const timer = setTimeout(() => { console.error('Smoke test timed out'); app.isQuiting = true; app.exit(1); }, 40000);
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
    const original = win.contentView.children.find(v => v !== bar);
    assert.equal(await bar.webContents.executeJavaScript('window.barApi.getProvider()'), 'chatgpt');
    assert.equal((await bar.webContents.executeJavaScript('window.barApi.setProvider("claude")')).ok, true);
    const claude = win.contentView.children.find(v => v !== bar);
    assert.notEqual(claude, original);
    assert.equal(win.getTitle(), 'ChatDock · Claude');
    assert.equal((await bar.webContents.executeJavaScript('window.barApi.setProvider("chatgpt")')).ok, true);
    assert.equal(win.contentView.children.find(v => v !== bar), original);
    assert.equal((await bar.webContents.executeJavaScript('window.barApi.setProvider("not-a-service")')).ok, false);
    await bar.webContents.executeJavaScript('window.barApi.openSettings()');
    for (let i = 0; i < 30 && BrowserWindow.getAllWindows().length < 2; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(BrowserWindow.getAllWindows().length, 2);
    const settings = BrowserWindow.getAllWindows().find(w => w !== win);
    for (let i = 0; i < 100 && settings.webContents.isLoading(); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(await settings.webContents.executeJavaScript('!!window.settingsApi'));
    // Render the actual native toolbar for visual inspection.
    fs.writeFileSync('/tmp/chatdock-toolbar.png', (await bar.webContents.capturePage()).toPNG());
    console.log('PASS real Electron: initial service, both switches, retained WebContentsView, invalid service rejection, settings window, toolbar render');
    clearTimeout(timer);
    app.isQuiting = true; app.exit(0);
  } catch (error) { console.error(error); app.isQuiting = true; app.exit(1); }
});
