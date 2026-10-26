# ChatDock

在桌面窗口或浏览器侧边栏中使用 **ChatGPT / Claude**。两个服务各自保留当前页面、登录态和草稿，顶部一键切换；不需要 API Key，使用网站本身的账号。

由桌面端 chatgpt-electron 与 [simple-chatgpt-sidebar](https://github.com/zhoudaxiaa/simple-chatgpt-sidebar) 合并，沿用当前仓库与发布历史。产品与仓库统一改名为 [ChatDock](https://github.com/zhoudaxiaa/chatdock)，保留原仓库的提交、标签与 Release；GitHub 会将旧地址重定向到新地址。

## 开发

要求 Node.js 22+、pnpm 10.11.0、Python 3（扩展 ZIP 打包与静态校验使用标准库）。一个根 package.json、一份 pnpm-lock.yaml，无 workspace 子包。

```sh
corepack enable
corepack prepare pnpm@10.11.0 --activate
pnpm install --frozen-lockfile
pnpm start
pnpm build:extension
pnpm check
pnpm test
pnpm test:desktop  # 真实 Electron 窗口冒烟，使用临时用户目录
```

扩展从 `dist/extension` 加载：Chrome / Edge → 扩展管理 → 开启开发者模式 → 加载已解压扩展。可分发 ZIP 为 `dist/chatdock-extension-v<版本>.zip`。源码目录需要构建后再加载，共享服务定义由构建脚本复制进扩展。

```text
package.json / pnpm-lock.yaml   统一依赖、命令、版本
shared/providers.js             两端共享服务 URL、域名和输入框适配
desktop/                      Electron 主进程、预加载、顶栏、设置与图标
extension/                     浏览器侧边栏、提示词、登录态桥接
scripts/                       构建、检查、发布脚本
tests/                         提示词、投递隔离、会话桥接、桌面切换检查
dist/extension/                可直接加载的扩展产物（生成）
```

## 桌面端

- 顶栏直接选择 ChatGPT / Claude，切换时保留两个页面；第二个服务按需加载。
- 顶栏右侧 **☰** 菜单提供截图、置顶、设置、隐藏与退出；也可用托盘菜单，macOS 还可使用系统「服务」菜单切换。
- 默认 `Control+Space` 唤起 / 隐藏，`Control+Alt+A` 区域截图，`Control+Q` 退出，均可在设置中修改。
- 关闭窗口只会隐藏到托盘。截图可复制并粘贴到当前服务的输入框。
- 兼容旧版桌面数据：沿用 `com.zhoudaxiaa.chatgpt-electron` 应用 ID、`chatgpt-electron` 用户数据目录和 ChatGPT 默认会话；Claude 使用独立持久化会话。
- macOS 安装包未签名、公证；Cloudflare、Google OAuth 等登录校验仍由网站决定，无法保证所有账号与网络条件都通过。

## 浏览器扩展

- 顶部切换 ChatGPT / Claude；已访问过的服务在当前侧边栏内保留页面，关闭整个侧边栏后浏览器会销毁页面，重新打开会加载上次选择的服务。
- 选中文字右键提问、自定义提示词、页面标题 / URL 提问、提示词回收站、自动发送开关沿用原侧边栏功能。页面提问传递标题与 URL，**不会自动读取整页正文**。
- 每条提示词绑定发送时选中的服务。只有当前服务的扩展 iframe 能处理，普通网页标签页不能抢走提示词。通知以输入框实际写入后的确认结果为准。
- 登录受限时用顶部 **↗** 在普通标签页登录，随后在侧边栏重新加载。iframe 登录可能受网站反嵌入、第三方 Cookie 或安全验证限制；保留普通标签页入口。
- 同步桌面登录态：在扩展设置中点击同步（针对侧边栏当前服务）；启动自动同步开启时分别同步两个服务。桌面端需要运行，监听 `127.0.0.1:32123`。Cookie 只发送给配置的桥接地址，默认本机回环地址；固定共享令牌沿用旧协议，不是抵御本机恶意程序的安全边界。
- 嵌入兼容规则仅针对两个服务和 OpenAI 的子框架响应，限定发起方为扩展或这些站点；不修改普通顶层页面响应。

扩展迁移注意：解压扩展的 ID 可能随加载路径变化。保留原扩展；旧提示词可在旧扩展的 service worker 控制台导出为 JSON，再在新扩展设置中导入（详细步骤见下文）；新安装不会自动获得另一个扩展 ID 下的 storage 数据，浏览器网站本身的登录 Cookie 不受此影响。独立桥接插件已并入侧边栏，无需再装两份。

### 从旧侧边栏导入提示词

旧版没有导出按钮。先在扩展管理页打开旧扩展的 service worker 控制台，执行：

```js
chrome.storage.sync.get(['pagePrompts', 'selectionPrompts', 'autoSubmit']).then(data => copy(JSON.stringify(data, null, 2)))
```

把剪贴板内容保存为 JSON 文件，在 ChatDock 扩展设置点击「导入提示词」。导入只覆盖同 ID 项，保留其余现有提示词，不包含 Cookie 或桥接令牌。新扩展提供导出按钮用于后续备份。

## 构建与发布

```sh
pnpm build:mac --arm64 --publish never
pnpm build:win --x64 --publish never
pnpm release:gh --dry-run
pnpm release:gh
```

桌面产物输出到 `dist/`。版本以根 `package.json` 为准，扩展 manifest 版本在构建时覆盖。统一版本从 **1.3.0** 起，避免低于原侧边栏的 1.2.1。

正式发布前更新 `package.json` 与 `RELEASE_NOTES.md` 并提交推送。发布提交 `chore: release v<版本>` 推到 main 时，工作流校验、创建 Release 并构建 Windows x64、macOS arm64 与扩展。也可使用 `pnpm release:gh`；如 main 推送已触发自动发布，不要再运行发布脚本创建同一版本。`workflow_dispatch` 只构建，不发布。

原项目文档保留在 `desktop/LEGACY_README.md` 与 `extension/LEGACY_README.md`，用于迁移参考；当前使用方式以本文件为准。

MIT。ChatDock 是第三方工具，与 OpenAI、Anthropic 无关联。
