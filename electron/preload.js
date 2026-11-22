'use strict';
/**
 * 展惠进销存 —— preload（P0 最小 API）。
 * contextIsolation 开、nodeIntegration 关；只暴露最小接口，不暴露 fs、child_process、
 * 不暴露任何服务端内部接口。窗口控制、打开数据目录等 API 在第二阶段补全。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zhanhui', {
  /** 应用版本号（取 package.json 的 version）。 */
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  /** 冒烟探针：验证 preload 正常注入。 */
  ping: () => 'pong',
});
