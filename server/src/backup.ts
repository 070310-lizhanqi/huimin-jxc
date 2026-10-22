/**
 * 数据备份与恢复（本地单机应用的信任底线）。
 *
 * - 备份 = WAL checkpoint 后整库文件复制到 <数据目录>/backups/（在线安全：checkpoint 后
 *   主库文件即完整快照，复制期间业务仍可继续读写，最多丢复制窗口内的增量——本地单机可接受）。
 * - 恢复 = 把备份文件复制为 <db>.restore-pending 后安排进程退出；
 *   下次启动 openDb 检测到 restore-pending 会整体替换库文件（见 db.ts）。
 *   恢复必须重启：连接池/预编译语句无法在换库文件后继续使用。
 * - 文件名一律服务端生成/白名单校验（backup-YYYYMMDD-HHMMSS.db），杜绝路径穿越。
 * - 全部接口仅管理员可用。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { dataDir } from './db';
import { verifyPassword } from './auth';

/** Express 4 不捕获 async 路由抛错：统一包一层返回 500 JSON */
function safe(fn: (req: Request, res: Response) => unknown) {
  return (req: Request, res: Response): void => {
    Promise.resolve(fn(req, res)).catch((e) => {
      console.error('[backup] 路由内部错误:', e);
      if (!res.headersSent) res.status(500).json({ error: '服务器内部错误' });
      else res.end();
    });
  };
}

const NAME_RE = /^backup-\d{8}-\d{6}(?:-[a-z0-9]{4})?\.db$/;

function backupDir(): string {
  const dir = path.join(dataDir(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function dbFilePath(): string {
  const override = process.env.ORANGE_DB_PATH;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(dataDir(), 'orange-clone.db');
}

/** WAL 合并进主库文件：备份前执行，保证复制出的文件是完整快照 */
function checkpoint(db: DatabaseSync): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    /* checkpoint 失败不阻断备份：WAL 未清零时主库文件仍自洽（可能少最新一笔） */
  }
}

/**
 * 重启助手源码：等父进程退出（释放端口与单实例锁）后以同一环境重新拉起服务。
 * 写入数据目录再 spawn —— 数据目录必然可写，且不依赖安装包的文件布局。
 */
const RESTART_HELPER = `const fs=require('node:fs');
const parentPid=Number(process.argv[2]||0), entry=process.argv[3]||'', wd=process.argv[4]||process.cwd();
if(!parentPid||!entry||!fs.existsSync(entry)) process.exit(1);
const t0=Date.now();
const timer=setInterval(()=>{
  let alive=false; try{process.kill(parentPid,0);alive=true;}catch{/* 父进程已退出 */}
  if(!alive||Date.now()-t0>10000){
    clearInterval(timer);
    setTimeout(()=>{
      const{spawn}=require('node:child_process');
      const c=spawn(process.execPath,[entry],{detached:true,stdio:'ignore',cwd:wd,env:process.env});
      c.unref(); process.exit(0);
    },400);
  }
},200);
`;

/**
 * 恢复调度：写 restore-pending → spawn 重启助手 → 响应送达后退出进程。
 * 不依赖外部启动器：命令行/服务管理器直接启动的服务也能自行完成重启闭环。
 */
function scheduleRestore(source: string): void {
  const dir = dataDir();
  const target = `${dbFilePath()}.restore-pending`;
  fs.copyFileSync(source, target);
  // 服务入口：编译产物 dist/server/index.js 相对 server/src 为 ../../dist/server/index.js
  const entry = path.join(__dirname, '..', '..', 'dist', 'server', 'index.js');
  const helper = path.join(dir, 'restart-helper.cjs');
  try {
    if (fs.existsSync(entry)) {
      fs.writeFileSync(helper, RESTART_HELPER);
      const c = spawn(process.execPath, [helper, String(process.pid), entry, process.cwd()], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      c.unref();
      console.log(`[恢复] 已安排重启助手（pid ${c.pid}），本进程退出后由它拉起服务。`);
    } else {
      console.warn(`[恢复] 未找到服务入口 ${entry}，请手动重启服务以应用恢复。`);
    }
  } catch (e) {
    console.warn(`[恢复] 重启助手启动失败（${(e as Error).message}），请手动重启服务。`);
  }
  // 响应写完后退出：让 HTTP 响应先落到客户端
  setTimeout(() => {
    console.log('[恢复] 数据库备份已排队，进程退出以应用恢复……');
    process.exit(0);
  }, 400);
}

export function mountBackup(router: Router, db: DatabaseSync): void {
  /** 管理员守卫：所有备份接口仅 admin 角色 */
  const requireAdmin = (req: Request, res: Response): boolean => {
    if (!req.auth) {
      res.status(401).json({ error: '未登录' });
      return false;
    }
    if (req.auth.role !== 'admin') {
      res.status(403).json({ error: '仅管理员可管理数据备份' });
      return false;
    }
    return true;
  };

  const statOf = (file: string) => {
    const st = fs.statSync(file);
    return { size: st.size, mtime: st.mtime.toISOString() };
  };

  /** 备份列表：文件名/大小/时间，服务端再按白名单过滤一遍 */
  router.get('/backup/list', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const dir = backupDir();
    const rows = fs
      .readdirSync(dir)
      .filter((f) => NAME_RE.test(f))
      .map((f) => {
        try {
          return { file: f, ...statOf(path.join(dir, f)) };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (a!.file < b!.file ? 1 : -1));
    return res.json({ dir, rows });
  });

  /** 立即备份 */
  router.post('/backup/create', (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      checkpoint(db);
      const now = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
      // 文件名带 4 位随机后缀：同一秒连点两次备份不互相覆盖
      const suffix = Math.random().toString(36).slice(2, 6);
      const name = `backup-${stamp}-${suffix}.db`;
      const dir = backupDir();
      fs.copyFileSync(dbFilePath(), path.join(dir, name));
      return res.json({ ok: true, file: name, ...statOf(path.join(dir, name)) });
    } catch (e) {
      return res.status(500).json({ error: `备份失败：${(e as Error).message}` });
    }
  });

  /** 下载备份文件（前端 fetch + Bearer 后转存） */
  router.get('/backup/download', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const file = String(req.query.file ?? '');
    if (!NAME_RE.test(file)) return res.status(400).json({ error: '备份文件名非法' });
    const full = path.join(backupDir(), file);
    if (!fs.existsSync(full)) return res.status(404).json({ error: '备份文件不存在' });
    return res.download(full, file);
  });

  /** 恢复备份：需二次验证当前管理员密码（高危不可逆操作），排队后自动重启生效 */
  router.post('/backup/restore', safe(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const file = String(req.body.file ?? '');
    if (!NAME_RE.test(file)) return res.status(400).json({ error: '备份文件名非法' });
    const full = path.join(backupDir(), file);
    if (!fs.existsSync(full)) return res.status(404).json({ error: '备份文件不存在' });
    // 二次验密：恢复会整体覆盖数据，即便会话被他人借走也不能一键抹库
    const password = String(req.body.password ?? '');
    if (!password) return res.status(400).json({ error: '请输入当前登录账号的密码以确认恢复' });
    const row = db.prepare(`SELECT password FROM "user" WHERE id = ?`).get(req.auth!.userId) as
      | { password: string | null }
      | undefined;
    if (!row || !(await verifyPassword(password, row.password))) {
      return res.status(400).json({ error: '密码不正确，恢复已取消' });
    }
    try {
      scheduleRestore(full);
      return res.json({ ok: true, message: '恢复已排队：服务即将重启，重启后数据回到所选备份时点。' });
    } catch (e) {
      return res.status(500).json({ error: `恢复失败：${(e as Error).message}` });
    }
  }));

  /** 删除备份 */
  router.delete('/backup/:file', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const file = String(req.params.file ?? '');
    if (!NAME_RE.test(file)) return res.status(400).json({ error: '备份文件名非法' });
    const full = path.join(backupDir(), file);
    if (!fs.existsSync(full)) return res.status(404).json({ error: '备份文件不存在' });
    fs.rmSync(full, { force: true });
    return res.json({ ok: true });
  });
}
