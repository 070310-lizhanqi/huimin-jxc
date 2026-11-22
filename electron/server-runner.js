'use strict';
/**
 * 展惠进销存 —— 服务子进程管理（P0 最小骨架）。
 *
 * 职责：spawn 服务子进程、轮询 port.txt + /api/auth/status、优雅停机。
 * 服务端代码零改动；行为复用 launcher.cjs（spawn、探测、SIGTERM 停机），不改它。
 * 守护重启（最多连续拉起 5 次）在第一阶段补全，P0 只做单次启动 + 停机。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/auth/status', timeout: 2000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
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
 * 启动服务子进程。
 * @returns {Promise<{child: ChildProcess|null, port: number, reused: boolean}>}
 *   child 为 null 表示复用了已在运行的服务（锁已持有，子进程 exit 0）。
 *   启动失败（子进程 exit 1 或 60 秒未就绪）时抛错。
 */
async function startServer({ dataDir, preferredPort, isPackaged }) {
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

module.exports = { startServer, stopServer, waitReady, probe, readPort };
