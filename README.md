# ChatGPT Desktop 🚀

ChatGPT 桌面壳（Electron 套壳）：**全局热键**、**系统托盘**、**登录态桥接**、**UA / Client-Hints 伪装**，并且内置 GitHub Actions，每次发版自动构建 **Windows x64（英特尔）** 与 **macOS Apple Silicon（M 芯片）** 安装包。

> 本项目是一个轻量的 Electron 包装层，把 ChatGPT 网页版装进原生桌面窗口，同时解决两个痛点：
> 1. 绕过浏览器对 ChatGPT 的 UA 限制（Google 登录 `disallowed_useragent` 拦截）。
> 2. 在桌面端复用浏览器里的 ChatGPT 登录态，无需重复扫码/输密码。

---

## ✨ 功能特性

| 功能 | 说明 |
| --- | --- |
| 🪟 桌面窗口 | 无边框体验，关闭按钮只是隐藏窗口，进程常驻后台 |
| ⌨️ 全局热键 | `Control + Space` 随时唤起 / 隐藏窗口 |
| 🖥️ 系统托盘 | 托盘图标左键切换窗口，右键菜单可退出 |
| 🍪 登录态桥接 | 本地 HTTP 服务（`127.0.0.1:32123`）接收浏览器扩展同步的 Cookies，一键继承浏览器里的 ChatGPT 登录态 |
| 🌐 UA 伪装 | 将 UA 伪装成 Chrome/130，配合 Client-Hints，规避 Google OAuth 的 `disallowed_useragent` 拦截 |
| 🔗 外链处理 | 会话内的外链自动用系统浏览器打开，不污染应用内历史 |
| 🧩 扩展加载 | 启动时自动加载 `extensions/` 目录下的 Chrome 扩展（如配套的 ChatGPT Session Bridge） |

---

## 📦 发布产物（GitHub Actions）

每次打 tag / 发 Release，工作流会自动构建并在 Release 页附带以下资源：

| 平台 | 架构 | 产物 |
| --- | --- | --- |
| Windows | x64（英特尔/AMD） | `.exe` NSIS 安装包、`.exe` 便携版、`.zip` |
| macOS | arm64（Apple Silicon / M 芯片） | `.dmg`、`.zip` |

> 想补一个 macOS 英特尔版？把 `build-release.yml` 里 mac job 的 `--arm64` 改成 `--x64` 或去掉即可（GitHub 的 `macos-13` runner 就是 x64）。

---

## 🚀 快速开始（开发环境）

```bash
# 1. 安装依赖
npm install

# 2. 启动开发模式
npm start
```

### 常用快捷键

| 按键 | 作用 |
| --- | --- |
| `Control + Space` | 全局唤起 / 隐藏窗口 |
| `Control + Q` | 退出应用 |

---

## 🍪 登录态桥接（可选）

应用内嵌一个本地桥接服务，配合 Chrome 扩展 **ChatGPT Session Bridge**（见 `browser-extension/`）使用：

1. 在 Chrome/Edge 中「加载已解压的扩展程序」，选择 `browser-extension/` 目录；
2. 先在浏览器里登录 ChatGPT；
3. 点击扩展图标（或自动触发），扩展会把当前域的 Cookies 同步到桌面应用；
4. 桌面应用收到 Cookies 后自动加载 `https://chatgpt.com`，即处于已登录状态。

**安全说明**

- 桥接服务只监听 `127.0.0.1:32123`，不对外网开放；
- 请求必须携带请求头 `x-bridge-token: dsh-chatgpt-bridge-2026`，否则返回 403；
- Cookies 仅写入 Electron 的会话存储，不会发送到任何第三方。

---

## 🔨 本地构建安装包

```bash
# Windows 安装包（NSIS + portable + zip）
npm run build:win

# macOS 安装包（dmg + zip）
npm run build:mac

# 全部
npm run release
```

产物输出到 `dist/` 目录。

---

## 🗂️ 项目结构

```
chatgpt-electron/
├── main.js               # Electron 主进程（窗口/托盘/热键/桥接/UA 伪装）
├── preload.js            # 预加载脚本（外链拦截、会话识别）
├── package.json          # 依赖与 electron-builder 构建配置
├── icon.png              # 应用图标（托盘 + 窗口 + 安装包）
├── extensions/           # 启动时自动加载的扩展目录（.gitkeep 占位）
├── browser-extension/    # 配套 Chrome 扩展「ChatGPT Session Bridge」源码
└── .github/workflows/    # GitHub Actions（自动构建发布产物）
```

---

## ⚙️ GitHub Actions 工作流

`.github/workflows/build-release.yml` 的工作流：

- **触发时机**：`push` 打 `v*` tag、Release `published`、手动 `workflow_dispatch`；
- **Windows job**：`windows-latest`（x64）→ 构建 NSIS + portable + zip；
- **macOS job**：`macos-latest`（Apple Silicon / arm64）→ 构建 dmg + zip；
- 构建成功后自动把产物上传到对应的 GitHub Release 页面。

---

## 📄 License

[MIT](./LICENSE)
