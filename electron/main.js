'use strict';
/**
 * 展惠进销存 —— Electron 主进程（P0 最小骨架）。
 *
 * 流程：node:sqlite 自检 → 单实例锁 → 解析数据目录 → spawn 服务子进程
 * （ELECTRON_RUN_AS_NODE=1，服务端零改动）→ 轮询就绪 → 建窗口加载本地服务地址。
 *
 * 安全边界：contextIsolation 开、nodeIntegration 关、不设 webSecurity: false、
 * 不加 CSP（Vue global build 需要 new Function，服务端注释 index.ts:109-111 已说明）。
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
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { resolveDataDir } = require('./data-dir');
const { startServer, stopServer } = require('./server-runner');

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
let serverChild = null;
let serverPort = null;
let quitting = false;

async function shutdown() {
  if (quitting) return;
  quitting = true;
  if (serverChild) {
    await stopServer(serverChild);
    console.log('P0:SERVER_STOPPED');
    serverChild = null;
  }
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.on('ready-to-show', () => win.show());
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

  ipcMain.handle('app:get-version', () => app.getVersion());

  const dataDir = resolveDataDir(app);
  console.log(`[main] 数据目录 ${dataDir}`);
  try {
    const started = await startServer({
      dataDir,
      preferredPort: PREFERRED_PORT,
      isPackaged: app.isPackaged,
    });
    serverChild = started.child;
    serverPort = started.port;
    console.log(`P0:SERVER_READY port=${serverPort} reused=${started.reused}`);
  } catch (e) {
    console.error(`[main] 服务启动失败：${e.message}`);
    return 1;
  }

  mainWindow = createWindow(`http://127.0.0.1:${serverPort}/`);

  app.on('before-quit', async (event) => {
    if (serverChild && !quitting) {
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
