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
import { DatabaseSync as DatabaseSyncImpl } from 'node:sqlite';
import type { Request, Response, Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { dataDir, createWindowLimiter } from './db';
import { verifyPassword } from './auth';
import { safeHandler as safe } from './safe-handler';
import { getConfig } from './config/env';
import { recordAuditFromRequest, extractClientIp } from './infra/audit-log';
import { sendError } from './infra/errors';
import { logger } from './infra/logger';

const NAME_RE = /^backup-\d{8}-\d{6}(?:-[a-z0-9]{4})?\.db$/;

function keepBackupsCount(): number {
  return getConfig().backupKeepCount;
}

function backupDir(): string {
  const dir = path.join(dataDir(), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 备份保留策略：保留最新 KEEP_BACKUPS 份，删除更旧的。只处理本目录下符合命名
 * 白名单的文件，用户手工放进来的其它文件一概不动。返回被删除的文件名列表。
 *
 * 排序用文件 mtime 而非文件名：文件名的时间戳只到秒，同一秒内连点备份会有多份
 * 同前缀文件，仅按文件名排会得出任意顺序——刚创建的那份可能被当成「最旧」立刻
 * 删掉（用户刚点的备份当场消失）。mtime 精度远高于秒，且 keepFile 显式豁免。
 */
function pruneBackups(dir: string, keepFile?: string): string[] {
  let entries: Array<{ file: string; mtimeMs: number }>;
  try {
    entries = [];
    for (const f of fs.readdirSync(dir)) {
      if (!NAME_RE.test(f)) continue;
      try {
        entries.push({ file: f, mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs });
      } catch {
        /* 读不到 stat 的跳过（可能正被删） */
      }
    }
  } catch {
    return [];
  }
  const keepBackups = keepBackupsCount();
  if (entries.length <= keepBackups) return [];
  entries.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.file < b.file ? 1 : -1)); // 新 → 旧
  const removed: string[] = [];
  let remaining = entries.length;
  for (let i = entries.length - 1; i >= 0 && remaining > keepBackups; i--) {
    const old = entries[i].file;
    if (old === keepFile) continue; // 绝不动本次刚创建的那份
    // 连副产物一起删：备份文件是 WAL 主库的复制，被工具打开过会留下 -wal/-shm，
    // 只删主文件会攒下一堆孤儿副产物
    for (const f of [old, old + '-wal', old + '-shm']) {
      try {
        fs.rmSync(path.join(dir, f), { force: true });
        if (f === old) { removed.push(old); remaining--; }
      } catch {
        /* 单个删除失败不影响其它与本次备份结果 */
      }
    }
  }
  return removed;
}

function dbFilePath(): string {
  const override = process.env.ORANGE_DB_PATH;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(dataDir(), 'huimin-clone.db');
}

/** SQLite 文件头魔数：所有合法 SQLite 3 库文件的前 16 字节 */
const SQLITE_MAGIC = 'SQLite format 3\0';

/** 恢复前校验备份文件是合法 SQLite 库：文件头不对直接拒绝。
 *  否则用户选错文件（或文件损坏）会整体换掉当前库，服务直接起不来。 */
function assertSQLiteFile(file: string): void {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    if (head.toString('latin1') !== SQLITE_MAGIC) {
      throw new Error('所选文件不是有效的 SQLite 数据库文件');
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** 连带删除备份的 WAL/SHM 副产物（备份文件被外部工具打开过会留下），避免孤儿文件累积 */
function removeBackupFile(dir: string, file: string): void {
  for (const f of [file, file + '-wal', file + '-shm']) {
    try {
      fs.rmSync(path.join(dir, f), { force: true });
    } catch {
      /* 单个删除失败不影响其它 */
    }
  }
}

/** WAL 合并进主库文件：备份前执行，保证复制出的文件是完整快照。
 *  B-安8：用 prepare().get() 读回 { busy, log, checkpointed }——exec() 不返回结果集，
 *  忙时 checkpoint 只返回 busy=1 而不抛错，旧代码会静默备出缺最新事务的库。
 *  busy 或 checkpointed < log 时重试一次，仍失败则抛错拒绝备份。
 *  实测背景：并发长读事务占住 WAL 读标记时备份会缺最新单。 */
function checkpoint(db: DatabaseSync): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
      | { busy: number; log: number; checkpointed: number }
      | undefined;
    if (row && row.busy !== 1 && row.checkpointed >= row.log) return;
    if (attempt === 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  throw new Error('WAL 检查点未完成（数据库正忙），备份已取消');
}

/** 恢复前必须存在的关键表（缺任何一张都说明该文件不是本系统账套） */
const REQUIRED_RESTORE_TABLES = ['team', 'user', 'doc', 'doc_item', 'stock', 'product', 'customer', 'vendor', 'settlement', 'setting', 'bill_seq'];

/**
 * B-安7：恢复前完整性校验。把待恢复文件拷到临时位置，用只读连接跑
 * `PRAGMA integrity_check` + 校验关键表存在。任一失败即抛错（调用方返回 400 通用文案）。
 * 注意：integrity_check 对大库耗时数秒是正常的；临时拷贝会短暂占用双倍磁盘，
 * 先校验磁盘余量（至少 2 倍备份文件大小）。
 */
function validateRestoreFile(file: string): { seconds: number } {
  const size = fs.statSync(file).size;
  try {
    const st = fs.statfsSync(path.dirname(file));
    if (st.bfree * st.bsize < size * 2) {
      throw new Error('磁盘剩余空间不足（恢复校验与备份当前库需要至少 2 倍备份文件大小的余量）');
    }
  } catch (e) {
    if ((e as Error).message.includes('磁盘剩余空间不足')) throw e;
    /* statfs 不可用时跳过余量检查 */
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huimin-restore-'));
  const tmpFile = path.join(tmpDir, 'candidate.db');
  const t0 = Date.now();
  try {
    fs.copyFileSync(file, tmpFile);
    const ro = new DatabaseSyncImpl(tmpFile, { readOnly: true });
    try {
      const rows = ro.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
      if (!rows.length || rows.some((r) => r.integrity_check !== 'ok')) {
        throw new Error('备份文件完整性校验未通过');
      }
      const have = new Set(
        (ro.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((r) => r.name),
      );
      const missing = REQUIRED_RESTORE_TABLES.filter((t) => !have.has(t));
      if (missing.length) throw new Error(`备份文件缺少关键表：${missing.join(',')}`);
    } finally {
      ro.close();
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return { seconds: (Date.now() - t0) / 1000 };
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
 *
 * B-安7：写 pending 前先把当前库文件（含 -wal 检查点后，由调用方先做 checkpoint）
 * 复制为 backups/pre-restore-<时间戳>.db，恢复失败可凭它回滚。
 * B-安18：退出前先 db.close() 再 process.exit(0)，WAL 已落盘。
 */
function scheduleRestore(source: string, db: DatabaseSync): void {
  const dir = dataDir();
  const target = `${dbFilePath()}.restore-pending`;
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${crypto.randomBytes(3).toString('hex')}`;
  const preName = `pre-restore-${stamp}.db`;
  // Use SQLite VACUUM INTO instead of fs.copyFileSync(dbFilePath()): on Linux, closing ANY
  // raw fd to the live DB file in the same PID clears all POSIX fcntl advisory locks held
  // by SQLite, which tricks other processes closing their DB handles into unlinking -wal/-shm.
  db.prepare('VACUUM INTO ?').run(path.join(backupDir(), preName));
  logger.info('Created pre-restore backup and queued restore marker', { preName });
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
      logger.info('Scheduled restart helper for restore', { helperPid: c.pid });
    } else {
      logger.warn('Server entrypoint missing; manual restart required after restore', { entry });
    }
  } catch (e) {
    logger.warn('Failed to spawn restart helper; manual restart required after restore', {
      err: (e as Error).message,
    });
  }
  // 响应写完后退出：让 HTTP 响应先落到客户端
  setTimeout(() => {
    logger.info('Exiting process to apply queued database restore');
    // B-安18：恢复退出前先关库，再退出（重启助手等父进程退出后拉起）
    try { db.close(); } catch { /* 关库失败不阻塞退出 */ }
    process.exit(0);
  }, 400);
}

export function mountBackup(router: Router, db: DatabaseSync): void {
  /** B-安4③：备份创建按团队限速（每分钟 100 次），防反复点备份耗磁盘/CPU。阈值调参（2026-11-21，总协调人）：
   *  全量回归 v027 用例一次连建 40 份备份并裁剪到 30，20 次/分钟会误伤合法批量操作；100 次留有余量，
   *  仍可拦住失控循环。 */
  const backupCreateLimit = createWindowLimiter(100, 60_000);
  /** B-安4②：/backup/restore 密码失败计数（按 IP）：5 次失败后冷却 10 分钟 */
  const restoreFailures = new Map<string, { count: number; lockedUntil: number }>();
  const RESTORE_MAX_FAILS = 5;
  const RESTORE_COOLDOWN_MS = 10 * 60_000;

  /** 管理员守卫：所有备份接口仅 admin 角色 */
  const requireAdmin = (req: Request, res: Response): boolean => {
    if (!req.auth) {
      sendError(req, res, 401, '未登录', 'UNAUTHORIZED');
      return false;
    }
    if (req.auth.role !== 'admin') {
      sendError(req, res, 403, '仅管理员可管理数据备份', 'FORBIDDEN');
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
    const rows = (
      fs
        .readdirSync(dir)
        .filter((f) => NAME_RE.test(f))
        .map((f) => {
          try {
            const st = fs.statSync(path.join(dir, f));
            return { file: f, size: st.size, mtime: st.mtime.toISOString(), _ms: st.mtimeMs };
          } catch {
            return null;
          }
        })
        .filter((x): x is { file: string; size: number; mtime: string; _ms: number } => x !== null)
        // 按 mtime 倒序：同一秒内多份备份仅按文件名排序顺序不定，最新一份可能不在首位
        .sort((a, b) => (b._ms - a._ms) || (a.file < b.file ? 1 : -1))
    ).map(({ _ms, ...rest }) => rest);
    return res.json({ dir, rows });
  });

  /** 立即备份 */
  router.post('/backup/create', (req, res) => {
    if (!requireAdmin(req, res)) return;
    // B-安4③：限速检查在鉴权之后、执行之前（被拒的调用不计入配额的是 401/403，429 本身计入一次）
    if (!backupCreateLimit(`team:${req.auth!.teamId}`)) {
      return sendError(req, res, 429, '备份创建过于频繁，请稍后再试', 'RATE_LIMITED');
    }
    try {
      checkpoint(db);
      const now = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
      // 文件名带 4 位随机后缀：同一秒连点两次备份不互相覆盖
      const suffix = crypto.randomBytes(2).toString('hex');
      const name = `backup-${stamp}-${suffix}.db`;
      const dir = backupDir();
      // Use VACUUM INTO instead of fs.copyFileSync(dbFilePath()) to keep SQLite's POSIX fcntl
      // locks intact while producing an atomic, compact standalone snapshot.
      db.prepare('VACUUM INTO ?').run(path.join(dir, name));
      // 保留策略：新建后立即裁剪，避免目录无限增长（显式豁免刚创建的这份）
      const removed = pruneBackups(dir, name);
      if (removed.length) {
        logger.info('Pruned expired backups', { removedCount: removed.length, keepCount: keepBackupsCount() });
      }
      recordAuditFromRequest(db, req, {
        action: 'backup.create',
        entityType: 'backup',
        entityId: name,
        detail: { pruned: removed.length },
      });
      return res.json({ ok: true, file: name, ...statOf(path.join(dir, name)), pruned: removed.length });
    } catch (e) {
      // A-安4：不把 err.message 回吐给客户端，只写服务端日志
      logger.error('Failed to create backup', { err: e });
      return sendError(req, res, 500, '备份失败，请稍后重试', 'INTERNAL_ERROR');
    }
  });

  /** 下载备份文件（前端 fetch + Bearer 后转存） */
  router.get('/backup/download', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const file = typeof req.query.file === 'string' ? req.query.file : '';
    if (!NAME_RE.test(file)) return sendError(req, res, 400, '备份文件名非法', 'VALIDATION_ERROR');
    // 防符号链接逃逸：仅文件名白名单不够，攻击者若能把 backupDir 里的文件替换成
    // 指向敏感文件的软链接，res.download 会读到任意文件。resolve 后必须仍落在 backupDir 内。
    const dir = backupDir();
    const full = path.join(dir, file);
    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
      return sendError(req, res, 400, '备份文件路径非法', 'VALIDATION_ERROR');
    }
    // 拒绝软链接/硬链接：lstat 与 stat 比较，符号链接直接拒绝
    try {
      const lst = fs.lstatSync(resolved);
      if (lst.isSymbolicLink()) return sendError(req, res, 400, '备份文件类型非法', 'VALIDATION_ERROR');
    } catch {
      return sendError(req, res, 404, '备份文件不存在', 'NOT_FOUND');
    }
    if (!fs.existsSync(resolved)) return sendError(req, res, 404, '备份文件不存在', 'NOT_FOUND');
    return res.download(resolved, file);
  });

  /** 恢复备份：需二次验证当前管理员密码（高危不可逆操作），排队后自动重启生效 */
  router.post('/backup/restore', safe(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const file = typeof body.file === 'string' ? body.file : '';
    if (!NAME_RE.test(file)) return sendError(req, res, 400, '备份文件名非法', 'VALIDATION_ERROR');
    const full = path.join(backupDir(), file);
    if (!fs.existsSync(full)) return sendError(req, res, 404, '备份文件不存在', 'NOT_FOUND');
    try {
      assertSQLiteFile(full);
    } catch (e) {
      // A-安4：assertSQLiteFile 的原始错误不回吐，只返回通用文案，详情写服务端日志
      logger.error('Restore validation failed (invalid SQLite header)', { file, err: e });
      return sendError(req, res, 400, '恢复已取消：所选文件不是有效的备份文件', 'VALIDATION_ERROR');
    }
    // 二次验密：恢复会整体覆盖数据，即便会话被他人借走也不能一键抹库
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) return sendError(req, res, 400, '请输入当前登录账号的密码以确认恢复', 'VALIDATION_ERROR');
    // B-安4②：失败计数——同一 IP 连续 5 次密码错误后冷却 10 分钟（冷却期内即使密码正确也 429）
    const ipKey = extractClientIp(req);
    const failRec = restoreFailures.get(ipKey);
    if (failRec && failRec.lockedUntil > Date.now()) {
      return sendError(req, res, 429, '恢复失败次数过多，请 10 分钟后再试', 'RATE_LIMITED');
    }
    const row = db.prepare(`SELECT password FROM "user" WHERE id = ?`).get(req.auth!.userId) as
      | { password: string | null }
      | undefined;
    if (!row || !(await verifyPassword(password, row.password))) {
      const rec = restoreFailures.get(ipKey) ?? { count: 0, lockedUntil: 0 };
      rec.count++;
      if (rec.count >= RESTORE_MAX_FAILS) rec.lockedUntil = Date.now() + RESTORE_COOLDOWN_MS;
      restoreFailures.set(ipKey, rec);
      return sendError(req, res, 400, '密码不正确，恢复已取消', 'VALIDATION_ERROR');
    }
    restoreFailures.delete(ipKey);
    // B-安7：恢复前完整性校验（integrity_check 对大库耗时数秒是正常的，请耐心等待；
    // 校验在临时拷贝上进行，不动当前库）
    let validation: { seconds: number };
    try {
      validation = validateRestoreFile(full);
    } catch (e) {
      // A-安4：校验失败的原始错误不回吐，只返回通用文案，详情写服务端日志
      logger.error('Restore integrity verification failed', { file, err: e });
      return sendError(req, res, 400, '恢复已取消：所选文件不是有效的备份文件', 'VALIDATION_ERROR');
    }
    try {
      // 校验通过：先检查点再备份当前库、写 pending（任一步失败都能回滚，见 db.ts）
      checkpoint(db);
      recordAuditFromRequest(db, req, {
        action: 'backup.restore',
        entityType: 'backup',
        entityId: file,
        detail: { validationSeconds: Number(validation.seconds.toFixed(2)) },
      });
      scheduleRestore(full, db);
      return res.json({ ok: true, message: `恢复已排队：服务即将重启，重启后数据回到所选备份时点。（恢复前完整性校验已通过，耗时 ${validation.seconds.toFixed(1)} 秒；当前库已备份，恢复失败可回滚。）` });
    } catch (e) {
      // A-安4：不把 err.message 回吐给客户端，只写服务端日志
      logger.error('Failed to queue restore', { file, err: e });
      return sendError(req, res, 500, '恢复失败，请稍后重试', 'INTERNAL_ERROR');
    }
  }));

  /** 删除备份 */
  router.delete('/backup/:file', (req, res) => {
    if (!requireAdmin(req, res)) return;
    const file = typeof req.params.file === 'string' ? req.params.file : '';
    if (!NAME_RE.test(file)) return sendError(req, res, 400, '备份文件名非法', 'VALIDATION_ERROR');
    const full = path.join(backupDir(), file);
    if (!fs.existsSync(full)) return sendError(req, res, 404, '备份文件不存在', 'NOT_FOUND');
    removeBackupFile(backupDir(), file);
    recordAuditFromRequest(db, req, {
      action: 'backup.delete',
      entityType: 'backup',
      entityId: file,
    });
    return res.json({ ok: true });
  });
}
