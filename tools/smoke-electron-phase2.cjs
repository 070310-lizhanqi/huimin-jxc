'use strict';
/**
 * 第二阶段冒烟测试（headless，跑在 xvfb-run 下）：
 *   xvfb-run -a node tools/smoke-electron-phase2.cjs [--mode dev|packaged]
 *
 * 环境：HOME 指向一个临时目录（内含 .config/huimin-yun/huimin-clone.db 旧数据，
 * 由种子脚本预先生成：鲜果批发部账套，库存总量 1068、货值 ¥47,715.21）。
 * 端口默认 17741（ORANGE_PORT），避免与本机其他服务冲突。
 * ZHANHUI_SMOKE=1 挂载主进程只读探针 globalThis.__zhanhuiTest（托盘状态/菜单点击）；
 * ZHANHUI_SMOKE_DOWNLOAD_DIR 让下载跳过原生保存对话框（headless 下点不了），
 * 直接落到指定目录——生产环境不走这条路。
 *
 * 覆盖的验收点（第二阶段）：
 *  1 托盘创建成功（日志 P2:TRAY_OK，探针 trayExists）
 *  2 托盘菜单六项中文齐全（打开主窗口/重启服务/打开数据目录/打开日志文件/打开开发者工具/退出）
 *  3 点关闭 → 窗口藏到托盘（不可见），应用进程活着、端口还通、服务子进程还在
 *  4 首次进托盘提示标记落盘（userData/tray-hint.json），第二次关闭不再重复提示
 *  5 托盘菜单“打开主窗口” → 窗口恢复可见，工作台还在
 *  6 打印子窗口：window.open('', '_blank') 在应用内开子窗口（带 preload，内容写得进去），关闭即销毁
 *  7 外链拦截：window.open('https://…') 不开新窗口，主窗口地址不变
 *  8 下载接管：复刻 api.download 的 fetch+blob+a.click 流程，文件落到下载目录
 *  9 托盘菜单“重启服务” → 返回端口，窗口重载后仍显示工作台
 * 10 托盘菜单“退出” → 主进程退出、端口关闭、无残留服务进程、-wal 已 checkpoint
 * 11 重新启动：数据完整（仍显示 1068），窗口状态恢复
 *
 * 明确不在 headless 下验证（需 Windows 真机或人工）：
 *  - 托盘图标在系统托盘区的实际显示、气泡提示的实际弹出、右键菜单的真实点击
 *    （Xvfb 下没有托盘宿主与通知服务；本脚本用主进程日志 + 探针验证创建与回调，
 *    真实点击路径在 Windows 上由人工点一遍）
 *  - 保存对话框 / 下载完成提示框的真实交互（headless 下点不了原生对话框；
 *    本脚本走 ZHANHUI_SMOKE_DOWNLOAD_DIR 绕过对话框，验证落盘逻辑）
 *  - 打印对话框本身（window.print() 的原生打印 UI 不在冒烟里点）
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
const HINT_FLAG = path.join(USER_DATA, 'tray-hint.json');
const DOWNLOAD_DIR = process.env.ZHANHUI_SMOKE_DOWNLOAD_DIR || '/tmp/phase2-smoke/downloads';
const EXPECTED_MENU = ['打开主窗口', '重启服务', '打开数据目录', '打开日志文件', '打开开发者工具', '退出'];

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
// 'close' 事件（窗口状态保存与关闭进托盘都挂在该事件上）；真实用户点窗口 × 走的是
// BrowserWindow.close()。所以关窗必须用主进程的 BrowserWindow.close()。
async function closeWindow(app) {
  await app.evaluate(async ({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
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

(async () => {
  if (!fs.existsSync(LEGACY_DB)) throw new Error(`种子旧库不存在：${LEGACY_DB}（先按脚本头注释准备）`);
  // 每次运行前重置为“首次启动”状态：删 userData（窗口状态/缓存/托盘提示标记），
  // 清旧目录里的服务端运行时文件（port.txt/server.lock/server.log/-wal/-shm），只保留旧库本身。
  fs.rmSync(USER_DATA, { recursive: true, force: true });
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  for (const f of ['port.txt', 'server.lock', 'server.log', 'huimin-clone.db-wal', 'huimin-clone.db-shm']) {
    fs.rmSync(path.join(HOME, '.config', 'huimin-yun', f), { force: true });
  }
  const { _electron } = require('playwright');

  const exe = MODE === 'packaged'
    ? path.join(REPO, 'dist-electron', 'linux-unpacked', 'zhanhui-jxc')
    : path.join(REPO, 'node_modules', 'electron', 'dist', 'electron');
  const args = MODE === 'packaged' ? ['--no-sandbox'] : ['.', '--no-sandbox'];
  const env = {
    ...process.env, HOME, ORANGE_PORT: PORT, ELECTRON_DISABLE_SANDBOX: '1',
    ZHANHUI_SMOKE: '1', ZHANHUI_SMOKE_DOWNLOAD_DIR: DOWNLOAD_DIR,
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

  await waitFor(() => logs.includes('P2:TRAY_OK'), 15000, '托盘创建日志 P2:TRAY_OK');
  check('1 托盘创建成功（日志 P2:TRAY_OK）', logs.includes('P2:TRAY_OK'));
  const trayExists = await testHook(app, 'trayExists()');
  check('1b 托盘探针存在', trayExists === true, `trayExists=${trayExists}`);
  const menuLabels = await testHook(app, 'trayMenuLabels()');
  check('2 托盘菜单六项中文齐全', JSON.stringify(menuLabels) === JSON.stringify(EXPECTED_MENU), JSON.stringify(menuLabels));

  await loginIfNeeded(win);
  let body1 = '';
  await waitFor(async () => {
    body1 = await win.locator('body').innerText();
    return body1.includes('1068') && (body1.includes('47,715.21') || body1.includes('47715.21'));
  }, 20000, '工作台种子数字出现');
  check('2b 登录进工作台且显示种子数据', true, '库存总量 1068 / 货值 47715.21');

  // ---------- 关闭进托盘 ----------
  await closeWindow(app);
  await waitFor(() => testHook(app, 'isHiddenToTray()'), 10000, '窗口藏进托盘');
  const hidden = await testHook(app, 'isHiddenToTray()');
  const visible = await testHook(app, 'windowVisible()');
  check('3 点关闭 → 窗口藏到托盘（不可见）', hidden === true && visible === false, `hidden=${hidden} visible=${visible}`);
  check('3b 藏托盘后应用进程还活着', proc.exitCode === null, `exitCode=${proc.exitCode}`);
  check('3c 藏托盘后端口还通', await portUp());
  check('3d 藏托盘后服务子进程还在', serverPids().length === 1, `pid=${serverPids().join(',')}`);
  check('4 首次进托盘提示标记落盘', fs.existsSync(HINT_FLAG), fs.existsSync(HINT_FLAG) ? fs.readFileSync(HINT_FLAG, 'utf8') : '文件不存在');

  // ---------- 托盘恢复 ----------
  await testHook(app, "clickTrayMenu('打开主窗口')");
  await waitFor(() => testHook(app, 'windowVisible()'), 10000, '托盘恢复窗口可见');
  const visible2 = await testHook(app, 'windowVisible()');
  check('5 托盘菜单“打开主窗口”恢复窗口', visible2 === true);
  await win.waitForSelector('text=工作台', { timeout: 10000 });
  check('5b 恢复后工作台还在', true);

  // 第二次关闭：仍进托盘，但提示只给一次。
  await closeWindow(app);
  await waitFor(() => testHook(app, 'isHiddenToTray()'), 10000, '第二次关闭进托盘');
  const hintCount = (logs.match(/P2:TRAY_HINT_SHOWN/g) || []).length;
  check('4b 第二次关闭不再重复提示', hintCount === 1, `P2:TRAY_HINT_SHOWN 出现 ${hintCount} 次`);
  await testHook(app, "clickTrayMenu('打开主窗口')");
  await waitFor(() => testHook(app, 'windowVisible()'), 10000, '第二次托盘恢复');

  // ---------- 打印子窗口 ----------
  const opened = await win.evaluate(() => {
    const w = window.open('', '_blank');
    if (!w) return false;
    w.document.write('<html><head><title>打印测试</title></head><body><h1>打印测试内容</h1></body></html>');
    w.document.close();
    return true;
  });
  check('6a window.open 空白页返回窗口对象', opened === true);
  const childCount = await testHook(app, 'childWindowCount()');
  check('6b 打印子窗口在应用内打开（子窗口数 1）', childCount === 1, `childWindowCount=${childCount}`);
  const childInfo = await app.evaluate(async ({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows();
    const child = wins.find((w) => w.webContents.getURL() === 'about:blank');
    if (!child) return null;
    return {
      ping: await child.webContents.executeJavaScript('window.zhanhui ? window.zhanhui.ping() : "no-preload"'),
      text: await child.webContents.executeJavaScript('document.body ? document.body.innerText : ""'),
      parent: !!child.getParentWindow(),
    };
  });
  check('6c 子窗口带 preload（ping=pong）', !!childInfo && childInfo.ping === 'pong', JSON.stringify(childInfo));
  check('6d 子窗口内容写得进去', !!childInfo && childInfo.text.includes('打印测试内容'), childInfo ? childInfo.text : '无子窗口');
  check('6e 子窗口挂在主窗口下（parent）', !!childInfo && childInfo.parent === true);
  await app.evaluate(async ({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .filter((w) => w.webContents.getURL() === 'about:blank')
      .forEach((w) => w.close());
  });
  await waitFor(() => testHook(app, 'childWindowCount()').then((n) => n === 0), 10000, '子窗口关闭');
  check('6f 子窗口关闭即销毁', (await testHook(app, 'childWindowCount()')) === 0);

  // ---------- 外链拦截 ----------
  const urlBefore = win.url();
  await win.evaluate(() => { window.open('https://example.com', '_blank'); return true; });
  await sleep(1000);
  const childCount2 = await testHook(app, 'childWindowCount()');
  check('7 外链不开新窗口', childCount2 === 0, `childWindowCount=${childCount2}`);
  check('7b 外链后主窗口地址不变', win.url() === urlBefore, `${win.url()} vs ${urlBefore}`);

  // ---------- 下载接管 ----------
  const dlName = await win.evaluate(async () => {
    // /api/doc/export 要求 teamId（与前端 13-doc.js 的导出调用一致）；
    // 团队 id 取登录后前端存在 localStorage 里的 oc_teamId。
    const teamId = localStorage.getItem('oc_teamId') || '1';
    const r = await fetch(`/api/doc/export?teamId=${encodeURIComponent(teamId)}`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const cd = r.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    const name = m ? decodeURIComponent(m[1].replace(/"/g, '')) : 'doc-export.csv';
    // 与产品 api.download 同款：先把文件名预告给主进程（blob: 下载的主进程拿不到 <a download> 的名字）。
    if (window.zhanhui && typeof window.zhanhui.setDownloadFilename === 'function') {
      window.zhanhui.setDownloadFilename(name);
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    requestAnimationFrame(() => URL.revokeObjectURL(url));
    return name;
  });
  const dlFile = await waitFor(() => {
    const p = path.join(DOWNLOAD_DIR, dlName);
    return fs.existsSync(p) && fs.statSync(p).size > 0 ? p : null;
  }, 20000, '下载文件落盘');
  check('8 下载接管：文件落到下载目录', !!dlFile, `${dlName}（${dlFile ? fs.statSync(dlFile).size : 0} 字节）`);

  // ---------- 托盘重启服务 ----------
  let newPort = null;
  try {
    newPort = await testHook(app, "clickTrayMenu('重启服务')");
  } catch (e) {
    if (!String(e.message).includes('Execution context was destroyed')) throw e;
  }
  check('9 托盘菜单“重启服务”返回端口', newPort === null || Number(newPort) === Number(PORT), `port=${newPort}（null = 返回被页面刷新抢先，仍以端口+工作台为准）`);
  await waitFor(portUp, 30000, '托盘重启后端口恢复');
  await win.waitForSelector('text=工作台', { timeout: 30000 });
  check('9b 托盘重启后窗口仍显示工作台', true);

  // ---------- 托盘退出 ----------
  try {
    await app.evaluate(() => { globalThis.__zhanhuiTest.clickTrayMenu('退出'); });
  } catch (e) {
    // 进程退出时 evaluate 的连接可能先断，属正常：以进程退出为准。
  }
  const exitCode = await waitProcExit(proc);
  check('10a 托盘菜单“退出”后主进程退出', exitCode !== null, `exit=${exitCode}`);
  await sleep(1000);
  check('10b 端口已关闭', !(await portUp()));
  const leftovers = serverPids();
  check('10c 无残留服务进程', leftovers.length === 0, `残留 pid=${leftovers.join(',')}`);
  const wal = LEGACY_DB + '-wal';
  const walOk = !fs.existsSync(wal) || fs.statSync(wal).size === 0;
  check('10d 服务关闭时 WAL 已 checkpoint（-wal 不存在或为空）', walOk, fs.existsSync(wal) ? `wal 大小 ${fs.statSync(wal).size}` : '无 -wal 文件');

  // ---------- 重新启动：数据完整 + 状态恢复 ----------
  let logs2 = '';
  const app2 = await _electron.launch({ executablePath: exe, args, cwd: REPO, env });
  const proc2 = app2.process();
  proc2.stdout.on('data', (d) => { logs2 += d.toString(); });
  proc2.stderr.on('data', (d) => { logs2 += d.toString(); });
  const win2 = await app2.firstWindow({ timeout: 30000 });
  await loginIfNeeded(win2);
  let body2 = '';
  await waitFor(async () => {
    body2 = await win2.locator('body').innerText();
    return body2.includes('1068');
  }, 20000, '重启动后工作台种子数字出现');
  check('11a 重新启动：数据完整（仍显示 1068）', true);
  const stateFile = path.join(USER_DATA, 'window-state.json');
  check('11b 窗口状态文件存在', fs.existsSync(stateFile));

  try {
    await app2.evaluate(() => { globalThis.__zhanhuiTest.clickTrayMenu('退出'); });
  } catch { /* 进程退出时连接先断属正常 */ }
  await waitProcExit(proc2);
  check('11c 第二次退出同样干净', !(await portUp()) && serverPids().length === 0);

  console.log(`\n合计 ${results.length} 项，${results.filter((r) => r.ok).length} 通过，${results.filter((r) => !r.ok).length} 失败`);
  if (process.exitCode) {
    console.log('\n--- 主进程日志（第一次启动）---\n' + logs);
    console.log('\n--- 主进程日志（第二次启动）---\n' + logs2);
  }
})().catch((e) => {
  console.error('FAIL  冒烟脚本异常：', e.message);
  process.exit(1);
});
