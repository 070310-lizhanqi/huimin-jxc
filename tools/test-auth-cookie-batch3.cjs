/**
 * 回归测试：B-前5 token 从 localStorage 改 httpOnly Cookie（第三批最后）。
 *
 * 用 node:http 原始请求观测 Set-Cookie（fetch 会抹掉/合并响应头细节），
 * 不依赖浏览器。登录 JSON 仍返回 token（API 客户端与既有 Bearer 测试用），
 * 前端忽略 body 里的 token，只依赖 cookie。
 *
 * 覆盖：
 *  §1 登录响应 Set-Cookie：存在、名 oc_token、值与 body token 一致、
 *     HttpOnly、Path=/、SameSite=Lax、Max-Age=604800（7 天）、无 Secure、无 Domain；
 *     JSON body 仍返回 token。
 *  §2 只带 cookie（无 Authorization）能调 /auth/me 与 /warehouse。
 *  §3 Bearer 后备仍可用（无 cookie、只带 Authorization）。
 *  §4 登出：响应 Set-Cookie 清掉 cookie（Max-Age=0）；旧 cookie 再请求得 401。
 *  §5 未登录无 cookie 请求 401（/auth/me 与 /warehouse）。
 *  §6 /auth/status：带 cookie 返回 200 且 initialized 为 true；不带 cookie 也是
 *     200（公开端点，不要求登录，不因 cookie 改造而 401）。
 *  §7 改密：响应 Set-Cookie 下发重签的新令牌；新 cookie 可用，旧 cookie 401。
 *     用独立新建的 clerk 用户做，避免动共享 admin 的密码。
 *  §8 注册：响应 Set-Cookie 下发令牌（前端注册后直接进系统，不再经 localStorage）。
 *     需临时开启注册（邀请码），finally 里关闭并直连库删掉新建账套。
 *
 * 清理：finally 里删本轮新建的用户与账套（按本轮唯一 tag / 新建 teamId），
 * 直连 SQLite；改前跑失败也不留脏数据。注意：登出会把吊销写进 setting 表
 * （B-安1 既有行为，仅针对本轮令牌），不纳入行数核对。
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const OC_BASE = process.env.OC_BASE || 'http://127.0.0.1:7741/api';
const ROOT = OC_BASE.replace(/\/api\/?$/, '');
const ROOT_URL = new URL(ROOT);
const USER = process.env.ORANGE_USER || 'admin';
const PASS = process.env.ORANGE_PASS || 'B2cost!9Xq';
const DATA_DIR = process.env.ORANGE_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'huimin-clone.db');

const COOKIE_NAME = 'oc_token';
/** 令牌有效期 7 天（秒），与 server/src/auth.ts 的 TOKEN_TTL 一致 */
const TOKEN_TTL = 7 * 24 * 3600;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : '')); }
}

/** 原始 HTTP 请求（不自动处理 cookie、不解压），返回 { status, headers, text, json } */
function rawReq(method, pathname, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: ROOT_URL.hostname,
      port: Number(ROOT_URL.port),
      path: pathname,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== null) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}
const jsonHeaders = { 'Content-Type': 'application/json' };
const postJson = (p, body, extra = {}) => rawReq('POST', p, { headers: { ...jsonHeaders, ...extra }, body });
const getWith = (p, extra = {}) => rawReq('GET', p, { headers: { ...extra } });

/** 解析一条 Set-Cookie：返回 { name, value, attrs }，attrs 为 ';' 后的属性段数组 */
function parseSetCookie(sc) {
  const parts = String(sc).split(';').map((s) => s.trim());
  const [nv, ...attrs] = parts;
  const eq = nv.indexOf('=');
  return { name: nv.slice(0, eq), value: eq >= 0 ? nv.slice(eq + 1) : '', attrs };
}
const hasAttr = (attrs, re) => attrs.some((a) => re.test(a));
const attrVal = (attrs, re) => {
  const hit = attrs.find((a) => re.test(a));
  return hit ? hit.split('=')[1] : undefined;
};
/** 从响应取第一条 Set-Cookie（没有则返回 null） */
function firstSetCookie(res) {
  const sc = res.headers['set-cookie'];
  if (!sc || !sc.length) return null;
  return parseSetCookie(sc[0]);
}
const cookieHeader = (value) => ({ Cookie: `${COOKIE_NAME}=${value}` });
const bearerHeader = (token) => ({ Authorization: 'Bearer ' + token });

/* ---------- 清理：直连 SQLite 删本轮新建的用户与账套 ---------- */
const CLEAN_TABLES = ['user', 'team', 'warehouse', 'account', 'cat'];
let runTag = '';
let tmpUserId = null;
let regTeamId = null;
let regConfOpened = false;
function openTestDb() {
  if (!fs.existsSync(DB_PATH)) throw new Error('数据库文件不存在：' + DB_PATH + '（是否漏设 ORANGE_DATA_DIR？）');
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}
function countAll(db) {
  const out = {};
  for (const t of CLEAN_TABLES) {
    try { out[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; }
    catch { out[t] = -1; }
  }
  return out;
}
async function cleanupAndVerify(before, adminToken) {
  // 先走接口恢复注册开关（§8 临时开启过），再直连库删数据
  if (regConfOpened && adminToken) {
    try {
      const r = await postJson('/api/auth/register-conf', { enabled: false }, bearerHeader(adminToken));
      check('清理：注册开关已关回', r.status === 200, { status: r.status, body: r.json });
      regConfOpened = false;
    } catch (e) {
      check('清理：注册开关已关回', false, String((e && e.message) || e));
    }
  }
  let db = null;
  try {
    db = openTestDb();
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      if (tmpUserId) db.prepare('DELETE FROM "user" WHERE id = ?').run(tmpUserId);
      if (regTeamId) {
        for (const t of ['warehouse', 'account', 'cat']) {
          db.prepare(`DELETE FROM ${t} WHERE teamId = ?`).run(regTeamId);
        }
        db.prepare('DELETE FROM "user" WHERE teamId = ?').run(regTeamId);
        db.prepare('DELETE FROM team WHERE id = ?').run(regTeamId);
      }
      // 兜底：按 tag 前缀删（注册用户名/账套名都带 tag）
      db.prepare('DELETE FROM "user" WHERE name LIKE ?').run(`${runTag}%`);
      db.prepare('DELETE FROM team WHERE name LIKE ?').run(`${runTag}%`);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
    const after = countAll(db);
    const allBack = CLEAN_TABLES.every((t) => before[t] === after[t]);
    check('清理：跑后相关表行数回到跑前', allBack, { before, after });
  } catch (e) {
    check('清理：删除本轮用户与账套', false, String((e && e.message) || e));
  } finally {
    try { if (db) db.close(); } catch { /* ignore */ }
  }
}

async function mainBody() {
  console.log('[test-auth-cookie-batch3] B-前5：token 从 localStorage 改 httpOnly Cookie');
  const t0 = Date.now();
  const tag = `B3C${Date.now().toString(36)}`;
  runTag = tag;

  // ---------- 前置：确保已初始化（独立跑时可能面对空库） ----------
  const st = await getWith('/api/auth/status');
  check('前置：/auth/status 可达', st.status === 200 && st.json && typeof st.json.initialized === 'boolean', { status: st.status, body: st.json });
  if (st.json && st.json.initialized === false) {
    const reg = await postJson('/api/auth/register', { username: USER, password: PASS, teamName: '我的账套' });
    check('前置：空库首注册成功', reg.status === 200 && reg.json && !!reg.json.token, { status: reg.status, body: reg.json });
  }

  // ---------- §1 登录 Set-Cookie ----------
  const login = await postJson('/api/auth/login', { username: USER, password: PASS });
  check('§1 登录 200 且 body 有 token', login.status === 200 && login.json && typeof login.json.token === 'string' && login.json.token.length > 0, { status: login.status, body: login.json });
  const bodyToken = login.json && login.json.token;
  const sc = firstSetCookie(login);
  check('§1 登录响应带 Set-Cookie', !!sc, login.headers['set-cookie']);
  if (sc) {
    check('§1 Set-Cookie 名为 oc_token 且值非空', sc.name === COOKIE_NAME && sc.value.length > 0, sc);
    check('§1 Set-Cookie 含 HttpOnly', hasAttr(sc.attrs, /^HttpOnly$/i), sc.attrs);
    check('§1 Set-Cookie Path=/', attrVal(sc.attrs, /^Path=/i) === '/', sc.attrs);
    check('§1 Set-Cookie SameSite=Lax', (attrVal(sc.attrs, /^SameSite=/i) || '').toLowerCase() === 'lax', sc.attrs);
    check('§1 Set-Cookie Max-Age=604800（7 天）', attrVal(sc.attrs, /^Max-Age=/i) === String(TOKEN_TTL), sc.attrs);
    check('§1 Set-Cookie 不含 Secure（本地明文 HTTP）', !hasAttr(sc.attrs, /^Secure$/i), sc.attrs);
    check('§1 Set-Cookie 不设 Domain', !hasAttr(sc.attrs, /^Domain=/i), sc.attrs);
    check('§1 Cookie 值与 body token 一致', sc.value === bodyToken, { cookieLen: sc.value.length, bodyLen: bodyToken ? bodyToken.length : 0 });
  } else {
    for (const n of ['§1 Set-Cookie 名为 oc_token 且值非空', '§1 Set-Cookie 含 HttpOnly', '§1 Set-Cookie Path=/',
      '§1 Set-Cookie SameSite=Lax', '§1 Set-Cookie Max-Age=604800（7 天）', '§1 Set-Cookie 不含 Secure（本地明文 HTTP）',
      '§1 Set-Cookie 不设 Domain', '§1 Cookie 值与 body token 一致']) check(n, false, '无 Set-Cookie，无法断言');
  }
  const cookieVal = sc ? sc.value : null;

  // ---------- §2 只带 cookie 能访问 ----------
  if (cookieVal) {
    const me = await getWith('/api/auth/me', cookieHeader(cookieVal));
    check('§2 只带 cookie 调 /auth/me 200 且是 admin', me.status === 200 && me.json && me.json.user && me.json.user.name === USER, { status: me.status, body: me.json });
    const wh = await getWith('/api/warehouse', cookieHeader(cookieVal));
    check('§2 只带 cookie 调 /warehouse 200', wh.status === 200 && Array.isArray(wh.json), { status: wh.status, body: wh.json });
  } else {
    check('§2 只带 cookie 调 /auth/me 200 且是 admin', false, '无 cookie 可测');
    check('§2 只带 cookie 调 /warehouse 200', false, '无 cookie 可测');
  }

  // ---------- §3 Bearer 后备仍可用（登出前测：登出会吊销该令牌） ----------
  if (bodyToken) {
    const meB = await getWith('/api/auth/me', bearerHeader(bodyToken));
    check('§3 无 cookie、只带 Bearer 调 /auth/me 200', meB.status === 200 && meB.json && meB.json.user && meB.json.user.name === USER, { status: meB.status, body: meB.json });
    const whB = await getWith('/api/warehouse', bearerHeader(bodyToken));
    check('§3 无 cookie、只带 Bearer 调 /warehouse 200', whB.status === 200 && Array.isArray(whB.json), { status: whB.status, body: whB.json });
  } else {
    check('§3 无 cookie、只带 Bearer 调 /auth/me 200', false, '登录未返回 token');
    check('§3 无 cookie、只带 Bearer 调 /warehouse 200', false, '登录未返回 token');
  }

  // ---------- §4 登出清 cookie + 旧 cookie 失效 ----------
  if (cookieVal) {
    const out = await postJson('/api/auth/logout', {}, cookieHeader(cookieVal));
    check('§4 带 cookie 登出 200', out.status === 200 && out.json && out.json.ok === true, { status: out.status, body: out.json });
    const scOut = firstSetCookie(out);
    check('§4 登出响应 Set-Cookie 清 cookie', !!scOut && scOut.name === COOKIE_NAME, out.headers['set-cookie']);
    if (scOut) {
      check('§4 清 cookie 的 Max-Age=0', attrVal(scOut.attrs, /^Max-Age=/i) === '0', scOut.attrs);
      check('§4 清 cookie 的值为空', scOut.value === '', scOut);
    } else {
      check('§4 清 cookie 的 Max-Age=0', false, '无 Set-Cookie');
      check('§4 清 cookie 的值为空', false, '无 Set-Cookie');
    }
    const meOld = await getWith('/api/auth/me', cookieHeader(cookieVal));
    check('§4 旧 cookie 再调 /auth/me 得 401', meOld.status === 401, { status: meOld.status, body: meOld.json });
  } else {
    for (const n of ['§4 带 cookie 登出 200', '§4 登出响应 Set-Cookie 清 cookie', '§4 清 cookie 的 Max-Age=0', '§4 清 cookie 的值为空', '§4 旧 cookie 再调 /auth/me 得 401']) check(n, false, '无 cookie 可测');
  }

  // ---------- §5 未登录无 cookie 401 ----------
  const meNo = await getWith('/api/auth/me');
  check('§5 无 cookie 调 /auth/me 得 401', meNo.status === 401, { status: meNo.status, body: meNo.json });
  const whNo = await getWith('/api/warehouse');
  check('§5 无 cookie 调 /warehouse 得 401', whNo.status === 401, { status: whNo.status, body: whNo.json });

  // ---------- §6 /auth/status ----------
  // 登录态判断入口：前端启动时先调它决定显示注册还是登录；它本身是公开端点，
  // cookie 改造不应让它 401，也不应要求它携带登录态。
  const stCookie = cookieVal
    ? await getWith('/api/auth/status', cookieHeader(cookieVal))
    : await getWith('/api/auth/status');
  check('§6 /auth/status 带 cookie 200 且 initialized 为 true', stCookie.status === 200 && stCookie.json && stCookie.json.initialized === true, { status: stCookie.status, body: stCookie.json });
  const stBare = await getWith('/api/auth/status');
  check('§6 /auth/status 不带 cookie 也是 200（公开端点）', stBare.status === 200 && stBare.json && stBare.json.initialized === true, { status: stBare.status, body: stBare.json });

  // ---------- §7 改密后 cookie 更新（独立 clerk 用户） ----------
  // 重新登录 admin（§4 已登出吊销了旧令牌），新建临时用户
  const adminLogin = await postJson('/api/auth/login', { username: USER, password: PASS });
  const adminToken = adminLogin.json && adminLogin.json.token;
  check('§7 前置：admin 重新登录成功', adminLogin.status === 200 && !!adminToken, { status: adminLogin.status });
  const tmpName = `${tag}u`;
  const tmpPassOld = 'B3Tmp!9Xq';
  const tmpPassNew = 'B3Tmp!8Wr';
  if (adminToken) {
    const created = await postJson('/api/auth/users', { username: tmpName, password: tmpPassOld, role: 'clerk' }, bearerHeader(adminToken));
    check('§7 前置：新建临时 clerk 用户', created.status === 200 && created.json && typeof created.json.id === 'number', { status: created.status, body: created.json });
    tmpUserId = created.json && created.json.id;
    if (tmpUserId) {
      const uLogin = await postJson('/api/auth/login', { username: tmpName, password: tmpPassOld });
      const uSc = firstSetCookie(uLogin);
      const uCookie = uSc ? uSc.value : null;
      check('§7 前置：临时用户登录拿到 cookie', uLogin.status === 200 && !!uCookie, { status: uLogin.status, setCookie: uLogin.headers['set-cookie'] });
      if (uCookie) {
        const pwd = await postJson('/api/auth/password', { oldPassword: tmpPassOld, newPassword: tmpPassNew }, cookieHeader(uCookie));
        check('§7 改密 200', pwd.status === 200 && pwd.json && pwd.json.ok === true, { status: pwd.status, body: pwd.json });
        const pwdSc = firstSetCookie(pwd);
        check('§7 改密响应 Set-Cookie 下发新令牌', !!pwdSc && pwdSc.name === COOKIE_NAME && pwdSc.value.length > 0, pwd.headers['set-cookie']);
        check('§7 改密响应 JSON 仍返回 token', pwd.json && typeof pwd.json.token === 'string' && pwd.json.token.length > 0, pwd.json);
        if (pwdSc) {
          check('§7 改密后新 cookie 可用', (await getWith('/api/auth/me', cookieHeader(pwdSc.value))).status === 200, '新 cookie 调 /auth/me');
          check('§7 改密后旧 cookie 得 401（tokenVer 已变）', (await getWith('/api/auth/me', cookieHeader(uCookie))).status === 401, '旧 cookie 调 /auth/me');
        } else {
          check('§7 改密后新 cookie 可用', false, '改密未下发 Set-Cookie');
          check('§7 改密后旧 cookie 得 401（tokenVer 已变）', false, '改密未下发 Set-Cookie');
        }
      } else {
        for (const n of ['§7 改密 200', '§7 改密响应 Set-Cookie 下发新令牌', '§7 改密响应 JSON 仍返回 token', '§7 改密后新 cookie 可用', '§7 改密后旧 cookie 得 401（tokenVer 已变）']) check(n, false, '临时用户无 cookie 可测');
      }
    } else {
      for (const n of ['§7 前置：临时用户登录拿到 cookie', '§7 改密 200', '§7 改密响应 Set-Cookie 下发新令牌', '§7 改密响应 JSON 仍返回 token', '§7 改密后新 cookie 可用', '§7 改密后旧 cookie 得 401（tokenVer 已变）']) check(n, false, '临时用户未建成');
    }
  } else {
    for (const n of ['§7 前置：新建临时 clerk 用户', '§7 前置：临时用户登录拿到 cookie', '§7 改密 200', '§7 改密响应 Set-Cookie 下发新令牌', '§7 改密响应 JSON 仍返回 token', '§7 改密后新 cookie 可用', '§7 改密后旧 cookie 得 401（tokenVer 已变）']) check(n, false, 'admin 未登录');
  }

  // ---------- §8 注册也下发 Set-Cookie ----------
  // 临时开启注册（邀请码），注册一个新账套用户，finally 里关开关并删账套。
  if (adminToken) {
    const invite = `${tag}INV`;
    const conf = await postJson('/api/auth/register-conf', { enabled: true, inviteCode: invite }, bearerHeader(adminToken));
    check('§8 前置：临时开启注册', conf.status === 200 && conf.json && conf.json.enabled === true, { status: conf.status, body: conf.json });
    if (conf.status === 200 && conf.json && conf.json.enabled === true) {
      regConfOpened = true;
      const regName = `${tag}r`;
      const reg = await postJson('/api/auth/register', { username: regName, password: 'B3Reg!9Xq', teamName: `${tag}team`, inviteCode: invite });
      check('§8 注册 200 且 body 有 token', reg.status === 200 && reg.json && typeof reg.json.token === 'string' && reg.json.token.length > 0, { status: reg.status, body: reg.json });
      regTeamId = reg.json && reg.json.teamId;
      const regSc = firstSetCookie(reg);
      check('§8 注册响应 Set-Cookie 下发令牌', !!regSc && regSc.name === COOKIE_NAME && regSc.value.length > 0, reg.headers['set-cookie']);
      if (regSc) {
        const meReg = await getWith('/api/auth/me', cookieHeader(regSc.value));
        check('§8 注册 cookie 可直接调 /auth/me', meReg.status === 200 && meReg.json && meReg.json.user && meReg.json.user.name === regName, { status: meReg.status, body: meReg.json });
      } else {
        check('§8 注册 cookie 可直接调 /auth/me', false, '注册未下发 Set-Cookie');
      }
    } else {
      for (const n of ['§8 注册 200 且 body 有 token', '§8 注册响应 Set-Cookie 下发令牌', '§8 注册 cookie 可直接调 /auth/me']) check(n, false, '注册未开启');
    }
  } else {
    for (const n of ['§8 前置：临时开启注册', '§8 注册 200 且 body 有 token', '§8 注册响应 Set-Cookie 下发令牌', '§8 注册 cookie 可直接调 /auth/me']) check(n, false, 'admin 未登录');
  }

  console.log(`[test-auth-cookie-batch3] 通过 ${pass} / ${pass + fail}，总耗时 ${Date.now() - t0}ms`);
  return { pass, fail, adminToken };
}

(async () => {
  let before = null;
  try {
    const db = openTestDb();
    try { before = countAll(db); } finally { try { db.close(); } catch { /* ignore */ } }
  } catch (e) {
    console.log('[test-auth-cookie-batch3] 跑前行数快照失败：' + e.message);
  }
  let result = { pass: 0, fail: 1, adminToken: null };
  try {
    result = await mainBody();
  } catch (e) {
    check('主流程未抛未捕获异常', false, String((e && e.stack) || e));
    console.log(`[test-auth-cookie-batch3] 通过 ${pass} / ${pass + fail}`);
  } finally {
    if (before) await cleanupAndVerify(before, result.adminToken);
  }
  process.exit(result.fail === 0 && fail === 0 ? 0 : 1);
})();
