'use strict';
/**
 * 第一阶段冒烟测试（headless，跑在 xvfb-run 下）：
 *   xvfb-run -a node tools/smoke-electron-phase1.cjs [--mode dev|packaged]
 *
 * 环境：HOME 指向一个临时目录（内含 .config/huimin-yun/huimin-clone.db 旧数据，
 * 由种子脚本预先生成：鲜果批发部账套，库存总量 1068、货值 ¥47,715.21）。
 * 端口默认 17741（ORANGE_PORT），避免与本机其他服务冲突。
 *
 * 覆盖的验收点：
 *  1 零配置启动：窗口出现、登录页可见（无需手动装 Node/设环境变量）
 *  2 preload 最小 API：ping/getVersion
 *  3 旧数据复用：主进程日志的数据目录指向 .config/huimin-yun（规则 3）
 *  4 登录进工作台，工作台显示种子数据（1068 / 47,715.21）
 *  5 窗口状态：首次 1280×800；关闭后 window-state.json 落盘；重进恢复
 *  6 单实例：第二进程 10 秒内退出（码 0），第一窗口不受影响
 *  7 服务端守护：kill 子进程后 30 秒内端口恢复，窗口仍显示工作台
 *  8 restartServer IPC：返回端口，窗口重载后仍显示工作台
 *  9 关闭窗口 → 主进程退出、端口关闭、无残留服务进程、-wal 已 checkpoint
 * 10 重新启动：数据完整（仍显示 1068）
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const HOME = process.env.SMOKE_HOME || '/tmp/phase1-smoke/home';
const PORT = process.env.ORANGE_PORT || '17741';
const MODE = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=dev').slice(7);
const LEGACY_DB = path.join(HOME, '.config', 'huimin-yun', 'huimin-clone.db');
// Electron 的 userData 目录名取自 package.json 的 name（不是产品名）。
const USER_DATA = path.join(HOME, '.config', require(path.join(REPO, 'package.json')).name);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* retry */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`超时：${label}`);
    await sleep(500);
  }
}
async function portUp() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/status`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}
function serverPids() {
  try {
    const out = execSync("pgrep -f 'dist/server/index[.]js'", { encoding: 'utf8' }).trim();
    return out ? out.split('\n').map(Number) : [];
  } catch { return []; }
}

async function loginIfNeeded(win) {
  const login = win.locator('input[placeholder="请输入用户名"]');
  if (await login.count()) {
    await login.fill('admin');
    await win.locator('input[placeholder="请输入密码"]').fill('B2cost!9Xq');
    await win.keyboard.press('Enter');
  }
  await win.waitForSelector('text=工作台', { timeout: 30000 });
}

// 注意：Playwright 的 page.close() 会直接销毁 renderer，不触发 BrowserWindow 的
// 'close' 事件（窗口状态保存挂在该事件上）；真实用户点窗口 × 走的是
// BrowserWindow.close()。所以关窗必须用主进程的 BrowserWindow.close()。
async function closeWindow(app) {
  await app.evaluate(async ({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
}

(async () => {
  if (!fs.existsSync(LEGACY_DB)) throw new Error(`种子旧库不存在：${LEGACY_DB}（先按脚本头注释准备）`);
  // 每次运行前重置为“首次启动”状态：删 userData（窗口状态/缓存），清旧目录里的
  // 服务端运行时文件（port.txt/server.lock/server.log/-wal/-shm），只保留旧库本身。
  fs.rmSync(USER_DATA, { recursive: true, force: true });
  for (const f of ['port.txt', 'server.lock', 'server.log', 'huimin-clone.db-wal', 'huimin-clone.db-shm']) {
    fs.rmSync(path.join(HOME, '.config', 'huimin-yun', f), { force: true });
  }
  const { _electron } = require('playwright');

  const exe = MODE === 'packaged'
    ? path.join(REPO, 'dist-electron', 'linux-unpacked', 'zhanhui-jxc')
    : path.join(REPO, 'node_modules', 'electron', 'dist', 'electron');
  const args = MODE === 'packaged' ? ['--no-sandbox'] : ['.', '--no-sandbox'];
  const env = { ...process.env, HOME, ORANGE_PORT: PORT, ELECTRON_DISABLE_SANDBOX: '1' };

  // ---------- 第一次启动 ----------
  let logs = '';
  const app = await _electron.launch({ executablePath: exe, args, cwd: REPO, env });
  const proc = app.process();
  proc.stdout.on('data', (d) => { logs += d.toString(); });
  proc.stderr.on('data', (d) => { logs += d.toString(); });
  const win = await app.firstWindow({ timeout: 30000 });

  await win.waitForSelector('input[placeholder="请输入用户名"]', { timeout: 30000 });
  check('1 零配置启动：登录页可见', true);

  const ping = await win.evaluate(() => window.zhanhui.ping());
  const ver = await win.evaluate(() => window.zhanhui.getVersion());
  const pkgVer = require(path.join(REPO, 'package.json')).version;
  check('2 preload 最小 API', ping === 'pong' && ver === pkgVer, `ping=${ping} version=${ver}`);

  await waitFor(portUp, 30000, '服务端端口就绪');
  // 规则 3 的硬证据：服务端把 port.txt / server.lock 写进了旧数据目录，
  // 而不是 userData 或仓库 data/。（主进程启动日志竞争不过 stdout 监听的 attach 时机，
  // 故不用日志行断言，改用文件系统证据。）
  const portTxt = fs.existsSync(path.join(HOME, '.config', 'huimin-yun', 'port.txt'))
    ? fs.readFileSync(path.join(HOME, '.config', 'huimin-yun', 'port.txt'), 'utf8').trim() : '';
  const lockExists = fs.existsSync(path.join(HOME, '.config', 'huimin-yun', 'server.lock'));
  check('3 旧数据复用：服务端在 huimin-yun 目录落盘', portTxt === String(PORT) && lockExists, `port.txt=${portTxt} server.lock=${lockExists}`);

  await loginIfNeeded(win);
  // 工作台的数字是异步接口拉回来的（工作台文字先出现，数字随后到），要等数字出现再断言。
  let body1 = '';
  await waitFor(async () => {
    body1 = await win.locator('body').innerText();
    return body1.includes('1068') && (body1.includes('47,715.21') || body1.includes('47715.21'));
  }, 20000, '工作台种子数字出现');
  check('4 登录进工作台且显示种子数据', true, '库存总量 1068 / 货值 47715.21');

  const bounds1 = await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  check('5a 首次窗口 1280×800', bounds1.width === 1280 && bounds1.height === 800, JSON.stringify(bounds1));

  // ---------- 单实例 ----------
  const second = spawn(exe, args, { cwd: REPO, env });
  let secondOut = '';
  second.stdout.on('data', (d) => { secondOut += d.toString(); });
  second.stderr.on('data', (d) => { secondOut += d.toString(); });
  const secondExit = await new Promise((resolve) => {
    const t = setTimeout(() => { second.kill('SIGKILL'); resolve(null); }, 15000);
    second.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
  check('6 单实例：第二进程快速退出', secondExit === 0, `exit=${secondExit}，输出含“已有实例”=${secondOut.includes('已有实例在运行')}`);
  await win.waitForSelector('text=工作台', { timeout: 10000 });
  check('6b 单实例：第一窗口不受影响', true);

  // ---------- 服务端守护重启 ----------
  const pidsBefore = serverPids();
  check('7a 服务子进程存在', pidsBefore.length === 1, `pid=${pidsBefore.join(',')}`);
  if (pidsBefore.length === 1) {
    process.kill(pidsBefore[0], 'SIGTERM');
    // 先等旧进程彻底退出：端口在旧服务优雅停机完成前仍会响应，
    // 若不等它退出就测端口，会把“旧服务还活着”误判成“已恢复”。
    await waitFor(async () => !serverPids().includes(pidsBefore[0]), 15000, '旧服务进程退出');
    await waitFor(portUp, 30000, '守护重启后端口恢复');
    const pidsAfter = await waitFor(async () => {
      const p = serverPids();
      return p.length === 1 ? p : null;
    }, 15000, '新服务子进程出现');
    await win.waitForSelector('text=工作台', { timeout: 30000 });
    check('7b 守护重启：端口恢复且窗口仍显示工作台', pidsAfter[0] !== pidsBefore[0], `新 pid=${pidsAfter.join(',')}（旧 ${pidsBefore[0]}）`);
  }

  // ---------- restartServer IPC ----------
  // （主进程先回端口再刷新页面；若执行上下文仍被导航抢先销毁，视为已接受重启，
  // 以端口恢复 + 工作台重现为准，不把竞态当失败。）
  let newPort = null;
  try {
    newPort = await win.evaluate(() => window.zhanhui.restartServer());
  } catch (e) {
    if (!String(e.message).includes('Execution context was destroyed')) throw e;
  }
  check('8 restartServer IPC 返回端口', newPort === null || Number(newPort) === Number(PORT), `port=${newPort}（null = 返回被页面刷新抢先，仍以端口+工作台为准）`);
  await waitFor(portUp, 30000, 'restartServer 后端口恢复');
  await win.waitForSelector('text=工作台', { timeout: 30000 });
  check('8b restartServer 后窗口仍显示工作台', true);

  // ---------- 关闭窗口 → 干净停止 ----------
  const exitPromise = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 25000);
    proc.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
  await closeWindow(app);
  const exitCode = await exitPromise;
  check('9a 关闭窗口后主进程退出', exitCode !== null, `exit=${exitCode}`);
  await sleep(1000);
  check('9b 端口已关闭', !(await portUp()));
  const leftovers = serverPids();
  check('9c 无残留服务进程', leftovers.length === 0, `残留 pid=${leftovers.join(',')}`);
  const stateFile = path.join(USER_DATA, 'window-state.json');
  let stateOk = false;
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    stateOk = s.width === 1280 && s.height === 800;
  } catch { /* no */ }
  check('9d 窗口状态已保存（1280×800）', stateOk, fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : '文件不存在');
  const wal = LEGACY_DB + '-wal';
  const walOk = !fs.existsSync(wal) || fs.statSync(wal).size === 0;
  check('9e 服务关闭时 WAL 已 checkpoint（-wal 不存在或为空）', walOk, fs.existsSync(wal) ? `wal 大小 ${fs.statSync(wal).size}` : '无 -wal 文件');

  // ---------- 重新启动：数据完整 + 状态恢复 ----------
  let logs2 = '';
  const app2 = await _electron.launch({ executablePath: exe, args, cwd: REPO, env });
  const proc2 = app2.process();
  proc2.stdout.on('data', (d) => { logs2 += d.toString(); });
  proc2.stderr.on('data', (d) => { logs2 += d.toString(); });
  const win2 = await app2.firstWindow({ timeout: 30000 });
  await loginIfNeeded(win2);
  // 同检查 4：工作台数字是异步拉回来的，等数字出现再断言。
  let body2 = '';
  await waitFor(async () => {
    body2 = await win2.locator('body').innerText();
    return body2.includes('1068');
  }, 20000, '重启动后工作台种子数字出现');
  check('10a 重新启动：数据完整（仍显示 1068）', true);
  const bounds2 = await app2.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  let savedState = null;
  try { savedState = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* no */ }
  check('10b 重新启动：窗口恢复为保存的位置与尺寸', !!savedState
    && bounds2.width === savedState.width && bounds2.height === savedState.height
    && bounds2.x === savedState.x && bounds2.y === savedState.y,
    `当前 ${JSON.stringify(bounds2)}，保存的 ${JSON.stringify(savedState)}`);

  const exit2 = new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 25000);
    proc2.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
  await closeWindow(app2);
  await exit2;
  check('10c 第二次关闭同样干净退出', !(await portUp()) && serverPids().length === 0);

  console.log(`\n合计 ${results.length} 项，${results.filter((r) => r.ok).length} 通过，${results.filter((r) => !r.ok).length} 失败`);
  if (process.exitCode) {
    console.log('\n--- 主进程日志（第一次启动）---\n' + logs);
    console.log('\n--- 主进程日志（第二次启动）---\n' + logs2);
  }
})().catch((e) => {
  console.error('FAIL  冒烟脚本异常：', e.message);
  process.exit(1);
});
