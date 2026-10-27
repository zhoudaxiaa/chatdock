# ChatDock

在桌面窗口或浏览器侧边栏中使用 **ChatGPT / Claude**。两个服务各自保留当前页面、登录态和草稿，顶部一键切换；不需要 API Key，使用网站本身的账号。

桌面端与浏览器侧边栏共用一个仓库、一套构建和测试入口。

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
- 「设置」后面的刷新按钮仅刷新当前服务，并保留当前页面地址；成功导入 Cookie 后，对应的已打开服务页面会自动刷新。
- macOS 默认以「辅助应用」形态运行：置顶能压住其他应用的全屏窗口，代价是没有 Dock 图标、⌘Tab 里也不出现（托盘图标与全局快捷键不受影响）。不想要可在「设置 → 窗口」关掉「连其他应用的全屏窗口也压住」，Dock 图标立刻回来，无需重启。
- 顶栏右侧 **☰** 菜单提供截图、置顶、设置、隐藏与退出；也可用托盘菜单，macOS 还可使用系统「服务」菜单切换。
- 默认 `Control+Space` 唤起 / 隐藏，`Control+Alt+A` 区域截图，`Control+Q` 退出，均可在设置中修改。
- 关闭窗口只会隐藏到托盘。截图可复制并粘贴到当前服务的输入框。
- 兼容旧版桌面数据：沿用 `com.zhoudaxiaa.chatgpt-electron` 应用 ID、`chatgpt-electron` 用户数据目录和 ChatGPT 默认会话；Claude 使用独立持久化会话。
- macOS 安装包未签名、公证（只有 ad-hoc 签名）。首次打开会被 Gatekeeper 拦下，任选一种方式放行：在「应用程序」里**右键 → 打开**；或到「系统设置 → 隐私与安全性」底部点「仍要打开」；或执行 `xattr -dr com.apple.quarantine /Applications/ChatDock.app`。Cloudflare、Google OAuth 等登录校验仍由网站决定，无法保证所有账号与网络条件都通过。

## 浏览器扩展

- 顶部居中排列两个标签，每个标签把服务名称和 ↗ 图标放在同一组：名称用于切换，图标独立打开该服务的新标签页。设置通过扩展右键菜单或扩展管理页进入。
- 在扩展设置的「服务地址」中分别配置 ChatGPT / Claude 的 HTTPS 地址（各自站点内路径与查询参数），保存后立即更新侧边栏及新开链接，无需重新打包；空值恢复默认地址。
- 切换 ChatGPT / Claude 时，已访问过的服务在当前侧边栏内保留页面，关闭整个侧边栏后浏览器会销毁页面，重新打开会加载上次选择的服务。
- 选中文字右键提问、自定义提示词、页面标题 / URL 提问、提示词回收站、自动发送开关内置。页面提问传递标题与 URL，**不会自动读取整页正文**。
- 每条提示词绑定发送时选中的服务。只有当前服务的扩展 iframe 能处理，普通网页标签页不能抢走提示词。通知以输入框实际写入后的确认结果为准。
- 登录受限时用标签右侧的 **↗ 图标** 在普通标签页登录，随后在侧边栏重新加载。iframe 登录可能受网站反嵌入、第三方 Cookie 或安全验证限制；保留普通标签页入口。
- 同步桌面登录态：手动同步与启动自动同步都会分别处理两个服务，不受当前标签影响。没有 Cookie 的服务安全跳过，不清除桌面端原有登录态；单个服务失败不阻止另一个同步。成功导入会自动刷新对应的已打开桌面页面。桌面端需要运行，监听 `127.0.0.1:32123`。Cookie 只发送给配置的桥接地址，默认本机回环地址；固定共享令牌沿用旧协议，不是抵御本机恶意程序的安全边界。
- 嵌入兼容规则仅针对两个服务和 OpenAI 的子框架响应，限定发起方为扩展或这些站点；不修改普通顶层页面响应。

### Claude 在 iframe 中的界面差异

2026-10-26 对照排查：相同登录态、相同 `https://claude.ai/new` 地址、895px 宽度下，普通页面有左侧导航，未启用兼容的 iframe 内没有导航组件；DOM 中也没有普通页面的 `aside[aria-label="Sidebar"]` 和 `.dframe-root`。这不是扩展 CSS 隐藏导航，也不是地址路径错误。

Claude 的客户端会区分顶层页面和 iframe（其[当前页面模块](https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/shared-l-p-m-0-jt4lVjGl.js)包含 `window.self !== window.top` 判断）。修改入口地址不能消除这个差异，但可以在客户端兼容该判断。

现在默认开启「Claude 完整导航兼容」：在页面脚本启动前，仅对 ChatDock 自己命名并由扩展直接承载的 Claude iframe，在页面 MAIN 世界调整 `self` 别名，使 Claude 自身业务脚本的判断得到顶层页面结果；其路由器、Cloudflare 验证等其他脚本仍拿到真实 window（顶层是跨域扩展页，访问其属性会抛 SecurityError 使页面空白）。该区分依赖脚本来源，网站打包结构变化后可能失效。真实 iframe、`top` / `parent`、浏览器同源策略、Cookie 权限和扩展隔离世界不变，普通 Claude 标签页及 ChatGPT 不处理。

兼容依赖网站当前实现，若更新后异常，可在扩展设置关闭「Claude 完整导航兼容」退回原始嵌入布局；切换会重新加载 Claude 页面。完整界面也可始终通过标签内的 ↗ 图标新开。

独立桥接插件已并入侧边栏，无需另装。解压扩展的 ID 可能随加载路径变化，新 ID 下不会带有其他 ID 的存储数据；提示词可用设置中的导出 / 导入按钮迁移，网站登录 Cookie 不受影响。


## 构建与发布

```sh
pnpm build:mac --arm64 --publish never
pnpm build:win --x64 --publish never
pnpm release:gh --dry-run
pnpm release:gh
```

桌面产物输出到 `dist/`。版本以根 `package.json` 为准，扩展 manifest 版本在构建时覆盖。

正式发布前更新 `package.json` 与 `RELEASE_NOTES.md` 并提交推送。发布提交 `chore: release v<版本>` 推到 main 时，工作流校验、创建 Release 并构建 Windows x64、macOS arm64 与扩展。也可使用 `pnpm release:gh`；如 main 推送已触发自动发布，不要再运行发布脚本创建同一版本。`workflow_dispatch` 只构建，不发布。

原项目文档保留在 `desktop/LEGACY_README.md` 与 `extension/LEGACY_README.md`，用于迁移参考；当前使用方式以本文件为准。

MIT。ChatDock 是第三方工具，与 OpenAI、Anthropic 无关联。
