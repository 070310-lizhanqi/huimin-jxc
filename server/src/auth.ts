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
import type { NextFunction, Request, Response, Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';

/** 令牌有效期（秒）：7 天 */
const TOKEN_TTL = 7 * 24 * 3600;
/** 签名密钥：优先环境变量，否则用固定本地密钥（单机部署可接受） */
const SECRET = process.env.ORANGE_JWT_SECRET ?? 'orange-clone-local-secret-v1';

export interface AuthUser {
  userId: number;
  teamId: number;
  role: string;
  name: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthUser;
  }
}

/* ---------------- 密码哈希（scrypt） ---------------- */

export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(plain: string, stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expect] = parts;
  const actual = crypto.scryptSync(plain, salt, 32).toString('hex');
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
    return { userId: payload.userId, teamId: payload.teamId, role: payload.role, name: payload.name };
  } catch {
    return null;
  }
}

/* ---------------- 中间件 ---------------- */

/** 从请求中取令牌（Authorization: Bearer xxx 优先，其次 ?token= 便于下载类请求） */
function readToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7).trim() || null;
  const q = req.query.token;
  if (typeof q === 'string' && q) return q;
  return null;
}

/** 强制登录：未登录或令牌失效返回 401 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = readToken(req);
  const user = token ? verifyToken(token) : null;
  if (!user) {
    res.status(401).json({ error: '未登录或登录已过期，请重新登录' });
    return;
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

/* ---------------- 认证路由 ---------------- */

interface UserRow {
  id: number;
  teamId: number;
  name: string;
  role: string;
  password: string | null;
}

export function mountAuth(router: Router, db: DatabaseSync): void {
  /** 注册：首个账号自动建团队；已有团队时需团队内无同名账号 */
  router.post('/auth/register', (req, res) => {
    const username = String(req.body.username ?? '').trim();
    const password = String(req.body.password ?? '');
    const teamName = String(req.body.teamName ?? '').trim();
    if (!username || username.length < 2) return res.status(400).json({ error: '用户名至少 2 个字符' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });

    const dup = db.prepare(`SELECT id FROM "user" WHERE name = ?`).get(username) as { id: number } | undefined;
    if (dup) return res.status(400).json({ error: '该用户名已被使用' });

    // 没有任何团队 → 首次部署，建团队并初始化默认档案
    const teamCount = (db.prepare('SELECT COUNT(*) AS c FROM team').get() as { c: number }).c;
    let teamId: number;
    if (teamCount === 0) {
      const startPeriod = String(req.body.startPeriod ?? new Date().toISOString().slice(0, 7).replace('-', ''));
      const info = db.prepare('INSERT INTO team (name, startPeriod) VALUES (?, ?)').run(teamName || '我的账套', startPeriod);
      teamId = Number(info.lastInsertRowid);
      db.prepare(`INSERT INTO warehouse (teamId, name) VALUES (?, '默认仓库')`).run(teamId);
      db.prepare(`INSERT INTO account (teamId, name, type) VALUES (?, '现金', 'cash')`).run(teamId);
      db.prepare(`INSERT INTO cat (teamId, name) VALUES (?, '默认分类')`).run(teamId);
    } else {
      return res.status(400).json({ error: '系统已有账套，请由管理员在系统内添加用户' });
    }

    const createdAt = new Date().toISOString();
    const info = db
      .prepare(`INSERT INTO "user" (teamId, name, role, password, createdAt) VALUES (?, ?, 'admin', ?, ?)`)
      .run(teamId, username, hashPassword(password), createdAt);
    const user: AuthUser = { userId: Number(info.lastInsertRowid), teamId, role: 'admin', name: username };
    return res.json({ ok: true, token: issueToken(user), user, teamId, teamName: teamName || '我的账套' });
  });

  /** 登录 */
  router.post('/auth/login', (req, res) => {
    const username = String(req.body.username ?? '').trim();
    const password = String(req.body.password ?? '');
    if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
    const row = db.prepare(`SELECT * FROM "user" WHERE name = ?`).get(username) as UserRow | undefined;
    if (!row || !verifyPassword(password, row.password)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const team = db.prepare('SELECT id, name FROM team WHERE id = ?').get(row.teamId) as
      | { id: number; name: string }
      | undefined;
    const user: AuthUser = { userId: row.id, teamId: row.teamId, role: row.role, name: row.name };
    return res.json({ ok: true, token: issueToken(user), user, team });
  });

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
  router.post('/auth/password', requireAuth, (req, res) => {
    const u = req.auth;
    if (!u) return res.status(401).json({ error: '未登录' });
    const oldPwd = String(req.body.oldPassword ?? '');
    const newPwd = String(req.body.newPassword ?? '');
    if (newPwd.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
    const row = db.prepare(`SELECT * FROM "user" WHERE id = ?`).get(u.userId) as UserRow | undefined;
    if (!row || !verifyPassword(oldPwd, row.password)) return res.status(400).json({ error: '原密码不正确' });
    db.prepare(`UPDATE "user" SET password = ? WHERE id = ?`).run(hashPassword(newPwd), u.userId);
    return res.json({ ok: true });
  });

  /** 团队内用户列表（管理员用） */
  router.get('/auth/users', requireAuth, (req, res) => {
    const u = req.auth;
    if (!u) return res.status(401).json({ error: '未登录' });
    const rows = db
      .prepare(`SELECT id, name, role, createdAt FROM "user" WHERE teamId = ? ORDER BY id`)
      .all(u.teamId);
    return res.json(rows);
  });

  /** 管理员新增同团队用户 */
  router.post('/auth/users', requireAuth, (req, res) => {
    const u = req.auth;
    if (!u) return res.status(401).json({ error: '未登录' });
    if (u.role !== 'admin') return res.status(403).json({ error: '只有管理员可以添加用户' });
    const username = String(req.body.username ?? '').trim();
    const password = String(req.body.password ?? '');
    const role = req.body.role === 'clerk' ? 'clerk' : 'admin';
    if (!username || username.length < 2) return res.status(400).json({ error: '用户名至少 2 个字符' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    const dup = db.prepare(`SELECT id FROM "user" WHERE name = ?`).get(username);
    if (dup) return res.status(400).json({ error: '该用户名已被使用' });
    const info = db
      .prepare(`INSERT INTO "user" (teamId, name, role, password, createdAt) VALUES (?, ?, ?, ?, ?)`)
      .run(u.teamId, username, role, hashPassword(password), new Date().toISOString());
    return res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });

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
