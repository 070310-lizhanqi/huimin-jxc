'use strict';
/**
 * 展惠进销存 —— preload（第一阶段最小 API）。
 * contextIsolation 开、nodeIntegration 关；只暴露最小接口，不暴露 fs、child_process、
 * 不暴露任何服务端内部接口。窗口控制、打开数据目录/日志、重启服务、退出应用。
 * 检查更新（app:check-updates）在第三阶段随 electron-updater 接入，这里不暴露。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zhanhui', {
  /** 应用版本号（取 package.json 的 version）。 */
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  /** 冒烟探针：验证 preload 正常注入。 */
  ping: () => 'pong',
  /** 窗口控制。 */
  windowMinimize: () => ipcRenderer.invoke('app:window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('app:window-maximize'),
  windowClose: () => ipcRenderer.invoke('app:window-close'),
  windowIsMaximized: () => ipcRenderer.invoke('app:window-is-maximized'),
  /** 打开数据目录（系统文件管理器）。 */
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  /** 在文件管理器里定位 server.log。 */
  openLogFile: () => ipcRenderer.invoke('app:open-log-file'),
  /** 重启服务子进程，返回新端口。 */
  restartServer: () => ipcRenderer.invoke('app:restart-server'),
  /** 退出应用（先停服务子进程）。 */
  quitApp: () => ipcRenderer.invoke('app:quit'),
});
