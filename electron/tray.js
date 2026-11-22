'use strict';
/**
 * 展惠进销存 —— 托盘图标 + 右键菜单（第二阶段）。
 *
 * 菜单（中文，对不懂电脑的用户也要一眼能懂）：
 *   打开主窗口 / 重启服务 / 打开数据目录 / 打开日志文件 / 打开开发者工具 / 退出。
 * “检查更新”是第三阶段的事（auto-updater 未接入），不要出现在这里。
 *
 * 图标：项目现有素材，不从网上拉图。
 *   Windows 托盘用 assets/icon-app.ico；Linux 托盘用 assets/preview-app.png
 *   （.ico 不被 Linux 托盘接受；preview-app.png 就是同一枚橙底白「惠」图标的 256 像素版，
 *   托盘会自动缩放到合适尺寸）。
 * 两个文件都在 assets/ 里，打包配置 files 含 "assets/**"，进 asar 后按 __dirname 相对路径取。
 *
 * 托盘创建失败时（比如 Linux 下没有托盘宿主）由调用方捕获：托盘不可用时关闭窗口
 * 应直接退出应用（不要把窗口藏起来却没有托盘可点回来）。
 */
const { Menu, Tray, nativeImage } = require('electron');
const path = require('node:path');

const TOOLTIP = '展惠进销存';

function trayIconPath() {
  if (process.platform === 'win32') {
    return path.join(__dirname, '..', 'assets', 'icon-app.ico');
  }
  return path.join(__dirname, '..', 'assets', 'preview-app.png');
}

/**
 * @param {{onShowWindow: () => void, onRestartServer: () => unknown,
 *   onOpenDataDir: () => void, onOpenLogFile: () => void,
 *   onOpenDevTools: () => void, onQuit: () => void}} callbacks
 * @returns {{tray: Tray, labels: Record<string,string>,
 *   clickMenu: (label: string) => unknown, showBalloon: (title: string, content: string) => boolean,
 *   destroy: () => void}}
 */
function createTray(callbacks) {
  const icon = nativeImage.createFromPath(trayIconPath());
  const tray = new Tray(icon);
  tray.setToolTip(TOOLTIP);

  const labels = {
    show: '打开主窗口',
    restart: '重启服务',
    dataDir: '打开数据目录',
    logFile: '打开日志文件',
    devtools: '打开开发者工具',
    quit: '退出',
  };
  const handlers = {
    [labels.show]: () => callbacks.onShowWindow(),
    [labels.restart]: () => callbacks.onRestartServer(),
    [labels.dataDir]: () => callbacks.onOpenDataDir(),
    [labels.logFile]: () => callbacks.onOpenLogFile(),
    [labels.devtools]: () => callbacks.onOpenDevTools(),
    [labels.quit]: () => callbacks.onQuit(),
  };
  const menu = Menu.buildFromTemplate([
    { label: labels.show, click: handlers[labels.show] },
    { type: 'separator' },
    { label: labels.restart, click: handlers[labels.restart] },
    { label: labels.dataDir, click: handlers[labels.dataDir] },
    { label: labels.logFile, click: handlers[labels.logFile] },
    { label: labels.devtools, click: handlers[labels.devtools] },
    { type: 'separator' },
    { label: labels.quit, click: handlers[labels.quit] },
  ]);
  tray.setContextMenu(menu);
  // 单击托盘图标 = 打开主窗口（最常用的动作，不用先找右键菜单）。
  tray.on('click', () => callbacks.onShowWindow());

  return {
    tray,
    labels,
    /** 冒烟测试用：按菜单文字触发与真实点击同一批回调。 */
    clickMenu(label) {
      const fn = handlers[label];
      if (!fn) throw new Error(`托盘菜单没有这一项：${label}`);
      return fn();
    },
    /** 气泡提示（Linux 下无通知服务时会静默失败，返回 false，不抛错）。 */
    showBalloon(title, content) {
      try {
        tray.displayBalloon({ title, content });
        return true;
      } catch {
        return false;
      }
    },
    destroy() {
      try {
        tray.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

module.exports = { createTray, trayIconPath, TOOLTIP };
