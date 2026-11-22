'use strict';
/**
 * 自动更新封装 —— 第三阶段才接入 electron-updater。
 *
 * 本文件在第一阶段仅占位：补齐设计文档 §3.1 的六个 electron/ 文件位置，
 * 明确“未实现”，不被 main.js 调用。不要在这里提前接 electron-updater，
 * 也不要在 main.js 里调用本模块——自动更新是第三阶段的工作（含发布流水线）。
 * 第三阶段实现时：checkForUpdatesManual() 走 electron-updater 的
 * autoUpdater.checkForUpdates()，installUpdateAndRestart() 走 quitAndInstall()。
 */

/** 手动检查更新（第三阶段实现；当前返回“不可用”）。 */
async function checkForUpdatesManual() {
  return { status: 'not-available', reason: 'auto-update lands in phase 3' };
}

/** 下载完提示重启安装（第三阶段实现；当前什么都不做）。 */
function installUpdateAndRestart() {
  return false;
}

module.exports = { checkForUpdatesManual, installUpdateAndRestart };
