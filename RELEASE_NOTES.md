## v1.3.1

修复侧边栏中 Claude 页面空白、一直显示"尚未就绪"的问题，并整理侧边栏与桌面端体验。

- Claude 兼容层此前把 `self` 整体指向跨域的顶层页，Claude 路由器写入 `self.__TSR_ROUTER__` 时抛 SecurityError。现在只对 Claude 业务脚本启用别名，路由器和 Cloudflare 验证拿到真实 window。
- 侧边栏顶部：服务切换居中，图标与名称合为一个标签，新标签打开用右侧图标。
- 服务地址可在设置中配置，无需重新打包。
- 同步登录态时同时处理两个服务，没有 Cookie 的服务安全跳过；同步后桌面端自动刷新，并新增手动刷新按钮（刷新当前标签）。
- 修复 macOS 桌面端 Dock 中不显示运行状态的问题。
- README 不再引用原侧边栏项目。

### 验证

- 在真实加载的扩展中复现并确认原 SecurityError 消失；16 项扩展测试通过。
- Claude 完整导航需登录态，未能在干净浏览器中端到端验证；若异常可在设置关闭"Claude 完整导航兼容"。
- Windows 安装包运行、扩展内真实登录与发送尚未实机验收。macOS 安装包未签名。

## v1.3.0

ChatDock：合并桌面端与浏览器侧边栏，支持 ChatGPT / Claude。

- 产品和现有 GitHub 仓库统一改名为 ChatDock，保留历史与 Release。
- 单个根 package.json 与 pnpm 锁文件，统一构建和测试入口。
- 桌面与侧边栏顶部切换服务，各自保留页面；桌面截图、置顶收进功能菜单，快捷键保留。
- Claude 输入框、外链及按服务隔离的提示词投递和登录态桥接。
- 桌面沿用旧用户数据目录与应用 ID，ChatGPT 会话不迁移；Claude 使用独立会话。
- 扩展更换加载目录可能产生新 ID，旧版提示词需按 README 的迁移步骤导出，再在新扩展设置中导入。
- 统一版本从 1.3.0 起，兼容原侧边栏 1.2.1 的版本顺序。

### 验证

- JavaScript 语法、扩展文件引用和版本一致性检查通过；109 项本地测试通过。
- 真实 Electron 验证服务切换、页面保留、设置窗口及顶栏渲染；macOS arm64 应用目录打包、包内截图原生模块加载检查通过。
- 在真实 Claude 页面验证编辑管线写入并清空测试草稿，未发送消息。
- 扩展内真实登录与发送、Windows 安装包运行、macOS 全屏置顶效果尚未实机验收。网站 iframe、Cookie 与安全验证限制仍可能影响使用。

macOS 安装包未签名。

<details>
<summary>桌面端历史发布说明</summary>

## v1.0.3

修复 macOS 开启置顶后，窗口无法悬浮在其他应用全屏空间之上的问题。

### 修复

- 主窗口和设置窗口在开启置顶时同步启用全屏空间可见性，关闭置顶时同步取消。
- 恢复 Electron 默认的进程类型转换；按窗口缓存工作区状态，避免反复唤起时重复转换。
- 窗口首次创建时先完成工作区配置再显示，转换完成后重新设置置顶层级。
- 设置保存失败时同步恢复窗口置顶策略。

### 发布与验证

- 版本号与锁文件统一为 1.0.3。
- GitHub Actions 支持由 `chore: release v…` 发布提交创建 Release，并上传 Windows x64、macOS arm64 安装包和浏览器扩展。
- 已通过 JavaScript 语法检查、差异检查和 16 项不加载 Electron 的模拟检查；未在本机安装依赖或启动项目，macOS 全屏效果尚未实机验证。

> macOS 安装包未签名；已安装旧版可覆盖安装，登录态与设置不受影响。

<details>
<summary>v1.0.2 更新日志</summary>

## v1.0.2

安装包终于用上自己的图标了，另外修掉了几处发版流程上的隐患。

### 🐞 修复

- **安装包图标一直是 Electron 默认 logo**：打包配置里 Windows / macOS 的图标都指向 `build/icon.png`，但这个文件从来没有进过版本库（`.gitignore` 也没排除它，纯粹是没生成过）。CI checkout 后目录里没有它，electron-builder 只会告警并回退到 Electron 默认图标——所以 1.0.0 / 1.0.1 的 `.exe`、`.dmg` 安装后在系统里显示的都是 Electron 的蓝绿 logo。现在改为直接引用仓库里已有的 `icon.png`（512×512，满足 macOS icns ≥ 512、Windows ico ≥ 256 的要求）。

### 🛠 发版流程

- `scripts/publish.mjs` 重写：`npm run release:gh` 一条命令完成「打 tag → 推 tag → 建 Release → 等 CI 出包」。版本号只认 `package.json`，tag 由脚本派生（原先写死在脚本里）；发布前会校验分支、工作区、与远端是否同步、发布说明标题的版本号是否一致、同名 tag / Release 是否存在，任一条不满足直接停下。
- 不再 `git add -A`、不强推 tag，推送失败会回收本地 tag；Release 通过 REST API 创建，本机不需要装 `gh`。
- 支持 `--dry-run`（只预览）/ `--draft`（草稿，不触发构建）/ `--no-wait`；默认等待 CI 完成并列出产物，失败时直接给出日志链接。
- 本机代理不放行 `github.com:443`（CONNECT 返回 502）时，自动去掉代理环境变量改直连重试。

### 📦 资源包

| 类型 | 平台 | 架构 | 文件 |
| --- | --- | --- | --- |
| 桌面应用 | Windows | x64 | `ChatGPT Desktop Setup 1.0.2.exe`（NSIS 安装版）、`ChatGPT Desktop 1.0.2.exe`（便携版）、`*.zip` |
| 桌面应用 | macOS | arm64 | `*.dmg`、`*.zip` |
| 浏览器扩展 | Chrome / Edge | 通用 | `chatgpt-session-bridge-v*.zip` |

> 已安装 1.0.1 的，直接覆盖安装 1.0.2 即可修正图标，登录态与设置不受影响。
>
> 登录态与设置保存在 `%APPDATA%\chatgpt-electron`，覆盖安装不会被清除。
>
> 默认截图键 `Control + Alt + A` 与微信、QQ 的默认截图键相同，同时运行时先启动的一方生效，可在「设置」中改键。
>
> macOS 安装包未签名，首次打开请在「系统设置 → 隐私与安全性」中允许来自不明开发者，或右键 → 打开。

<details>
<summary>v1.0.1 更新日志</summary>

### v1.0.1

两个 macOS 相关的修复：菜单栏图标改为专用的单色 template 图，窗口置顶不再偶发失效。

### 🐞 修复

- **macOS 菜单栏图标过大**：之前直接把 512×512 的彩色应用图标（绿底 + 白色 AI）交给托盘，被整块塞进 22pt 高的菜单栏，视觉上又大又糊，深色菜单栏下更突兀。现在菜单栏使用独立绘制的单色 template 图（圆角对话气泡 + 左下尾巴 + 内嵌四角星），16pt 画布、四周留 1px 安全边距、100% 纯黑 + alpha 通道，系统会自动染色（浅色模式黑、深色模式白、点选时反色）。随包提供 16 / 32 / 48 三档倍图，Retina 屏使用 @2x。三档图标由 `scripts/make-tray-icon.mjs` 生成（零依赖，手写 PNG 编码 + 有向距离场抗锯齿），可用 `npm run icons:tray` 重新生成并通过预览图校验。Windows / Linux 行为不变，图标缺失时自动回退到彩色图标缩至 16×16。

- **macOS 上置顶偶发失效**：表现是置顶开关明明开着，窗口却被别的应用压住，手动关一下再开又好了。根因是上一版为了「浮在全屏应用之上」传了 `visibleOnFullScreen: true`，而 Electron 的 `setVisibleOnAllWorkspaces` 在这个选项下会做一次进程类型转换，**每次调用都会把窗口和 Dock 短暂隐藏**；唤起流程刚好在 `show()` 之后调用它，紧接着的 `moveTop()` 就落在「窗口正被隐藏」的中间态上，AppKit 收尾重排后窗口又回到后面（此时层级仍是 floating，所以看起来像置顶没生效）。现在把两件事拆开：
  - 窗口层级（`setAlwaysOnTop`）在每次 `show()` 后廉价地重新压一次；
  - 跨桌面可见（`setVisibleOnAllWorkspaces`）只在置顶开关真正变化或启动时设置一次，并传 `skipTransformProcessType: true` 跳过进程类型转换。

  代价是不再压在别人的全屏应用之上——那项能力本身就要求把进程降级成 accessory，会让 Dock 图标消失、窗口抢不到键盘焦点，而它正是这次不稳定的来源。同时补齐了四条此前会漏掉置顶的唤起路径（`show` / `restore` / `leave-full-screen` / 点 Dock），以及「截图临时取消置顶后没有还原」的漏洞。Windows 行为不变。

### 📦 资源包

| 类型 | 平台 | 架构 | 文件 |
| --- | --- | --- | --- |
| 桌面应用 | Windows | x64 | `ChatGPT Desktop Setup 1.0.1.exe`（NSIS 安装版）、`ChatGPT Desktop 1.0.1.exe`（便携版）、`*.zip` |
| 桌面应用 | macOS | arm64 | `*.dmg`、`*.zip` |
| 浏览器扩展 | Chrome / Edge | 通用 | `chatgpt-session-bridge-v*.zip` |

> 登录态与设置保存在 `%APPDATA%\chatgpt-electron`，覆盖安装不会被清除。
>
> 默认截图键 `Control + Alt + A` 与微信、QQ 的默认截图键相同，同时运行时先启动的一方生效，可在「设置」中改键。
>
> macOS 安装包未签名，首次打开请在「系统设置 → 隐私与安全性」中允许来自不明开发者，或右键 → 打开。

<details>
<summary>v1.0.0 更新日志</summary>

ChatGPT 桌面壳首个正式版：全局热键唤起、窗口置顶、区域截图、可视化快捷键设置、浏览器登录态同步。

### ✨ 功能

- **全局热键唤起**：默认 `Control + Space`，在任何应用中唤起 / 隐藏窗口。关闭按钮只是把窗口隐藏到托盘，进程常驻，热键始终可用。
- **窗口置顶**：唤起时窗口浮在其他应用上层，不会被当前应用盖住。置顶状态可在顶栏「置顶」按钮、托盘右键菜单、设置页三处切换，选择会持久化。截图时若不隐藏窗口，会临时取消置顶，避免挡住截图层。
- **区域截图**：默认 `Control + Alt + A` 全局唤起，支持多显示器框选，以及矩形 / 椭圆 / 箭头 / 画笔 / 文字 / 马赛克标注。确认后写入剪贴板；可自动唤起窗口并粘贴进 ChatGPT 输入框，截图时默认先隐藏本应用窗口。基于开源项目 [electron-screenshots](https://github.com/nashaofu/screenshots)（MIT）。
- **快捷键设置**：窗口顶部「设置」入口，可修改全部功能快捷键（唤起窗口 / 区域截图 / 退出），支持单项与全部恢复默认。录入时拦截重复绑定、缺少修饰键，以及被其他程序占用的组合，并给出明确提示。
- **配置持久化**：设置保存在 `%APPDATA%\chatgpt-electron\settings.json`；配置文件损坏或快捷键冲突时自动回退默认值，不影响启动。
- **登录态桥接**：本地 HTTP 服务（`127.0.0.1:32123`）接收浏览器扩展同步的 Cookies，一键继承浏览器登录态。
- **UA / Client-Hints 伪装**：UA 伪装为 Chrome 130，并通过 CDP 覆盖 `Sec-CH-UA`，规避 Google OAuth 的 `disallowed_useragent` 拦截。
- **外链处理**：会话内链接交给系统默认浏览器打开，不污染应用内历史（兼容 `<a>` 与 `window.open`）。
- **扩展加载**：启动时自动加载 `extensions/` 目录下的 Chrome 扩展。
- **系统托盘**：左键切换窗口显示，右键菜单含截图、窗口置顶、设置与退出。

### 🎨 界面

- **工具栏并入标题栏**：去掉系统标题栏，顶部工具栏兼任标题栏，省出一行高度。左侧依次为 `ChatGPT` 标题、设置、截图（含当前快捷键提示）、置顶，中间空白区域可拖动窗口、双击最大化，右侧为自绘的最小化 / 最大化 / 关闭按钮（Windows）。顶栏空白处右键还有「设置 / 截图 / 窗口置顶 / 隐藏窗口 / 退出应用」菜单。
- 工具栏与窗口控制按钮跟随系统深浅色自动切换配色。

### 🐞 修复与加固

- **唤起后被其他窗口盖住**：此前窗口从未设置过置顶，Windows 的前台锁会让 `show()` 出来的窗口只闪一下任务栏。现在唤起时先 `show()` 显示、再 `setAlwaysOnTop` 压层级，并用 `moveTop()` 兜底。
- **页面顶部一块区域点不了**：`titleBarOverlay` 会让 Windows 把窗口顶部当作标题栏（caption），该区域鼠标事件被窗口层吞掉。现改为隐藏标题栏 + 自绘窗口按钮，鼠标事件全部落到页面里。
- **登录后左上角一块区域点不了**：chatgpt.com 登录后的界面会给自己的顶部栏加 `-webkit-app-region: drag`，在 Electron 里会把那块区域变成窗口标题栏。现在启动时向页面注入 `*{-webkit-app-region:no-drag !important}`，并在页面加载完成 / SPA 路由切换后重新压一遍。
- **工具栏左侧点不了**：拖动区曾设在整条工具栏上，标题与左侧留白一并变成窗口非客户区。现在只有中间空白是拖动区。
- **安装版启动即静默失败**：`extensions/` 目录里的 `.gitkeep` 是点文件，打包时匹配不到，整个空目录没有进入 `app.asar`，启动时 `fs.readdirSync` 抛 `ENOENT` 中断了 `whenReady`。现在目录缺失只记日志并跳过，扩展加载 / 桥接服务 / 托盘 / 热键注册各自独立兜底，异常统一写入 `%APPDATA%\chatgpt-electron\startup-error.log`。
- **退出入口与退出流程**：顶栏右键、设置页、`Control + Q`、托盘菜单均可退出；`app.quit()` 推迟到当前回调之外执行，避免在输入 / 菜单消息循环里同步销毁窗口造成主线程卡死。新增进程内 6 秒、进程外 9 秒两级兜底，退出耗时约 1.7 秒，退出过程写入 `%APPDATA%\chatgpt-electron\quit.log`。
- **某个热键被占用会拖累全部设置**：现在只有「本次修改过的键」注册失败才拒绝保存并回滚，未修改的键仅给出警告。

</details>

</details>

</details>

</details>
