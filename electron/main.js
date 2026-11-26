'use strict';
/**
 * 展惠进销存 —— Electron 主进程（第二阶段：托盘 + 桌面体验）。
 *
 * 流程：node:sqlite 自检 → 单实例锁 → 数据目录初始化（含旧目录迁移）
 * → 托管启动服务子进程（守护重启，最多连续失败 5 次，服务端零改动）
 * → 轮询就绪 → 按窗口状态建窗口，加载本地服务地址。
 * 关闭窗口 → 最小化到托盘（首次给一次气泡提示）；托盘菜单“退出”才真正退出，
 * 退出时服务子进程优雅停机（SIGTERM，10 秒超时），无残留进程、无端口占用。
 *
 * 安全边界：contextIsolation 开、nodeIntegration 关、不设 webSecurity: false、
 * 不加 CSP（Vue global build 需要 new Function，服务端注释 index.ts:109-111 已说明）。
 * 导航锁定：同源放行；外链走系统浏览器；window.open 空白页（单据打印预览 /
 * 对账单打印）在应用内开带 preload 的打印子窗口（第二阶段接管，见 setWindowOpenHandler）。
 *
 * 第二阶段新增：托盘（右键菜单：打开主窗口 / 重启服务 / 打开数据目录 / 打开日志文件 /
 * 打开开发者工具 / 退出）、关闭窗口最小化到托盘（首次给一次气泡提示）、下载接管
 * （will-download → 保存对话框，完成后提示并可打开所在文件夹）。
 *
 * 第三阶段新增：自动更新（electron-updater + GitHub Releases；托盘菜单“检查更新”，
 * 启动后 60 秒做一次后台检查，没新版静默；绝不静默下载安装，见 electron/auto-updater.js）。
 *
 * P0 冒烟模式（仅用于验证，不进产品流程）：
 *   electron . --p0-smoke [--p0-shot=/tmp/p0-shot.png]
 * 窗口加载完成后截图保存，随即优雅停机并退出，退出码 0 表示冒烟通过。
 * 日志标记：P0:SQLITE_OK / P0:SERVER_READY / P0:WINDOW_LOADED / P0:SHOT_SAVED /
 * P0:SERVER_STOPPED；失败时 P0:SQLITE_FAIL / P0:WINDOW_LOAD_FAIL 并以非 0 退出。
 *
 * 零配置要求：安装后双击即用，不需要手动装 Node、设环境变量、改配置文件。
 * 数据目录默认走 app.getPath('userData')，端口默认 7741（被占则服务端自适应后移）。
 *
 * 注意：主进程里不要用 process.exit() 做致命错误退出——实测 Electron 45 的
 * process.exit()/app.exit() 在 await 之后调用时不会同步停住，之后的同步代码
 * 仍会继续跑（曾导致服务启动失败后仍建出 http://127.0.0.1:null/ 的窗口）。
 * 正确做法：main() 返回退出码，失败路径 return 1，绝不继续往下走；
 * 顶层再按退出码调 app.exit()，并同时置 process.exitCode 兜底。
 */
const { app, BrowserWindow, dialog, ipcMain, screen, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { initDataDir } = require('./data-dir');
const { startServerManaged } = require('./server-runner');
const { loadWindowState, saveWindowState, isStateVisible } = require('./window-state');
const { createTray } = require('./tray');
const {
  initAutoUpdater,
  checkForUpdatesManual,
  checkForUpdatesBackground,
  scheduleBackgroundCheck,
  installUpdateAndRestart,
  setTestFeedUrl,
  getLastResult,
} = require('./auto-updater');

// ---------- 实验 1：node:sqlite 在 Electron 主进程里是否无需重编即可用 ----------
function checkSqlite() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE p0 (id INTEGER PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO p0 (v) VALUES (?)').run('ok');
    const row = db.prepare('SELECT v FROM p0 WHERE id = 1').get();
    db.close();
    if (row && row.v === 'ok') {
      console.log(`P0:SQLITE_OK node=${process.versions.node} electron=${process.versions.electron}`);
      return true;
    }
    throw new Error('读回的值不正确');
  } catch (e) {
    console.error(`P0:SQLITE_FAIL ${e.message}`);
    return false;
  }
}

// ---------- 命令行与端口 ----------
const argv = process.argv.slice(1);
const smokeMode = argv.includes('--p0-smoke');
const shotArg = argv.find((a) => a.startsWith('--p0-shot='));
const shotPath = shotArg ? shotArg.slice('--p0-shot='.length) : '/tmp/p0-shot.png';

const PREFERRED_PORT = Number(process.env.ORANGE_PORT || 7741);

let mainWindow = null;
let serverHandle = null;
let serverPort = null;
let dataDir = null;
let quitting = false;
let trayHandle = null;
let hiddenToTray = false;
/** 渲染进程预告的下一个下载文件名（见 registerDownloadHandler 的注释）。 */
let pendingDownloadFilename = null;

async function shutdown() {
  if (quitting) return;
  quitting = true;
  if (serverHandle) {
    await serverHandle.stop();
    console.log('P0:SERVER_STOPPED');
    serverHandle = null;
  }
}

/** 把主窗口提到前台：最小化了就恢复，藏到托盘了就重新显示。 */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  hiddenToTray = false;
  mainWindow.focus();
}

/** 首次最小化到托盘时给一次气泡提示（只提示一次，标记存在 userData 里）。 */
function showTrayHintOnce() {
  const flagFile = path.join(app.getPath('userData'), 'tray-hint.json');
  try {
    if (fs.existsSync(flagFile)) return false;
  } catch {
    return false;
  }
  if (trayHandle) trayHandle.showBalloon('展惠进销存', '已最小化到托盘，右键托盘图标可以打开窗口或退出应用');
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(flagFile, JSON.stringify({ shown: true }), 'utf8');
  } catch {
    /* 标记写失败不影响使用，下次启动会再提示一次 */
  }
  console.log('P2:TRAY_HINT_SHOWN');
  return true;
}

/** 重启服务子进程，返回新端口（托盘菜单与 IPC 共用同一条路）。 */
async function restartServerFlow() {
  if (!serverHandle) return null;
  const port = await serverHandle.restart();
  if (port !== null) {
    serverPort = port;
    if (mainWindow && !mainWindow.isDestroyed()) {
      // 先把端口回给调用方再刷新页面：loadURL 会立即销毁当前执行上下文，
      // 若不等返回就导航，invoke 的 Promise 永远等不到返回值。
      setTimeout(() => {
        if (!mainWindow.isDestroyed()) mainWindow.loadURL(`http://127.0.0.1:${port}/`);
      }, 100);
    }
  }
  return port;
}

/**
 * 下载接管：前端 api.download 用 fetch 取 blob 再点 <a download> 触发，
 * Electron 里这会走下载管理器。默认弹系统保存对话框让用户选位置
 * （默认文件名取 Content-Disposition 里的名字，默认目录为系统下载目录）；
 * 下载完成弹一次提示，可选“打开所在文件夹”；用户取消则静默不打扰。
 *
 * 实测坑：blob: 链接下载时 item.getFilename() 只会给 "download"，
 * 拿不到 <a download> 里写的名字（有无 revoke objectURL 都一样）。
 * 所以渲染进程在点下载前先用 window.zhanhui.setDownloadFilename(name)
 * 把算好的名字预告给主进程（见 web/js/01-api.js）；主进程优先用这个名字，
 * 拿不到预告时才退回 item.getFilename()。预告 30 秒过期，避免一次失败的
 * 下载把名字留给后面不相干的下载。
 *
 * 冒烟测试专用：设置 ZHANHUI_SMOKE_DOWNLOAD_DIR 时跳过原生对话框，
 * 直接落到指定目录（原生对话框在 headless 下点不了；生产环境不走这条路）。
 */
function registerDownloadHandler() {
  session.defaultSession.on('will-download', (_event, item, _webContents) => {
    const hinted =
      pendingDownloadFilename && Date.now() - pendingDownloadFilename.at < 30000 ? pendingDownloadFilename.name : null;
    pendingDownloadFilename = null;
    const filename = hinted || item.getFilename() || '下载文件';
    const smokeDir = process.env.ZHANHUI_SMOKE_DOWNLOAD_DIR;
    let savePath;
    if (smokeDir) {
      fs.mkdirSync(smokeDir, { recursive: true });
      savePath = path.join(smokeDir, filename);
    } else {
      savePath = dialog.showSaveDialogSync(mainWindow, {
        title: '保存文件',
        defaultPath: path.join(app.getPath('downloads'), filename),
      });
      if (!savePath) {
        item.cancel();
        return;
      }
    }
    item.setSavePath(savePath);
    console.log(`[download] 开始下载 ${filename} → ${savePath}`);
    item.once('done', (_e, state) => {
      if (state === 'completed') {
        console.log(`[download] 下载完成 ${savePath}`);
        if (smokeDir) return;
        const choice = dialog.showMessageBoxSync(mainWindow, {
          type: 'info',
          title: '下载完成',
          message: `文件已保存：${filename}`,
          detail: savePath,
          buttons: ['打开所在文件夹', '确定'],
          defaultId: 1,
          cancelId: 1,
        });
        if (choice === 0) shell.showItemInFolder(savePath);
      } else if (state === 'cancelled') {
        console.log('[download] 用户取消了下载');
      } else {
        console.log(`[download] 下载未完成：${state}`);
      }
    });
  });
}

/** 导航锁定：给每个窗口（主窗口 + 打印子窗口）各挂一份；WeakSet 防重复挂接。 */
const guardedWindows = new WeakSet();
function attachNavGuard(win) {
  if (guardedWindows.has(win)) return;
  guardedWindows.add(win);
  win.webContents.on('will-navigate', (event, navUrl) => {
    if (!isAppUrl(navUrl)) {
      event.preventDefault();
      shell.openExternal(navUrl).catch(() => {});
    }
  });
}
function isAppUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:') return false;
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return false;
    return serverPort !== null && Number(u.port) === serverPort;
  } catch {
    return false;
  }
}

function createWindow(url) {
  const saved = loadWindowState(app.getPath('userData'));
  const displays = screen.getAllDisplays().map((d) => d.workArea);
  const useSaved = isStateVisible(saved, displays);
  const win = new BrowserWindow({
    width: useSaved ? saved.width : 1280,
    height: useSaved ? saved.height : 800,
    x: useSaved ? saved.x : undefined,
    y: useSaved ? saved.y : undefined,
    show: false,
    // Windows 下用应用图标；Linux 下 .ico 可能不被窗口管理器接受，留空用默认图标。
    icon: process.platform === 'win32' ? path.join(__dirname, '..', 'assets', 'icon-app.ico') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (useSaved && saved.isMaximized) win.maximize();
  win.on('ready-to-show', () => win.show());
  // 关闭窗口：默认最小化到托盘，不退出应用（第二阶段）。
  // 真正退出只走两条路：托盘菜单“退出”，或 IPC app:quit。
  // quitting=true（正在退出）或托盘不可用时放行关闭，行为退回第一阶段。
  win.on('close', (event) => {
    saveWindowState(app.getPath('userData'), {
      ...win.getBounds(),
      isMaximized: win.isMaximized(),
    });
    if (!quitting && trayHandle) {
      event.preventDefault();
      hiddenToTray = true;
      win.hide();
      console.log('P2:WINDOW_HIDDEN_TO_TRAY');
      showTrayHintOnce();
    }
  });
  // 导航锁定（主窗口 + 打印子窗口共用同一份逻辑，见 attachNavGuard）。
  attachNavGuard(win);
  win.webContents.setWindowOpenHandler(({ url }) => {
    // window.open('', '_blank')（单据打印预览 / 对账单打印）是空白页：
    // 在应用内开带 preload 的打印子窗口（同样走 contextIsolation 安全配置），
    // 不要放给系统浏览器；子窗口只做打印预览，关闭即销毁。
    if (url === 'about:blank' || isAppUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 820,
          height: 900,
          parent: win,
          show: true,
          title: '打印预览',
          icon: process.platform === 'win32' ? path.join(__dirname, '..', 'assets', 'icon-app.ico') : undefined,
          webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
          },
        },
      };
    }
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('did-finish-load', async () => {
    console.log('P0:WINDOW_LOADED');
    if (!smokeMode) return;
    // 冒烟：多等 1.5 秒让首屏渲染完，再截图、停机、退出。
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(shotPath, image.toPNG());
      console.log(`P0:SHOT_SAVED ${shotPath}`);
    } catch (e) {
      console.error(`P0:SHOT_FAIL ${e.message}`);
      await shutdown();
      process.exitCode = 1;
      app.quit();
      return;
    }
    await shutdown();
    app.quit();
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`P0:WINDOW_LOAD_FAIL ${code} ${desc} url=${win.webContents.getURL()}`);
    if (smokeMode) {
      shutdown().then(() => {
        process.exitCode = 1;
        app.quit();
      });
    }
  });
  win.loadURL(url);
  return win;
}

/** preload 最小 API 的主进程侧实现（检查更新走第三阶段接入的 electron-updater）。 */
function registerIpc() {
  ipcMain.handle('app:get-version', () => app.getVersion());
  ipcMain.handle('app:window-minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });
  ipcMain.handle('app:window-maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('app:window-close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
  ipcMain.handle('app:window-is-maximized', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    return mainWindow.isMaximized();
  });
  ipcMain.handle('app:open-data-dir', async () => {
    if (dataDir) await shell.openPath(dataDir);
  });
  ipcMain.handle('app:open-log-file', async () => {
    if (dataDir) await shell.showItemInFolder(path.join(dataDir, 'server.log'));
  });
  ipcMain.handle('app:restart-server', () => restartServerFlow());
  // 检查更新（托盘菜单与渲染进程共用同一条路；有新版问要不要下载，没新版明确提示）。
  ipcMain.handle('app:check-updates', () => checkForUpdatesManual());
  // 渲染进程预告下一个下载的文件名（blob: 下载的主进程拿不到 <a download> 的名字）。
  ipcMain.on('app:set-download-filename', (_event, name) => {
    if (typeof name === 'string' && name) pendingDownloadFilename = { name, at: Date.now() };
  });
  ipcMain.handle('app:quit', () => {
    app.quit();
  });
}

/** 返回进程退出码：0 继续运行，1 致命错误（调用方负责退出，见文件顶注释）。 */
async function main() {
  if (!checkSqlite()) {
    // node:sqlite 不可用是 P0 的否决项：方案不成立，立即返回，不硬绕。
    return 1;
  }
  if (!Number.isInteger(PREFERRED_PORT) || PREFERRED_PORT < 1 || PREFERRED_PORT > 65535) {
    console.error(`[main] 端口号非法：${process.env.ORANGE_PORT ?? 7741}，合法范围 1-65535。`);
    return 1;
  }

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    console.log('[main] 已有实例在运行，本次退出。');
    app.quit();
    return 0;
  }
  app.on('second-instance', () => {
    // 窗口藏在托盘里时也要能从托盘里拉回来，只 focus 不够。
    showMainWindow();
  });

  await app.whenReady();

  let dataInit;
  try {
    dataInit = await initDataDir(app);
  } catch (e) {
    console.error(`[main] 数据目录初始化失败：${e.message}`);
    return 1;
  }
  dataDir = dataInit.dataDir;
  console.log(
    `[main] 数据目录 ${dataDir}（${dataInit.kind}${dataInit.migrated ? '，已迁移旧目录' : ''}${dataInit.fellBack ? '，迁移失败已回退旧目录' : ''}）`,
  );

  try {
    serverHandle = await startServerManaged({
      dataDir,
      preferredPort: PREFERRED_PORT,
      isPackaged: app.isPackaged,
      onRestart: (port) => {
        serverPort = port;
        console.log(`[main] 服务已重启，端口 ${port}，窗口重载。`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(`http://127.0.0.1:${port}/`);
        }
      },
      onFailed: (err) => {
        dialog.showErrorBox('服务启动失败', `${err.message}\n\n日志：${path.join(dataDir, 'server.log')}`);
      },
    });
    serverPort = serverHandle.getPort();
    console.log(`P0:SERVER_READY port=${serverPort} reused=${serverHandle.isReused()}`);
  } catch (e) {
    console.error(`[main] 服务启动失败：${e.message}`);
    return 1;
  }

  registerIpc();
  mainWindow = createWindow(`http://127.0.0.1:${serverPort}/`);

  // 打印子窗口（setWindowOpenHandler 创建）同样锁导航；主窗口已在
  // createWindow 里挂过，WeakSet 保证不重复挂接。
  app.on('browser-window-created', (_event, window) => attachNavGuard(window));

  // 下载接管（will-download → 保存对话框）。
  registerDownloadHandler();

  // 托盘：建不起来（比如 Linux 下没有托盘宿主）也不阻塞启动，
  // 只是关闭窗口退回第一阶段行为（直接退出），并记一条日志。
  try {
    trayHandle = createTray({
      onShowWindow: () => showMainWindow(),
      onRestartServer: () => restartServerFlow(),
      onOpenDataDir: () => {
        if (dataDir) shell.openPath(dataDir).catch(() => {});
      },
      onOpenLogFile: () => {
        if (dataDir) shell.showItemInFolder(path.join(dataDir, 'server.log'));
      },
      onCheckUpdates: () => checkForUpdatesManual(),
      onOpenDevTools: () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.openDevTools();
      },
      onQuit: () => app.quit(),
    });
    console.log('P2:TRAY_OK');
  } catch (e) {
    trayHandle = null;
    console.error(`P2:TRAY_FAIL ${e.message}（托盘不可用：关闭窗口将直接退出应用）`);
  }

  // 自动更新（第三阶段）：托盘菜单“检查更新”与 IPC 共用同一条路；
  // 启动后 60 秒做一次后台检查（没新版/失败时静默）。冒烟模式下不自动跑，
  // 改由探针触发（否则 60 秒后的自动检查会干扰冒烟断言）。
  initAutoUpdater({ getWindow: () => mainWindow });
  if (process.env.ZHANHUI_SMOKE !== '1') {
    scheduleBackgroundCheck(60000);
  }
  console.log('P3:UPDATER_READY');

  // 冒烟测试专用只读探针（ZHANHUI_SMOKE=1 时才挂载，生产环境不暴露）。
  if (process.env.ZHANHUI_SMOKE === '1') {
    globalThis.__zhanhuiTest = {
      trayExists: () => !!trayHandle,
      trayMenuLabels: () => (trayHandle ? Object.values(trayHandle.labels) : []),
      clickTrayMenu: (label) => trayHandle.clickMenu(label),
      isHiddenToTray: () => hiddenToTray,
      windowVisible: () => !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
      childWindowCount: () => BrowserWindow.getAllWindows().filter((w) => w !== mainWindow && !w.isDestroyed()).length,
      // 第三阶段：更新检查探针（冒烟脚本用本地 latest.yml 服务切换更新源）。
      lastUpdateResult: () => getLastResult(),
      setUpdateFeed: (url) => setTestFeedUrl(url),
      triggerBackgroundCheck: () => checkForUpdatesBackground(),
      installUpdate: () => installUpdateAndRestart(),
    };
  }

  app.on('before-quit', async (event) => {
    if (serverHandle && !quitting) {
      event.preventDefault();
      await shutdown();
      if (trayHandle) {
        trayHandle.destroy();
        trayHandle = null;
      }
      app.quit();
    }
  });
  app.on('window-all-closed', () => {
    // 第二阶段起不再退出：窗口关了只是藏进托盘，应用靠托盘常驻；
    // 真正退出只走托盘菜单“退出”或 IPC app:quit（经 before-quit 停服务）。
  });
  return 0;
}

main().then((code) => {
  if (code !== 0) {
    // 致命错误退出：先置 exitCode 兜底（即使 app.exit 被延迟，循环排空后仍以该码退出），
    // 再调 app.exit()；失败路径已经 return，绝不会继续建窗口。
    process.exitCode = code;
    app.exit(code);
  }
});
