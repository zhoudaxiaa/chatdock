const {
  app, BrowserWindow, WebContentsView, globalShortcut, session, shell, ipcMain,
  Tray, Menu, clipboard, nativeImage, nativeTheme
} = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const settingsLib = require('./app-settings');

const START_URL = 'https://chatgpt.com';
const WINDOW_TITLE = 'ChatGPT';
const BAR_HEIGHT = 36;   // 顶部工具栏高度（px）

// ===== 启动日志 =====
// 安装版是 GUI 进程，没有控制台；一旦启动阶段抛异常，用户只会看到“双击没反应”。
// 这里把启动异常落到 %APPDATA%\chatgpt-electron\startup-error.log，方便排查。
const LOG_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'chatgpt-electron')
  : app.getPath('userData');
const LOG_FILE = path.join(LOG_DIR, 'startup-error.log');
const SETTINGS_FILE = path.join(LOG_DIR, 'settings.json');

function logStartupError(tag, err) {
  const line = `[${new Date().toISOString()}] ${tag}: ${err && (err.stack || err.message) || err}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* 日志写不进去也不能再抛 */ }
  console.error(line);
}

process.on('uncaughtException', err => logStartupError('uncaughtException', err));
process.on('unhandledRejection', err => logStartupError('unhandledRejection', err));


// ===== 登录态桥接端口（与 browser-extension 里的配置保持一致）=====
const BRIDGE_PORT = 32123;
const BRIDGE_TOKEN = 'dsh-chatgpt-bridge-2026';

// 去掉 UA 里的 Electron / chatgpt-electron 标识，避免 Google 登录提示
// “此浏览器或应用可能不安全”（disallowed_useragent）而拦截 OAuth
app.userAgentFallback = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Safari/537.36';

// 只接收 preload 上报的「对话正文里」的外部链接，交给系统默认浏览器打开
// 其余任何链接/导航都不再拦截，保持页面默认行为
// preload 会带时间戳上报；这里记录下来，用于识别随后由页面 JS 发起的
// window.open（ChatGPT 有时不直接走 <a> 默认导航，而是 JS 打开新窗口）
const recentExternalIntents = new Map();   // url -> ts
const INTENT_TTL = 8000;                   // 8 秒内的 window.open 才算同一次点击

ipcMain.on('open-external', (event, payload) => {
  const url = typeof payload === 'string' ? payload : (payload && payload.url);
  const ts = payload && payload.ts;
  if (typeof url !== 'string') return;
  if (typeof ts === 'number') recentExternalIntents.set(url, ts);

  // 清理超时意图，避免残留标记误拦截之后的正常 window.open
  const now = Date.now();
  for (const [u, t] of recentExternalIntents) {
    if (now - t > INTENT_TTL) recentExternalIntents.delete(u);
  }

  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      shell.openExternal(u.toString());
    }
  } catch { /* 非法地址直接忽略 */ }
});

// preload 标记过（且未超时）的 URL 才算“对话外链意图”
function isRecentExternalIntent(url) {
  const ts = recentExternalIntents.get(url);
  if (!ts) return false;
  return Date.now() - ts <= INTENT_TTL;
}

let win = null;
let tray = null;   // 系统托盘图标（关窗隐藏后仍可找到入口）

// ===== 登录态桥接 =====
// 默认浏览器里的扩展（browser-extension/）读到的 ChatGPT 登录 Cookie，
// 会 POST 到这个本机端口；这里校验后写入 Electron 的会话存储，套壳即登录。
function startCookieBridge() {
  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const handle = async () => {
      if (req.method !== 'POST' || req.url !== '/import-cookies') {
        return send(404, { ok: false, error: 'not found' });
      }
      if (req.headers['x-bridge-token'] !== BRIDGE_TOKEN) {
        return send(401, { ok: false, error: 'bad token' });
      }
      let body = '';
      req.on('data', chunk => { body += chunk; if (body.length > 2 * 1024 * 1024) req.destroy(); });
      req.on('end', async () => {
        try {
          const { cookies = [] } = JSON.parse(body || '{}');
          if (!Array.isArray(cookies)) throw new Error('payload 不是数组');
          let count = 0;
          const failed = [];
          for (const c of cookies) {
            if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') continue;
            const host = String(c.domain || '').replace(/^\./, '').replace(/^\[|\]$/g, '');
            if (!host) continue;
            const name = c.name;
            // __Host- 前缀的 Cookie 规则严格：必须 Secure、Path=/、且不能带 Domain
            const isHostPrefix = name.startsWith('__Host-');
            // __Secure- / __Host- 前缀必须带 Secure 属性
            const mustSecure = name.startsWith('__Secure-') || isHostPrefix;
            const opts = {
              url: 'https://' + host + '/',
              name,
              value: c.value,
              path: '/',
              secure: mustSecure ? true : !!c.secure,
              httpOnly: !!c.httpOnly
            };
            if (!isHostPrefix) {
              if (c.path) opts.path = c.path;
              if (c.domain) opts.domain = c.domain;
            }
            if (typeof c.expirationDate === 'number') opts.expirationDate = c.expirationDate;
            if (c.sameSite) opts.sameSite = c.sameSite;
            try {
              await session.defaultSession.cookies.set(opts);
              count++;
            } catch (err) {
              failed.push(name);
              console.warn('[登录态桥接] 单个 Cookie 写入失败', name, err.message);
            }
          }
          console.log('[登录态桥接] 导入完成：成功', count, '个，失败', failed.length, '个', failed.join(','));
          if (count > 0) {
            send(200, { ok: true, count, skipped: failed });
            // 导入后跳回 ChatGPT 首页，使用新会话
            const wc = chatWC();
            if (wc) wc.loadURL(START_URL);
          } else {
            send(400, { ok: false, error: '所有 Cookie 均写入失败: ' + failed.join(',') });
          }
        } catch (err) {
          console.warn('[登录态桥接] 导入失败', err.message);
          send(400, { ok: false, error: err.message });
        }
      });
    };
    void handle();
  });
  server.on('error', err => {
    console.warn('[登录态桥接] 监听失败', err.code || err.message);
  });
  server.listen(BRIDGE_PORT, '127.0.0.1', () => {
    console.log('[登录态桥接] 正在监听 http://127.0.0.1:' + BRIDGE_PORT);
  });
  return server;
}

// ===== 扩展加载 =====
// 把解包后的扩展文件夹放进 ./extensions/<扩展名>/（里面要有 manifest.json）
// 启动时会自动全部加载
function loadExtensions() {
  const dir = path.join(__dirname, 'extensions');
  // 注意：打包成 asar 后目录可能是只读的、甚至整个目录不存在（空目录不会被打包）。
  // 这里任何一步失败都只记日志，绝不能中断后续的窗口创建。
  try {
    if (!fs.existsSync(dir)) {
      console.log('[扩展] 目录不存在，跳过:', dir);
      return;
    }
    fs.readdirSync(dir, { withFileTypes: true }).forEach(ent => {
      const p = path.join(dir, ent.name);
      try {
        if (ent.isDirectory() && fs.existsSync(path.join(p, 'manifest.json'))) {
          session.defaultSession.loadExtension(p)
            .then(ext => console.log('[扩展已加载]', ext.name))
            .catch(err => console.warn('[扩展加载失败]', ent.name, err.message));
        }
      } catch (err) {
        console.warn('[扩展加载异常]', ent.name, err.message);
      }
    });
  } catch (err) {
    console.warn('[扩展] 扫描失败，跳过:', err.message);
  }
}

// ===== 窗口 =====
// 伪装成普通 Chrome：除了 UA 字符串，Google 还会通过 Client Hints
// （Sec-CH-UA / navigator.userAgentData）检测到 "Electron" 品牌，
// 必须连 UA-CH 元数据一起覆盖，否则 Google 登录会提示“此浏览器或应用可能不安全”
function spoofChromeUA(wc) {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Safari/537.36';
  const metadata = {
    brands: [
      { brand: 'Chromium', version: '130' },
      { brand: 'Google Chrome', version: '130' },
      { brand: 'Not?A_Brand', version: '99' }
    ],
    fullVersionList: [
      { brand: 'Chromium', version: '130.0.6723.191' },
      { brand: 'Google Chrome', version: '130.0.6723.191' },
      { brand: 'Not?A_Brand', version: '99.0.0.0' }
    ],
    platform: 'Windows',
    platformVersion: '10.0.0',
    architecture: 'x86',
    model: '',
    mobile: false
  };
  const apply = () => {
    try {
      wc.debugger.attach('1.3');
    } catch { /* 已连接则忽略 */ }
    wc.debugger.sendCommand('Network.setUserAgentOverride', { userAgent: ua, userAgentMetadata: metadata })
      .catch(err => console.warn('[UA 伪装失败]', err.message));
  };
  apply();
  // 开发工具等场景会导致 debugger 断开，断开后重新挂上伪装
  wc.debugger.on('detach', apply);
}

// 窗口结构：BrowserWindow 本身只当容器，里面并排放两个视图
//   barView  —— 顶部工具栏（截图 / 设置按钮）
//   chatView —— ChatGPT 页面（原来的 win.webContents）
let barView = null;
let chatView = null;

const chatWC = () => (chatView && !chatView.webContents.isDestroyed() ? chatView.webContents : null);

function layoutViews() {
  if (!win || win.isDestroyed() || !barView || !chatView) return;
  const { width, height } = win.getContentBounds();
  barView.setBounds({ x: 0, y: 0, width, height: BAR_HEIGHT });
  chatView.setBounds({ x: 0, y: BAR_HEIGHT, width, height: Math.max(0, height - BAR_HEIGHT) });
}

// 把键盘焦点交给聊天页面（window.focus() 只聚焦窗口，不会聚焦里面的视图）
function focusChat() {
  const wc = chatWC();
  if (wc) wc.focus();
}

// 窗口内快捷键（仅应用获得焦点时生效），按设置里 scope === 'window' 的功能动态匹配
function handleWindowShortcut(event, input) {
  if (input.type !== 'keyDown') return;
  for (const a of settingsLib.ACTIONS) {
    if (a.scope !== 'window') continue;
    if (!settingsLib.matchesAccelerator(input, settings.shortcuts[a.id])) continue;
    const handler = windowActionHandlers[a.id];
    if (handler) {
      event.preventDefault();
      handler();
      return;
    }
  }
}

// 顶栏 / 设置页都是本地页面，不允许跳转，也不允许开新窗口
function lockLocalPage(wc) {
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event) => event.preventDefault());
}

// 工具栏兼任标题栏：去掉系统标题栏，Windows 用 titleBarOverlay 把最小化/最大化/关闭
// 画在工具栏右侧（颜色需与 bar.html 的浅/深色底一致），macOS 保留左上角红绿灯。
const BAR_COLORS = {
  light: { color: '#f4f4f4', symbolColor: '#333333' },
  dark: { color: '#1e1e1e', symbolColor: '#e6e6e6' }
};
const overlayOptions = () => ({
  ...BAR_COLORS[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'],
  height: BAR_HEIGHT
});

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 400,
    title: WINDOW_TITLE,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: (BAR_HEIGHT - 16) / 2 } }
      : { titleBarOverlay: overlayOptions() })
  });
  win.setMenuBarVisibility(false);
  // 系统切换深浅色时，窗口控制按钮的底色 / 图标色跟着换，否则会和工具栏对不上
  const syncOverlayTheme = () => {
    if (process.platform === 'darwin' || !win || win.isDestroyed()) return;
    try { win.setTitleBarOverlay(overlayOptions()); } catch { /* 忽略 */ }
  };
  nativeTheme.on('updated', syncOverlayTheme);

  // ---- ChatGPT 页面 ----
  chatView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  // ---- 顶部工具栏 ----
  barView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'bar-preload.js')
    }
  });
  win.contentView.addChildView(chatView);
  win.contentView.addChildView(barView);
  layoutViews();
  ['resize', 'enter-full-screen', 'leave-full-screen', 'maximize', 'unmaximize', 'restore']
    .forEach(ev => win.on(ev, layoutViews));

  const wc = chatView.webContents;
  spoofChromeUA(wc);   // 伪装 UA + Client Hints，让 Google 登录不拦截

  // 兜底：页面 JS 用 window.open 打开“刚被 preload 标记过的对话外链”时，
  // 拦截并转默认浏览器；其余新窗口保持 Electron 默认行为（方案A：不干预）
  wc.setWindowOpenHandler(({ url }) => {
    if (isRecentExternalIntent(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // 兜底2：对话外链若以同窗口导航方式打开，同样拦截转默认浏览器
  wc.on('will-navigate', (event, url) => {
    if (isRecentExternalIntent(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // 窗口内快捷键（默认 Ctrl+Q 退出：点 X 只是隐藏窗口，怕用户找不到退出入口）
  wc.on('before-input-event', handleWindowShortcut);
  barView.webContents.on('before-input-event', handleWindowShortcut);

  lockLocalPage(barView.webContents);
  barView.webContents.loadFile(path.join(__dirname, 'bar.html'))
    .catch(err => logStartupError('loadBar', err));

  wc.loadURL(START_URL);
  win.show();    // 确保窗口出现在前台（避免“双击没反应”的错觉）
  win.focus();
  focusChat();

  // 点 X（右上角关闭）= 隐藏而不是退出，保证全局热键一直可用
  win.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    nativeTheme.removeListener('updated', syncOverlayTheme);
    // 子视图的 webContents 不会随窗口自动销毁，需要手动关
    for (const v of [chatView, barView]) {
      try { if (v && !v.webContents.isDestroyed()) v.webContents.close(); } catch { /* 忽略 */ }
    }
    chatView = null;
    barView = null;
    win = null;
  });
  return win;
}

// 唤起主窗口并把焦点交给聊天页面
function showMainWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  focusChat();
}

// ===== 全局快捷键：唤起 / 隐藏窗口 =====
function toggleWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isVisible() && win.isFocused()) {
    win.hide();          // 在前台 -> 收起
  } else {
    showMainWindow();    // 不在前台 -> 唤起
  }
}

function quitApp() {
  app.isQuiting = true;
  app.quit();
}

// ===== 设置：加载 / 全局热键注册 =====
let settings = settingsLib.defaultSettings();   // 启动后会用磁盘上的配置覆盖
let registeredAccels = [];                      // 当前已注册的全局热键（用于注销 / 回滚）

const globalActionHandlers = {
  toggleWindow: () => toggleWindow(),
  screenshot: () => { void startScreenshot(); }
};
const windowActionHandlers = {
  quit: () => quitApp()
};

function unregisterGlobals() {
  for (const accel of registeredAccels) {
    try { globalShortcut.unregister(accel); } catch { /* 忽略 */ }
  }
  registeredAccels = [];
}

// 注册一整套全局热键。
//   strict=false（启动 / 恢复时）：成功的保留，失败的只报告 —— 不能因为一个被占用就连累其他热键
//   strict=true （保存设置时）：只有「这次改动过的键」注册失败才算失败并整体回滚；
//                没改过的键如果本来就被别的程序占着（启动时就失败了），只给警告，
//                否则用户永远没法保存任何别的修改。
// 返回 { ok, error?, warning? }
function applyGlobalShortcuts(shortcuts, strict = false) {
  const previous = registeredAccels.slice();
  unregisterGlobals();
  const failedChanged = [];     // 改动过且注册失败 -> 致命
  const failedUnchanged = [];   // 没改动但注册失败 -> 仅警告
  for (const a of settingsLib.ACTIONS) {
    if (a.scope !== 'global') continue;
    const accel = shortcuts[a.id];
    let ok = false;
    try {
      ok = globalShortcut.register(accel, globalActionHandlers[a.id]);
    } catch (err) {
      console.warn('[热键] 注册异常', accel, err.message);
    }
    if (ok) { registeredAccels.push(accel); continue; }
    const label = `「${a.label}」(${accel})`;
    if (settings.shortcuts[a.id] === accel) failedUnchanged.push(label);
    else failedChanged.push(label);
  }
  const hint = '注册失败，可能已被其他程序占用，请换一个快捷键';
  const warning = failedUnchanged.length ? `${failedUnchanged.join('、')} ${hint}` : undefined;

  if (!strict) {
    const all = failedChanged.concat(failedUnchanged);
    return all.length ? { ok: false, error: `${all.join('、')} ${hint}` } : { ok: true };
  }
  if (failedChanged.length === 0) return warning ? { ok: true, warning } : { ok: true };

  // 回滚：先撤掉这次注册成功的，再恢复旧的
  unregisterGlobals();
  for (const accel of previous) {
    const a = settingsLib.ACTIONS.find(x => x.scope === 'global' && settings.shortcuts[x.id] === accel);
    try {
      if (a && globalShortcut.register(accel, globalActionHandlers[a.id])) registeredAccels.push(accel);
    } catch { /* 忽略 */ }
  }
  return { ok: false, error: `${failedChanged.join('、')} ${hint}` };
}

// ===== 区域截图（electron-screenshots）=====
let screenshots = null;     // 懒创建：第一次截图时才加载，不拖慢启动
let capture = null;         // 进行中的截图上下文 { wasVisible, t }

const delay = (ms) => new Promise(r => setTimeout(r, ms));

function getScreenshots() {
  if (screenshots) return screenshots;
  const Screenshots = require('electron-screenshots');   // CJS 入口直接导出类，不需要 .default
  const s = new Screenshots({ singleWindow: true });

  // 点“确定”：自己接管，先写剪贴板，再关闭截图层，最后决定要不要粘贴
  s.on('ok', (event, buffer) => {
    event.preventDefault();
    try {
      clipboard.writeImage(nativeImage.createFromBuffer(buffer));
    } catch (err) {
      logStartupError('screenshot.clipboard', err);
      void s.endCapture().then(() => finishCapture(false));
      return;
    }
    void s.endCapture().then(() => finishCapture(true));
  });
  // 取消 / 保存成功：库自己会关闭截图层，这里只负责善后
  s.on('cancel', () => { void finishCapture(false); });
  s.on('afterSave', (event, buffer, data, isSaved) => { if (isSaved) void finishCapture(false); });

  screenshots = s;
  return s;
}

async function startScreenshot() {
  // 防止连按热键重复触发；超过 2 分钟视为上一次异常中断，允许重新开始
  if (capture && Date.now() - capture.t < 120000) return;
  const ctx = capture = {
    wasVisible: !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()),
    t: Date.now()
  };
  try {
    if (ctx.wasVisible && settings.hideWindowOnCapture) {
      win.hide();
      await delay(250);      // 等窗口真正从屏幕上消失，否则会被截进去
    }
    await getScreenshots().startCapture();
  } catch (err) {
    logStartupError('screenshot', err);
    capture = null;
    if (ctx.wasVisible) showMainWindow();
  }
}

// 截图结束后的善后：恢复窗口；截图成功且开启了自动粘贴时，粘贴到输入框
async function finishCapture(copied) {
  const ctx = capture;
  capture = null;
  if (!ctx) return;
  const wantPaste = copied && settings.autoPasteAfterCapture;
  if (!ctx.wasVisible && !wantPaste) return;   // 原本就藏着、也不需要粘贴：保持原样
  await delay(150);                            // 等截图层完全收起
  showMainWindow();
  if (wantPaste) {
    await delay(150);
    await pasteIntoChat();
  }
}

async function pasteIntoChat() {
  const wc = chatWC();
  if (!wc) return;
  wc.focus();
  try {
    // 优先聚焦 ChatGPT 的输入框；找不到就沿用当前焦点（如果它本身可编辑），再不行退而求其次
    await wc.executeJavaScript(`(() => {
      const prompt = document.querySelector('#prompt-textarea');
      if (prompt) { prompt.focus(); return; }
      const a = document.activeElement;
      const editable = a && (a.isContentEditable || /^(INPUT|TEXTAREA)$/.test(a.tagName));
      if (editable) return;
      const el = document.querySelector('textarea, [contenteditable="true"]');
      if (el) el.focus();
    })()`);
  } catch (err) {
    console.warn('[截图] 聚焦输入框失败', err.message);
  }
  wc.paste();
}

// ===== 设置窗口 =====
let settingsWin = null;

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 620,
    height: 660,
    minWidth: 520,
    minHeight: 520,
    title: '设置',
    autoHideMenuBar: true,
    minimizable: false,
    maximizable: false,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'settings-preload.js')
    }
  });
  const sw = settingsWin;
  sw.setMenuBarVisibility(false);
  lockLocalPage(sw.webContents);

  // 录入快捷键时，已注册的全局热键会被系统先吞掉（按 Ctrl+Alt+A 会直接触发截图，
  // 根本到不了设置页）。所以设置窗口获得焦点期间暂时注销全局热键，失焦 / 关闭后恢复。
  sw.on('focus', () => unregisterGlobals());
  const resume = () => {
    const r = applyGlobalShortcuts(settings.shortcuts);
    if (!r.ok) console.warn('[热键] 恢复失败:', r.error);
  };
  sw.on('blur', resume);
  sw.on('closed', () => { settingsWin = null; resume(); });

  sw.loadFile(path.join(__dirname, 'settings.html'))
    .catch(err => logStartupError('loadSettings', err));
}

const fromSettingsWin = (e) => !!settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents;
const fromBar = (e) => !!barView && !barView.webContents.isDestroyed() && e.sender === barView.webContents;

ipcMain.handle('settings:get', (e) => {
  if (!fromSettingsWin(e)) return null;
  return {
    settings,
    actions: settingsLib.ACTIONS,
    defaults: settingsLib.defaultSettings()
  };
});

ipcMain.handle('settings:save', (e, raw) => {
  if (!fromSettingsWin(e)) return { ok: false, error: '非法调用' };
  const v = settingsLib.validateSettings(raw);
  if (!v.ok) return v;

  const previous = settings;
  const applied = applyGlobalShortcuts(v.value.shortcuts, true);
  if (!applied.ok) return applied;

  settings = v.value;
  const saved = settingsLib.saveSettings(SETTINGS_FILE, settings);
  if (!saved.ok) {
    // 配置文件写不进去：回滚内存和热键，避免“本次能用、重启就丢”的假象
    settings = previous;
    applyGlobalShortcuts(previous.shortcuts, true);
    return { ok: false, error: '保存配置文件失败：' + saved.error };
  }

  if (barView && !barView.webContents.isDestroyed()) {
    barView.webContents.send('bar:shortcuts', settings.shortcuts);
  }
  refreshTray();
  // 保存成功但设置窗口仍然开着（有警告时不自动关）：它还在前台，
  // 继续暂停全局热键，免得用户接着录入键位时又被系统拦截；失焦 / 关闭后会自动恢复
  if (settingsWin && !settingsWin.isDestroyed() && settingsWin.isFocused()) unregisterGlobals();
  return applied.warning ? { ok: true, warning: applied.warning } : { ok: true };
});

ipcMain.on('settings:close', (e) => {
  if (fromSettingsWin(e)) settingsWin.close();
});

ipcMain.handle('bar:get-shortcuts', (e) => (fromBar(e) ? settings.shortcuts : null));
ipcMain.on('bar:open-settings', (e) => { if (fromBar(e)) openSettings(); });
ipcMain.on('bar:screenshot', (e) => { if (fromBar(e)) void startScreenshot(); });

// ===== 系统托盘 =====
// 关掉窗口只是隐藏，托盘图标常驻：左键单击切换显示/隐藏，右键菜单可退出
const prettyAccel = (s) => String(s || '').replace(/Control/g, 'Ctrl').replace(/Meta/g, 'Win/Cmd');

// 托盘菜单 / 提示里带着当前快捷键，所以改完设置后要刷新一次
function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const k = settings.shortcuts;
  tray.setToolTip(`ChatGPT 套壳（${prettyAccel(k.toggleWindow)} 或左键单击托盘图标显示/隐藏）`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `显示 / 隐藏窗口\t${prettyAccel(k.toggleWindow)}`, click: toggleWindow },
    { label: `区域截图\t${prettyAccel(k.screenshot)}`, click: () => { void startScreenshot(); } },
    { label: '设置…', click: openSettings },
    { type: 'separator' },
    { label: '退出', click: quitApp }
  ]));
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'icon.png'));
  tray.on('click', toggleWindow);
  refreshTray();
  return tray;
}

// ===== 单实例 =====
// 重复双击图标时只唤起已有窗口，避免堆出一堆没有窗口的僵尸进程
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (app.isReady()) showMainWindow();
  });

  app.whenReady().then(() => {
    // 每一步都单独兜底：任何一环失败都不能连累窗口创建
    try { settings = settingsLib.loadSettings(SETTINGS_FILE); } catch (err) { logStartupError('loadSettings', err); }
    try { loadExtensions(); } catch (err) { logStartupError('loadExtensions', err); }
    try { startCookieBridge(); } catch (err) { logStartupError('startCookieBridge', err); }
    try {
      createWindow();
    } catch (err) {
      logStartupError('createWindow', err);
      app.quit();
      return;
    }
    try { createTray(); } catch (err) { logStartupError('createTray', err); }

    try {
      // 启动时某个热键被占用不致命：记日志，用户可以在“设置”里换一个
      const r = applyGlobalShortcuts(settings.shortcuts);
      if (!r.ok) logStartupError('globalShortcut', new Error(r.error));
    } catch (err) {
      logStartupError('globalShortcut', err);
    }
  }).catch(err => {
    logStartupError('whenReady', err);
    app.quit();
  });
}

// 应用退出时释放热键
app.on('will-quit', () => globalShortcut.unregisterAll());

// 所有窗口被"消灭"时不退出（我们平时是 hide，不会走到这里，保险起见）
app.on('window-all-closed', () => {});
