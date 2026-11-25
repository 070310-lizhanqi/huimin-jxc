'use strict';
/**
 * 展惠进销存 —— 服务子进程管理（第一阶段完整版）。
 *
 * 职责：spawn 服务子进程、轮询 port.txt + /api/auth/status、优雅停机、守护重启。
 * 服务端代码零改动；行为复用 launcher.cjs（spawn、探测、SIGTERM 停机、守护计数）。
 *
 * 两种用法：
 * - startServer()：单次启动（P0 接口，行为不变），启动失败抛错；
 * - startServerManaged()：托管启动，带守护重启。子进程意外退出 → 2 秒后重拉，
 *   连续失败 ≥5 次停止并回调 onFailed；一次成功就绪后失败计数清零。
 *   若退出后端口仍能探测到（别的进程的服务在跑）→ 不重拉，标记复用。
 *
 * 退出码语义（服务端原样）：子进程 exit 0 = 锁已被持有（已有服务在跑，可复用）；
 * exit 1 = 启动失败（端口非法、密钥缺失等）。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_RESTART_FAILS = 5;
const RESTART_DELAY_MS = 2000;

/** 服务入口：打包后走 asar 解包目录，开发期走仓库 dist/。 */
function serverEntry(isPackaged) {
  if (isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'server', 'index.js');
  }
  return path.join(__dirname, '..', 'dist', 'server', 'index.js');
}

function readPort(dataDir) {
  try {
    const p = Number(fs.readFileSync(path.join(dataDir, 'port.txt'), 'utf8').trim());
    return Number.isInteger(p) && p >= 1 && p <= 65535 ? p : null;
  } catch {
    return null;
  }
}

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/auth/status', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitReady(dataDir, preferredPort, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = readPort(dataDir) ?? preferredPort;
    if (await probe(port)) return port;
    await sleep(500);
  }
  return null;
}

/** 子进程日志：追加写 <数据目录>/server.log，超 2MB 轮转一次（照搬 launcher.cjs 的做法）。 */
function openLogStream(dataDir) {
  const logFile = path.join(dataDir, 'server.log');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) {
      try {
        fs.renameSync(logFile, `${logFile}.1`);
      } catch {
        /* 轮转失败不阻塞启动 */
      }
    }
    return fs.createWriteStream(logFile, { flags: 'a' });
  } catch {
    return null;
  }
}

/**
 * 单次拉起：spawn + 等就绪。
 * @returns {Promise<{child: ChildProcess|null, port: number, reused: boolean}>}
 *   child 为 null 表示复用了已在运行的服务（锁已持有，子进程 exit 0）。
 *   启动失败（子进程 exit 1 或 60 秒未就绪）时抛错。
 */
async function launchOnce({ dataDir, preferredPort, isPackaged }) {
  const entry = serverEntry(isPackaged);
  if (!fs.existsSync(entry)) {
    throw new Error(`服务入口不存在：${entry}`);
  }
  const logStream = openLogStream(dataDir);
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ORANGE_DATA_DIR: dataDir,
      PORT: String(preferredPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (logStream) {
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
  } else {
    child.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  }

  let exitCode = null;
  child.on('exit', (code) => {
    exitCode = code;
  });

  const port = await waitReady(dataDir, preferredPort);
  if (port !== null) {
    return { child: exitCode === null ? child : null, port, reused: exitCode !== null };
  }
  // 未就绪：区分“已有实例在运行”（exit 0 + 探测成功，已在上面返回）与启动失败。
  if (exitCode !== null) {
    throw new Error(`服务子进程已退出（exit ${exitCode}），请查看 ${path.join(dataDir, 'server.log')}`);
  }
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  throw new Error(`服务 60 秒内未就绪（数据目录 ${dataDir}），请查看 server.log`);
}

/** 单次启动（P0 接口，行为不变）。 */
async function startServer(opts) {
  return launchOnce(opts);
}

/** 优雅停机：先 SIGTERM，等 10 秒，仍不退出再 SIGKILL。 */
async function stopServer(child, timeoutMs = 10000) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && Date.now() < deadline) {
    await sleep(100);
  }
  if (child.exitCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

/**
 * 托管启动：首次启动成功后返回 handle，后台守护子进程。
 * @param {{dataDir: string, preferredPort: number, isPackaged: boolean,
 *   onRestart?: (port: number) => void, onFailed?: (err: Error) => void}} opts
 * @returns {Promise<{getPort: () => number, getChild: () => ChildProcess|null,
 *   isReused: () => boolean, stop: () => Promise<void>, restart: () => Promise<number|null>}>}
 */
async function startServerManaged({ dataDir, preferredPort, isPackaged, onRestart, onFailed }) {
  const first = await launchOnce({ dataDir, preferredPort, isPackaged });
  let child = first.child;
  let port = first.port;
  let reused = first.reused;
  let stopping = false;
  let dead = false;
  let failCount = 0;
  let epoch = 0;

  /** 守护循环：等当前子进程退出 → 按策略重拉；epoch 变化（stop/restart）即退出。 */
  async function watchLoop(myEpoch) {
    while (!stopping && !dead && myEpoch === epoch) {
      if (!child) return; // 复用已有服务：没有自己拉起的子进程可守护
      const current = child;
      if (current.exitCode === null) {
        await new Promise((resolve) => current.once('exit', resolve));
      }
      if (stopping || dead || myEpoch !== epoch) return;
      // 给“已有实例”留一点确认时间：端口还能探测到 → 是别的进程在服务，不重拉。
      await sleep(500);
      if (stopping || dead || myEpoch !== epoch) return;
      if (await probe(port)) {
        reused = true;
        child = null;
        console.log(`[server-runner] 服务子进程已退出，但端口 ${port} 仍有服务在跑（其他进程的服务），不再重拉。`);
        return;
      }
      failCount += 1;
      if (failCount >= MAX_RESTART_FAILS) {
        dead = true;
        const err = new Error(
          `服务连续启动失败 ${failCount} 次，已停止自动拉起。请查看 ${path.join(dataDir, 'server.log')}`,
        );
        if (typeof onFailed === 'function') onFailed(err);
        return;
      }
      console.log(`[server-runner] 服务进程退出，2 秒后重新拉起（第 ${failCount} 次）……`);
      await sleep(RESTART_DELAY_MS);
      if (stopping || dead || myEpoch !== epoch) return;
      try {
        const r = await launchOnce({ dataDir, preferredPort, isPackaged });
        child = r.child;
        port = r.port;
        reused = r.reused;
        failCount = 0;
        if (!child) return; // 重拉后复用了已有服务：无子进程可守护
        if (typeof onRestart === 'function') onRestart(port);
      } catch (e) {
        // 本次拉起失败也算一次：循环顶部会立即再走失败分支继续计数。
        console.error(`[server-runner] 服务重拉失败：${e.message}`);
      }
    }
  }

  if (child) {
    epoch += 1;
    void watchLoop(epoch);
  }

  return {
    getPort: () => port,
    getChild: () => child,
    isReused: () => reused,
    /** 停止守护并优雅停掉自己拉起的子进程（复用的服务不碰）。 */
    async stop() {
      if (stopping) return;
      stopping = true;
      epoch += 1;
      if (child) {
        const c = child;
        child = null;
        await stopServer(c);
      }
    },
    /**
     * 手动重启服务（托盘/界面“重启服务”用）：停掉当前子进程再拉一次，返回新端口。
     * 复用已有服务时没有自己拉起的子进程，直接返回当前端口。
     */
    async restart() {
      if (stopping || dead) return null;
      epoch += 1; // 让旧守护循环退出
      if (child) {
        const c = child;
        child = null;
        await stopServer(c);
      }
      const r = await launchOnce({ dataDir, preferredPort, isPackaged });
      child = r.child;
      port = r.port;
      reused = r.reused;
      failCount = 0;
      if (child) {
        epoch += 1;
        void watchLoop(epoch);
      }
      return port;
    },
  };
}

module.exports = { startServer, startServerManaged, stopServer, waitReady, probe, readPort };
