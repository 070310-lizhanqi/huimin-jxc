#!/usr/bin/env node
/**
 * 卸载前清理：停止服务与启动器，清掉 pid/锁等运行期文件。
 *
 * 要停两类进程：
 *   1) launcher.cjs —— 守护进程（supervisor）。它的循环每 2 秒检查一次服务存活，
 *      服务一没就立刻重新拉起。
 *   2) dist/server/index.js —— 服务进程本身。
 * 必须**先停启动器再停服务**：反过来先杀服务，启动器会在被杀之前把服务复活，
 * 结果卸载完机器上还留着跑着的服务，而安装目录已被删掉。
 *
 * pid 文件可能落在两处（都要找）：
 *   - 数据目录 %APPDATA%\huimin-yun\{launcher,server}.pid
 *   - 安装目录 {app}\.tools\server.pid（服务端自写，与启动器无关）
 * 两者都找不到时，退化为「按端口找监听进程」兜底。
 *
 * 数据目录默认保留——账套数据删了就没了；是否连带删除由安装包的
 * 「同时删除数据目录」附加任务决定（见 installer/huimin-yun.iss）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const DATA_DIRS = [
  process.env.ORANGE_DATA_DIR,
  process.env.APPDATA ? path.join(process.env.APPDATA, 'huimin-yun') : null,
  // 旧品牌名目录（还没升级的老用户数据在这，也要能停掉/清理）
  process.env.APPDATA ? path.join(process.env.APPDATA, 'orange-jxc') : null,
  path.join(APP_DIR, 'data'),
].filter(Boolean);

/** 结束进程：先温和 terminate，超时再强杀 */
function killPid(pid) {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid); // SIGTERM
  } catch {
    return false; // 已退出
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // 已退出
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
    console.log('[卸载] 已强制结束进程 ' + pid);
  } catch { /* 已退出 */ }
  return true;
}

/** 按 pid 文件找进程 */
function pidsFromFile(file) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    return pid > 0 ? [pid] : [];
  } catch {
    return [];
  }
}

/** 兜底：按命令行特征找出属于本应用的 node 进程。返回 {launcher:[], server:[]} */
function pidsByCommandLine() {
  const launcher = [];
  const server = [];
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "ForEach-Object { Write-Output ($_.ProcessId.ToString() + '|' + $_.CommandLine) }",
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    // 归一化：统一小写 + 把反斜杠换成正斜杠再比对。
    // （早前用 replace(/\\/g,'\\\\') 反而把路径弄成了双反斜杠，永远匹配不上）
    const needle = APP_DIR.replace(/\\/g, '/').toLowerCase();
    for (const line of String(out).split(/\r?\n/)) {
      const i = line.indexOf('|');
      if (i < 0) continue;
      const pid = Number(line.slice(0, i));
      const cmd = line.slice(i + 1).replace(/\\/g, '/').toLowerCase();
      if (!pid) continue;
      // 只认本应用目录下的，避免误杀别的 node 服务
      if (!cmd.includes(needle)) continue;
      if (cmd.includes('launcher.cjs')) launcher.push(pid);
      else if (cmd.includes('dist/server/index.js')) server.push(pid);
    }
  } catch { /* 查询失败就算了，靠 pid 文件那条路 */ }
  return { launcher, server };
}

const killed = new Set();
function killOnce(pid, label) {
  if (!pid || killed.has(pid)) return;
  if (killPid(pid)) {
    killed.add(pid);
    console.log(`[卸载] 已停止${label}进程 ${pid}`);
  }
}

// ---------- 第 1 轮：先停启动器（守护进程），必须最先 ----------
const byCmd = pidsByCommandLine();
for (const dir of DATA_DIRS) {
  for (const pid of pidsFromFile(path.join(dir, 'launcher.pid'))) killOnce(pid, '启动器');
}
for (const pid of byCmd.launcher) killOnce(pid, '启动器');
// 清理 pid 文件，防止下次读到旧 pid
for (const dir of DATA_DIRS) {
  try { fs.rmSync(path.join(dir, 'launcher.pid'), { force: true }); } catch { /* ignore */ }
}
// 给守护进程一点退出时间，避免它在被杀前把服务复活
const graceDeadline = Date.now() + 1500;
while (Date.now() < graceDeadline) { /* 短暂等待 */ }

// ---------- 第 2 轮：再停服务 ----------
for (const dir of DATA_DIRS) {
  for (const pid of pidsFromFile(path.join(dir, 'server.pid'))) killOnce(pid, '服务');
}
// 服务端自写的 pid 在安装目录 .tools\ 下
for (const pid of pidsFromFile(path.join(APP_DIR, '.tools', 'server.pid'))) killOnce(pid, '服务');
for (const pid of byCmd.server) killOnce(pid, '服务');
for (const dir of DATA_DIRS) {
  try { fs.rmSync(path.join(dir, 'server.pid'), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(dir, 'server.lock'), { force: true }); } catch { /* ignore */ }
}

// ---------- 收尾：清掉安装目录内的运行期产物 ----------
try {
  for (const f of fs.readdirSync(path.join(APP_DIR, '.tools'))) {
    if (f.endsWith('.pid') || f.endsWith('.log')) {
      try { fs.rmSync(path.join(APP_DIR, '.tools', f), { force: true }); } catch { /* ignore */ }
    }
  }
} catch { /* 无 .tools 目录 */ }

console.log(`[卸载] 共停止 ${killed.size} 个进程；运行期文件已清理。`);
console.log('[卸载] 数据目录保留：' + (process.env.APPDATA ? path.join(process.env.APPDATA, 'huimin-yun') : '(见安装说明)'));
