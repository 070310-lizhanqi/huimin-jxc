#!/usr/bin/env node
/** 卸载前停止服务：读 pid 文件，进程存活则结束；数据目录保留不动。 */
const fs = require('fs');
const path = require('path');

const candidates = [
  process.env.ORANGE_DATA_DIR,
  process.env.APPDATA ? path.join(process.env.APPDATA, 'orange-jxc') : null,
  path.join(__dirname, '..', 'data'),
].filter(Boolean);

for (const dir of candidates) {
  const f = path.join(dir, 'server.pid');
  try {
    const pid = Number(fs.readFileSync(f, 'utf8').trim());
    if (pid > 0) {
      try { process.kill(pid); console.log('[卸载] 已停止服务进程 ' + pid); } catch { /* 已退出 */ }
    }
    fs.rmSync(f, { force: true });
  } catch { /* 无 pid 文件 */ }
  const lock = path.join(dir, 'server.lock');
  try { fs.rmSync(lock, { force: true }); } catch { /* ignore */ }
}
console.log('[卸载] 服务已停止；数据目录保留：' + (process.env.APPDATA ? path.join(process.env.APPDATA, 'orange-jxc') : '(见安装说明)'));
