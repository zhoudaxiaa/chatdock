# Release Notes

## v1.0.0

首个正式版本。ChatGPT 桌面壳（Electron 套壳）。

### ✨ 功能

- **全局热键**：`Control + Space` 随时唤起 / 隐藏窗口
- **系统托盘**：常驻托盘，左键切换窗口，右键菜单退出
- **登录态桥接**：配合 Chrome 扩展「ChatGPT Session Bridge」一键继承浏览器里的 ChatGPT 登录态（本地 `127.0.0.1:32123` 服务，带 Token 鉴权）
- **UA / Client-Hints 伪装**：绕过 Google OAuth 的 `disallowed_useragent` 拦截
- **外链处理**：会话内链接自动用系统浏览器打开
- **自动加载扩展**：`extensions/` 目录下的扩展随应用启动加载

### 📦 安装包（本次发布）

| 平台 | 架构 | 文件 |
| --- | --- | --- |
| Windows | x64（英特尔/AMD） | `ChatGPT Desktop Setup *.exe`（NSIS 安装版）、`ChatGPT Desktop *.exe`（便携版）、`*.zip` |
| macOS | arm64（Apple Silicon / M 芯片） | `*.dmg`（安装镜像）、`*.zip` |

> macOS 安装包未签名，首次打开请在「系统设置 → 隐私与安全性」中允许来自不明开发者，或右键 → 打开。

### 🚀 快速上手

1. 下载对应平台的安装包并安装；
2. （可选）安装 Chrome 扩展 `browser-extension/`，同步浏览器登录态；
3. 启动后按 `Control + Space` 唤起窗口。