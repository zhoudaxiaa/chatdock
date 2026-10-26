const {
  app, BrowserWindow, WebContentsView, globalShortcut, session, shell, ipcMain,
  Tray, Menu, clipboard, nativeImage
} = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const settingsLib = require('./app-settings');

const { providers, getProvider, ownsDomain } = require('../shared/providers');
const WINDOW_TITLE = 'ChatDock';
// Keep the original profile so upgrades retain sessions, settings and extensions.
app.setPath('userData', process.env.CHATDOCK_USER_DATA_DIR || path.join(app.getPath('appData'), 'chatgpt-electron'));
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
let bridgeServer = null;   // 退出时要主动关掉，别让它拖着进程

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
          const { cookies = [], provider = 'chatgpt' } = JSON.parse(body || '{}');
          if (!Object.hasOwn(providers, provider)) throw new Error('未知服务');
          if (!Array.isArray(cookies)) throw new Error('payload 不是数组');
          if (cookies.length === 0) return send(200, { ok: true, count: 0, reason: 'empty' });
          let count = 0;
          const failed = [];
          for (const c of cookies) {
            if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') continue;
            const host = String(c.domain || '').replace(/^\./, '').replace(/^\[|\]$/g, '');
            if (!host || !ownsDomain(provider, host)) continue;
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
              await providerSession(provider).cookies.set(opts);
              count++;
            } catch (err) {
              failed.push(name);
              console.warn('[登录态桥接] 单个 Cookie 写入失败', name, err.message);
            }
          }
          console.log('[登录态桥接] 导入完成：成功', count, '个，失败', failed.length, '个', failed.join(','));
          if (count > 0) {
            // Refresh that provider's existing page without selecting it or losing its URL.
            const refreshed = refreshProvider(provider);
            send(200, { ok: true, count, skipped: failed, refreshed });
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
  // unref：这个 server 只是给浏览器扩展推送 Cookie 用的，不该拖着进程不让它退出。
  // （退出时 Electron 会收尾 Node 环境，一个还挂在 listen 状态的句柄足以让收尾卡住。）
  server.unref();
  bridgeServer = server;
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
    // 窗口销毁时 debugger 会触发 detach，此时再碰 wc / wc.debugger 会抛
    // “Object has been destroyed”，整段包在 try 里最稳妥。
    if (app.isQuiting || wc.isDestroyed()) return;
    try {
      wc.debugger.attach('1.3');
      wc.debugger.sendCommand('Network.setUserAgentOverride', { userAgent: ua, userAgentMetadata: metadata })
        .catch(err => {
          // 退出时目标会被销毁，这条命令必然失败，没必要刷屏
          if (app.isQuiting) return;
          try {
            if (!wc.isDestroyed()) console.warn('[UA 伪装失败]', err.message);
          } catch { /* 已销毁 */ }
        });
    } catch { /* 目标已销毁 / 已断开，忽略 */ }
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
const providerViews = new Map();
function providerSession(id) {
  return id === 'chatgpt' ? session.defaultSession : session.fromPartition('persist:chatdock-claude');
}

function createProviderView(id) {
  const view = new WebContentsView({ webPreferences: {
    contextIsolation: true, nodeIntegration: false,
    session: providerSession(id), preload: path.join(__dirname, 'preload.js')
  } });
  const wc = view.webContents;
  neutralizeDragRegions(wc);
  spoofChromeUA(wc);
  wc.setWindowOpenHandler(({ url }) => {
    if (isRecentExternalIntent(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  wc.on('will-navigate', (event, url) => {
    if (isRecentExternalIntent(url)) { event.preventDefault(); shell.openExternal(url); }
  });
  wc.on('before-input-event', handleWindowShortcut);
  wc.loadURL(getProvider(id).url).catch(err => logStartupError('loadProvider', err));
  providerViews.set(id, view);
  return view;
}

function switchProvider(id) {
  if (!Object.hasOwn(providers, id)) return { ok: false, error: '未知服务' };
  const nextSettings = { ...settings, provider: id };
  const saved = settingsLib.saveSettings(SETTINGS_FILE, nextSettings);
  if (!saved.ok) return saved;
  const next = providerViews.get(id) || createProviderView(id);
  if (chatView !== next) {
    if (chatView) win.contentView.removeChildView(chatView);
    chatView = next;
    win.contentView.addChildView(chatView);
    win.contentView.addChildView(barView);
  }
  settings = nextSettings;
  layoutViews();
  win.setTitle('ChatDock · ' + getProvider(id).label);
  if (barView && !barView.webContents.isDestroyed()) barView.webContents.send('bar:provider', id);
  refreshTray();
  refreshAppMenu();
  focusChat();
  return { ok: true, provider: id };
}

const chatWC = () => (chatView && !chatView.webContents.isDestroyed() ? chatView.webContents : null);

function refreshProvider(id) {
  const view = providerViews.get(id);
  if (!view || view.webContents.isDestroyed()) return false;
  try { view.webContents.reload(); return true; }
  catch (error) { logStartupError('refreshProvider', error); return false; }
}

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

// ===== 退出日志 =====
// 退出路径上任何一步卡住，用户看到的就是「窗口没了、进程还在、任务管理器都关不掉」。
// 这种事后再去复现很难，所以把关键节点落到 %APPDATA%\chatgpt-electron\quit.log（每次退出只有几行）。
const QUIT_LOG = path.join(LOG_DIR, 'quit.log');
function logQuit(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(QUIT_LOG, line);
  } catch { /* 日志写不进去也不能再抛 */ }
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

// ChatGPT 登录后的界面会给自己的顶部栏加 `-webkit-app-region: drag`（给官方桌面端拖窗口用的）。
// 在 Electron 里这个属性会把那块区域变成**窗口标题栏**：鼠标点上去会被窗口层吞掉，
// 页面根本收不到事件 —— 表现就是「左上角有一块点不了」，而且只在登录后才出现。
// 这里把页面里的拖动区全部中和掉；拖动窗口统一交给我们自己的顶栏空白区。
const NO_DRAG_CSS = '*{-webkit-app-region:no-drag !important}';
function neutralizeDragRegions(wc) {
  const apply = () => {
    if (!wc || wc.isDestroyed()) return;
    wc.insertCSS(NO_DRAG_CSS).catch(() => { /* 页面还没就绪就下次再来 */ });
  };
  wc.on('did-finish-load', apply);
  wc.on('did-navigate-in-page', apply);   // SPA 路由切换后重新压一遍
  apply();
}

// 工具栏兼任标题栏。
// 这里**不用** titleBarOverlay：Windows 上 overlay 会让系统把窗口顶部一段当作 caption
// （标题栏），该区域内的鼠标事件被窗口层吞掉，只有显式标了 -webkit-app-region: no-drag
// 的元素能收到点击。表现就是「自己的按钮能点，但下方 ChatGPT 页面顶部那一块点不了」。
// 所以改成隐藏标题栏 + 自绘最小化/最大化/关闭，鼠标事件全部落到页面里。
// macOS 用 hiddenInset，保留左上角原生红绿灯。
const IS_MAC = process.platform === 'darwin';

// ===== 置顶（浮在其他应用上层）=====
// 快捷键唤起时窗口必须真正压在最前面。Windows 有前台锁（foreground lock）：
// 一个被 hide() 过、或由后台进程 show() 出来的窗口，常常只在任务栏闪一下，
// 实际仍被当前应用盖住 —— 表现就是「按了快捷键，窗口没出来 / 出来了但被挡住」。
// 所以统一走 raiseWindow()：先 show 显示，再 setAlwaysOnTop 压层级，最后 moveTop() 兜底
// （顺序很重要：macOS 上 hide→show 会重置窗口层级，置顶必须在 show 之后再设置）。
// floating 负责窗口层级；macOS 全屏 Space 的可见性由下面的工作区配置负责。
const TOP_LEVEL = 'floating';
const workspaceVisibility = new WeakMap();

// 只负责「窗口层级」这一件事：开销小，可以反复调用，不会让窗口闪一下。
function setLevel(on, target = win) {
  if (!target || target.isDestroyed()) return;
  try {
    target.setAlwaysOnTop(!!on, TOP_LEVEL);
  } catch (err) {
    console.warn('[置顶] 设置层级失败：' + err.message);
  }
}

// Workspace visibility must not transform the whole app into a UIElement:
// that removes it from the Dock and macOS's normal application list.
// Keep the foreground application policy while setting per-window collection behaviour.
function applyWorkspacesVisible(on, target = win) {
  if (!IS_MAC || !target || target.isDestroyed()) return;
  if (typeof target.setVisibleOnAllWorkspaces !== 'function') return;
  const visible = !!on;
  if (workspaceVisibility.get(target) === visible) return;
  try {
    target.setVisibleOnAllWorkspaces(visible, {
      visibleOnFullScreen: visible,
      skipTransformProcessType: true
    });
    workspaceVisibility.set(target, visible);
  } catch (err) {
    console.warn('[置顶] 设置跨桌面可见失败：' + err.message);
  }
}

function setWindowTopmost(target, on) {
  // 先配置工作区可见性，再恢复窗口层级。
  applyWorkspacesVisible(on, target);
  setLevel(on, target);
}

// 主窗口、设置窗口共享同一策略，所有入口切换置顶时同步更新。
function setTopmost(on) {
  // 先完成两个窗口的工作区配置，再统一恢复层级。
  applyWorkspacesVisible(on, win);
  applyWorkspacesVisible(on, settingsWin);
  setWindowTopmost(win, on);
  setWindowTopmost(settingsWin, on);
}

// 把窗口强行提到本层最前。
// 关键：setAlwaysOnTop 在层级没变化时是个「无操作」—— 它只改 window level，
// 不会重新排序，所以顶不开压在上面的同层窗口；真正把窗口提前的是 orderFront
// （Electron 的 moveTop 走 orderWindowByShuffling）。
function nudgeToFront() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  try {
    if (typeof win.moveTop === 'function') win.moveTop();
  } catch { /* 忽略 */ }
}

// 重新确立「浮在最上面」：层级 + 立刻顶一次 + 延迟再顶一次。
// macOS 会在本轮 runloop 末尾再重排一次窗口顺序，所以同步顶完还要补一枪才稳。
function promote() {
  if (!win || win.isDestroyed()) return;
  if (!settings || !settings.alwaysOnTopOnShow) return;
  setLevel(true);
  nudgeToFront();
  setTimeout(nudgeToFront, 80);
}

// 把主窗口显示到最前面（最小化则先还原），并按设置决定是否置顶
function raiseWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  // macOS 上 hide→show 会把窗口层级重置回普通层（always-on-top 丢失），
  // 所以置顶必须在 show() **之后**再压一次。这里只碰 level 和 orderFront，
  // 工作区配置只在置顶开关变化时更新；唤起路径只恢复层级和顺序。
  promote();
  focusChat();
}

// 顶栏「置顶」按钮 / 托盘菜单 / 设置页共用的开关：立刻生效并写回配置文件
function setTopmostSetting(on) {
  settings.alwaysOnTopOnShow = !!on;
  setTopmost(settings.alwaysOnTopOnShow);
  // 光改 level 不会让窗口跳到同层最前，还得 orderFront 一次 ——
  // 这也正是「手动关一下再开就好了」的原因，现在把这一步补上，不必再手动开关
  if (settings.alwaysOnTopOnShow) promote();
  const saved = settingsLib.saveSettings(SETTINGS_FILE, settings);
  if (!saved.ok) console.warn('[置顶] 保存设置失败：' + saved.error);
  if (barView && !barView.webContents.isDestroyed()) {
    barView.webContents.send('bar:topmost', settings.alwaysOnTopOnShow);
  }
  refreshTray();
  refreshAppMenu();
}

function createWindow() {
  win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 860,
    minWidth: 480,
    minHeight: 400,
    title: WINDOW_TITLE,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
    ...(IS_MAC ? { trafficLightPosition: { x: 12, y: (BAR_HEIGHT - 16) / 2 } } : {})
  });
  win.setMenuBarVisibility(false);

  // ---- ChatGPT 页面 ----
  chatView = createProviderView(settings.provider);
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

  // macOS 上 hide→show 会重置窗口层级，任何路径把窗口亮出来都要重新压一次：
  // 热键唤起、托盘点击、点 Dock、从最小化恢复、退出全屏都算。
  // 这里只走 promote()（改 level + orderFront），不碰跨桌面可见，
  // 工作区配置另行缓存，避免在每次 show 时重复设置。
  const onBecomeVisible = () => promote();
  win.on('show', onBecomeVisible);
  win.on('restore', onBecomeVisible);
  win.on('leave-full-screen', onBecomeVisible);

  // 自绘的最大化按钮需要知道自己当前该显示「最大化」还是「还原」
  const notifyMaximized = () => {
    if (barView && !barView.webContents.isDestroyed()) {
      barView.webContents.send('bar:maximized', !!(win && !win.isDestroyed() && win.isMaximized()));
    }
  };
  win.on('maximize', notifyMaximized);
  win.on('unmaximize', notifyMaximized);

  barView.webContents.on('before-input-event', handleWindowShortcut);

  lockLocalPage(barView.webContents);
  barView.webContents.loadFile(path.join(__dirname, 'bar.html'))
    .then(() => {
      notifyMaximized();
      // 顶栏「置顶」按钮的初始状态
      if (barView && !barView.webContents.isDestroyed()) {
        barView.webContents.send('bar:topmost', settings.alwaysOnTopOnShow);
      }
    })
    .catch(err => logStartupError('loadBar', err));

  win.setTitle('ChatDock · ' + getProvider(settings.provider).label);
  // 首次显示前完成置顶与工作区配置；后续仅在开关变化时更新工作区状态。
  setTopmost(!!settings.alwaysOnTopOnShow);
  // 首次显示也走同一套置顶逻辑，保证启动就是最前面那一层
  raiseWindow();

  // 点 X（右上角关闭）= 隐藏而不是退出，保证全局热键一直可用
  win.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    // 子视图的 webContents 不会随窗口自动销毁，需要手动关
    for (const v of [...providerViews.values(), barView]) {
      try {
        const w = v && v.webContents;
        if (w && !w.isDestroyed()) w.close();
      } catch (err) { logQuit('关闭子视图失败：' + err.message); }
    }
    providerViews.clear();
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
  raiseWindow();
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

// ===== 退出看门狗（进程外兜底）=====
// 主线程一旦卡进 Electron 的原生收尾流程（窗口已销毁、quit 事件已发，进程却不动了），
// 进程内的 setTimeout 再也不会触发 —— 所以只能另起一个进程来强杀。
// 用 ELECTRON_RUN_AS_NODE 让同一个可执行文件跑成纯 Node，不会多开一个应用实例。
// 用 stdin 管道判断父进程死活：父进程一退出管道就断，子进程据此立刻收工，
// 绝不会因为 PID 被系统复用而误杀别的程序。
const WATCHDOG_SRC = `
let done = false;
const finish = () => { if (!done) { done = true; process.exit(0); } };
process.stdin.on('end', finish);
process.stdin.on('error', finish);
process.stdin.resume();
setTimeout(() => {
  try { process.kill(Number(process.argv[1]), 'SIGKILL'); } catch (e) { /* 已经没了 */ }
  finish();
}, 9000);
`;

function armQuitWatchdog() {
  try {
    const child = require('child_process').spawn(
      process.execPath,
      ['-e', WATCHDOG_SRC, String(process.pid)],
      {
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      }
    );
    child.on('error', () => { /* 起不来就算了，不能影响正常退出 */ });
    child.unref();
  } catch (err) {
    logQuit('看门狗启动失败（不影响退出）：' + err.message);
  }
}

// ===== 退出 =====
// 退出入口有三处：窗口内快捷键、托盘菜单、顶栏/设置窗口里的「退出应用」。
// 三个坑都在这里处理：
//   1) 这三处都发生在同步回调里（before-input-event / 菜单点击 / IPC）。在回调里直接
//      app.quit() 会一边销毁窗口和 WebContentsView 的 webContents、一边继续走当前的
//      输入/菜单消息循环，重入后主线程卡死 —— 表现就是「窗口没了，进程还在，关不掉」。
//      所以真正退出推迟到 setImmediate。
//   2) 进程内定时器兜底：app.quit() 返回了但事件循环还被句柄拖着时，6 秒后强制结束。
//   3) 进程外兜底：主线程一旦卡进 Electron 的原生收尾流程，进程内的定时器再也不会触发，
//      只能靠另一个进程强杀。见 armQuitWatchdog()。
let quitRequested = false;
function quitApp(source) {
  if (quitRequested) return;
  quitRequested = true;
  app.isQuiting = true;          // 让 win.on('close') 放行，不再 hide
  logQuit(`请求退出（来源：${source || '未知'}）`);
  armQuitWatchdog();

  setImmediate(() => {
    try {
      app.quit();
    } catch (err) {
      logQuit('app.quit 抛错，强制结束：' + err.message);
      app.exit(0);
    }
  });

  // 进程内兜底：app.quit() 返回了、事件循环却被句柄拖着时，6 秒后强制结束。
  // 正常收尾在 2 秒内完成，6 秒已经是很宽的余量；进程外看门狗排在 9 秒之后。
  const watchdog = setTimeout(() => {
    logQuit('6 秒内未退出，强制结束进程');
    app.exit(0);
  }, 6000);
  if (typeof watchdog.unref === 'function') watchdog.unref();
}

// ===== 设置：加载 / 全局热键注册 =====
let settings = settingsLib.defaultSettings();   // 启动后会用磁盘上的配置覆盖
let registeredAccels = [];                      // 当前已注册的全局热键（用于注销 / 回滚）

const globalActionHandlers = {
  toggleWindow: () => toggleWindow(),
  screenshot: () => { void startScreenshot(); }
};
const windowActionHandlers = {
  quit: () => quitApp('窗口内快捷键')
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
let topmostSuspended = false; // 是否是「截图期间临时关掉了置顶」，结束时必须还回去

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// 截图期间临时取消置顶：截图层本身也是置顶窗口，主窗口压在上面就框选不了。
// 用独立标记记住「是我们临时关的」——以前靠 showMainWindow() 顺带恢复，
// 一旦截图流程没走到那一步（库没发 cancel / save 事件、或超过 2 分钟限制后重入
// 把 capture 覆盖掉），置顶就一直是关的，表现同样是「偶发置顶失效」。
function suspendTopmost() {
  if (!settings || !settings.alwaysOnTopOnShow || topmostSuspended) return;
  topmostSuspended = true;
  setLevel(false);
}

function resumeTopmost() {
  if (!topmostSuspended) return;
  topmostSuspended = false;
  promote();
}

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
  // 上一次是异常中断（超时重入）：先把临时取消的置顶还回去，再开始新的
  if (topmostSuspended) resumeTopmost();
  const ctx = capture = {
    wasVisible: !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()),
    t: Date.now()
  };
  try {
    if (ctx.wasVisible && settings.hideWindowOnCapture) {
      win.hide();
      await delay(250);      // 等窗口真正从屏幕上消失，否则会被截进去
    } else if (ctx.wasVisible && settings.alwaysOnTopOnShow) {
      // 不隐藏窗口时，置顶的主窗口会把截图层（也是置顶窗口）压在下面，
      // 框选时看不清也点不到 —— 截屏期间先临时取消置顶，结束由 resumeTopmost() 还回去。
      suspendTopmost();
    }
    await getScreenshots().startCapture();
  } catch (err) {
    logStartupError('screenshot', err);
    capture = null;
    resumeTopmost();
    if (ctx.wasVisible) showMainWindow();
  }
}

// 截图结束后的善后：恢复窗口；截图成功且开启了自动粘贴时，粘贴到输入框
async function finishCapture(copied) {
  const ctx = capture;
  capture = null;
  if (!ctx) return;
  // 先无条件还原置顶，后面无论怎么提前 return 都不会把它漏成「关着的」
  resumeTopmost();
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
      const selectors = ${JSON.stringify(getProvider(settings.provider).composers)};
      const prompt = selectors.map(s => document.querySelector(s)).find(el => el && el.getBoundingClientRect().width > 0);
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
    setLevel(settings.alwaysOnTopOnShow, settingsWin);
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    show: false,
    width: 620,
    height: 720,          // 小屏也能放下；内容超出时设置页内部自行滚动
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
  // 主窗口置顶时设置窗口也要置顶，否则它会被主窗口盖住、点都点不到
  setWindowTopmost(sw, settings.alwaysOnTopOnShow);
  sw.on('show', () => setLevel(settings.alwaysOnTopOnShow, sw));
  lockLocalPage(sw.webContents);

  // 录入快捷键时，已注册的全局热键会被系统先吞掉（按 Ctrl+Alt+A 会直接触发截图，
  // 根本到不了设置页）。所以设置窗口获得焦点期间暂时注销全局热键，失焦 / 关闭后恢复。
  sw.on('focus', () => unregisterGlobals());
  const resume = () => {
    if (app.isQuiting) return;        // 正在退出时不要再把热键注册回去
    const r = applyGlobalShortcuts(settings.shortcuts);
    if (!r.ok) console.warn('[热键] 恢复失败:', r.error);
  };
  sw.on('blur', resume);
  sw.on('closed', () => {
    settingsWin = null;
    resume();
    // 设置窗口关掉后把主窗口重新顶回最前：两个窗口同在 floating 层，
    // 关掉一个之后 AppKit 不一定会把另一个重新提到前面
    promote();
  });

  sw.loadFile(path.join(__dirname, 'settings.html'))
    .catch(err => logStartupError('loadSettings', err));
  sw.show();
  sw.focus();
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

  // The settings page may have been opened before a service switch.
  settings = { ...v.value, provider: previous.provider };
  // 置顶开关改动立即生效，不必重启；设置窗口自己也要跟着置顶，
  // 否则它会被刚刚变成置顶的主窗口盖住（保存有警告时窗口不会自动关闭）
  // 只在开关变化时更新工作区配置。
  if (!!previous.alwaysOnTopOnShow !== !!settings.alwaysOnTopOnShow) {
    setTopmost(settings.alwaysOnTopOnShow);
  }
  if (settingsWin && !settingsWin.isDestroyed()) {
    try {
      setWindowTopmost(settingsWin, settings.alwaysOnTopOnShow);
      settingsWin.moveTop();
    } catch { /* 忽略 */ }
  }
  const saved = settingsLib.saveSettings(SETTINGS_FILE, settings);
  if (!saved.ok) {
    // 配置文件写不进去：回滚内存和热键，避免“本次能用、重启就丢”的假象
    settings = previous;
    setTopmost(previous.alwaysOnTopOnShow);
    promote();
    applyGlobalShortcuts(previous.shortcuts, true);
    return { ok: false, error: '保存配置文件失败：' + saved.error };
  }

  if (barView && !barView.webContents.isDestroyed()) {
    barView.webContents.send('bar:shortcuts', settings.shortcuts);
    barView.webContents.send('bar:topmost', settings.alwaysOnTopOnShow);
  }
  refreshTray();
  refreshAppMenu();
  // 保存成功但设置窗口仍然开着（有警告时不自动关）：它还在前台，
  // 继续暂停全局热键，免得用户接着录入键位时又被系统拦截；失焦 / 关闭后会自动恢复
  if (settingsWin && !settingsWin.isDestroyed() && settingsWin.isFocused()) unregisterGlobals();
  return applied.warning ? { ok: true, warning: applied.warning } : { ok: true };
});

ipcMain.on('settings:close', (e) => {
  if (fromSettingsWin(e)) settingsWin.close();
});
ipcMain.on('settings:quit', (e) => {
  if (fromSettingsWin(e)) quitApp('设置窗口');
});

ipcMain.handle('bar:refresh', (e) => {
  if (!fromBar(e)) return { ok: false };
  return { ok: refreshProvider(settings.provider) };
});

ipcMain.handle('bar:get-provider', (e) => fromBar(e) ? settings.provider : null);
ipcMain.handle('bar:set-provider', (e, id) => fromBar(e) ? switchProvider(id) : { ok: false });

ipcMain.handle('bar:get-shortcuts', (e) => (fromBar(e) ? settings.shortcuts : null));
ipcMain.handle('bar:get-topmost', (e) => (fromBar(e) ? !!settings.alwaysOnTopOnShow : null));
ipcMain.on('bar:toggle-topmost', (e) => {
  if (!fromBar(e)) return;
  setTopmostSetting(!settings.alwaysOnTopOnShow);
});
ipcMain.on('bar:open-settings', (e) => { if (fromBar(e)) openSettings(); });
ipcMain.on('bar:screenshot', (e) => { if (fromBar(e)) void startScreenshot(); });

// 自绘窗口按钮：最小化 / 最大化-还原 / 关闭
ipcMain.on('bar:window-action', (e, action) => {
  if (!fromBar(e) || !win || win.isDestroyed()) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  } else if (action === 'close') win.close();
});

// 顶栏右键菜单：给「退出」一个看得见摸得着的入口。
// 光靠托盘图标不够 —— Windows 11 默认把托盘图标收进溢出区，用户根本找不到退出。
const prettyAccel = (s) => String(s || '').replace(/Control/g, 'Ctrl').replace(/Meta/g, 'Win/Cmd');

ipcMain.on('bar:context-menu', (e) => { if (fromBar(e)) showBarMenu(); });
ipcMain.on('bar:quit', (e) => { if (fromBar(e)) quitApp('顶栏菜单'); });

function showBarMenu() {
  if (!win || win.isDestroyed()) return;
  const k = settings.shortcuts;
  Menu.buildFromTemplate([
    ...providerMenuItems(),
    { type: 'separator' },
    { label: '设置…', click: openSettings },
    { label: `区域截图\t${prettyAccel(k.screenshot)}`, click: () => { void startScreenshot(); } },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: !!settings.alwaysOnTopOnShow,
      click: (item) => setTopmostSetting(item.checked)
    },
    { type: 'separator' },
    { label: '隐藏窗口', click: () => { if (win && !win.isDestroyed()) win.hide(); } },
    { label: `退出应用\t${prettyAccel(k.quit)}`, click: () => quitApp('顶栏菜单') }
  ]).popup({ window: win });
}

function providerMenuItems() {
  return Object.values(providers).map(p => ({
    label: p.label, type: 'radio', checked: settings.provider === p.id,
    click: () => { const result = switchProvider(p.id); if (!result.ok) logStartupError('switchProvider', new Error(result.error)); }
  }));
}

function refreshAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(IS_MAC ? [{ label: 'ChatDock', submenu: [
      { label: '设置…', click: openSettings }, { type: 'separator' },
      { label: '退出 ChatDock', click: () => quitApp('应用菜单') }
    ] }] : []),
    { label: '服务', submenu: providerMenuItems() },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ label: '设置…', click: openSettings },
      { label: '区域截图', click: () => { void startScreenshot(); } },
      { label: '窗口置顶', type: 'checkbox', checked: !!settings.alwaysOnTopOnShow, click: item => setTopmostSetting(item.checked) },
      { label: '重新加载当前服务', click: () => chatWC()?.reload() },
      { label: '开发者工具', click: () => chatWC()?.toggleDevTools() }, { label: '隐藏窗口', click: () => win?.hide() }
    ] }
  ]));
}

// ===== 系统托盘 =====
// 关掉窗口只是隐藏，托盘图标常驻：左键单击切换显示/隐藏，右键菜单可退出

// 托盘菜单 / 提示里带着当前快捷键，所以改完设置后要刷新一次
function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const k = settings.shortcuts;
  tray.setToolTip(`ChatDock · ${getProvider(settings.provider).label}（${prettyAccel(k.toggleWindow)} 或左键单击托盘图标显示/隐藏）`);
  tray.setContextMenu(Menu.buildFromTemplate([
    ...providerMenuItems(),
    { type: 'separator' },
    { label: `显示 / 隐藏窗口\t${prettyAccel(k.toggleWindow)}`, click: toggleWindow },
    { label: `区域截图\t${prettyAccel(k.screenshot)}`, click: () => { void startScreenshot(); } },
    {
      label: '窗口置顶',
      type: 'checkbox',
      checked: !!settings.alwaysOnTopOnShow,
      click: (item) => setTopmostSetting(item.checked)
    },
    { label: '设置…', click: openSettings },
    { type: 'separator' },
    { label: '退出', click: () => quitApp('托盘菜单') }
  ]));
}

// 托盘图标：mac 与其他平台要分开处理
// - macOS 菜单栏图标只有 22pt 高，必须用「单色 + 透明背景」的 template image
//   （系统自动适配浅色/深色菜单栏，选中态还会反色）。直接把 512px 的彩色 icon.png
//   丢进去，会被整块塞进菜单栏：视觉上又大又糊，深色菜单栏下尤其明显。
//   trayTemplate.png 由 scripts/make-tray-icon.mjs 生成，自带 @2x/@3x 倍图。
// - Windows / Linux 托盘沿用彩色 icon.png。
function createTrayImage() {
  const colorful = path.join(__dirname, 'icon.png');
  if (process.platform !== 'darwin') return nativeImage.createFromPath(colorful);

  const templatePath = path.join(__dirname, 'trayTemplate.png');
  const template = nativeImage.createFromPath(templatePath);
  if (!template.isEmpty()) {
    // 文件名已以 Template 结尾，Electron 会自动识别；这里显式再声明一次，避免打包后命名被改
    template.setTemplateImage(true);
    return template;
  }

  logStartupError('createTrayImage', new Error(`菜单栏图标缺失，回退到彩色图标：${templatePath}`));
  // 兜底：至少缩到菜单栏尺寸，不至于占满整条菜单栏
  return nativeImage.createFromPath(colorful).resize({ width: 16, height: 16 });
}

function createTray() {
  tray = new Tray(createTrayImage());
  tray.on('click', toggleWindow);
  refreshTray();
  refreshAppMenu();
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

  // macOS 点 Dock 图标回来时补一条唤起路径。
  // 窗口被 hide() 过之后系统不会自动再显示，而「点 Dock 没反应 / 窗口回来但不置顶」
  // 正是这条缺失路径的典型表现 —— 顺手也能把层级重新压一次。
  app.on('activate', () => {
    if (app.isReady()) showMainWindow();
  });

  app.whenReady().then(() => {
    if (IS_MAC) {
      app.setActivationPolicy('regular');
      void app.dock.show().catch(err => logStartupError('showDock', err));
    }
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
    refreshAppMenu();
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

// 任何来源的退出（本应用的菜单 / 快捷键、系统关机、异常兜底里的 app.quit()）
// 都要放行 win.on('close') 里的 hide 拦截，否则退出会被悄悄取消掉。
app.on('before-quit', () => { app.isQuiting = true; });

// 应用退出时释放热键、关掉常驻的 HTTP 服务
app.on('will-quit', () => {
  logQuit('will-quit：释放全局热键 / 关闭登录态桥接');
  globalShortcut.unregisterAll();
  try { if (bridgeServer) bridgeServer.close(); } catch { /* 忽略 */ }
});
app.on('quit', () => logQuit('quit：进程即将结束'));

// 平时点 X 只是 hide，不会走到这里。真走到这里说明窗口已经被销毁了，
// 这时候再留在后台就是个「没有界面、只剩热键」的僵尸进程，直接退出。
app.on('window-all-closed', () => {
  logQuit('window-all-closed：窗口已全部销毁');
  quitApp('window-all-closed');
});
