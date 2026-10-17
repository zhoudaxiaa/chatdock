# ChatGPT Desktop 🚀

把 ChatGPT 网页版装进原生桌面窗口的轻量 Electron 壳 —— 全局热键、系统托盘、浏览器登录态一键桥接、UA / Client-Hints 伪装，并内置 GitHub Actions 自动构建 Windows 与 macOS 安装包。

[![Release](https://img.shields.io/github/v/release/zhoudaxiaa/chatgpt-electron?color=10a37f&label=release)](https://github.com/zhoudaxiaa/chatgpt-electron/releases/latest)
[![Build & Release](https://img.shields.io/github/actions/workflow/status/zhoudaxiaa/chatgpt-electron/build-release.yml?label=build)](https://github.com/zhoudaxiaa/chatgpt-electron/actions/workflows/build-release.yml)
[![License](https://img.shields.io/github/license/zhoudaxiaa/chatgpt-electron?color=blue)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey)](#-下载安装)

> 一个很薄的包装层，只解决网页版在桌面上最难受的两件事：
> 1. **Google 登录被拦**（`disallowed_useragent`）—— 通过 UA + Client-Hints 伪装绕过；
> 2. **每次都要重新登录** —— 用配套浏览器扩展把浏览器里的 ChatGPT 登录态同步进桌面应用。

---

## ⬇️ 下载安装

前往 [**Releases**](https://github.com/zhoudaxiaa/chatgpt-electron/releases/latest) 下载对应平台的安装包：

| 平台 | 架构 | 推荐文件 | 说明 |
| --- | --- | --- | --- |
| Windows | x64（Intel / AMD） | `ChatGPT Desktop Setup x.y.z.exe` | NSIS 安装版，可选安装目录、创建桌面快捷方式 |
| Windows | x64 | `ChatGPT Desktop x.y.z.exe` | 便携版，免安装，双击即用 |
| Windows | x64 | `*.zip` | 免安装压缩包 |
| macOS | arm64（Apple Silicon / M 系列） | `*.dmg` | 拖入「应用程序」即可 |
| macOS | arm64 | `*.zip` | 解压后运行 `.app` |
| 浏览器扩展 | Chrome / Edge | `chatgpt-session-bridge-v*.zip` | 登录态桥接插件包（可选，见下文） |

> **macOS 未签名提示**：安装包未做 Apple 公证，首次打开若提示「无法验证开发者」，请右键 → 打开，或到「系统设置 → 隐私与安全性」中点击「仍要打开」。

---

## ✨ 功能特性

| 功能 | 说明 |
| --- | --- |
| 🪟 原生窗口 | 干净的桌面窗口，关闭按钮只隐藏窗口，进程常驻后台 |
| ⌨️ 全局热键 | `Control + Space` 在任何应用中唤起 / 隐藏窗口 |
| 🖥️ 系统托盘 | 托盘图标左键切换窗口显示，右键菜单退出应用 |
| 🍪 登录态桥接 | 本地 HTTP 服务（`127.0.0.1:32123`）接收浏览器扩展同步的 Cookies，一键继承浏览器登录态 |
| 🌐 UA / Client-Hints 伪装 | UA 伪装为 Chrome 130，并通过 CDP 覆盖 `Sec-CH-UA`，规避 Google OAuth 的 `disallowed_useragent` 拦截 |
| 🔗 外链处理 | 会话内链接自动交给系统浏览器打开，不污染应用内历史（兼容 `<a>` 与 `window.open` 两种打开方式） |
| 🧩 扩展加载 | 启动时自动加载 `extensions/` 目录下的 Chrome 扩展 |
| 🤖 自动发版 | 打 tag / 发 Release 即触发 GitHub Actions，构建并回传安装包与插件包 |

---

## 🚀 快速上手

### 方式一：直接用安装包（普通用户）

1. 从 [Releases](https://github.com/zhoudaxiaa/chatgpt-electron/releases/latest) 下载并安装对应平台的包；
2. 启动应用，首次会打开 `https://chatgpt.com`，可直接在窗口内登录；
3. （推荐）安装配套浏览器扩展，省去重复登录 —— 见下一节；
4. 之后随时按 `Control + Space` 唤起窗口。

### 方式二：从源码运行（开发者）

```bash
git clone https://github.com/zhoudaxiaa/chatgpt-electron.git
cd chatgpt-electron
npm install
npm start
```

#### 常用快捷键

| 按键 | 作用 |
| --- | --- |
| `Control + Space` | 全局唤起 / 隐藏窗口 |
| `Control + Q` | 退出应用 |

---

## 🍪 登录态桥接（可选但强烈推荐）

配套 Chrome 扩展 **ChatGPT Session Bridge** 会把浏览器中已登录的 ChatGPT Cookies 推送到桌面应用，实现「浏览器登过一次，桌面端免登录」。

**安装扩展**

1. 下载 Release 中的 `chatgpt-session-bridge-v*.zip` 并解压；
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启右上角「开发者模式」；
3. 点击「加载已解压的扩展程序」，选择解压后的目录；
4. 也可以直接从仓库源码加载：选择 `browser-extension/` 目录。

**使用流程**

1. 先在浏览器里登录 ChatGPT；
2. 保持桌面应用处于运行状态；
3. 点击扩展图标手动同步（扩展/浏览器启动时也会自动同步一次）；
4. 桌面应用收到 Cookies 后自动加载 `https://chatgpt.com`，此时已是登录状态。

**安全说明**

- 桥接服务仅监听 `127.0.0.1:32123`，不对公网开放；
- 请求必须携带请求头 `x-bridge-token: dsh-chatgpt-bridge-2026`，否则返回 `403`；
- Cookies 只写入 Electron 自己的会话存储，不会上传到任何第三方服务器。

---

## 🔨 本地构建安装包

```bash
# Windows：NSIS 安装版 + 便携版 + zip
npm run build:win

# macOS：dmg + zip
npm run build:mac

# 两个平台一起打（需在对应系统上分别执行）
npm run release
```

产物输出到 `dist/` 目录。macOS 构建默认未签名，如需签名请自行配置 `CSC_LINK` / `CSC_KEY_PASSWORD`。

---

## 🤖 GitHub Actions 自动发版

工作流：[`.github/workflows/build-release.yml`](./.github/workflows/build-release.yml)

| 触发方式 | 说明 |
| --- | --- |
| `release: published` | **推荐**：在 Releases 页面发布版本后自动构建，并把产物回传该 Release |
| `workflow_dispatch` | 手动触发，产物只上传到 Actions Artifacts（不写 Release），适合先验证构建 |

> 只打 tag 不会触发构建 —— 请在 Releases 页面基于该 tag 发布 Release。

**构建矩阵**

- `windows-latest` → x64：NSIS `.exe`、便携版 `.exe`、`.zip`
- `macos-latest` → arm64：`.dmg`、`.zip`
- `ubuntu-latest` → 浏览器扩展插件包 `chatgpt-session-bridge-v*.zip`

构建完成后，所有产物会自动挂到对应 Release 页面，用户可直接下载。

> 想补一个 macOS Intel 版？把 `build-release.yml` 中 mac 矩阵项的 `--arm64` 改成 `--x64`（或使用 `macos-13` runner）即可。

---

## 🗂️ 项目结构

```
chatgpt-electron/
├── main.js                  # 主进程：窗口 / 托盘 / 全局热键 / 桥接服务 / UA 伪装
├── preload.js               # 预加载脚本：外链意图标记、会话识别
├── package.json             # 依赖与 electron-builder 打包配置
├── icon.png                 # 应用与托盘图标
├── browser-extension/       # 配套 Chrome 扩展「ChatGPT Session Bridge」
│   ├── manifest.json        # MV3 清单
│   └── background.js        # 读取 Cookie 并 POST 到本机桥接端口
├── extensions/              # 启动时自动加载的扩展目录（.gitkeep 占位）
├── scripts/                 # 发布 / 调试辅助脚本
├── .github/workflows/       # GitHub Actions：构建 + 发版 + 插件打包
├── README.md
├── RELEASE_NOTES.md
└── LICENSE
```

---

## ❓ 常见问题

**Q：窗口里登录 Google 账号还是失败？**
A：确认应用是通过安装包启动的（而不是 `file://` 打开页面）；UA 伪装依赖 `app.userAgentFallback` 与 CDP 覆盖，二者都只在主进程生效。

**Q：扩展点了没反应？**
A：确认桌面应用正在运行（桥接服务随应用启动），并且 `127.0.0.1:32123` 未被占用。端口被占用时桥接服务会启动失败，可在日志中确认。

**Q：热键 `Control + Space` 与输入法冲突？**
A：`Control + Space` 常被输入法切换占用，可在 `main.js` 中修改 `HOT_KEY` 常量后重新构建。

**Q：为什么 macOS 只有 M 芯片版？**
A：CI 默认只构建 arm64 以节省构建时间；需要 Intel 版可自行改矩阵参数，或本地执行 `npm run build:mac -- --x64`。

**Q：这是 OpenAI 官方客户端吗？**
A：不是。本项目与 OpenAI 无任何关联，只是一个第三方网页封装层，请遵守 ChatGPT 的服务条款。

---

## 📄 License

[MIT](./LICENSE) © zhoudaxiaa
