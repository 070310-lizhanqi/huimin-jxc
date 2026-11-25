'use strict';
/**
 * 展惠进销存 —— 自动更新封装（第三阶段：electron-updater 6.x + GitHub Releases）。
 *
 * 更新源：GitHub Releases（仓库 070310-lizhanqi/huimin-jxc），
 * electron-builder 在打包时把 package.json 的 build.publish 写进
 * resources/app-update.yml，electron-updater 按它找 latest.yml。
 * 版本号唯一来源是 package.json 的 version；不要手改 latest.yml，它是构建产物。
 *
 * 对小商贩的承诺（硬性要求：零配置、别吓着人）：
 *   - 绝不静默下载：autoDownload = false，有新版先问“立即下载 / 以后再说”；
 *   - 绝不静默安装：autoInstallOnAppQuit = false，下载完只提示“立即重启安装 / 稍后”，
 *     只有用户点了“立即重启安装”才调 quitAndInstall()；正在记的单据不会被强制重启打断；
 *   - 后台检查只跑一次（启动后 60 秒），没新版 / 检查失败时静默，只记日志，不弹任何框；
 *   - 手动检查（托盘菜单“检查更新”）一定给明确结果：有新版 / 已是最新 / 检查失败。
 *
 * 未签名现状：安装包未签名，首次安装时 Windows SmartScreen 会弹警告，
 * 用户要点“更多信息 → 仍要运行”；electron-updater 的自动更新本身不受签名影响
 * （electron-builder 26.x 下 NSIS 更新不强制签名校验）。买证书以后再议。
 *
 * 冒烟测试专用（ZHANHUI_SMOKE_UPDATE=1 时不弹任何对话框，只记日志并返回结果；
 * ZHANHUI_SMOKE_UPDATE_FEED=<本地 latest.yml 服务地址> 时用 generic provider
 * + forceDevUpdateConfig，开发模式下 electron-updater 默认拒绝检查更新）。
 * 生产打包版不走这两条路。
 */
const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.allowPrerelease = false;

let getWindow = () => null;
/** 最近一次检查的结果（手动/后台共用；冒烟探针读它）。 */
let lastResult = { status: 'idle' };
let checking = false;

function isSmokeNoDialog() {
  return process.env.ZHANHUI_SMOKE_UPDATE === '1';
}

/** 纯数字三段版本号比较（本仓库版本号就是 x.y.z，不引入 semver 依赖）。 */
function compareVersions(a, b) {
  const pa = String(a)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  const pb = String(b)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** 冒烟测试专用：在运行时切换更新源（generic provider，指向本地 latest.yml 服务）。 */
function setTestFeedUrl(url) {
  autoUpdater.forceDevUpdateConfig = true;
  autoUpdater.setFeedURL({ provider: 'generic', url });
  console.log(`[updater] 测试更新源已切换：${url}`);
}

/**
 * 初始化（主进程 app.whenReady() 之后调一次）：
 * 挂 'error' 监听（electron-updater 是 EventEmitter，error 事件无人接会抛错、
 * 可能拖垮主进程——必须接住）；冒烟环境变量有值时套用测试更新源。
 */
function initAutoUpdater({ getWindow: gw }) {
  getWindow = gw || (() => null);
  autoUpdater.on('error', (err) => {
    console.log(`P3:UPDATE_ERROR ${err && err.message ? err.message : err}`);
  });
  autoUpdater.on('update-downloaded', () => {
    lastResult = { status: 'downloaded', version: lastResult.version };
    console.log('P3:UPDATE_DOWNLOADED');
  });
  const feed = process.env.ZHANHUI_SMOKE_UPDATE_FEED;
  if (feed) setTestFeedUrl(feed);
}

/** 下载完提示重启安装（只有用户点了“立即重启安装”才走到这一步）。 */
async function downloadAndPromptInstall(win, version) {
  try {
    console.log(`[updater] 开始下载新版本 ${version}`);
    await autoUpdater.downloadUpdate();
    lastResult = { status: 'downloaded', version };
    console.log('P3:UPDATE_DOWNLOADED');
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    console.log(`P3:UPDATE_ERROR 下载失败：${message}`);
    if (!isSmokeNoDialog()) {
      await dialog.showMessageBox(win, {
        type: 'warning',
        title: '下载失败',
        message: '新版本下载失败，请检查网络后重试。',
        detail: message,
        buttons: ['确定'],
        defaultId: 0,
        cancelId: 0,
      });
    }
    return { status: 'error', message };
  }
  if (isSmokeNoDialog()) return { status: 'downloaded', version };
  const choice = await dialog.showMessageBox(win, {
    type: 'question',
    title: '新版本已下载完成',
    message: `展惠进销存 ${version} 已下载完成，是否立即重启安装？`,
    detail: '安装只需几秒，账套数据不受影响；正在编辑的单据请先保存。',
    buttons: ['立即重启安装', '稍后'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice === 0) installUpdateAndRestart();
  return { status: 'downloaded', version };
}

/**
 * 检查一次更新。silent=true 时（后台检查）：没新版 / 检查失败都静默，
 * 只有发现新版才弹框问用户；silent=false 时（手动检查）：三种结果都给明确提示。
 * 返回 {status: 'available'|'not-available'|'error'|'checking', version?, message?}，
 * 绝不抛错（检查失败不该让托盘菜单点一下就崩）。
 */
async function runCheck({ silent }) {
  if (checking) return { status: 'checking' };
  checking = true;
  try {
    console.log('P3:UPDATE_CHECK_START');
    const result = await autoUpdater.checkForUpdates();
    const latest = result && result.updateInfo ? result.updateInfo.version : null;
    const current = app.getVersion();
    if (latest && compareVersions(latest, current) > 0) {
      lastResult = { status: 'available', version: latest };
      console.log(`P3:UPDATE_AVAILABLE ${latest}`);
      if (isSmokeNoDialog()) return lastResult;
      const choice = await dialog.showMessageBox(getWindow(), {
        type: 'question',
        title: '发现新版本',
        message: `展惠进销存 ${latest} 已发布，当前版本 ${current}。`,
        detail: '更新包下载完成后会提示重启安装；下载时应用可以继续使用，正在记的单据不会丢。',
        buttons: ['立即下载', '以后再说'],
        defaultId: 0,
        cancelId: 1,
      });
      if (choice === 0) return downloadAndPromptInstall(getWindow(), latest);
      return lastResult;
    }
    lastResult = { status: 'not-available', version: current };
    console.log('P3:UPDATE_NOT_AVAILABLE');
    if (!silent && !isSmokeNoDialog()) {
      await dialog.showMessageBox(getWindow(), {
        type: 'info',
        title: '已是最新版本',
        message: `当前已是最新版本 ${current}，无需更新。`,
        buttons: ['确定'],
        defaultId: 0,
        cancelId: 0,
      });
    }
    return lastResult;
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    lastResult = { status: 'error', message };
    console.log(`P3:UPDATE_ERROR ${message}`);
    if (!silent && !isSmokeNoDialog()) {
      await dialog.showMessageBox(getWindow(), {
        type: 'warning',
        title: '检查更新失败',
        message: '检查更新失败，请检查网络后重试。',
        detail: message,
        buttons: ['确定'],
        defaultId: 0,
        cancelId: 0,
      });
    }
    return lastResult;
  } finally {
    checking = false;
  }
}

/** 手动检查更新（托盘菜单“检查更新”与 IPC app:check-updates 共用）。 */
function checkForUpdatesManual() {
  return runCheck({ silent: false });
}

/** 后台检查一次（启动后延迟调用；没新版 / 失败时静默）。 */
function checkForUpdatesBackground() {
  return runCheck({ silent: true });
}

/** 启动后延迟做一次后台检查（默认 60 秒；冒烟模式下不自动跑，改由探针触发）。 */
function scheduleBackgroundCheck(delayMs = 60000) {
  setTimeout(() => {
    checkForUpdatesBackground().catch(() => {});
  }, delayMs);
}

/** 下载完成且用户确认后重启安装；未下载完成时返回 false，什么都不做。 */
function installUpdateAndRestart() {
  if (lastResult.status !== 'downloaded') return false;
  autoUpdater.quitAndInstall();
  return true;
}

function getLastResult() {
  return lastResult;
}

module.exports = {
  initAutoUpdater,
  checkForUpdatesManual,
  checkForUpdatesBackground,
  scheduleBackgroundCheck,
  installUpdateAndRestart,
  setTestFeedUrl,
  getLastResult,
};
