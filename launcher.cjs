#!/usr/bin/env node
/**
 * 橙子进销存 —— 应用启动器（安装版/便携版共用）。
 *
 * 职责：
 * 1) 计算数据目录（%APPDATA%\orange-jxc，便携模式为安装目录\data）并注入 ORANGE_DATA_DIR
 * 2) 启动/唤醒服务（服务已在线则直接复用，不重复起进程）
 * 3) 轮询就绪后用系统默认浏览器打开页面
 * 4) 服务进程退出（如「恢复备份」触发的重启）→ 自动再次拉起并重开浏览器
 *
 * 端口约定：优先 7741，被占用则向下自适应（服务端已实现）；
 * 服务把实际端口写进 <数据目录>\port.txt，本启动器据此打开浏览器。
 */
const { spawn, exec } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const APP_ROOT = __dirname;                       // launcher 位于安装根目录
const SERVER_ENTRY = path.join(APP_ROOT, 'dist', 'server', 'index.js');
const PORTABLE_FLAG = path.join(APP_ROOT, 'portable.flag');
const PREFERRED_PORT = Number(process.env.ORANGE_PORT || 7741);

// ---------- 数据目录 ----------
function dataDir() {
  if (process.env.ORANGE_DATA_DIR) return process.env.ORANGE_DATA_DIR;
  if (fs.existsSync(PORTABLE_FLAG)) return path.join(APP_ROOT, 'data');
  const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'orange-jxc');
}
const DATA = dataDir();
fs.mkdirSync(DATA, { recursive: true });
const LAUNCHER_PID = path.join(DATA, 'launcher.pid');
// 记录启动器自身 pid：卸载/管理脚本可据此停止看护进程
try { fs.writeFileSync(LAUNCHER_PID, String(process.pid)); } catch { /* ignore */ }
process.on('exit', () => { try { if (Number(fs.readFileSync(LAUNCHER_PID,'utf8').trim())===process.pid) fs.rmSync(LAUNCHER_PID,{force:true}); } catch {} });
const PORT_FILE = path.join(DATA, 'port.txt');
const LOG_FILE = path.join(DATA, 'server.log');
const PID_FILE = path.join(DATA, 'server.pid');

// ---------- 工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 日志体积上限：超过则将当前日志改名为 .old（只保留一代），避免跨年堆积成几十 MB 纯文本 */
const LOG_MAX_BYTES = 2 * 1024 * 1024;
/**
 * 启动前轮转日志：服务每次重启都会以追加模式新开一个 write stream，
 * 无轮转的话一年下来 server.log 会累积几百次启动的输出。超过 2MB 就滚动成 .old
 * （旧的一代直接覆盖），保证日志目录始终只有 server.log + server.log.old 两个文件。
 */
function rotateLog() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size > LOG_MAX_BYTES) {
      fs.rmSync(LOG_FILE + '.old', { force: true });
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
  } catch { /* 日志不存在或改不动：不阻断启动 */ }
}
function readPort() {
  try {
    const p = Number(fs.readFileSync(PORT_FILE, 'utf8').trim());
    return p > 0 ? p : null;
  } catch { return null; }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/auth/status', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, { windowsHide: true }, () => {});
}

// ---------- 服务生命周期 ----------
let child = null;
let opening = 0; // 去抖：同一端口只开一次浏览器

async function ensureServer() {
  // 已有本启动器拉起的进程活着 → 复用
  if (child && child.exitCode === null) return true;
  // pid 文件里的进程仍活着 → 也是复用（服务由上次会话遗留）
  try {
    const old = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (old > 0 && pidAlive(old)) {
      const p = readPort();
      if (p && (await probe(p))) return true;
    }
  } catch { /* ignore */ }
  // 冷启动
  const nodeExe = process.execPath;
  rotateLog();
  child = spawn(nodeExe, [SERVER_ENTRY], {
    cwd: APP_ROOT,
    env: { ...process.env, ORANGE_DATA_DIR: DATA, ELECTRON_RUN_AS_NODE: undefined },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const log = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  return true;
}

async function main() {
  console.log(`[启动器] 数据目录：${DATA}`);
  await ensureServer();

  // 轮询就绪（最多 ~60s：恢复大量数据的库首启可能较慢）
  let port = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const p = readPort() ?? PREFERRED_PORT;
    if (await probe(p)) { port = p; break; }
  }
  if (!port) {
    console.error('[启动器] 服务 60 秒内未就绪，详见 ' + LOG_FILE);
    // 仍保持等待：服务可能稍后起来（守护循环会探测到并打开浏览器）
  } else {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`[启动器] 服务就绪：${url}`);
    if (opening !== port) { opening = port; openBrowser(url); }
  }

  // 守护循环：服务退出（含「恢复备份」重启）→ 重新拉起并重开浏览器
  let lastPort = port;
  for (;;) {
    await sleep(2000);
    if (child && child.exitCode !== null) {
      console.log('[启动器] 服务进程退出，2 秒后重新拉起……');
      await sleep(2000);
      await ensureServer();
      lastPort = null; // 端口可能变化，强制重新探测
    }
    const p = readPort();
    if (p && p !== lastPort && (await probe(p))) {
      lastPort = p;
      const url = `http://127.0.0.1:${p}/`;
      console.log(`[启动器] 服务在 ${url} 就绪（重启完成）`);
      openBrowser(url);
    }
  }
}

main().catch((e) => {
  console.error('[启动器] 异常退出：', e);
  process.exit(1);
});
