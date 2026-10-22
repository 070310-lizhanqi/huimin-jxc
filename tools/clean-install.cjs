#!/usr/bin/env node
/**
 * 彻底清除工具：卸载之外的「清干净」入口。
 *
 * 卸载（unins000.exe）只删程序文件，**账套数据目录默认保留**——这是刻意的，
 * 避免用户误删数据。想要连数据、快捷方式、注册表一起清干净时跑这个脚本：
 *
 *   node tools/clean-install.cjs          # 交互确认后清除
 *   node tools/clean-install.cjs --yes    # 不再询问，直接清除（谨慎）
 *
 * 清除范围：
 *   1) 安装目录（%LOCALAPPDATA%\OrangeJXC，或注册表里记录的路径）
 *   2) 数据目录（%APPDATA%\orange-jxc）—— 账套数据，不可恢复
 *   3) 桌面 / 开始菜单快捷方式
 *   4) 卸载注册表项
 *   5) 残留的 node 进程（先停启动器再停服务，顺序不能反）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ASSUME_YES = process.argv.includes('--yes');
const APP_ID = '{8A3E1C62-5B7D-4B8E-9A21-ORANGEJXC001}_is1';
const APP_NAME = '橙子进销存';

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const APPDATA = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

const DATA_DIR = path.join(APPDATA, 'orange-jxc');
const DEFAULT_INSTALL_DIR = path.join(LOCALAPPDATA, 'OrangeJXC');
// 桌面路径必须用系统 API 取：OneDrive 重定向后桌面可能不在 %USERPROFILE%\Desktop
// （实测本机桌面在 D:\HP-Li\Desktop），写死 USERPROFILE 会漏删快捷方式。
function systemFolder(name) {
  try {
    const ps = `[Environment]::GetFolderPath('${name}')`;
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
    if (out) return out;
  } catch { /* ignore */ }
  return null;
}
const DESKTOP = systemFolder('Desktop') ||
  (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop') : path.join(HOME, 'Desktop'));
// 开始菜单同理用系统 API 取（同样可能被重定向）
const START_MENU = systemFolder('Programs') ||
  path.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');

/** 从注册表读实际安装目录（用户可能装到了自定义路径） */
function installedDirFromRegistry() {
  for (const base of [
    'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]) {
    try {
      const ps = `Get-ItemProperty '${base}\\${APP_ID}' -ErrorAction SilentlyContinue | ` +
        "Select-Object -ExpandProperty InstallLocation";
      const out = execFileSync('powershell', ['-NoProfile', '-Command', ps],
        { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
      if (out) return out;
    } catch { /* 该键不存在，继续找 */ }
  }
  return null;
}

/** 结束属于本应用目录下的 node 进程：先启动器（守护），再服务 */
function stopAppProcesses(appDirs) {
  const killed = [];
  let rows = [];
  try {
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "ForEach-Object { Write-Output ($_.ProcessId.ToString() + '|' + $_.CommandLine) }";
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    rows = String(out).split(/\r?\n/).filter(Boolean).map((line) => {
      const i = line.indexOf('|');
      return { pid: Number(line.slice(0, i)), cmd: line.slice(i + 1).replace(/\\/g, '/').toLowerCase() };
    });
  } catch { /* 查不到就靠 pid 文件 */ }

  const needles = appDirs.filter(Boolean).map((d) => path.resolve(d).replace(/\\/g, '/').toLowerCase());
  const mine = rows.filter((r) => r.pid && needles.some((n) => r.cmd.includes(n)) &&
    (r.cmd.includes('launcher.cjs') || r.cmd.includes('dist/server/index.js')));

  const kill = (pid) => {
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); killed.push(pid); }
    catch { /* 已退出 */ }
  };
  // 先杀启动器（守护进程），否则它会把服务复活
  for (const r of mine.filter((x) => x.cmd.includes('launcher.cjs'))) kill(r.pid);
  for (const r of mine.filter((x) => !x.cmd.includes('launcher.cjs'))) kill(r.pid);
  return killed;
}

function rmrf(p) {
  if (!p || !fs.existsSync(p)) return false;
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    return !fs.existsSync(p);
  } catch {
    return false;
  }
}

function rmLnk(dir, name) {
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return false;
  try { fs.rmSync(p, { force: true }); return true; } catch { return false; }
}

(async () => {
  const installDir = installedDirFromRegistry() || DEFAULT_INSTALL_DIR;
  const appDirs = [installDir, DEFAULT_INSTALL_DIR];

  console.log('========== 彻底清除 ' + APP_NAME + ' ==========');
  console.log('安装目录：' + installDir);
  console.log('数据目录：' + DATA_DIR + '（账套数据，删除不可恢复）');

  if (!ASSUME_YES) {
    console.log('\n这会删除程序文件、账套数据、快捷方式与注册表项。');
    const answer = (process.argv.find((a) => a.startsWith('--confirm=')) || '').split('=')[1];
    if (answer !== 'YES') {
      console.log('如确认清除，请加参数重跑：node tools/clean-install.cjs --confirm=YES');
      process.exit(1);
    }
  }

  // 1) 停进程（先启动器后服务）
  const killed = stopAppProcesses(appDirs);
  console.log(`\n[1/5] 已停止 ${killed.length} 个进程` + (killed.length ? '（' + killed.join(', ') + '）' : ''));

  // 2) 快捷方式（桌面在系统 API 取到的真实路径；开始菜单是 Inno 建的一整个文件夹）
  const lnks = [
    rmLnk(DESKTOP, APP_NAME + '.lnk'),
    rmrf(path.join(START_MENU, APP_NAME)),
  ];
  console.log(`[2/5] 快捷方式清理：桌面 ${lnks[0] ? '已删' : '无'} / 开始菜单 ${lnks[1] ? '已删' : '无'}`);
  console.log(`      （桌面路径：${DESKTOP}）`);

  // 3) 注册表
  let regDone = false;
  try {
    const ps = `Remove-Item 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}' ` +
      "-ErrorAction SilentlyContinue; " +
      `Remove-Item 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}' ` +
      "-ErrorAction SilentlyContinue";
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore', windowsHide: true });
    regDone = true;
  } catch { /* ignore */ }
  console.log(`[3/5] 卸载注册表项：${regDone ? '已清理' : '未找到或无权（可手动删除）'}`);

  // 4) 安装目录
  let dirDone = true;
  for (const d of appDirs) {
    if (!d) continue;
    if (fs.existsSync(d)) {
      const okd = rmrf(d);
      dirDone = dirDone && okd;
      console.log(`[4/5] 安装目录 ${d}：${okd ? '已删除' : '删除失败（可能有文件被占用，请重启后重试）'}`);
    }
  }
  if (dirDone) console.log('[4/5] 安装目录清理完成');

  // 5) 数据目录
  const dataDone = rmrf(DATA_DIR);
  console.log(`[5/5] 数据目录：${dataDone ? '已删除' : (fs.existsSync(DATA_DIR) ? '删除失败（服务可能仍在跑）' : '已删除')}`);

  console.log('\n完成。');
})();
