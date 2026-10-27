// 依赖补丁：electron-screenshots 的 preload 用了 Buffer。
//
// Electron 44 起，sandboxed preload 不再提供 Node 的 Buffer 全局，
// 而这个库的 preload 里是 `ipcRenderer.send('SCREENSHOTS:ok', Buffer.from(arrayBuffer), data)`。
// 结果是点「确定」时渲染进程抛 ReferenceError，IPC 根本发不出去 ——
// 主进程收不到 ok，截图层不关闭也不写剪贴板，看起来就像「点确认又回到了初始截图状态」。
//
// 库的最新版（0.6.2）就是这个写法，上游没修，所以在这里换成 Uint8Array：
// 主进程侧 desktop/main.js 的 writeImageToClipboard() 已经会把 Uint8Array 转回 Buffer。
//
// 用 postinstall 而不是 pnpm 的 patchedDependencies，是因为 npm / pnpm / yarn 都会跑
// 根包的 postinstall，换包管理器不用改配置。脚本是幂等的，重复跑不会出问题。
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TARGET = 'Buffer.from(arrayBuffer)';
const REPLACEMENT = 'new Uint8Array(arrayBuffer)';

let file;
try {
  file = require.resolve('electron-screenshots/lib/preload.js');
} catch {
  console.log('[patch-deps] 未安装 electron-screenshots，跳过');
  process.exit(0);
}

let src;
try {
  src = fs.readFileSync(file, 'utf8');
} catch (err) {
  console.warn('[patch-deps] 读取 electron-screenshots preload 失败：' + err.message);
  process.exit(0);
}

if (!src.includes(TARGET)) {
  console.log('[patch-deps] electron-screenshots 已是修补后的状态');
  process.exit(0);
}

const count = src.split(TARGET).length - 1;
fs.writeFileSync(file, src.split(TARGET).join(REPLACEMENT));
console.log(`[patch-deps] 已修补 electron-screenshots/lib/preload.js（${count} 处）`);
