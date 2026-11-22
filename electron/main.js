'use strict';
/**
 * 展惠进销存 —— Electron 主进程（第一阶段：最小可用壳）。
 *
 * 流程：node:sqlite 自检 → 单实例锁 → 数据目录初始化（含旧目录迁移）
 * → 托管启动服务子进程（守护重启，最多连续失败 5 次，服务端零改动）
 * → 轮询就绪 → 按窗口状态建窗口，加载本地服务地址。
 * 关闭窗口 → 服务子进程优雅停机（SIGTERM，10 秒超时），无残留进程、无端口占用。
 *
 * 安全边界：contextIsolation 开、nodeIntegration 关、不设 webSecurity: false、
 * 不加 CSP（Vue global build 需要 new Function，服务端注释 index.ts:109-111 已说明）。
 * 导航锁定：同源放行；外链走系统浏览器；window.open 空白页（单据打印预览）
 * 在应用内默认新窗口打开——第二阶段再接管为带 preload 的打印子窗口。
 *
 * 不做（第二/三阶段）：托盘、自动更新、下载接管。不要在这里加。
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
const { app, BrowserWindow, dialog, ipcMain, screen, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { initDataDir } = require('./data-dir');
const { startServerManaged } = require('./server-runner');
const { loadWindowState, saveWindowState, isStateVisible } = require('./window-state');

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

async function shutdown() {
  if (quitting) return;
  quitting = true;
  if (serverHandle) {
    await serverHandle.stop();
    console.log('P0:SERVER_STOPPED');
    serverHandle = null;
  }
}

/** 当前服务地址的同源判定（端口可能随服务重启变化，读最新值）。 */
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
    icon: process.platform === 'win32'
      ? path.join(__dirname, '..', 'assets', 'icon-app.ico')
      : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (useSaved && saved.isMaximized) win.maximize();
  win.on('ready-to-show', () => win.show());
  // 关闭窗口即保存状态（第一阶段：关闭 = 退出应用，托盘常驻在第二阶段再加）。
  win.on('close', () => {
    saveWindowState(app.getPath('userData'), {
      ...win.getBounds(),
      isMaximized: win.isMaximized(),
    });
  });
  // 导航锁定：同源放行，外链走系统浏览器。
  win.webContents.on('will-navigate', (event, navUrl) => {
    if (!isAppUrl(navUrl)) {
      event.preventDefault();
      shell.openExternal(navUrl).catch(() => {});
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // window.open('', '_blank')（单据打印预览 / 对账单打印）是空白页：应用内默认新窗口打开；
    // 第二阶段再接管为带 preload 的打印子窗口。
    if (url === 'about:blank' || isAppUrl(url)) return { action: 'allow' };
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

/** preload 最小 API 的主进程侧实现（检查更新在第三阶段再加）。 */
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
  ipcMain.handle('app:restart-server', async () => {
    if (!serverHandle) return null;
    const port = await serverHandle.restart();
    if (port !== null) {
      serverPort = port;
      if (mainWindow && !mainWindow.isDestroyed()) {
        // 先把端口回给渲染进程再刷新页面：loadURL 会立即销毁当前执行上下文，
        // 若不等返回就导航，invoke 的 Promise 永远等不到返回值。
        setTimeout(() => {
          if (!mainWindow.isDestroyed()) mainWindow.loadURL(`http://127.0.0.1:${port}/`);
        }, 100);
      }
    }
    return port;
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
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
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
  console.log(`[main] 数据目录 ${dataDir}（${dataInit.kind}${dataInit.migrated ? '，已迁移旧目录' : ''}${dataInit.fellBack ? '，迁移失败已回退旧目录' : ''}）`);

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

  app.on('before-quit', async (event) => {
    if (serverHandle && !quitting) {
      event.preventDefault();
      await shutdown();
      app.quit();
    }
  });
  app.on('window-all-closed', () => {
    // 桌面版只做 Windows；窗口全关即退出应用（托盘常驻在第二阶段再加）。
    app.quit();
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
