/**
 * 认证与授权：账号密码登录、HMAC 签名令牌、团队数据隔离
 *
 * 设计要点：
 * - 零第三方依赖：密码用 node:crypto scrypt 哈希，令牌用 HMAC-SHA256 自签（JWT-like）
 * - 令牌载荷含 userId / teamId / role，服务端不存 session，重启不掉线
 * - 鉴权中间件强制把 req 里的 teamId 覆盖成令牌中的 teamId，
 *   因此下游 47 条路由无需改造即实现团队隔离，客户端无法越权读写别的团队
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { NextFunction, Request, Response, Router } from 'express';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { localDate } from './db';

/** 令牌有效期（秒）：7 天 */
const TOKEN_TTL = 7 * 24 * 3600;
/** 签名密钥：优先环境变量，否则用固定本地密钥（单机部署可接受） */
const SECRET = process.env.ORANGE_JWT_SECRET ?? 'huimin-clone-local-secret-v1';

export interface AuthUser {
  userId: number;
  teamId: number;
  role: string;
  name: string;
  /** 令牌版本：与 user.tokenVer 比对，改密/删号后旧令牌立即失效 */
  ver?: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthUser;
  }
}

/* ---------------- 密码哈希（scrypt） ---------------- */

const scrypt = promisify(crypto.scrypt) as (plain: string, salt: string, keylen: number) => Promise<Buffer>;

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(plain, salt, 32)).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export async function verifyPassword(plain: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expect] = parts;
  const actual = (await scrypt(plain, salt, 32)).toString('hex');
  // 定长比较，避免时序侧信道
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expect, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------- 令牌签发与校验 ---------------- */

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const sign = (data: string): string => b64url(crypto.createHmac('sha256', SECRET).update(data).digest());

export function issueToken(user: AuthUser): string {
  const payload = { ...user, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${sign(body)}`;
}

export function verifyToken(token: string): AuthUser | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = sign(body);
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as
      AuthUser & { exp?: number };
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    if (!payload.userId || !payload.teamId) return null;
    return { userId: payload.userId, teamId: payload.teamId, role: payload.role, name: payload.name, ver: payload.ver };
  } catch {
    return null;
  }
}

/* ---------------- 中间件 ---------------- */

/** 从请求中取令牌（Authorization: Bearer xxx）。
 *  不支持 ?token= query：令牌会泄漏进访问日志/浏览器历史/Referer。
 *  下载类请求请前端用 fetch 携带 Bearer 头再转 blob。 */
function readToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7).trim() || null;
  return null;
}

/** 强制登录：未登录或令牌失效返回 401 */
/** 令牌版本库校验句柄：mountAuth 挂载时设置（index.ts 先挂认证路由再 api.use(requireAuth)，时序安全） */
let stmtTokenVer: StatementSync | null = null;

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = readToken(req);
  const user = token ? verifyToken(token) : null;
  if (!user) {
    res.status(401).json({ error: '未登录或登录已过期，请重新登录' });
    return;
  }
  // 令牌版本比对：改密、删除账号后旧令牌立即失效（无此机制时旧令牌最长仍可用 7 天）
  if (stmtTokenVer) {
    const row = stmtTokenVer.get(user.userId) as { tokenVer: number } | undefined;
    if (!row || user.ver !== row.tokenVer) {
      res.status(401).json({ error: '登录凭证已变更，请重新登录' });
      return;
    }
  }
  req.auth = user;
  // 团队隔离：把请求里的 teamId 统一覆盖为令牌中的 teamId，下游路由无需改动
  if (req.query && typeof req.query === 'object') {
    (req.query as Record<string, unknown>).teamId = String(user.teamId);
  }
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    (req.body as Record<string, unknown>).teamId = user.teamId;
  }
  next();
}

/* ---------------- 简单 IP 限速（防登录/注册爆破） ---------------- */

/** 每个 key 的失败记录：Map<key, timestamps[]>，内存态，重启即清零。
 *  key 为 `ip:username`：按 IP 计数会让 NAT 出口下一人爆破封锁整个公司；
 *  按 username 单独计数则攻击者可换 IP 绕过。组合 key 兼顾两侧。 */
const rateBucket = new Map<string, number[]>();
/** 窗口时长 60s，窗口内失败 ≥ MAX_TRIES 次即拒绝，成功登录/注册不计数 */
const RATE_WINDOW_MS = 60_000;
const MAX_TRIES = 15;
/** 注册接口单独限速：即便没失败也应限制总频率（防止无限重试抢首管理员） */
const REGISTER_WINDOW_MS = 60_000;
const REGISTER_MAX = 10;
const registerBucket = new Map<string, number[]>();

function tooManyFails(key: string): boolean {
  const now = Date.now();
  const list = (rateBucket.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  rateBucket.set(key, list);
  return list.length >= MAX_TRIES;
}

function recordFail(key: string): void {
  const now = Date.now();
  const list = (rateBucket.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  list.push(now);
  rateBucket.set(key, list);
  // 简单内存回收：桶数量过大时清掉全空项
  if (rateBucket.size > 1000) {
    for (const [k, v] of rateBucket) {
      if (v.every((t) => now - t >= RATE_WINDOW_MS)) rateBucket.delete(k);
    }
  }
}

/** 登录/注册成功时清空对应 key 的失败计数，避免误伤合法用户 */
function clearFails(key: string): void {
  rateBucket.delete(key);
}

/** 注册总频率限速（不区分成功失败） */
function tooManyRegisters(ip: string): boolean {
  const now = Date.now();
  const list = (registerBucket.get(ip) ?? []).filter((t) => now - t < REGISTER_WINDOW_MS);
  registerBucket.set(ip, list);
  if (list.length >= REGISTER_MAX) return true;
  list.push(now);
  registerBucket.set(ip, list);
  return false;
}

function clientIp(req: Request): string {
  return req.socket.remoteAddress ?? 'unknown';
}

/* ---------------- 认证路由 ---------------- */

interface UserRow {
  id: number;
  teamId: number;
  name: string;
  role: string;
  password: string | null;
  tokenVer: number;
}

/** 全局注册配置存 setting 表 teamId=0 行（单账套语义下的全局命名空间） */
const GLOBAL_TEAM = 0;
const REGISTER_KEY = 'global.register';
/** 系统所有者 = 首个账套（自增 id 从 1 开始，team 永不删除，因此 teamId=1 恒定存在且稳定） */
const OWNER_TEAM = 1;

interface RegisterConf {
  enabled: boolean;
  inviteCode: string;
}

function loadRegisterConf(db: DatabaseSync): RegisterConf {
  const row = db.prepare(`SELECT value FROM setting WHERE teamId = ? AND key = ?`).get(GLOBAL_TEAM, REGISTER_KEY) as
    | { value: string }
    | undefined;
  if (!row) return { enabled: false, inviteCode: '' };
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Record<string, unknown>;
      return { enabled: p.enabled === true, inviteCode: typeof p.inviteCode === 'string' ? p.inviteCode : '' };
    }
  } catch {
    /* 脏数据回落 */
  }
  return { enabled: false, inviteCode: '' };
}

/** 定长比较，避免时序侧信道 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * 弱密码黑名单：命中即拒绝（注册 / 管理员建用户 / 改密共用）。
 * 单机自用场景不做复杂强度分级，但常见弱口令必须挡住——
 * 服务一旦经隧道暴露，admin123 这类密码等于不设防。
 */
const WEAK_PASSWORDS = new Set([
  '123456', '1234567', '12345678', '123456789', '1234567890',
  'password', 'password1', 'passw0rd', 'admin123', 'admin888',
  'admin666', 'admin000', 'root123', 'abc123', 'abc123456',
  '111111', '11111111', '000000', '666666', '888888', '88888888',
  'a123456', '123123', '654321', '112233', '123321', '1qaz2wsx',
  'qwe123', 'qq123456', 'taobao123', '1111111', '1111',
]);

/** 密码强度统一校验：长度 ≥6 且不命中弱密码黑名单 */
function checkPasswordStrength(password: string): string | null {
  if (password.length < 6) return '密码至少 6 位';
  if (password.length > 64) return '密码过长（最多 64 位）';
  if (WEAK_PASSWORDS.has(password.toLowerCase())) {
    return '密码过于简单（常见弱口令），请换一个包含字母与数字的密码';
  }
  return null;
}

/** 用户名统一校验：2-30 个字符 */
function checkUsername(username: string): string | null {
  if (!username || username.length < 2) return '用户名至少 2 个字符';
  if (username.length > 30) return '用户名过长（最多 30 个字符）';
  return null;
}

/** Express 4 不捕获 async 路由抛出的错误；包装后统一返回 500 JSON，避免未处理 rejection 导致请求挂起 */
function safe(fn: (req: Request, res: Response) => unknown) {
  return (req: Request, res: Response): void => {
    Promise.resolve(fn(req, res)).catch((e) => {
      console.error('[auth] 路由内部错误:', e);
      if (!res.headersSent) res.status(500).json({ error: '服务器内部错误' });
      else res.end();
    });
  };
}

export function mountAuth(router: Router, db: DatabaseSync): void {
  // 供 requireAuth 做令牌版本比对（预编译语句，避免每请求重复编译）
  stmtTokenVer = db.prepare(`SELECT tokenVer FROM "user" WHERE id = ?`);

  /** 注册：首个账号自动建团队；已有团队时按全局注册开关走邀请码建「独立新账套」 */
  router.post('/auth/register', safe(async (req, res) => {
    // 注册接口按 IP 做总频率限速（不区分成败）：teamCount=0 时若不限速，
    // 攻击者可无限重试直到抢到首个管理员
    if (tooManyRegisters(clientIp(req))) {
      return res.status(429).json({ error: '注册请求过于频繁，请 1 分钟后再试' });
    }
    const username = String(req.body.username ?? '').trim();
    const password = String(req.body.password ?? '');
    const teamName = String(req.body.teamName ?? '').trim();
    // 失败计数 key 按 ip:username：NAT 出口下一人爆破不再封锁整个公司
    const failKey = `${clientIp(req)}:${username}`;
    const fail = (status: number, error: string) => {
      recordFail(failKey);
      return res.status(status).json({ error });
    };
    if (tooManyFails(failKey)) {
      return fail(429, '尝试过于频繁，请 1 分钟后再试');
    }
    const nameErr = checkUsername(username);
    if (nameErr) return fail(400, nameErr);
    const pwdErr = checkPasswordStrength(password);
    if (pwdErr) return fail(400, pwdErr);
    if (teamName.length > 60) return fail(400, '账套名称过长（最多 60 个字符）');

    const dup = db.prepare(`SELECT id FROM "user" WHERE name = ?`).get(username) as { id: number } | undefined;
    if (dup) return fail(400, '该用户名已被使用');

    const teamCount = (db.prepare('SELECT COUNT(*) AS c FROM team').get() as { c: number }).c;
    let teamId: number;
    if (teamCount === 0) {
      // 没有任何团队 → 首次部署，建团队并初始化默认档案（起账期缺省取本地年月，勿用 UTC）
      // 起账期格式必须为 YYYYMM：报表按 substr(date,1,6) 与账期比较，脏格式会让所有期间报表错位
      let startPeriod = String(req.body.startPeriod ?? localDate().slice(0, 7).replace('-', ''));
      if (!/^\d{6}$/.test(startPeriod)) {
        const m = String(startPeriod).match(/^(\d{4})-?(\d{1,2})$/);
        if (m) startPeriod = `${m[1]}${m[2].padStart(2, '0')}`;
        else startPeriod = localDate().slice(0, 7).replace('-', '');
      }
      const mm = Number(startPeriod.slice(4, 6));
      if (mm < 1 || mm > 12) startPeriod = localDate().slice(0, 7).replace('-', '');
      const info = db.prepare('INSERT INTO team (name, startPeriod) VALUES (?, ?)').run(teamName || '我的账套', startPeriod);
      teamId = Number(info.lastInsertRowid);
      db.prepare(`INSERT INTO warehouse (teamId, name) VALUES (?, '默认仓库')`).run(teamId);
      db.prepare(`INSERT INTO account (teamId, name, type) VALUES (?, '现金', 'cash')`).run(teamId);
      db.prepare(`INSERT INTO cat (teamId, name) VALUES (?, '默认分类')`).run(teamId);
    } else {
      // 已有账套 → 开放注册默认关闭；开启后凭邀请码创建「独立新账套」（各用各的账套）
      const conf = loadRegisterConf(db);
      if (!conf.enabled) {
        return fail(400, '注册未开放，请联系已有账套的管理员开启');
      }
      const invite = String(req.body.inviteCode ?? '').trim();
      if (!invite || !conf.inviteCode || !safeEqual(invite, conf.inviteCode)) {
        return fail(400, '邀请码不正确');
      }
      const info = db.prepare('INSERT INTO team (name, startPeriod) VALUES (?, ?)').run(teamName || '我的账套', localDate().slice(0, 7).replace('-', ''));
      teamId = Number(info.lastInsertRowid);
      db.prepare(`INSERT INTO warehouse (teamId, name) VALUES (?, '默认仓库')`).run(teamId);
      db.prepare(`INSERT INTO account (teamId, name, type) VALUES (?, '现金', 'cash')`).run(teamId);
      db.prepare(`INSERT INTO cat (teamId, name) VALUES (?, '默认分类')`).run(teamId);
    }

    const createdAt = new Date().toISOString();
    const hashed = await hashPassword(password);
    let info: { lastInsertRowid: number | bigint };
    try {
      info = db
        .prepare(`INSERT INTO "user" (teamId, name, role, password, createdAt) VALUES (?, ?, 'admin', ?, ?)`)
        .run(teamId, username, hashed, createdAt);
    } catch {
      // 并发注册撞唯一索引 idx_user_name：预检（SELECT）与 INSERT 之间有竞态窗口
      return fail(400, '该用户名已被使用');
    }
    const user: AuthUser = { userId: Number(info.lastInsertRowid), teamId, role: 'admin', name: username, ver: 0 };
    // 注册成功清空失败计数：避免正常用户首次注册时因前面试错被误锁
    clearFails(failKey);
    return res.json({ ok: true, token: issueToken(user), user, teamId, teamName: teamName || '我的账套' });
  }));

  /** 登录 */
  router.post('/auth/login', safe(async (req, res) => {
    const username = String(req.body.username ?? '').trim();
    const password = String(req.body.password ?? '');
    if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
    // 失败计数 key 按 ip:username（理由同注册）：爆破单个账号不再误伤 NAT 后的其它账号
    const failKey = `${clientIp(req)}:${username}`;
    if (tooManyFails(failKey)) {
      return res.status(429).json({ error: '尝试过于频繁，请 1 分钟后再试' });
    }
    const row = db.prepare(`SELECT * FROM "user" WHERE name = ?`).get(username) as UserRow | undefined;
    if (!row || !(await verifyPassword(password, row.password))) {
      recordFail(failKey);
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const team = db.prepare('SELECT id, name FROM team WHERE id = ?').get(row.teamId) as
      | { id: number; name: string }
      | undefined;
    const user: AuthUser = { userId: row.id, teamId: row.teamId, role: row.role, name: row.name, ver: row.tokenVer };
    // 登录成功清空失败计数：解锁此前的试错，下次登录不受影响
    clearFails(failKey);
    return res.json({ ok: true, token: issueToken(user), user, team });
  }));

  /** 当前登录信息（前端启动时校验令牌是否还有效） */
  router.get('/auth/me', requireAuth, (req, res) => {
    const u = req.auth;
    if (!u) return res.status(401).json({ error: '未登录' });
    const team = db.prepare('SELECT id, name FROM team WHERE id = ?').get(u.teamId) as
      | { id: number; name: string }
      | undefined;
    return res.json({ user: u, team });
  });

  /** 首次部署探测：是否已有账号（前端据此决定显示注册还是登录） */
  router.get('/auth/status', (_req, res) => {
    const teamCount = (db.prepare('SELECT COUNT(*) AS c FROM team').get() as { c: number }).c;
    const userCount = (db.prepare(`SELECT COUNT(*) AS c FROM "user"`).get() as { c: number }).c;
    return res.json({ initialized: teamCount > 0 && userCount > 0, teamCount, userCount });
  });

  /** 改密码（需登录） */
  router.post('/auth/password', requireAuth, safe(async (req, res) => {
    const u = req.auth;
    if (!u) return res.status(401).json({ error: '未登录' });
    const oldPwd = String(req.body.oldPassword ?? '');
    const newPwd = String(req.body.newPassword ?? '');
    const pwdErr = checkPasswordStrength(newPwd);
    if (pwdErr) return res.status(400).json({ error: '新' + pwdErr });
    const row = db.prepare(`SELECT * FROM "user" WHERE id = ?`).get(u.userId) as UserRow | undefined;
    if (!row || !(await verifyPassword(oldPwd, row.password))) return res.status(400).json({ error: '原密码不正确' });
    // 改密后 tokenVer + 1：吊销该用户全部旧令牌（含泄漏在外的），并为当前会话重签新令牌
    db.prepare(`UPDATE "user" SET password = ?, tokenVer = tokenVer + 1 WHERE id = ?`).run(await hashPassword(newPwd), u.userId);
    const fresh = db.prepare(`SELECT tokenVer FROM "user" WHERE id = ?`).get(u.userId) as { tokenVer: number } | undefined;
    const renewed: AuthUser = { userId: u.userId, teamId: u.teamId, role: u.role, name: u.name, ver: fresh?.tokenVer ?? row.tokenVer + 1 };
    return res.json({ ok: true, token: issueToken(renewed) });
  }));

  /** 读注册配置：仅系统所有者（首个账套）的 admin 可看，防止朋友账套的管理员改动全局开关 */
  router.get('/auth/register-conf', requireAuth, (req, res) => {
    const u = req.auth;
    if (!u) return res.status(401).json({ error: '未登录' });
    if (u.role !== 'admin' || u.teamId !== OWNER_TEAM) {
      return res.status(403).json({ error: '只有系统所有者（首个账套）的管理员可以管理注册配置' });
    }
    const conf = loadRegisterConf(db);
    return res.json({ enabled: conf.enabled, inviteCode: conf.inviteCode });
  });

  /** 写注册配置：开启注册必须同时设置至少 6 位邀请码 */
  router.post('/auth/register-conf', requireAuth, (req, res) => {
    const u = req.auth;
    if (!u) return res.status(401).json({ error: '未登录' });
    if (u.role !== 'admin' || u.teamId !== OWNER_TEAM) {
      return res.status(403).json({ error: '只有系统所有者（首个账套）的管理员可以管理注册配置' });
    }
    const enabled = req.body.enabled === true;
    const inviteCode = String(req.body.inviteCode ?? '').trim();
    if (enabled) {
      if (!/^[A-Za-z0-9-]{6,32}$/.test(inviteCode)) {
        return res.status(400).json({ error: '开启注册必须设置 6-32 位邀请码（字母/数字/短横线）' });
      }
    }
    db.prepare(
      `INSERT INTO setting (teamId, key, value) VALUES (?, ?, ?)
       ON CONFLICT(teamId, key) DO UPDATE SET value = excluded.value`,
    ).run(GLOBAL_TEAM, REGISTER_KEY, JSON.stringify({ enabled, inviteCode: enabled ? inviteCode : '' }));
    return res.json({ ok: true, enabled, inviteCode: enabled ? inviteCode : '' });
  });

  /** 团队内用户列表：仅管理员可看（员工账号信息也是敏感数据） */
  router.get('/auth/users', requireAuth, (req, res) => {
    const u = req.auth;
    if (!u) return res.status(401).json({ error: '未登录' });
    if (u.role !== 'admin') return res.status(403).json({ error: '只有管理员可以查看用户列表' });
    const rows = db
      .prepare(`SELECT id, name, role, createdAt FROM "user" WHERE teamId = ? ORDER BY id`)
      .all(u.teamId);
    return res.json(rows);
  });

  /** 管理员新增同团队用户 */
  router.post('/auth/users', requireAuth, safe(async (req, res) => {
    const u = req.auth;
    if (!u) return res.status(401).json({ error: '未登录' });
    if (u.role !== 'admin') return res.status(403).json({ error: '只有管理员可以添加用户' });
    const username = String(req.body.username ?? '').trim();
    const password = String(req.body.password ?? '');
    const role = req.body.role === 'clerk' ? 'clerk' : 'admin';
    const nameErr = checkUsername(username);
    if (nameErr) return res.status(400).json({ error: nameErr });
    const pwdErr = checkPasswordStrength(password);
    if (pwdErr) return res.status(400).json({ error: pwdErr });
    const dup = db.prepare(`SELECT id FROM "user" WHERE name = ?`).get(username);
    if (dup) return res.status(400).json({ error: '该用户名已被使用' });
    const hashed = await hashPassword(password);
    let info: { lastInsertRowid: number | bigint };
    try {
      info = db
        .prepare(`INSERT INTO "user" (teamId, name, role, password, createdAt) VALUES (?, ?, ?, ?, ?)`)
        .run(u.teamId, username, role, hashed, new Date().toISOString());
    } catch {
      // 并发新增撞唯一索引 idx_user_name（预检与 INSERT 之间有竞态窗口）
      return res.status(400).json({ error: '该用户名已被使用' });
    }
    return res.json({ ok: true, id: Number(info.lastInsertRowid) });
  }));

  /** 管理员删除同团队用户（不能删自己，避免把最后一个管理员删掉） */
  router.delete('/auth/users/:id', requireAuth, (req, res) => {
    const u = req.auth;
    if (!u) return res.status(401).json({ error: '未登录' });
    if (u.role !== 'admin') return res.status(403).json({ error: '只有管理员可以删除用户' });
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: '用户 ID 无效' });
    if (id === u.userId) return res.status(400).json({ error: '不能删除当前登录账号' });
    const row = db.prepare(`SELECT id, role FROM "user" WHERE id = ? AND teamId = ?`).get(id, u.teamId) as
      | { id: number; role: string }
      | undefined;
    if (!row) return res.status(404).json({ error: '用户不存在' });
    if (row.role === 'admin') {
      const admins = (db.prepare(`SELECT COUNT(*) AS c FROM "user" WHERE teamId = ? AND role = 'admin'`).get(u.teamId) as { c: number }).c;
      if (admins <= 1) return res.status(400).json({ error: '至少保留一个管理员' });
    }
    db.prepare(`DELETE FROM "user" WHERE id = ? AND teamId = ?`).run(id, u.teamId);
    return res.json({ ok: true });
  });
}
