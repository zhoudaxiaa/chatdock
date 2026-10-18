// 顶栏 preload：只暴露顶栏需要的几个动作
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('barApi', {
  // 顶栏要给系统窗口控制按钮（Windows 右侧）/ 红绿灯（macOS 左侧）留出位置
  platform: process.platform,
  getShortcuts: () => ipcRenderer.invoke('bar:get-shortcuts'),
  onShortcuts: (cb) => {
    ipcRenderer.on('bar:shortcuts', (_e, shortcuts) => cb(shortcuts));
  },
  openSettings: () => ipcRenderer.send('bar:open-settings'),
  screenshot: () => ipcRenderer.send('bar:screenshot')
});
