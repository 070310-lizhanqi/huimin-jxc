#!/usr/bin/env node
/**
 * 惠民云进销存 —— 应用启动器（安装版/便携版共用）。
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
/**
 * 品牌改名后的数据目录名，以及旧名（用于一次性迁移）。
 * 环境变量名 ORANGE_DATA_DIR 保持不变——它是外部约定（安装器、脚本、用户自设），
 * 改名会破坏既有部署。
 */
const DATA_DIR_NAME = 'huimin-yun';
const LEGACY_DATA_DIR_NAME = 'orange-jxc';
/** 库文件名也随品牌改了：旧的 orange-clone.db → 新的 huimin-clone.db */
const DB_FILE_NAME = 'huimin-clone.db';
const LEGACY_DB_FILE_NAME = 'orange-clone.db';

function appDataDir() {
  return process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
}
function dataDir() {
  if (process.env.ORANGE_DATA_DIR) return process.env.ORANGE_DATA_DIR;
  if (fs.existsSync(PORTABLE_FLAG)) return path.join(APP_ROOT, 'data');
  return path.join(appDataDir(), DATA_DIR_NAME);
}

/**
 * 旧数据目录迁移：%APPDATA%\orange-jxc → %APPDATA%\huimin-yun。
 *
 * 安全要点（数据丢了就没了）：
 *  1. 只在「新目录还不存在或为空」时才搬——绝不覆盖已有数据；
 *  2. 搬之前先把 WAL 合并进主库（WAL 里可能还有未落盘的账），
 *     用完 node:sqlite 的 checkpoint 能力，保证 .db 是完整快照；
 *  3. 整个目录用「先复制 → 校验 → 再删旧目录」的方式，
 *     中途失败旧目录还在，数据不会丢；
 *  4. 失败只告警不阻断启动——服务仍可用旧目录（见下面的回退逻辑）。
 *
 * 返回值约定：
 *   null      → 用新目录继续（迁移成功，或本来就没什么可迁的）
 *   旧目录路径 → 迁移失败，调用方应回退到旧目录继续（数据还在那，不会丢）
 */
function migrateLegacyDataDir(target) {
  const legacy = path.join(appDataDir(), LEGACY_DATA_DIR_NAME);
  if (legacy === target) return null;
  if (!fs.existsSync(legacy)) return null;

  // 目标已有数据 → 不动（避免覆盖）
  try {
    const existing = fs.readdirSync(target);
    const meaningful = existing.filter((f) => f !== 'launcher.pid' && f !== 'port.txt' && f !== 'server.lock');
    if (meaningful.length > 0) {
      console.log(`[启动器] 检测到旧数据目录 ${legacy}，但新目录已有数据，跳过迁移（不覆盖）。`);
      return null;
    }
  } catch {
    // 目标目录读不到：当作空，继续
  }

  try {
    // 1) 先把旧库 WAL 合并进主库，得到完整快照
    const oldDb = path.join(legacy, LEGACY_DB_FILE_NAME);
    if (fs.existsSync(oldDb)) {
      try {
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(oldDb);
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        db.close();
      } catch (e) {
        console.warn('[启动器] 旧库 checkpoint 失败（继续尝试搬运）：' + e.message);
      }
    }

    // 2) 复制整个目录（不删旧的）；库文件要改新名，否则服务端找不到
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(legacy)) {
      const src = path.join(legacy, name);
      const dstName = name === LEGACY_DB_FILE_NAME ? DB_FILE_NAME : name;
      const dst = path.join(target, dstName);
      if (fs.existsSync(dst)) continue; // 目标已有同名文件，不覆盖
      fs.cpSync(src, dst, { recursive: true });
    }
    // 库文件改名后，其 WAL/SHM 副产物也要跟着改名（服务端按新库名找副产物）
    for (const suffix of ['-wal', '-shm']) {
      const oldSide = path.join(target, LEGACY_DB_FILE_NAME + suffix);
      if (fs.existsSync(oldSide)) {
        try { fs.renameSync(oldSide, path.join(target, DB_FILE_NAME + suffix)); } catch { /* ignore */ }
      }
    }

    // 3) 校验：新库必须存在且大小一致
    if (fs.existsSync(oldDb)) {
      const newDb = path.join(target, DB_FILE_NAME);
      if (!fs.existsSync(newDb)) throw new Error('迁移后主库缺失');
      const a = fs.statSync(oldDb).size;
      const b = fs.statSync(newDb).size;
      if (a !== b) throw new Error(`迁移后大小不一致（${a} vs ${b}）`);
    }

    // 4) 校验通过才删旧目录
    //    删除前先把旧库句柄彻底释放（WAL 模式下 .db/-wal/-shm 仍被占用会 EPERM）；
    //    删除本身也可能因句柄未释放失败 → 重试若干次，仍失败则保留旧目录
    //    （旧目录留着只是多占点空间，不删反而更安全——下次启动会再判定一次）。
    try {
      const oldDbHandle = new DatabaseSync(oldDb, { readOnly: true });
      oldDbHandle.close();
    } catch { /* 打不开就算了，删不掉就保留旧目录 */ }
    fs.rmSync(path.join(legacy, LEGACY_DB_FILE_NAME + '-wal'), { force: true });
    fs.rmSync(path.join(legacy, LEGACY_DB_FILE_NAME + '-shm'), { force: true });
    let removed = false;
    for (let attempt = 0; attempt < 5 && !removed; attempt++) {
      try {
        fs.rmSync(legacy, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        removed = !fs.existsSync(legacy);
      } catch {
        // 句柄未释放，稍等再试
        const until = Date.now() + 300;
        while (Date.now() < until) { /* 短暂等待 */ }
      }
    }
    if (!removed) {
      console.warn(`[启动器] 旧数据目录未能删除（可能仍被占用），已保留：${legacy}`);
    }
    console.log(`[启动器] 数据目录已从 ${LEGACY_DATA_DIR_NAME} 迁移到 ${DATA_DIR_NAME}。`);
    // 迁移成功：返回 null，表示「继续用新目录」（不触发回退）
    return null;
  } catch (e) {
    console.error('[启动器] 数据目录迁移失败：' + e.message);
    console.error('           为避免丢数据，仍使用旧目录 ' + legacy + '（可手动改名后重试）。');
    return legacy; // 回退：继续用旧目录
  }
}

let DATA = dataDir();
fs.mkdirSync(DATA, { recursive: true });
// 迁移只在「默认安装目录」场景发生：用户显式指定 ORANGE_DATA_DIR 或便携模式时不插手
if (!process.env.ORANGE_DATA_DIR && !fs.existsSync(PORTABLE_FLAG)) {
  const fellBack = migrateLegacyDataDir(DATA);
  // 迁移失败 → 回退继续用旧目录启动（数据还在那，不会丢）
  if (fellBack && fellBack !== DATA) {
    DATA = fellBack;
    fs.mkdirSync(DATA, { recursive: true });
  }
}
const LAUNCHER_PID = path.join(DATA, 'launcher.pid');
const PORT_FILE = path.join(DATA, 'port.txt');
const LOG_FILE = path.join(DATA, 'server.log');
const PID_FILE = path.join(DATA, 'server.pid');

// ---------- 工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * 日志输出：安装版由原生启动器以「无控制台 + 脱离会话」方式拉起，
 * 此时 stdout/stderr 句柄指向 NUL，console.log 虽不报错但内容会丢；
 * 这里统一写进 server.log，既不依赖控制台，也留得下排障痕迹。
 */
const LOG_FILE_PATH = path.join(DATA, 'server.log');
function logLine(msg) {
  try {
    fs.appendFileSync(LOG_FILE_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* 日志写不进去也不能影响启动 */ }
}
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

/**
 * 启动器单实例锁：双击桌面图标连开多个浏览器窗口的根因是没有这道拦截——
 * 每次双击都拉起一个新启动器进程，每个进程的 opening 去抖都是从 0 重新开始，
 * 探测到服务就绪后各自 openBrowser 一次（N 次双击 = N 个浏览器窗口）。
 * 用「原子创建（wx）+ 存活复核」：第二个启动器只在已有实例已死时才接管。
 * 与服务端 server.lock 同款策略：进程级去重必须在窗口期外就生效。
 */
function acquireLauncherLock() {
  const lockFile = LAUNCHER_PID;
  try {
    const old = Number(fs.readFileSync(lockFile, 'utf8').trim());
    if (old > 0 && old !== process.pid && pidAlive(old)) return false; // 已有启动器活着
  } catch { /* 无锁文件，首次启动 */ }
  // 原子创建：两个启动器同时双击时只有一个能建立锁文件，另一个进 EEXIST 复核
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      break; // 抢锁成功
    } catch (e) {
      if (e && e.code !== 'EEXIST') throw e;
      let other = 0;
      try { other = Number(fs.readFileSync(lockFile, 'utf8').trim()); } catch { /* ignore */ }
      if (!(other > 0) || other === process.pid) {
        try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
        continue;
      }
      if (pidAlive(other)) return false; // 抢先者存活：本启动器退出
      try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
    }
  }
  return true;
}
/** 退出时清锁（kill 等异常退出留残留，由存活复核兜底） */
function releaseLauncherLock() {
  try { if (Number(fs.readFileSync(LAUNCHER_PID, 'utf8').trim()) === process.pid) fs.rmSync(LAUNCHER_PID, { force: true }); } catch { /* ignore */ }
}
process.on('exit', releaseLauncherLock);
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
  // 启动器单实例：双击桌面图标连开多个浏览器窗口的根因是没有这道拦截——
  // 每次双击都拉起一个新启动器进程，探测到服务就绪后各自 openBrowser 一次
  if (!acquireLauncherLock()) {
    logLine('已有启动器实例在运行（双击重复触发），本次直接退出，不再重复开浏览器。');
    process.exit(0);
  }
  logLine(`启动器：数据目录 ${DATA}`);
  await ensureServer();

  // 轮询就绪（最多 ~60s：恢复大量数据的库首启可能较慢）
  let port = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const p = readPort() ?? PREFERRED_PORT;
    if (await probe(p)) { port = p; break; }
  }
  if (!port) {
    logLine('服务 60 秒内未就绪');
    // 仍保持等待：服务可能稍后起来（守护循环会探测到并打开浏览器）
  } else {
    const url = `http://127.0.0.1:${port}/`;
    logLine(`服务就绪：${url}`);
    if (opening !== port) { opening = port; openBrowser(url); }
  }

  // 守护循环：服务退出（含「恢复备份」重启）→ 重新拉起并重开浏览器
  let lastPort = port;
  // 连续启动失败计数：超过上限就停止自动拉起（避免坏数据导致无限重启刷屏）
  let restartFails = 0;
  const MAX_RESTART_FAILS = 5;
  for (;;) {
    await sleep(2000);
    if (child && child.exitCode !== null) {
      // 连续拉起失败（如数据文件损坏/结构不兼容）就停下，别无限重启刷日志
      restartFails++;
      if (restartFails >= MAX_RESTART_FAILS) {
        logLine(`服务已连续 ${restartFails} 次启动失败，停止自动拉起。请查看 ${LOG_FILE} 里的错误信息。`);
        break;
      }
      logLine(`服务进程退出，2 秒后重新拉起（第 ${restartFails} 次）……`);
      await sleep(2000);
      await ensureServer();
      lastPort = null; // 端口可能变化，强制重新探测
    } else {
      restartFails = 0; // 跑起来了就清零
    }
    const p = readPort();
    if (p && p !== lastPort && (await probe(p))) {
      lastPort = p;
      const url = `http://127.0.0.1:${p}/`;
      logLine(`服务在 ${url} 就绪（重启完成）`);
      openBrowser(url);
    }
  }
}

main().catch((e) => {
  logLine('异常退出：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
