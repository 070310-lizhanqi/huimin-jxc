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
import { safeHandler } from './safe-handler';
import { getConfig } from './config/env';

/** 令牌有效期（秒）：7 天 */
const TOKEN_TTL = 7 * 24 * 3600;

/** 浏览器会话 Cookie 名：与旧 localStorage 键同名，便于对照 */
const COOKIE_NAME = 'oc_token';
/**
 * B-前5：令牌改由 httpOnly Cookie 下发，浏览器不再把 token 存 localStorage
 * （任意 XSS 可直接读走 localStorage 里的令牌）。属性口径：
 * - HttpOnly：JS（含 XSS 注入脚本）读不到；
 * - Path=/：全站接口都带；
 * - SameSite=Lax：跨站写请求不带，防 CSRF（配合 index.ts 已有的 Host 白名单）；
 * - Max-Age=TOKEN_TTL（7 天，与令牌有效期一致）；
 * - 不加 Secure：本地部署是明文 HTTP，加了浏览器不会存；
 * - 不设 Domain：默认仅当前 host。
 * 登录/注册 JSON 仍返回 token（API 客户端与既有 Bearer 测试用），前端忽略 body 里的 token。
 * 不加 Access-Control-Allow-Credentials：应用是同源部署，浏览器不需要跨域带凭据。
 */
function setAuthCookie(res: Response, token: string): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TOKEN_TTL}`);
}
/** 登出时清掉 Cookie：空值 + Max-Age=0 */
function clearAuthCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export interface AuthUser {
  userId: number;
  teamId: number;
  role: string;
  name: string;
  /** 令牌版本：与 user.tokenVer 比对，改密/删号后旧令牌立即失效 */
  ver?: number;
  /**
   * 令牌唯一标识（签发时随机生成）：吊销键须精确到单个令牌。
   * 只用 userId:exp 会碰撞——exp 是秒级时间戳，同一秒内两次登录的 exp 相同，
   * 注销旧令牌会误杀同秒签发的新令牌（实测复现）。键格式为 userId:exp:jti。
   */
  jti?: string;
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

/**
 * A-安6 登录时序侧信道用的固定假哈希：用户名不存在时也对它跑一次 verifyPassword，
 * 再返回 401，使“用户不存在”与“密码错误”的耗时不可区分。
 * 格式须能通过 verifyPassword 的解析：`scrypt$<32 位 hex 盐>$<64 位 hex 哈希>`。
 * 全零值仅作耗时填充，从不对应任何真实用户的 stored 密码。
 */
const DUMMY_HASH = 'scrypt$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000';

/* ---------------- 令牌签发与校验 ---------------- */

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const sign = (data: string): string =>
  b64url(crypto.createHmac('sha256', getConfig().jwtSecret).update(data).digest());

export function issueToken(user: AuthUser): string {
  const payload = { ...user, jti: crypto.randomBytes(8).toString('hex'), exp: Math.floor(Date.now() / 1000) + TOKEN_TTL };
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
    // B-安15：载荷类型校验。只判真值不够：userId:true 这类伪造载荷会通过真值
    // 检查，随后在 requireAuth 里把非法绑定值传给 node:sqlite 而抛 500。
    // 类型不对一律视为无效令牌（401），不让伪造载荷走到数据库层。
    if (!Number.isInteger(payload.userId) || !Number.isInteger(payload.teamId) || typeof payload.role !== 'string') {
      return null;
    }
    if (payload.jti !== undefined && typeof payload.jti !== 'string') return null;
    // 退出登录黑名单：单实例部署用进程内表即可，条目随令牌过期自动失效。
    // 键含 jti（见 AuthUser.jti 注释）：只用 userId:exp 时同秒签发的令牌会互杀。
    if (revoked.has(`${payload.userId}:${payload.exp}:${payload.jti ?? ''}`)) return null;
    return { userId: payload.userId, teamId: payload.teamId, role: payload.role, name: payload.name, ver: payload.ver, jti: payload.jti };
  } catch {
    return null;
  }
}

/** 已吊销令牌表：key = userId:exp:jti（jti 缺失的老令牌 key 为 userId:exp:，见 AuthUser.jti 注释） */
const revoked = new Set<number | string>();

/**
 * B-安1：吊销持久化。吊销只放进程内存时，备份恢复/守护重启会让已注销令牌复活。
 * 改为同时写 setting 表（teamId=0 全局行，键 'auth.revoked'，值为 key 数组的 JSON），
 * 启动时由 mountAuth 读回，定期清过期。
 */
const REVOKED_KEY = 'auth.revoked';
/** 持久化句柄：mountAuth 挂载时设置（revokeToken 在 logout 路由里调用，此时已挂载） */
let revokedDb: DatabaseSync | null = null;

function persistRevoked(): void {
  if (!revokedDb) return;
  try {
    revokedDb
      .prepare(
        `INSERT INTO setting (teamId, key, value) VALUES (?, ?, ?)
         ON CONFLICT(teamId, key) DO UPDATE SET value = excluded.value`,
      )
      .run(GLOBAL_TEAM, REVOKED_KEY, JSON.stringify([...revoked]));
  } catch (e) {
    console.error('[auth] 吊销持久化失败（注销本身仍生效于当前进程）:', e);
  }
}

/** 启动时从 setting 表加载吊销表（过期条目直接丢弃，不写回） */
function loadRevoked(db: DatabaseSync): void {
  try {
    const row = db.prepare(`SELECT value FROM setting WHERE teamId = ? AND key = ?`).get(GLOBAL_TEAM, REVOKED_KEY) as
      | { value: string }
      | undefined;
    if (!row) return;
    const parsed: unknown = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return;
    const now = Math.floor(Date.now() / 1000);
    for (const k of parsed) {
      if (typeof k !== 'string') continue;
      // 接受 userId:exp:jti 与老格式 userId:exp（jti 段缺失时按空串补齐）
      const m = k.match(/^(\d+):(\d+)(?::([0-9a-f]*))?$/);
      if (!m) continue;
      if (Number(m[2]) > now) revoked.add(m[3] === undefined ? `${m[1]}:${m[2]}:` : k);
    }
  } catch (e) {
    console.error('[auth] 加载吊销表失败（按空表启动）:', e);
  }
}

/** 清掉已过期的吊销条目，返回是否删过条目 */
function pruneRevoked(): boolean {
  const now = Math.floor(Date.now() / 1000);
  let removed = false;
  for (const k of revoked) {
    const exp = Number(String(k).split(':')[1]);
    if (Number.isFinite(exp) && exp < now) {
      revoked.delete(k);
      removed = true;
    }
  }
  return removed;
}

/** 黑名单清理：每次吊销时顺手清掉已过期的条目，防止长期运行内存增长 */
function revokeToken(payload: { userId: number; exp?: number; jti?: string }): void {
  if (!payload.exp) return;
  revoked.add(`${payload.userId}:${payload.exp}:${payload.jti ?? ''}`);
  pruneRevoked();
  // 持久化：重启后该令牌仍被吊销；同用户新签发的令牌 jti 不同，不受影响
  persistRevoked();
}

/* ---------------- 中间件 ---------------- */

/** 从请求中取令牌：优先 httpOnly Cookie（浏览器登录态），再读 Authorization: Bearer。
 *  Bearer 保留作后备，供 API 客户端与既有测试脚本用。
 *  不支持 ?token= query：令牌会泄漏进访问日志/浏览器历史/Referer。
 *  下载/上传类请求前端直接用 fetch，不再手动拼 Bearer 头（同源 cookie 自动带上）。 */
function readToken(req: Request): string | null {
  const cookie = req.headers.cookie;
  if (cookie) {
    for (const part of cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0 && part.slice(0, eq).trim() === COOKIE_NAME) {
        const v = part.slice(eq + 1).trim();
        if (v) return v;
      }
    }
  }
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

/** 尽力解析登录态：令牌缺失/失效/版本过期都返回 null，不抛 401。
 * 供 /auth/session 这类探测接口用；与 requireAuth 同一套校验（签名 + 版本），
 * 只是把「未登录」从 401 降级为 null，由调用方决定返回什么。 */
export function resolveAuth(req: Request): AuthUser | null {
  const token = readToken(req);
  const user = token ? verifyToken(token) : null;
  if (!user) return null;
  if (stmtTokenVer) {
    const row = stmtTokenVer.get(user.userId) as { tokenVer: number } | undefined;
    if (!row || user.ver !== row.tokenVer) return null;
  }
  return user;
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

/**
 * B-安4①：登录再加一层按用户名全局计数。只按 ip:username 计数时，攻击者换 IP
 * 即可重置；同一用户名 10 分钟内失败超 50 次则临时锁定该用户名，不论 IP。
 * 阈值远高于正常误操作（连输 50 次才锁），锁定窗口 10 分钟，避免“故意输错
 * 密码锁死正常用户”的 DoS；锁定只针对该用户名，不影响其他用户登录。
 * 被 IP 限速挡下的尝试也计入全局桶（它仍是一次未成功的登录尝试），否则
 * 单 IP 攻击下全局计数永远到不了 50 次。
 */
const userFailBucket = new Map<string, number[]>();
const USER_FAIL_WINDOW_MS = 10 * 60_000;
const USER_FAIL_MAX = 50;

function userTooManyFails(username: string): boolean {
  const now = Date.now();
  const list = (userFailBucket.get(username) ?? []).filter((t) => now - t < USER_FAIL_WINDOW_MS);
  userFailBucket.set(username, list);
  return list.length >= USER_FAIL_MAX;
}

function recordUserFail(username: string): void {
  const now = Date.now();
  const list = (userFailBucket.get(username) ?? []).filter((t) => now - t < USER_FAIL_WINDOW_MS);
  list.push(now);
  userFailBucket.set(username, list);
  if (userFailBucket.size > 1000) {
    for (const [k, v] of userFailBucket) {
      if (v.every((t) => now - t >= USER_FAIL_WINDOW_MS)) userFailBucket.delete(k);
    }
  }
}

function clearUserFails(username: string): void {
  userFailBucket.delete(username);
}

/**
 * B-安4②：改密接口的失败计数（与登录同款思路）。键为登录用户 id：旧密码连续
 * 猜错 5 次后冷却 10 分钟，冷却期内即使密码正确也返回 429；成功改密后清零。
 * 只计“旧密码校验失败”，新密码强度不合格不计（那不是猜密码）。
 */
const pwdChangeBucket = new Map<number, number[]>();
const PWD_CHANGE_WINDOW_MS = 10 * 60_000;
const PWD_CHANGE_MAX = 5;

function pwdChangeLocked(userId: number): boolean {
  const now = Date.now();
  const list = (pwdChangeBucket.get(userId) ?? []).filter((t) => now - t < PWD_CHANGE_WINDOW_MS);
  pwdChangeBucket.set(userId, list);
  return list.length >= PWD_CHANGE_MAX;
}

function recordPwdChangeFail(userId: number): void {
  const now = Date.now();
  const list = (pwdChangeBucket.get(userId) ?? []).filter((t) => now - t < PWD_CHANGE_WINDOW_MS);
  list.push(now);
  pwdChangeBucket.set(userId, list);
}

function clearPwdChangeFails(userId: number): void {
  pwdChangeBucket.delete(userId);
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

/**
 * B-安14：邀请码哈希化。旧格式明文存 `{ enabled, inviteCode }`，备份外泄即
 * 等于注册权限外泄；新格式只存 scrypt 哈希 `{ enabled, inviteCodeHash }`，
 * 校验用 verifyPassword。`inviteCode` 字段仅在读到存量明文行时出现（待迁移）。
 */
interface RegisterConf {
  enabled: boolean;
  inviteCodeHash: string;
  /** 存量明文邀请码（旧格式行才有）；读到后由 loadRegisterConfMigrated 转哈希 */
  inviteCode: string;
}

function loadRegisterConf(db: DatabaseSync): RegisterConf {
  const row = db.prepare(`SELECT value FROM setting WHERE teamId = ? AND key = ?`).get(GLOBAL_TEAM, REGISTER_KEY) as
    | { value: string }
    | undefined;
  if (!row) return { enabled: false, inviteCodeHash: '', inviteCode: '' };
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Record<string, unknown>;
      return {
        enabled: p.enabled === true,
        inviteCodeHash: typeof p.inviteCodeHash === 'string' ? p.inviteCodeHash : '',
        inviteCode: typeof p.inviteCode === 'string' ? p.inviteCode : '',
      };
    }
  } catch {
    /* 脏数据回落 */
  }
  return { enabled: false, inviteCodeHash: '', inviteCode: '' };
}

/** 写注册配置（只存哈希，永不写明文） */
function saveRegisterConf(db: DatabaseSync, conf: { enabled: boolean; inviteCodeHash: string }): void {
  db.prepare(
    `INSERT INTO setting (teamId, key, value) VALUES (?, ?, ?)
     ON CONFLICT(teamId, key) DO UPDATE SET value = excluded.value`,
  ).run(GLOBAL_TEAM, REGISTER_KEY, JSON.stringify({ enabled: conf.enabled, inviteCodeHash: conf.inviteCodeHash }));
}

/**
 * 读注册配置并做存量迁移：读到旧格式明文邀请码时，首次读取即转存为哈希
 * （B-安14 选定的迁移方式；此后库里不再有明文邀请码）。
 * 迁移写失败时不影响本次读取——调用方仍可用内存里的明文做一次性校验，
 * 下次读取再试迁移。
 */
async function loadRegisterConfMigrated(db: DatabaseSync): Promise<RegisterConf> {
  const conf = loadRegisterConf(db);
  if (conf.inviteCode && !conf.inviteCodeHash) {
    try {
      const hash = await hashPassword(conf.inviteCode);
      saveRegisterConf(db, { enabled: conf.enabled, inviteCodeHash: hash });
      return { enabled: conf.enabled, inviteCodeHash: hash, inviteCode: '' };
    } catch (e) {
      console.error('[auth] 邀请码明文转哈希失败（本次仍用明文校验）:', e);
    }
  }
  return conf;
}

/** 校验邀请码：有哈希时走 verifyPassword；仅当哈希缺失且内存里是存量明文时才走定长比较 */
async function verifyInviteCode(invite: string, conf: RegisterConf): Promise<boolean> {
  if (!invite) return false;
  if (conf.inviteCodeHash) return verifyPassword(invite, conf.inviteCodeHash);
  if (conf.inviteCode) return safeEqual(invite, conf.inviteCode);
  return false;
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
 * B-安5：黑名单扩到常见弱口令表；另有模式检查（见 checkPasswordStrength）。
 * 注意：黑名单是精确匹配整串密码，不含 'admin123456'、'clerk123456'、
 * 'test123456' 这类现有测试夹具密码——夹具密码本身不合新策略时，
 * 应由总协调人更新夹具，而非把弱口令放回白名单。
 */
const WEAK_PASSWORDS = new Set([
  '123456', '1234567', '12345678', '123456789', '1234567890',
  'password', 'password1', 'password123', 'password1234', 'passw0rd', 'passw0rd123',
  'admin123', 'admin1234', 'admin12345', 'admin888',
  'admin666', 'admin000', 'root123', 'root1234', 'abc123', 'abc123456',
  'abcd1234', 'abc12345', '111111', '11111111', '000000', '00000000', '666666', '888888', '88888888',
  '999999', '7777777', 'a123456', 'a1234567', 'a12345678', 'a123456789', '123123', '654321', '112233', '123321', '1qaz2wsx',
  'qwe123', 'qwerty', 'qwerty123', 'qwertyuiop', 'qq123456', 'taobao123', '1111111', '1111',
  'letmein', 'welcome', 'welcome1', 'monkey', 'dragon', 'football', 'iloveyou', 'sunshine',
  'master', 'shadow', 'superman', 'michael', 'asdfgh', 'asdfghjkl', 'zxcvbnm',
  '1q2w3e', '1q2w3e4r', 'qazwsx', '123qwe', '123456a', 'aa123456', 'a1b2c3', 'a1b2c3d4',
  '5201314', '1314520', 'woaini', 'test123', 'test1234', 'pass123', 'pass1234',
]);

/**
 * 键盘/数字/字母连续序列：密码整体是一段连续序列时拒绝，如 12345678、
 * abcdefgh、qwertyui。只判“整体是序列”（密码是该序列的子串），不判
 * “包含某段序列”——否则 admin123456 这类正常密码里的一小段 123 也会被误杀。
 */
const KEYBOARD_RUNS = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/**
 * 密码强度统一校验：长度 ≥8、不得包含用户名、不命中弱密码黑名单与弱模式。
 * B-安5：下限由 6 位提到 8 位；只对新设/修改的密码生效，不强制存量用户改密
 * （登录不校验强度，存量弱口令仍可登录）。
 */
function checkPasswordStrength(password: string, username?: string): string | null {
  if (password.length < 8) return '密码至少 8 位';
  if (password.length > 64) return '密码过长（最多 64 位）';
  // 密码不得包含用户名（不区分大小写；用户名为空时跳过）
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    return '密码不得包含用户名';
  }
  if (WEAK_PASSWORDS.has(password.toLowerCase())) {
    return '密码过于简单（常见弱口令），请换一个包含字母与数字的密码';
  }
  // 全同字符：同一字符连续出现 6 次及以上，如 aaaaaa、11111111
  if (/(.)\1{5,}/.test(password)) {
    return '密码过于简单（同一字符连续重复过多），请换一个包含字母与数字的密码';
  }
  // 键盘序列：密码整体是数字/字母/键盘行上的一段连续序列
  const lower = password.toLowerCase();
  for (const run of KEYBOARD_RUNS) {
    const rev = [...run].reverse().join('');
    if (run.includes(lower) || rev.includes(lower)) {
      return '密码过于简单（键盘连续序列），请换一个包含字母与数字的密码';
    }
  }
  return null;
}

/** 用户名统一校验：2-30 个字符 */
function checkUsername(username: string): string | null {
  if (!username || username.length < 2) return '用户名至少 2 个字符';
  if (username.length > 30) return '用户名过长（最多 30 个字符）';
  return null;
}

/** async 路由统一包装见 ./safe-handler.ts（B-安19①：与 backup.ts 共用同一模块） */

export function mountAuth(router: Router, db: DatabaseSync): void {
  // 供 requireAuth 做令牌版本比对（预编译语句，避免每请求重复编译）
  stmtTokenVer = db.prepare(`SELECT tokenVer FROM "user" WHERE id = ?`);
  // B-安1：启动时从 setting 表加载吊销表，并每小时清一次过期条目
  revokedDb = db;
  loadRevoked(db);
  if (!(globalThis as Record<string, unknown>).__revokedPruneTimer) {
    const timer = setInterval(() => {
      if (pruneRevoked()) persistRevoked();
    }, 60 * 60_000);
    timer.unref?.();
    (globalThis as Record<string, unknown>).__revokedPruneTimer = timer;
  }

  /** 注册：首个账号自动建团队；已有团队时按全局注册开关走邀请码建「独立新账套」 */
  router.post('/auth/register', safeHandler(async (req, res) => {
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
    const pwdErr = checkPasswordStrength(password, username);
    if (pwdErr) return fail(400, pwdErr);
    if (teamName.length > 60) return fail(400, '账套名称过长（最多 60 个字符）');

    /**
     * B-安2 + B-安3：注册原子化 + 首注册竞态。
     * “建 team + 默认档案 + 建 user”包进一个 BEGIN IMMEDIATE … COMMIT 事务，
     * 失败则 ROLLBACK——用户插入失败不再留下“无主账套”，首个管理员路径
     * 不会被一次失败注册永久关闭。
     * 事务内不做任何 await：node:sqlite 是同步 API，await 期间会长时间持写锁；
     * 密码哈希（scrypt，异步）与邀请码校验（scrypt，异步）一律先在事务外算好。
     * 事务开始后、插入前再次 SELECT COUNT(*) 重查 teamCount（B-安3），
     * 两个并发首注册只有一个能建成账套。
     * 注意：用户名重的预检（SELECT）已从事务外去掉——预检与 INSERT 之间
     * 本就有竞态窗口，真正的兜底是事务内 INSERT 撞唯一索引 idx_user_name
     * 后 ROLLBACK，返回同一条 400 文案。
     */
    const teamCountOut = (db.prepare('SELECT COUNT(*) AS c FROM team').get() as { c: number }).c;
    // 邀请码配置：事务外读一次（存量明文顺带转哈希，见 B-安14）
    const confOut = await loadRegisterConfMigrated(db);
    const invite = String(req.body.inviteCode ?? '').trim();
    // 事务外已校验通过的邀请码（已有账套时必须校验；首注册时若顺带传了
    // 邀请码也先验一次，供事务内“外面看是 0、里面已变 1”的竞态分支复核）
    let inviteVerified = false;
    if (teamCountOut > 0) {
      // 已有账套 → 开放注册默认关闭；开启后凭邀请码创建「独立新账套」（各用各的账套）
      if (!confOut.enabled) {
        return fail(400, '注册未开放，请联系已有账套的管理员开启');
      }
      if (!(await verifyInviteCode(invite, confOut))) {
        return fail(400, '邀请码不正确');
      }
      inviteVerified = true;
    } else if (invite && confOut.enabled && confOut.inviteCodeHash) {
      inviteVerified = await verifyPassword(invite, confOut.inviteCodeHash);
    }

    // 先在事务外算好密码哈希，再在事务内只做纯 SQL 插入
    const hashed = await hashPassword(password);
    const createdAt = new Date().toISOString();
    const teamNameOut = teamName || '我的账套';

    // 事务内可控失败用 sentinel 抛出，catch 里统一 ROLLBACK 后按原口径返回 400
    const txFail = (status: number, error: string): never => {
      throw { __txFail: true, status, error };
    };
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch {
      // BEGIN 失败即无事务，不执行 ROLLBACK（与 A-数3 同口径）
      return res.status(503).json({ error: '系统繁忙，请重试' });
    }
    let teamId: number;
    let userId: number;
    try {
      // B-安3：事务开始后、插入前再次重查 teamCount，按锁内最新值定分支
      const teamCountIn = (db.prepare('SELECT COUNT(*) AS c FROM team').get() as { c: number }).c;
      if (teamCountIn === 0) {
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
        const info = db.prepare('INSERT INTO team (name, startPeriod) VALUES (?, ?)').run(teamNameOut, startPeriod);
        teamId = Number(info.lastInsertRowid);
      } else {
        // 锁内已有账套：配置可能在事务外校验后刚被改动，重新读一次再定
        const confIn = loadRegisterConf(db);
        if (!confIn.enabled) {
          txFail(400, '注册未开放，请联系已有账套的管理员开启');
        }
        if (!inviteVerified) {
          txFail(400, '邀请码不正确');
        }
        const info = db.prepare('INSERT INTO team (name, startPeriod) VALUES (?, ?)').run(teamNameOut, localDate().slice(0, 7).replace('-', ''));
        teamId = Number(info.lastInsertRowid);
      }
      db.prepare(`INSERT INTO warehouse (teamId, name) VALUES (?, '默认仓库')`).run(teamId);
      db.prepare(`INSERT INTO account (teamId, name, type) VALUES (?, '现金', 'cash')`).run(teamId);
      db.prepare(`INSERT INTO cat (teamId, name) VALUES (?, '默认分类')`).run(teamId);
      const info = db
        .prepare(`INSERT INTO "user" (teamId, name, role, password, createdAt) VALUES (?, ?, 'admin', ?, ?)`)
        .run(teamId, username, hashed, createdAt);
      userId = Number(info.lastInsertRowid);
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 已无事务可回滚 */
      }
      const ce = e as { __txFail?: boolean; status?: number; error?: string; message?: string };
      if (ce && ce.__txFail) {
        return fail(ce.status ?? 400, ce.error ?? '注册失败');
      }
      if (String(ce?.message ?? '').includes('UNIQUE constraint failed')) {
        // 并发注册撞唯一索引 idx_user_name：team 与默认档案已随事务回滚，
        // teamCount 不变，可重新注册首个管理员
        return fail(400, '该用户名已被使用');
      }
      console.error('[auth] 注册事务失败:', e);
      return res.status(500).json({ error: '服务器内部错误' });
    }
    const user: AuthUser = { userId, teamId, role: 'admin', name: username, ver: 0 };
    // 注册成功清空失败计数：避免正常用户首次注册时因前面试错被误锁
    clearFails(failKey);
    // B-前5：注册也经 Set-Cookie 下发令牌（前端注册后直接进系统，不再读 body token）
    const token = issueToken(user);
    setAuthCookie(res, token);
    return res.json({ ok: true, token, user, teamId, teamName: teamNameOut });
  }));

  /** 登录 */
  router.post('/auth/login', safeHandler(async (req, res) => {
    const username = String(req.body.username ?? '').trim();
    const password = String(req.body.password ?? '');
    if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
    // B-安4①：先查按用户名全局锁定（不论 IP）。锁定中直接 429，不再计数，
    // 避免被挡下的尝试自我延续锁定；锁定只针对该用户名。
    if (userTooManyFails(username)) {
      return res.status(429).json({ error: '该账号登录尝试过于频繁，请 10 分钟后再试' });
    }
    // 失败计数 key 按 ip:username（理由同注册）：爆破单个账号不再误伤 NAT 后的其它账号
    const failKey = `${clientIp(req)}:${username}`;
    if (tooManyFails(failKey)) {
      // 被 IP 限速挡下也计入全局桶：否则单 IP 攻击下全局计数永远到不了 50 次
      recordUserFail(username);
      return res.status(429).json({ error: '尝试过于频繁，请 1 分钟后再试' });
    }
    const row = db.prepare(`SELECT * FROM "user" WHERE name = ?`).get(username) as UserRow | undefined;
    // A-安6：用户名不存在时也对固定假哈希跑一次 verifyPassword 再返回 401，
    // 否则“不存在（直接 401）”与“存在（跑一次 scrypt）”的耗时可区分用户是否存在。
    if (!row) {
      await verifyPassword(password, DUMMY_HASH);
      recordFail(failKey);
      recordUserFail(username);
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    if (!(await verifyPassword(password, row.password))) {
      recordFail(failKey);
      recordUserFail(username);
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    const team = db.prepare('SELECT id, name FROM team WHERE id = ?').get(row.teamId) as
      | { id: number; name: string }
      | undefined;
    const user: AuthUser = { userId: row.id, teamId: row.teamId, role: row.role, name: row.name, ver: row.tokenVer };
    // 登录成功清空失败计数：解锁此前的试错，下次登录不受影响
    clearFails(failKey);
    clearUserFails(username);
    // B-前5：登录经 Set-Cookie 下发令牌；JSON 里仍返回 token（API 客户端与测试用）
    const token = issueToken(user);
    setAuthCookie(res, token);
    return res.json({ ok: true, token, user, team });
  }));

  /** 退出登录：吊销当前令牌（此前只是客户端删 token，令牌在过期前仍可继续调用接口） */
  router.post('/auth/logout', requireAuth, (req, res) => {
    // B-前5：令牌可能来自 Cookie（浏览器）或 Bearer（API 客户端），统一用 readToken 取
    const token = readToken(req) ?? '';
    const dot = token.lastIndexOf('.');
    if (dot > 0) {
      try {
        const payload = JSON.parse(Buffer.from(token.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as
          { userId?: number; exp?: number; jti?: string };
        if (payload.userId && payload.exp) revokeToken(payload as { userId: number; exp: number; jti?: string });
      } catch { /* 令牌格式异常时无需吊销 */ }
    }
    // B-前5：登出同时清掉浏览器里的 Cookie（Max-Age=0）
    clearAuthCookie(res);
    return res.json({ ok: true });
  });

  /** 会话探测（前端启动时用）：永远返回 200，不用 401 区分登录态。
   * 未登录时浏览器对 401 的请求会在控制台留一条 Failed to load resource，
   * 登录页每次打开都会多一条报错，UI E2E 的「无 JS 报错」断言因此长红。
   * 已登录时顺带返回用户信息，与 /auth/me 同形。 */
  router.get('/auth/session', (req, res) => {
    const u = resolveAuth(req);
    if (!u) return res.json({ loggedIn: false });
    const team = db.prepare('SELECT id, name FROM team WHERE id = ?').get(u.teamId) as
      | { id: number; name: string }
      | undefined;
    return res.json({ loggedIn: true, user: u, team });
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
  router.post('/auth/password', requireAuth, safeHandler(async (req, res) => {
    const u = req.auth;
    if (!u) return res.status(401).json({ error: '未登录' });
    // B-安4②：旧密码连续猜错 5 次后冷却 10 分钟（失败计数，不含新密码强度不合格）
    if (pwdChangeLocked(u.userId)) {
      return res.status(429).json({ error: '改密尝试过于频繁，请 10 分钟后再试' });
    }
    const oldPwd = String(req.body.oldPassword ?? '');
    const newPwd = String(req.body.newPassword ?? '');
    const pwdErr = checkPasswordStrength(newPwd, u.name);
    if (pwdErr) return res.status(400).json({ error: '新' + pwdErr });
    const row = db.prepare(`SELECT * FROM "user" WHERE id = ?`).get(u.userId) as UserRow | undefined;
    if (!row || !(await verifyPassword(oldPwd, row.password))) {
      recordPwdChangeFail(u.userId);
      return res.status(400).json({ error: '原密码不正确' });
    }
    // 改密后 tokenVer + 1：吊销该用户全部旧令牌（含泄漏在外的），并为当前会话重签新令牌
    db.prepare(`UPDATE "user" SET password = ?, tokenVer = tokenVer + 1 WHERE id = ?`).run(await hashPassword(newPwd), u.userId);
    const fresh = db.prepare(`SELECT tokenVer FROM "user" WHERE id = ?`).get(u.userId) as { tokenVer: number } | undefined;
    const renewed: AuthUser = { userId: u.userId, teamId: u.teamId, role: u.role, name: u.name, ver: fresh?.tokenVer ?? row.tokenVer + 1 };
    // 改密成功清零失败计数
    clearPwdChangeFails(u.userId);
    // B-前5：改密会吊销旧令牌（tokenVer+1），重签的新令牌经 Set-Cookie 下发，
    // 否则浏览器里旧 cookie 失效后下一次请求即 401 被踢回登录页
    const renewedToken = issueToken(renewed);
    setAuthCookie(res, renewedToken);
    return res.json({ ok: true, token: renewedToken });
  }));

  /**
   * 读注册配置：仅系统所有者（首个账套）的 admin 可看，防止朋友账套的管理员改动全局开关。
   * B-安14：只返回 enabled 与“是否已设置”（hasInviteCode），不再回显明文邀请码。
   * 读到存量明文行时顺带转哈希（首次读取即迁移）。
   */
  router.get('/auth/register-conf', requireAuth, safeHandler(async (req, res) => {
    const u = req.auth;
    if (!u) return res.status(401).json({ error: '未登录' });
    if (u.role !== 'admin' || u.teamId !== OWNER_TEAM) {
      return res.status(403).json({ error: '只有系统所有者（首个账套）的管理员可以管理注册配置' });
    }
    const conf = await loadRegisterConfMigrated(db);
    return res.json({ enabled: conf.enabled, hasInviteCode: !!conf.inviteCodeHash });
  }));

  /**
   * 写注册配置：邀请码只存 scrypt 哈希，永不回显明文。
   * E 组契约：前端在“邀请码已设置且输入框留空”时只发 { enabled: true }、
   * 不带 inviteCode——此时保持原哈希不变，不要 400；只有“开启且从未设置
   * 邀请码”时才要求提供新码。关闭注册时清掉哈希。
   */
  router.post('/auth/register-conf', requireAuth, safeHandler(async (req, res) => {
    const u = req.auth;
    if (!u) return res.status(401).json({ error: '未登录' });
    if (u.role !== 'admin' || u.teamId !== OWNER_TEAM) {
      return res.status(403).json({ error: '只有系统所有者（首个账套）的管理员可以管理注册配置' });
    }
    const enabled = req.body.enabled === true;
    const inviteCode = String(req.body.inviteCode ?? '').trim();
    const existing = await loadRegisterConfMigrated(db);
    if (enabled) {
      if (inviteCode) {
        if (!/^[A-Za-z0-9-]{6,32}$/.test(inviteCode)) {
          return res.status(400).json({ error: '开启注册必须设置 6-32 位邀请码（字母/数字/短横线）' });
        }
        saveRegisterConf(db, { enabled: true, inviteCodeHash: await hashPassword(inviteCode) });
        return res.json({ ok: true, enabled: true, hasInviteCode: true });
      }
      // 未提供新码：已设置则保持原哈希不变；从未设置则 400
      if (!existing.inviteCodeHash) {
        return res.status(400).json({ error: '开启注册必须设置 6-32 位邀请码（字母/数字/短横线）' });
      }
      saveRegisterConf(db, { enabled: true, inviteCodeHash: existing.inviteCodeHash });
      return res.json({ ok: true, enabled: true, hasInviteCode: true });
    }
    saveRegisterConf(db, { enabled: false, inviteCodeHash: '' });
    return res.json({ ok: true, enabled: false, hasInviteCode: false });
  }));

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
  router.post('/auth/users', requireAuth, safeHandler(async (req, res) => {
    const u = req.auth;
    if (!u) return res.status(401).json({ error: '未登录' });
    if (u.role !== 'admin') return res.status(403).json({ error: '只有管理员可以添加用户' });
    const username = String(req.body.username ?? '').trim();
    const password = String(req.body.password ?? '');
    // B-安6：默认角色改为权限最小的 clerk，只有显式传 'admin' 才建管理员
    // （此前漏传 role 字段即静默产生新管理员，与最小权限原则相反）
    const role = req.body.role === 'admin' ? 'admin' : 'clerk';
    const nameErr = checkUsername(username);
    if (nameErr) return res.status(400).json({ error: nameErr });
    const pwdErr = checkPasswordStrength(password, username);
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
