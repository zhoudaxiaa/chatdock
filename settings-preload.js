// 设置窗口 preload：只暴露读取 / 保存 / 关闭三个动作
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  load: () => ipcRenderer.invoke('settings:get'),
  save: (settings) => ipcRenderer.invoke('settings:save', settings),
  close: () => ipcRenderer.send('settings:close')
});
