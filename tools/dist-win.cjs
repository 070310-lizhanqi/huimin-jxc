#!/usr/bin/env node
/**
 * Windows 安装包构建流水线：pnpm run dist:win
 *
 * 步骤：
 *  1) pnpm build（tsc 编译）
 *  2) 组装 installer/payload/：应用文件（dist/web/tools/launcher/入口.cmd）
 *     + 自带 node.exe（优先取本地 .tools/node.exe，否则提示从 nodejs.org 下载放入）
 *  3) payload 内 npm install --omit=dev 装运行时依赖（express；pnpm 的符号链接结构不能直接拷）
 *  4) 写 installer/version.ini（ISS 读版本号）
 *  5) 产物自检（隔离目录独立起服务探测）+ 编译安装包；未装 Inno Setup 则产出便携版目录
 *
 * 产物：installer/out/橙子进销存-Setup-<版本>.exe 与可独立分发的 installer/payload/（便携版）
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PAYLOAD = path.join(ROOT, 'installer', 'payload');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) {
    console.error(`[dist:win] 命令失败：${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

/** 复制目录（递归，覆盖） */
function cpDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) cpDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

console.log('========== 1/5 编译 TypeScript ==========');
run('pnpm', ['build']);

console.log('========== 2/5 组装 payload ==========');
fs.rmSync(PAYLOAD, { recursive: true, force: true });
fs.mkdirSync(PAYLOAD, { recursive: true });
cpDir(path.join(ROOT, 'dist'), path.join(PAYLOAD, 'dist'));
cpDir(path.join(ROOT, 'web'), path.join(PAYLOAD, 'web'));
cpDir(path.join(ROOT, 'tools'), path.join(PAYLOAD, 'tools'));
for (const f of ['launcher.cjs', '橙子进销存.cmd', 'package.json', 'README.md']) {
  if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(PAYLOAD, f));
}
// node.exe：内置运行时（~80MB）。手工放置：把官方 zip 里的 node.exe 拷到 .tools/node.exe
const nodeSrc = path.join(ROOT, '.tools', 'node.exe');
if (fs.existsSync(nodeSrc)) {
  fs.mkdirSync(path.join(PAYLOAD, 'node'), { recursive: true });
  fs.copyFileSync(nodeSrc, path.join(PAYLOAD, 'node', 'node.exe'));
  console.log('[payload] 已内置 node.exe');
} else {
  console.warn('[payload] 未找到 .tools/node.exe —— 请从 https://nodejs.org/zh-cn 下载 LTS zip，');
  console.warn('           解压后把 node.exe 放到项目 .tools/node.exe 再重跑本脚本（否则安装包无法自带运行时）。');
}

console.log('========== 3/5 安装运行时依赖（express）==========');
// 关键：payload 必须自带 node_modules。pnpm 的 node_modules 是符号链接结构，直接 cp 会断链，
// 因此在 payload 内用 npm 单独装一次生产依赖（express 是唯一 prod 依赖，无其它传递依赖问题）。
{
  // payload 内的 package.json 只保留生产依赖，避免 npm 去装 devDependencies
  const payloadPkg = {
    name: 'orange-jxc-payload',
    version: pkg.version,
    private: true,
    type: 'commonjs',
    dependencies: pkg.dependencies,
  };
  fs.writeFileSync(path.join(PAYLOAD, 'package.json'), JSON.stringify(payloadPkg, null, 2) + '\n');
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npmCmd, ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: PAYLOAD, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    console.error('[dist:win] payload 依赖安装失败，安装包将无法运行。请检查网络后重试。');
    process.exit(r.status ?? 1);
  }
  if (!fs.existsSync(path.join(PAYLOAD, 'node_modules', 'express', 'index.js'))) {
    console.error('[dist:win] payload 内未找到 express，依赖安装异常，终止。');
    process.exit(1);
  }
  console.log('[payload] 运行时依赖已就位（node_modules/express）');
}

console.log('========== 4/5 写版本信息 ==========');
fs.mkdirSync(path.join(ROOT, 'installer'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'installer', 'version.ini'),
  `[app]\nversion=${pkg.version}\n`,
);

console.log('========== 5/5 产物自检 + 编译安装包 ==========');
// 自检：把 payload 复制到临时隔离目录（模拟用户机器，杜绝向上解析到仓库 node_modules），
// 独立起服务并探测 /api/auth/status —— 这一步能挡住「产物缺依赖却交付」这类错误。
async function selfCheck() {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'orange-dist-check-'));
  try {
    cpDir(PAYLOAD, tmp);
    const checkPort = 7841;
    const checkData = path.join(tmp, 'data');
    const nodeExe = fs.existsSync(path.join(tmp, 'node', 'node.exe'))
      ? path.join(tmp, 'node', 'node.exe')
      : process.execPath;
    const child = require('node:child_process').spawn(nodeExe, [path.join(tmp, 'dist', 'server', 'index.js')], {
      cwd: tmp,
      env: { ...process.env, ORANGE_DATA_DIR: checkData, PORT: String(checkPort) },
      stdio: 'ignore',
      windowsHide: true,
    });
    // 轮询就绪（最多 15s），用 http 直接探测
    const probeOnce = () => new Promise((resolve) => {
      const req = require('node:http').get(
        { host: '127.0.0.1', port: checkPort, path: '/api/auth/status', timeout: 1500 },
        (res) => { res.resume(); resolve(res.statusCode < 500); },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    let ok = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await probeOnce()) { ok = true; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    try { child.kill(); } catch { /* ignore */ }
    if (!ok) {
      console.error('[dist:win] ❌ 产物自检失败：隔离目录中的服务未能启动（缺依赖/入口错误）。');
      console.error('           已阻止交付。请检查上面的 payload 组装与依赖安装步骤。');
      process.exit(1);
    }
    console.log('[自检] ✅ 产物在隔离目录中可独立启动并响应 /api/auth/status');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

(async () => {
  await selfCheck();

  const isccCandidates = [
    process.env.ISCC,
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
  ].filter(Boolean);
  const iscc = isccCandidates.find((p) => fs.existsSync(p));
  if (!iscc) {
    console.warn('[dist:win] 未找到 Inno Setup 6（ISCC.exe），安装包未编译。');
    console.warn('  安装：winget install JRSoftware.InnoSetup   或到 https://jrsoftware.org/isinfo.php 下载');
    console.warn('  已生成 installer/payload/ —— 可直接作为「便携版」目录分发。');
    process.exit(0);
  }
  run(iscc, [path.join(ROOT, 'installer', 'orange-jxc.iss')]);
  console.log('[dist:win] 完成：installer/out/ 与 installer/payload/（便携版）');
})();
