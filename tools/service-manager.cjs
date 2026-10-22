#!/usr/bin/env node
/**
 * 惠民服务管理器 —— 本地服务控制页
 *
 * 管理 1) 惠民云服务器（node dist/server/index.js，端口 7741）
 *      2) Cloudflare 隧道（cloudflared.exe，trycloudflare 快速隧道）
 *
 * 仅监听 127.0.0.1:7742，不暴露公网。
 * 管理器以 detached 方式启动子进程：本管理器关闭后，已启动的服务继续运行。
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
// 管理器自己监听的端口（与橙子云服务端口区分开）；可用 ORANGE_MGR_PORT 覆盖
const PORT = Number(process.env.ORANGE_MGR_PORT) || 7742;
const HOST = '127.0.0.1';
// 橙子云服务端口：可用 ORANGE_PORT 覆盖（默认 7741，被占用时服务自身会自适应后移并写 port.txt）
const APP_PORT = Number(process.env.ORANGE_PORT) || 7741;
// 运行期产物（pid/日志/二进制）放 .tools/（已在 .gitignore，不进 git）
const RUNTIME = path.join(__dirname, '..', '.tools');
fs.mkdirSync(RUNTIME, { recursive: true });
const PID_SERVER = path.join(RUNTIME, 'server.pid');
const PID_TUNNEL = path.join(RUNTIME, 'tunnel.pid');
const LOG_SERVER = path.join(RUNTIME, 'server.log');
const LOG_TUNNEL = path.join(RUNTIME, 'tunnel.log');
const CLOUDFLARED = path.join(RUNTIME, 'cloudflared.exe');
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/** 判断 pid 对应的进程是否存活 */
function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

/** 读 pid 文件（无效时返回 null） */
function readPid(file) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    return pid > 0 && pidAlive(pid) ? pid : null;
  } catch { return null; }
}

/** 通过端口号找到监听进程 pid（netstat 兜底，服务不是管理器启动时也能停） */
function pidByPort(port) {
  try {
    const { execSync } = require('child_process');
    const out = execSync(
      `netstat -ano | findstr ":${port}" | findstr "LISTENING"`,
      { encoding: 'utf8', windowsHide: true },
    );
    const line = out.trim().split(/\r?\n/)[0];
    if (!line) return null;
    return Number(line.trim().split(/\s+/).pop()) || null;
  } catch { return null; }
}

/** 探测惠民云服务器 HTTP 是否可达 */
function probeApp() {
  return new Promise((resolve) => {
    const req = http.get(`http://${HOST}:${APP_PORT}/api/auth/status`, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** 读日志尾部（最多 64KB） */
function tailLog(file, maxLines = 60) {
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, 64 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').trimEnd().split(/\r?\n/);
    return lines.slice(-maxLines).join('\n');
  } catch { return ''; }
}

/** 从隧道日志抓 trycloudflare 网址 */
function tunnelUrl() {
  return (tailLog(LOG_TUNNEL, 200).match(TUNNEL_URL_RE) || [null])[0];
}

/** spawn 独立进程（关管理器不受影响），输出进日志 */
function spawnDetached(cmd, args, logFile, pidFile) {
  const fd = fs.openSync(logFile, 'w');
  const child = spawn(cmd, args, {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  return child.pid;
}

/** 杀进程：优先 Node 原生信号（不依赖外部命令，沙箱/受限环境也可用），再兜底 taskkill 杀进程树 */
function killPid(pid) {
  try { process.kill(Number(pid), 'SIGKILL'); } catch { /* 进程可能已退出 */ }
  if (!pidAlive(pid)) return;
  try {
    const { execSync } = require('child_process');
    execSync(`taskkill /PID ${pid} /T /F`, { windowsHide: true, stdio: 'ignore' });
  } catch { /* 外部命令不可用或被拒时忽略 */ }
}

/** 状态汇总 */
async function status() {
  const appHttp = await probeApp();
  const tunnelPid = readPid(PID_TUNNEL) || pidByName('cloudflared.exe');
  return {
    app: {
      running: appHttp,
      port: APP_PORT,
      pid: readPid(PID_SERVER) || pidByPort(APP_PORT),
    },
    tunnel: {
      running: tunnelPid != null,
      pid: tunnelPid,
      url: tunnelUrl(),
    },
    updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
}

/** 按镜像名找进程（无 pid 文件兜底） */
function pidByName(image) {
  try {
    const { execSync } = require('child_process');
    const out = execSync(`tasklist /FI "IMAGENAME eq ${image}" /FO CSV /NH`, { encoding: 'utf8', windowsHide: true });
    const m = out.match(/"(\d+)"/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

/** 统一 JSON 响应 */
function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;

  try {
    if (p === '/api/status' && req.method === 'GET') {
      return send(res, 200, await status());
    }

    if (p === '/api/start/app' && req.method === 'POST') {
      if (await probeApp()) return send(res, 200, { ok: true, message: '服务器已在运行' });
      const node = process.execPath;
      spawnDetached(node, [path.join(ROOT, 'dist', 'server', 'index.js')], LOG_SERVER, PID_SERVER);
      return send(res, 200, { ok: true, message: '启动命令已发出，几秒内就绪' });
    }

    if (p === '/api/stop/app' && req.method === 'POST') {
      const pid = readPid(PID_SERVER) || pidByPort(APP_PORT);
      if (!pid) {
        // pid 找不到但 HTTP 探测活着 → 如实报告，别让用户以为停掉了
        if (await probeApp()) {
          return send(res, 500, { ok: false, message: '服务在运行但找不到进程 PID，请用任务管理器结束 node.exe' });
        }
        return send(res, 200, { ok: true, message: '服务器未在运行' });
      }
      killPid(pid);
      await new Promise((r) => setTimeout(r, 800));
      const still = await probeApp();
      return send(res, 200, { ok: true, message: still ? '停止命令已发出，但服务可能仍在运行' : '已停止' });
    }

    if (p === '/api/start/tunnel' && req.method === 'POST') {
      const alive = readPid(PID_TUNNEL) || pidByName('cloudflared.exe');
      if (alive) return send(res, 200, { ok: true, message: '隧道已在运行' });
      if (!fs.existsSync(CLOUDFLARED)) {
        return send(res, 500, { ok: false, message: '找不到 cloudflared.exe（.tools/cloudflared.exe）' });
      }
      // http2 走 TCP：Clash 等代理开 TUN 模式时 QUIC(UDP) 被劫持，隧道会一直断连
      spawnDetached(CLOUDFLARED, ['tunnel', '--url', `http://${HOST}:${APP_PORT}`, '--no-autoupdate', '--protocol', 'http2'], LOG_TUNNEL, PID_TUNNEL);
      return send(res, 200, { ok: true, message: '隧道启动中，网址几秒后显示' });
    }

    if (p === '/api/stop/tunnel' && req.method === 'POST') {
      const pid = readPid(PID_TUNNEL) || pidByName('cloudflared.exe');
      if (!pid) return send(res, 200, { ok: true, message: '隧道未在运行' });
      killPid(pid);
      await new Promise((r) => setTimeout(r, 800));
      const still = pidAlive(pid);
      return send(res, 200, { ok: true, message: still ? '停止命令已发出，但隧道进程可能仍在运行' : '已停止' });
    }

    if (p === '/api/log/server' && req.method === 'GET') {
      return send(res, 200, { log: tailLog(LOG_SERVER, 100) });
    }
    if (p === '/api/log/tunnel' && req.method === 'GET') {
      return send(res, 200, { log: tailLog(LOG_TUNNEL, 100) });
    }

    if (p === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(pageHtml());
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

function pageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>惠民服务管理</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: system-ui, "Microsoft YaHei", sans-serif; background: #f3f5f9; color: #1f2937; padding: 24px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #6b7280; font-size: 13px; margin-bottom: 20px; }
  .card { background: #fff; border-radius: 12px; padding: 18px 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .name { font-size: 16px; font-weight: 600; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .on { background: #22c55e; } .off { background: #d1d5db; }
  .state { font-size: 13px; color: #6b7280; }
  .btn { border: 0; border-radius: 8px; padding: 8px 18px; font-size: 14px; cursor: pointer; margin-right: 8px; }
  .start { background: #2563eb; color: #fff; }
  .stop { background: #fee2e2; color: #b91c1c; }
  .url { font-size: 13px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 8px 10px; margin-top: 8px; word-break: break-all; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .url a { color: #15803d; }
  .copy { font-size: 12px; border: 1px solid #bbf7d0; background: #fff; border-radius: 6px; padding: 2px 8px; cursor: pointer; }
  pre { background: #0f172a; color: #d1e7ff; font-size: 12px; border-radius: 8px; padding: 12px; max-height: 220px; overflow: auto; margin-top: 10px; white-space: pre-wrap; }
  .tip { font-size: 12px; color: #9ca3af; margin-top: 6px; }
  .toast { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); background: #1f2937; color: #fff; padding: 8px 18px; border-radius: 8px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
<h1>🍊 惠民服务管理</h1>
<div class="sub">本地控制台 · 仅本机可访问 · 关闭本页面不影响服务运行</div>

<div class="card">
  <div class="head">
    <span class="name"><span class="dot" id="app-dot" class="off"></span>惠民云服务器</span>
    <span class="state" id="app-state">检查中…</span>
  </div>
  <button class="btn start" onclick="act('/api/start/app')">启动</button>
  <button class="btn stop" onclick="act('/api/stop/app')">停止</button>
  <button class="btn stop" style="background:#e5e7eb;color:#374151" onclick="showLog('server')">查看日志</button>
  <div class="tip">管理地址：http://127.0.0.1:${APP_PORT} —— 启动后用浏览器打开即可使用系统</div>
  <pre id="log-server" style="display:none"></pre>
</div>

<div class="card">
  <div class="head">
    <span class="name"><span class="dot" id="tun-dot" class="off"></span>Cloudflare 隧道（外网访问）</span>
    <span class="state" id="tun-state">检查中…</span>
  </div>
  <button class="btn start" onclick="act('/api/start/tunnel')">启动</button>
  <button class="btn stop" onclick="act('/api/stop/tunnel')">停止</button>
  <button class="btn stop" style="background:#e5e7eb;color:#374151" onclick="showLog('tunnel')">查看日志</button>
  <div class="url" id="tun-url-row" style="display:none">
    <a id="tun-url" target="_blank"></a>
    <button class="copy" onclick="copyUrl()">复制</button>
  </div>
  <div class="tip">启动后生成临时外网网址，把网址发给朋友即可访问；每次重启网址会变</div>
  <pre id="log-tunnel" style="display:none"></pre>
</div>

<div class="toast" id="toast"></div>

<script>
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}
async function refresh() {
  try {
    const s = await (await fetch('/api/status')).json();
    const ad = document.getElementById('app-dot'), as = document.getElementById('app-state');
    ad.className = 'dot ' + (s.app.running ? 'on' : 'off');
    as.textContent = s.app.running ? ('运行中 · pid ' + (s.app.pid ?? '?')) : '已停止';
    const td = document.getElementById('tun-dot'), ts = document.getElementById('tun-state');
    td.className = 'dot ' + (s.tunnel.running ? 'on' : 'off');
    ts.textContent = s.tunnel.running ? ('运行中 · pid ' + (s.tunnel.pid ?? '?')) : '已停止';
    const row = document.getElementById('tun-url-row');
    if (s.tunnel.url) {
      row.style.display = 'flex';
      const a = document.getElementById('tun-url');
      a.textContent = s.tunnel.url; a.href = s.tunnel.url;
    } else row.style.display = 'none';
    document.getElementById('updatedAt').textContent = '更新于 ' + s.updatedAt;
  } catch (e) { document.getElementById('app-state').textContent = '管理器连接失败'; }
}
async function act(path) {
  try {
    const r = await (await fetch(path, { method: 'POST' })).json();
    toast(r.message || (r.ok ? '已执行' : '失败'));
  } catch (e) { toast('请求失败'); }
  setTimeout(refresh, 1500);
}
async function showLog(name) {
  const el = document.getElementById('log-' + name);
  if (el.style.display === 'none') {
    const r = await (await fetch('/api/log/' + name)).json();
    el.textContent = r.log || '（日志为空）';
    el.style.display = 'block'; el.scrollTop = el.scrollHeight;
  } else el.style.display = 'none';
}
function copyUrl() {
  navigator.clipboard.writeText(document.getElementById('tun-url').textContent)
    .then(() => toast('已复制')).catch(() => toast('复制失败，请手动选中复制'));
}
refresh();
setInterval(refresh, 3000);
</script>
<span class="sub" id="updatedAt"></span>
</body>
</html>`;
}

server.listen(PORT, HOST, () => {
  console.log(`service manager listening on http://${HOST}:${PORT}`);
});
