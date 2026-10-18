// 顶栏 preload：只暴露顶栏需要的几个动作
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('barApi', {
  // 顶栏要给 macOS 红绿灯留出位置（Windows 的窗口按钮由我们自己画）
  platform: process.platform,
  getShortcuts: () => ipcRenderer.invoke('bar:get-shortcuts'),
  onShortcuts: (cb) => {
    ipcRenderer.on('bar:shortcuts', (_e, shortcuts) => cb(shortcuts));
  },
  openSettings: () => ipcRenderer.send('bar:open-settings'),
  screenshot: () => ipcRenderer.send('bar:screenshot'),
  windowAction: (action) => ipcRenderer.send('bar:window-action', action),
  contextMenu: () => ipcRenderer.send('bar:context-menu'),
  quit: () => ipcRenderer.send('bar:quit'),
  onMaximized: (cb) => {
    ipcRenderer.on('bar:maximized', (_e, maximized) => cb(maximized));
  }
});
