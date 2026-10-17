const { app, BrowserWindow, globalShortcut, session, shell, ipcMain, Tray, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');

const START_URL = 'https://chatgpt.com';
const HOT_KEY = 'Control+Space'; // 全局切换热键
const WINDOW_TITLE = 'ChatGPT';

// ===== 启动日志 =====
// 安装版是 GUI 进程，没有控制台；一旦启动阶段抛异常，用户只会看到“双击没反应”。
// 这里把启动异常落到 %APPDATA%\chatgpt-electron\startup-error.log，方便排查。
const LOG_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'chatgpt-electron')
  : app.getPath('userData');
const LOG_FILE = path.join(LOG_DIR, 'startup-error.log');

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
            if (win && !win.isDestroyed()) win.loadURL(START_URL);
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
function spoofChromeUA() {
  const wc = win.webContents;
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

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 400,
    title: WINDOW_TITLE,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  win.setMenuBarVisibility(false);

  spoofChromeUA();   // 伪装 UA + Client Hints，让 Google 登录不拦截

  // 兜底：页面 JS 用 window.open 打开“刚被 preload 标记过的对话外链”时，
  // 拦截并转默认浏览器；其余新窗口保持 Electron 默认行为（方案A：不干预）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isRecentExternalIntent(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // 兜底2：对话外链若以同窗口导航方式打开，同样拦截转默认浏览器
  win.webContents.on('will-navigate', (event, url) => {
    if (isRecentExternalIntent(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Ctrl+Q 退出（点 X 只是隐藏窗口，怕用户找不到退出入口）
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown'
        && input.control && !input.alt && !input.shift
        && (input.key === 'q' || input.key === 'Q')) {
      event.preventDefault();
      app.isQuiting = true;
      app.quit();
    }
  });

  win.loadURL(START_URL);
  win.show();    // 确保窗口出现在前台（避免“双击没反应”的错觉）
  win.focus();

  // 点 X（右上角关闭）= 隐藏而不是退出，保证全局热键一直可用
  win.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
  return win;
}

// ===== 全局快捷键 Ctrl+Space：toggle =====
function toggleWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isVisible() && win.isFocused()) {
    win.hide();          // 在前台 -> 收起
  } else {
    win.show();          // 不在前台 -> 唤起
    win.focus();
  }
}

// ===== 系统托盘 =====
// 关掉窗口只是隐藏，托盘图标常驻：左键单击切换显示/隐藏，右键菜单可退出
function createTray() {
  tray = new Tray(path.join(__dirname, 'icon.png'));
  tray.setToolTip('ChatGPT 套壳（Ctrl+Space 或左键单击托盘图标显示/隐藏）');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏窗口', click: toggleWindow },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuiting = true;
        app.quit();
      }
    }
  ]));
  tray.on('click', toggleWindow);
  return tray;
}

// ===== 单实例 =====
// 重复双击图标时只唤起已有窗口，避免堆出一堆没有窗口的僵尸进程
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    } else if (app.isReady()) {
      createWindow();
    }
  });

  app.whenReady().then(() => {
    // 每一步都单独兜底：任何一环失败都不能连累窗口创建
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
      const ok = globalShortcut.register(HOT_KEY, toggleWindow);
      if (!ok) console.warn('全局热键注册失败（可能被其他程序占用）');
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
