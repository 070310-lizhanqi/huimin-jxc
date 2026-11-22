'use strict';
/**
 * 第三阶段冒烟测试（headless，跑在 xvfb-run 下）：
 *   xvfb-run -a node tools/smoke-electron-phase3.cjs [--mode dev|packaged]
 *
 * 环境：HOME 指向一个临时目录（内含 .config/huimin-yun/huimin-clone.db 旧数据，
 * 由种子脚本预先生成：鲜果批发部账套，库存总量 1068、货值 ¥47,715.21）。
 * 端口默认 17741（ORANGE_PORT），避免与本机其他服务冲突。
 * ZHANHUI_SMOKE=1 挂载主进程只读探针 globalThis.__zhanhuiTest；
 * ZHANHUI_SMOKE_UPDATE=1 让更新检查不弹任何原生对话框（headless 下点不了），
 * 只记日志并返回结果——生产环境不走这条路。
 *
 * 更新源：本脚本自带一个本地 HTTP 服务，模拟 electron-updater 的 generic
 * provider（latest.yml 三种场景）：
 *   /same/latest.yml    版本 = 当前版（0.5.3）→ 无更新
 *   /new/latest.yml     版本 9.9.9 → 有新版（只测到“发现新版”，不真下载）
 *   /missing/latest.yml 404 → 检查失败
 * 探针 setUpdateFeed(url) 在运行时切换更新源；生产环境的更新源是 GitHub
 * Releases（package.json 的 build.publish），端到端下载安装只能在 Windows
 * runner 上验（见 .github/workflows/release.yml 的安装冒烟步骤）。
 *
 * 覆盖的验收点（第三阶段）：
 *  0 零配置启动：登录页可见
 *  1 自动更新模块就绪（日志 P3:UPDATER_READY）
 *  2 托盘菜单七项中文齐全（含“检查更新”，在“打开日志文件”与“打开开发者工具”之间）
 *  3 手动检查 + 同版本源 → 无更新（日志 P3:UPDATE_NOT_AVAILABLE，探针 status=not-available）
 *  4 手动检查 + 新版本源 → 发现新版 9.9.9（日志 P3:UPDATE_AVAILABLE，探针 status=available）
 *  5 后台检查触发 + 同版本源 → 静默无更新（不崩溃、不弹框）
 *  6 手动检查 + 404 源 → 检查失败（日志 P3:UPDATE_ERROR，探针 status=error），应用不崩
 *  7 未下载完成时 installUpdate 返回 false（什么都不做，不重启）
 *  8 渲染进程 preload 有 checkForUpdates（window.zhanhui.checkForUpdates 是函数）
 *  9 托盘菜单“退出” → 主进程退出、端口关闭、无残留服务进程、-wal 已 checkpoint
 * 10 重新启动：数据完整（仍显示 1068），第二次退出同样干净
 *
 * 明确不在 headless 下验证（需 Windows runner 或人工）：
 *  - 真实 GitHub Releases 的 latest.yml 拉取、安装包下载、重启安装后版本号变化
 *  - 更新提示对话框的真实点击（headless 下点不了原生对话框；本脚本跳过对话框，
 *    验证检查逻辑与结果）
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const HOME = process.env.SMOKE_HOME || '/tmp/phase1-smoke/home';
const PORT = process.env.ORANGE_PORT || '17741';
const MODE = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=dev').slice(7);
const LEGACY_DB = path.join(HOME, '.config', 'huimin-yun', 'huimin-clone.db');
// Electron 的 userData 目录名取自 package.json 的 name（不是产品名）。
const USER_DATA = path.join(HOME, '.config', require(path.join(REPO, 'package.json')).name);
const CURRENT_VERSION = require(path.join(REPO, 'package.json')).version;
const EXPECTED_MENU = ['打开主窗口', '重启服务', '打开数据目录', '打开日志文件', '检查更新', '打开开发者工具', '退出'];

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

async function testHook(app, expr) {
  return app.evaluate(new Function(`return globalThis.__zhanhuiTest.${expr};`));
}
async function waitProcExit(proc, timeoutMs = 25000) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve(proc.exitCode);
    const t = setTimeout(() => resolve(null), timeoutMs);
    proc.on('exit', (code) => { clearTimeout(t); resolve(code); });
  });
}

/** 本地 latest.yml 服务：/same（同版本）、/new（新版 9.9.9）、其它 404。 */
function startFeedServer() {
  const dummy = Buffer.from('fake-installer-bytes');
  const sha512 = crypto.createHash('sha512').update(dummy).digest('base64');
  const latestYml = (version) => [
    `version: ${version}`,
    'files:',
    `  - url: 展惠进销存-Setup-${version}.exe`,
    `    sha512: ${sha512}`,
    `    size: ${dummy.length}`,
    `path: 展惠进销存-Setup-${version}.exe`,
    `sha512: ${sha512}`,
    "releaseDate: '2026-11-22T00:00:00.000Z'",
    '',
  ].join('\n');
  const server = http.createServer((req, res) => {
    // 注意：generic provider 在 Linux 下拉的是 latest-linux.yml（Windows 下是
    // latest.yml，macOS 下是 latest-mac.yml），所以按目录前缀匹配，不按文件名。
    if (req.url.startsWith('/same/')) {
      res.writeHead(200, { 'content-type': 'text/yaml' });
      res.end(latestYml(CURRENT_VERSION));
    } else if (req.url.startsWith('/new/')) {
      res.writeHead(200, { 'content-type': 'text/yaml' });
      res.end(latestYml('9.9.9'));
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

(async () => {
  if (!fs.existsSync(LEGACY_DB)) throw new Error(`种子旧库不存在：${LEGACY_DB}（先按脚本头注释准备）`);
  // 每次运行前重置为“首次启动”状态：删 userData，只保留旧库本身。
  fs.rmSync(USER_DATA, { recursive: true, force: true });
  for (const f of ['port.txt', 'server.lock', 'server.log', 'huimin-clone.db-wal', 'huimin-clone.db-shm']) {
    fs.rmSync(path.join(HOME, '.config', 'huimin-yun', f), { force: true });
  }
  const { server: feedServer, base: feedBase } = await startFeedServer();
  const { _electron } = require('playwright');

  const exe = MODE === 'packaged'
    ? path.join(REPO, 'dist-electron', 'linux-unpacked', 'zhanhui-jxc')
    : path.join(REPO, 'node_modules', 'electron', 'dist', 'electron');
  const args = MODE === 'packaged' ? ['--no-sandbox'] : ['.', '--no-sandbox'];
  const env = {
    ...process.env, HOME, ORANGE_PORT: PORT, ELECTRON_DISABLE_SANDBOX: '1',
    ZHANHUI_SMOKE: '1', ZHANHUI_SMOKE_UPDATE: '1',
  };

  // ---------- 第一次启动 ----------
  let logs = '';
  const app = await _electron.launch({ executablePath: exe, args, cwd: REPO, env });
  const proc = app.process();
  proc.stdout.on('data', (d) => { logs += d.toString(); });
  proc.stderr.on('data', (d) => { logs += d.toString(); });
  const win = await app.firstWindow({ timeout: 30000 });

  await win.waitForSelector('input[placeholder="请输入用户名"]', { timeout: 30000 });
  check('0 零配置启动：登录页可见', true);

  await waitFor(() => logs.includes('P3:UPDATER_READY'), 15000, '更新模块就绪日志 P3:UPDATER_READY');
  check('1 自动更新模块就绪（日志 P3:UPDATER_READY）', logs.includes('P3:UPDATER_READY'));
  const menuLabels = await testHook(app, 'trayMenuLabels()');
  check('2 托盘菜单七项中文齐全（含检查更新）', JSON.stringify(menuLabels) === JSON.stringify(EXPECTED_MENU), JSON.stringify(menuLabels));

  await loginIfNeeded(win);
  let body1 = '';
  await waitFor(async () => {
    body1 = await win.locator('body').innerText();
    return body1.includes('1068') && (body1.includes('47,715.21') || body1.includes('47715.21'));
  }, 20000, '工作台种子数字出现');
  check('2b 登录进工作台且显示种子数据', true, '库存总量 1068 / 货值 47715.21');

  // ---------- 3. 手动检查：同版本 → 无更新 ----------
  await testHook(app, `setUpdateFeed('${feedBase}/same/')`);
  const rSame = await testHook(app, "clickTrayMenu('检查更新')");
  check('3 手动检查 + 同版本源 → 无更新', rSame && rSame.status === 'not-available', JSON.stringify(rSame));
  check('3b 无更新日志 P3:UPDATE_NOT_AVAILABLE', logs.includes('P3:UPDATE_NOT_AVAILABLE'));

  // ---------- 4. 手动检查：新版本 → 发现新版 ----------
  await testHook(app, `setUpdateFeed('${feedBase}/new/')`);
  const rNew = await testHook(app, "clickTrayMenu('检查更新')");
  check('4 手动检查 + 新版本源 → 发现新版 9.9.9', rNew && rNew.status === 'available' && rNew.version === '9.9.9', JSON.stringify(rNew));
  check('4b 发现新版日志 P3:UPDATE_AVAILABLE 9.9.9', logs.includes('P3:UPDATE_AVAILABLE 9.9.9'));

  // ---------- 5. 后台检查：同版本 → 静默无更新 ----------
  await testHook(app, `setUpdateFeed('${feedBase}/same/')`);
  const rBg = await testHook(app, 'triggerBackgroundCheck()');
  check('5 后台检查 + 同版本源 → 静默无更新', rBg && rBg.status === 'not-available', JSON.stringify(rBg));
  const notAvailCount = (logs.match(/P3:UPDATE_NOT_AVAILABLE/g) || []).length;
  check('5b 后台检查也记了无更新日志', notAvailCount >= 2, `P3:UPDATE_NOT_AVAILABLE 出现 ${notAvailCount} 次`);

  // ---------- 6. 手动检查：404 源 → 检查失败，应用不崩 ----------
  await testHook(app, `setUpdateFeed('${feedBase}/missing/')`);
  const rErr = await testHook(app, "clickTrayMenu('检查更新')");
  check('6 手动检查 + 404 源 → 检查失败', rErr && rErr.status === 'error', JSON.stringify(rErr));
  check('6b 失败日志 P3:UPDATE_ERROR', logs.includes('P3:UPDATE_ERROR'));
  check('6c 检查失败后窗口还在、端口还通', (await testHook(app, 'windowVisible()')) === true && (await portUp()));

  // ---------- 7. 未下载完成时不重启 ----------
  const installed = await testHook(app, 'installUpdate()');
  check('7 未下载完成时 installUpdate 返回 false', installed === false, `installUpdate=${installed}`);
  check('7b 未重启：应用进程还活着', proc.exitCode === null, `exitCode=${proc.exitCode}`);

  // ---------- 8. 渲染进程 preload 有 checkForUpdates ----------
  const hasApi = await win.evaluate(() => typeof window.zhanhui?.checkForUpdates === 'function');
  check('8 preload 暴露 checkForUpdates', hasApi === true, `typeof=${hasApi}`);

  // ---------- 9. 托盘退出 ----------
  try {
    await app.evaluate(() => { globalThis.__zhanhuiTest.clickTrayMenu('退出'); });
  } catch (e) {
    // 进程退出时 evaluate 的连接可能先断，属正常：以进程退出为准。
  }
  const exitCode = await waitProcExit(proc);
  check('9a 托盘菜单“退出”后主进程退出', exitCode !== null, `exit=${exitCode}`);
  await sleep(1000);
  check('9b 端口已关闭', !(await portUp()));
  const leftovers = serverPids();
  check('9c 无残留服务进程', leftovers.length === 0, `残留 pid=${leftovers.join(',')}`);
  const wal = LEGACY_DB + '-wal';
  const walOk = !fs.existsSync(wal) || fs.statSync(wal).size === 0;
  check('9d 服务关闭时 WAL 已 checkpoint（-wal 不存在或为空）', walOk, fs.existsSync(wal) ? `wal 大小 ${fs.statSync(wal).size}` : '无 -wal 文件');

  // ---------- 10. 重新启动：数据完整 ----------
  let logs2 = '';
  const app2 = await _electron.launch({ executablePath: exe, args, cwd: REPO, env });
  const proc2 = app2.process();
  proc2.stdout.on('data', (d) => { logs2 += d.toString(); });
  proc2.stderr.on('data', (d) => { logs2 += d.toString(); });
  const win2 = await app2.firstWindow({ timeout: 30000 });
  await loginIfNeeded(win2);
  await waitFor(async () => {
    const b = await win2.locator('body').innerText();
    return b.includes('1068');
  }, 20000, '重启动后工作台种子数字出现');
  check('10a 重新启动：数据完整（仍显示 1068）', true);

  try {
    await app2.evaluate(() => { globalThis.__zhanhuiTest.clickTrayMenu('退出'); });
  } catch { /* 进程退出时连接先断属正常 */ }
  await waitProcExit(proc2);
  check('10b 第二次退出同样干净', !(await portUp()) && serverPids().length === 0);

  feedServer.close();
  console.log(`\n合计 ${results.length} 项，${results.filter((r) => r.ok).length} 通过，${results.filter((r) => !r.ok).length} 失败`);
  if (process.exitCode) {
    console.log('\n--- 主进程日志（第一次启动）---\n' + logs);
    console.log('\n--- 主进程日志（第二次启动）---\n' + logs2);
  }
})().catch((e) => {
  console.error('FAIL  冒烟脚本异常：', e.message);
  process.exit(1);
});
