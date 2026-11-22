/**
 * 第二批 A 组（鉴权与注册）回归测试：B-安1/2/3/4/5/6/14/15、A-安3（settings 部分）、B-安19。
 *
 * 自带服务生命周期：用唯一端口 7751 与唯一临时数据目录 /tmp/huimin-b2-a 起服务，
 * 跑完停掉自己的测试服务。测试之间用 wipe + 重启隔离阶段。
 * 前置：需先 pnpm build（dist/server/*.js 须存在且新于 server/src/*.ts，否则直接报错退出）。
 *
 * 用法：node tools/test-auth-batch2.cjs
 */
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 7751;
const DATA_DIR = '/tmp/huimin-b2-a';
const BASE = `http://127.0.0.1:${PORT}/api`;
const ENTRY = path.join(ROOT, 'dist', 'server', 'index.js');
const DB_PATH = path.join(DATA_DIR, 'huimin-clone.db');
/** 默认 JWT 密钥（服务端未设 ORANGE_JWT_SECRET 时的回落值，仅用于伪造令牌测试） */
const DEFAULT_SECRET = 'huimin-clone-local-secret-v1';

const results = [];
let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? '  ' + extra : ''}`); }
  results.push({ name, ok: !!cond });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, p, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, data };
}

/** 注册总限速 10 次/分钟/IP：调用过多时主动等窗口滑过，避免 429 污染断言 */
const regCalls = [];
async function registerPost(body) {
  for (;;) {
    const now = Date.now();
    while (regCalls.length && now - regCalls[0] >= 60_000) regCalls.shift();
    if (regCalls.length < 9) break;
    const wait = 60_000 - (now - regCalls[0]) + 1000;
    console.log(`[节流] 注册调用达 9 次/分钟，等待 ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
  regCalls.push(Date.now());
  return req('POST', '/auth/register', body);
}

function hashSync(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function forgeToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', DEFAULT_SECRET).update(body).digest().toString('base64url');
  return `${body}.${sig}`;
}

function decodePayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}

function openDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 5000');
  // 测试连接专供直写种子/断言：关掉外键（node:sqlite 默认 foreign_keys=ON），
  // 才能写 teamId=999 的“孤儿用户”这类非法中间态；服务端连接不受影响
  db.exec('PRAGMA foreign_keys = OFF');
  return db;
}

/* ---------------- 服务生命周期 ---------------- */

let child = null;
let childOut = '';
function spawnServer() {
  const env = { ...process.env, PORT: String(PORT), ORANGE_DATA_DIR: DATA_DIR };
  delete env.ORANGE_JWT_SECRET; // 伪造令牌测试依赖默认密钥
  childOut = '';
  child = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => { childOut += d.toString(); });
  child.stderr.on('data', (d) => { childOut += d.toString(); });
}

async function waitReady(timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(BASE + '/auth/status');
      if (r.ok) return true;
    } catch { /* 未起 */ }
    if (Date.now() - t0 > timeoutMs) {
      console.log('--- 服务启动日志 ---\n' + childOut.slice(-2000));
      return false;
    }
    await sleep(250);
  }
}

async function stopServer() {
  if (!child) return;
  const c = child;
  child = null;
  if (c.exitCode !== null) return;
  c.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((r) => c.once('exit', () => r(true))),
    sleep(8000).then(() => false),
  ]);
  if (!exited) c.kill('SIGKILL');
  await sleep(500); // 等端口释放，避免重起时 listenOn 后移到 7752
}

async function restartServer() {
  await stopServer();
  spawnServer();
  if (!(await waitReady())) throw new Error('服务重启后未就绪');
}

async function wipeAndStart() {
  await stopServer();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  spawnServer();
  if (!(await waitReady())) throw new Error('服务启动后未就绪');
}

async function getStatus() {
  return (await req('GET', '/auth/status')).data;
}

async function loginAs(username, password) {
  const r = await req('POST', '/auth/login', { username, password });
  if (r.status !== 200 || !r.data?.token) throw new Error(`登录失败 ${username}: ${JSON.stringify(r.data)}`);
  return r.data.token;
}

/* ---------------- 测试 ---------------- */

(async () => {
  // 前置：dist 必须新鲜，否则测的是旧代码
  for (const f of ['auth', 'settings', 'safe-handler']) {
    const src = path.join(ROOT, 'server', 'src', `${f}.ts`);
    const out = path.join(ROOT, 'dist', 'server', `${f}.js`);
    if (!fs.existsSync(out)) {
      console.error(`[前置失败] ${out} 不存在，请先跑 pnpm build`);
      process.exit(2);
    }
    if (fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs) {
      console.error(`[前置失败] ${out} 比源码旧，请先跑 pnpm build`);
      process.exit(2);
    }
  }

  try {
    /* ===== Phase 0：干净启动 ===== */
    await wipeAndStart();
    let st = await getStatus();
    check('P0 全新库未初始化', st.initialized === false && st.teamCount === 0, JSON.stringify(st));

    /* ===== Phase 1：B-安3 首注册竞态 ===== */
    const [raceA, raceB] = await Promise.all([
      registerPost({ username: 'raceone', password: 'Race!One11', teamName: '竞态甲' }),
      registerPost({ username: 'racetwo', password: 'Race!Two22', teamName: '竞态乙' }),
    ]);
    const raceOk = (raceA.status === 200 && raceB.status === 400) || (raceA.status === 400 && raceB.status === 200);
    check('B-安3 并发首注册恰好一个成功一个 400', raceOk, `A=${raceA.status} B=${raceB.status}`);
    st = await getStatus();
    check('B-安3 竞态后只有一个账套', st.teamCount === 1, `teamCount=${st.teamCount}`);

    /* ===== Phase 2：B-安2 注册原子化（用户插入失败 → 无无主账套） ===== */
    await wipeAndStart();
    st = await getStatus();
    check('B-安2 重新 wipe 后 teamCount=0', st.teamCount === 0, JSON.stringify(st));
    // 直写一个“孤儿用户”：teamId 指向不存在的账套（测试连接默认 foreign_keys=OFF），
    // 使随后的注册在事务内建 team 后、建 user 时撞唯一索引
    {
      const db = openDb();
      db.prepare(`INSERT INTO "user" (teamId, name, role, password, createdAt) VALUES (?, 'clashuser', 'admin', ?, ?)`)
        .run(999, hashSync('Seed!Pass99'), new Date().toISOString());
      const row = db.prepare(`SELECT id FROM "user" WHERE name = 'clashuser'`).get();
      db.close();
      check('B-安2 孤儿用户已直写进库', !!row);
    }
    st = await getStatus();
    check('B-安2 种子状态 teamCount=0/userCount=1', st.teamCount === 0 && st.userCount === 1, JSON.stringify(st));
    let r = await registerPost({ username: 'clashuser', password: 'Clash!Pass9', teamName: '冲突测试' });
    check('B-安2 用户插入撞唯一索引返回 400', r.status === 400 && r.data?.error === '该用户名已被使用', `status=${r.status} ${r.data?.error || ''}`);
    st = await getStatus();
    check('B-安2 失败后 teamCount 仍为 0（事务已回滚）', st.teamCount === 0, `teamCount=${st.teamCount}`);
    {
      const db = openDb();
      db.prepare(`DELETE FROM "user" WHERE name = 'clashuser'`).run();
      db.close();
    }
    r = await registerPost({ username: 'clashuser', password: 'Clash!Pass9', teamName: '冲突测试' });
    check('B-安2 清掉冲突后可重新注册首个管理员', r.status === 200 && !!r.data?.token, `status=${r.status} ${r.data?.error || ''}`);
    const ADMIN = { username: 'clashuser', password: 'Clash!Pass9' };
    let adminToken = r.data?.token;
    st = await getStatus();
    check('B-安2 注册后 teamCount=1', st.teamCount === 1, `teamCount=${st.teamCount}`);

    /* ===== Phase 3：B-安15 令牌载荷类型校验 ===== */
    {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const forged = [
        ['userId:true', { userId: true, teamId: 1, role: 'admin', name: 'x', ver: 0, exp }],
        ['userId:{}', { userId: {}, teamId: 1, role: 'admin', name: 'x', ver: 0, exp }],
        ['userId:1.5', { userId: 1.5, teamId: 1, role: 'admin', name: 'x', ver: 0, exp }],
        ["userId:'1'", { userId: '1', teamId: 1, role: 'admin', name: 'x', ver: 0, exp }],
        ['userId:null', { userId: null, teamId: 1, role: 'admin', name: 'x', ver: 0, exp }],
        ["teamId:'1'", { userId: 1, teamId: '1', role: 'admin', name: 'x', ver: 0, exp }],
        ['teamId:1.5', { userId: 1, teamId: 1.5, role: 'admin', name: 'x', ver: 0, exp }],
        ['role:123', { userId: 1, teamId: 1, role: 123, name: 'x', ver: 0, exp }],
        ['role 缺失', { userId: 1, teamId: 1, name: 'x', ver: 0, exp }],
        ['ver 不匹配', { userId: 1, teamId: 1, role: 'admin', name: 'x', ver: 99, exp }],
      ];
      for (const [label, payload] of forged) {
        const rr = await req('GET', '/product', null, forgeToken(payload));
        check(`B-安15 伪造载荷 ${label} 返回 401`, rr.status === 401, `status=${rr.status}`);
      }
    }

    /* ===== Phase 4：B-安5 密码策略 ===== */
    // 注册路径（2 个样本；其余走 /auth/users，避免注册总限速）
    r = await registerPost({ username: 'weak1', password: '12345678' });
    check('B-安5 注册：黑名单 12345678 被拒', r.status === 400 && /密码/.test(r.data?.error || ''), `status=${r.status} ${r.data?.error || ''}`);
    r = await registerPost({ username: 'bob', password: 'BobSecure1' });
    check('B-安5 注册：密码含用户名被拒', r.status === 400 && r.data?.error === '密码不得包含用户名', `status=${r.status} ${r.data?.error || ''}`);
    // 管理员建用户路径
    const weakCases = [
      ['weak-a', 'aaaaaaaa', '全同字符'],
      ['weak-b', 'abcdefgh', '字母键盘序列'],
      ['weak-c', 'qwertyui', '键盘行序列'],
      ['weak-d', 'short77', '不足 8 位'],
      ['weak-e', 'password123', '黑名单'],
      ['weak-f', 'Admin123', '黑名单（大小写不敏感）'],
    ];
    for (const [uname, pwd, label] of weakCases) {
      const rr = await req('POST', '/auth/users', { username: uname, password: pwd }, adminToken);
      check(`B-安5 建用户：${label}「${pwd}」被拒`, rr.status === 400 && /密码/.test(rr.data?.error || ''), `status=${rr.status} ${rr.data?.error || ''}`);
    }
    // 合规密码可建（同时是 B-安6 的默认角色样本）
    r = await req('POST', '/auth/users', { username: 'stronguser', password: 'Str0ng!Pass9' }, adminToken);
    check('B-安5 合规密码可建用户', r.status === 200 && !!r.data?.id, `status=${r.status} ${r.data?.error || ''}`);
    // 存量弱口令不强制改密：直写一个密码为 123456 的用户，仍可登录
    {
      const db = openDb();
      db.prepare(`INSERT INTO "user" (teamId, name, role, password, createdAt) VALUES (1, 'legacyweak', 'clerk', ?, ?)`)
        .run(hashSync('123456'), new Date().toISOString());
      db.close();
    }
    r = await req('POST', '/auth/login', { username: 'legacyweak', password: '123456' });
    check('B-安5 存量弱口令用户仍可登录（不强制改密）', r.status === 200 && !!r.data?.token, `status=${r.status}`);

    /* ===== Phase 5：B-安4① 登录按用户名全局限速 ===== */
    r = await req('POST', '/auth/users', { username: 'locktest', password: 'L0ck!Test9' }, adminToken);
    check('B-安4① 建限速测试用户', r.status === 200, `status=${r.status} ${r.data?.error || ''}`);
    {
      const statuses = [];
      for (let i = 0; i < 55; i++) {
        const rr = await req('POST', '/auth/login', { username: 'locktest', password: 'Wrong!000' });
        statuses.push(rr.status);
      }
      check('B-安4① 前 15 次失败为 401（IP 桶未满）', statuses.slice(0, 15).every((s) => s === 401), statuses.slice(0, 15).join(','));
      check('B-安4① 第 51 次为 429（全局 50 次已满）', statuses[50] === 429, `status[50]=${statuses[50]}`);
      console.log('[B-安4①] 等待 61s，让 IP 桶窗口滑过，验证全局锁独立于 IP……');
      await sleep(61_000);
      const rr = await req('POST', '/auth/login', { username: 'locktest', password: 'Wrong!000' });
      check('B-安4① IP 窗口滑过后仍 429（全局锁 10 分钟未解）', rr.status === 429, `status=${rr.status}`);
      const rr2 = await req('POST', '/auth/login', { username: 'locktest', password: 'L0ck!Test9' });
      check('B-安4① 锁定期内正确密码也 429', rr2.status === 429, `status=${rr2.status}`);
      const rr3 = await req('POST', '/auth/login', { username: ADMIN.username, password: ADMIN.password });
      check('B-安4① 其他用户登录不受影响', rr3.status === 200 && !!rr3.data?.token, `status=${rr3.status}`);
      adminToken = rr3.data?.token; // 刷新 adminToken（旧的仍有效，刷新无妨）
    }

    /* ===== Phase 6：B-安4② 改密限速 ===== */
    r = await req('POST', '/auth/users', { username: 'pwdtest', password: 'Pwd!Test77' }, adminToken);
    check('B-安4② 建改密测试用户', r.status === 200, `status=${r.status} ${r.data?.error || ''}`);
    const pwdToken = await loginAs('pwdtest', 'Pwd!Test77');
    {
      let all400 = true;
      for (let i = 0; i < 5; i++) {
        const rr = await req('POST', '/auth/password', { oldPassword: 'Wrong!Old1', newPassword: 'New!Pass88' }, pwdToken);
        if (rr.status !== 400 || rr.data?.error !== '原密码不正确') all400 = false;
      }
      check('B-安4② 前 5 次旧密码错误均为 400', all400);
      const rr = await req('POST', '/auth/password', { oldPassword: 'Pwd!Test77', newPassword: 'New!Pass88' }, pwdToken);
      check('B-安4② 第 6 次（正确旧密码）进冷却 429', rr.status === 429, `status=${rr.status} ${rr.data?.error || ''}`);
    }

    /* ===== Phase 7：B-安6 管理员建用户默认角色 ===== */
    {
      const list = (await req('GET', '/auth/users', null, adminToken)).data;
      const find = (name) => (Array.isArray(list) ? list.find((u) => u.name === name) : null);
      check('B-安6 不传 role 默认 clerk', find('stronguser')?.role === 'clerk', `role=${find('stronguser')?.role}`);
      r = await req('POST', '/auth/users', { username: 'roleadmin', password: 'Role!Admin1', role: 'admin' }, adminToken);
      check('B-安6 显式 role=admin 建管理员', r.status === 200, `status=${r.status} ${r.data?.error || ''}`);
      r = await req('POST', '/auth/users', { username: 'roleclerk', password: 'Role!Clerk2', role: 'clerk' }, adminToken);
      check('B-安6 显式 role=clerk 建店员', r.status === 200, `status=${r.status} ${r.data?.error || ''}`);
      r = await req('POST', '/auth/users', { username: 'rolegarbage', password: 'Role!Garb3', role: 'superuser' }, adminToken);
      check('B-安6 非法 role 值回落 clerk', r.status === 200, `status=${r.status} ${r.data?.error || ''}`);
      const list2 = (await req('GET', '/auth/users', null, adminToken)).data;
      const find2 = (name) => (Array.isArray(list2) ? list2.find((u) => u.name === name) : null);
      check('B-安6 role=admin 落库为 admin', find2('roleadmin')?.role === 'admin', `role=${find2('roleadmin')?.role}`);
      check('B-安6 role=clerk 落库为 clerk', find2('roleclerk')?.role === 'clerk', `role=${find2('roleclerk')?.role}`);
      check('B-安6 role=superuser 落库为 clerk', find2('rolegarbage')?.role === 'clerk', `role=${find2('rolegarbage')?.role}`);
    }

    /* ===== Phase 8：A-安3 settings 写接口 admin 守卫 ===== */
    {
      const clerkToken = await loginAs('stronguser', 'Str0ng!Pass9');
      for (const [p, body] of [
        ['/setting/prefix', { teamId: 1, prefix: { stockout: 'SO' } }],
        ['/setting/no-mode', { teamId: 1, noMode: 'month' }],
        ['/setting/print', { teamId: 1, print: { company: 'X' } }],
        ['/setting/reset', { teamId: 1, scope: 'all' }],
      ]) {
        const rr = await req('POST', p, body, clerkToken);
        check(`A-安3 店员调 ${p} 返回 403`, rr.status === 403, `status=${rr.status}`);
      }
      const g = await req('GET', '/setting/get?teamId=1', null, clerkToken);
      check('A-安3 店员读 /setting/get 仍 200', g.status === 200, `status=${g.status}`);
      const p1 = await req('POST', '/setting/prefix', { teamId: 1, prefix: { stockout: 'SO' } }, adminToken);
      check('A-安3 管理员写前缀成功', p1.status === 200 && p1.data?.prefix?.stockout === 'SO', `status=${p1.status}`);
      const p2 = await req('POST', '/setting/reset', { teamId: 1, scope: 'all' }, adminToken);
      check('A-安3 管理员恢复默认', p2.status === 200 && p2.data?.prefix?.stockout === 'CK', `status=${p2.status}`);
    }

    /* ===== Phase 9：B-安14 邀请码哈希化 + E 组“留空保持原码”契约 ===== */
    {
      r = await req('POST', '/auth/register-conf', { enabled: true, inviteCode: 'Invite-99' }, adminToken);
      check('B-安14 开启注册并设码成功', r.status === 200 && r.data?.hasInviteCode === true, `status=${r.status} ${JSON.stringify(r.data)}`);
      check('B-安14 POST 不回显明文邀请码', !('inviteCode' in (r.data || {})), JSON.stringify(r.data));
      const g = await req('GET', '/auth/register-conf', null, adminToken);
      check('B-安14 GET 只返回 enabled 与 hasInviteCode', g.status === 200 && g.data?.enabled === true && g.data?.hasInviteCode === true && !('inviteCode' in (g.data || {})), JSON.stringify(g.data));
      r = await registerPost({ username: 'inviteuser1', password: 'Invite!User1', inviteCode: 'Invite-99', teamName: '邀请甲' });
      check('B-安14 正确邀请码可注册新账套', r.status === 200 && !!r.data?.token, `status=${r.status} ${r.data?.error || ''}`);
      r = await registerPost({ username: 'inviteuser2', password: 'Invite!User2', inviteCode: 'Wrong-99' });
      check('B-安14 错误邀请码被拒', r.status === 400 && r.data?.error === '邀请码不正确', `status=${r.status} ${r.data?.error || ''}`);
      r = await registerPost({ username: 'inviteuser3', password: 'Invite!User3' });
      check('B-安14 不带邀请码被拒', r.status === 400 && r.data?.error === '邀请码不正确', `status=${r.status} ${r.data?.error || ''}`);
      // E 组契约：已设置时只发 { enabled: true }、不带 inviteCode → 保持原哈希，不 400
      r = await req('POST', '/auth/register-conf', { enabled: true }, adminToken);
      check('B-安14/E组 已设置时留空保存不 400', r.status === 200 && r.data?.hasInviteCode === true, `status=${r.status} ${JSON.stringify(r.data)}`);
      r = await registerPost({ username: 'inviteuser4', password: 'Invite!User4', inviteCode: 'Invite-99', teamName: '邀请乙' });
      check('B-安14 留空保存后原邀请码仍可用', r.status === 200 && !!r.data?.token, `status=${r.status} ${r.data?.error || ''}`);
      r = await req('POST', '/auth/register-conf', { enabled: false }, adminToken);
      check('B-安14 关闭注册', r.status === 200 && r.data?.enabled === false && r.data?.hasInviteCode === false, JSON.stringify(r.data));
      r = await req('POST', '/auth/register-conf', { enabled: true }, adminToken);
      check('B-安14 未设置时留空开启仍 400', r.status === 400, `status=${r.status} ${r.data?.error || ''}`);
      r = await req('POST', '/auth/register-conf', { enabled: true, inviteCode: 'Invite-77' }, adminToken);
      check('B-安14 重新设码开启成功', r.status === 200 && r.data?.hasInviteCode === true, `status=${r.status}`);
      // 存量明文迁移：直写旧格式行，首次 GET 即转哈希
      {
        const db = openDb();
        db.prepare(
          `INSERT INTO setting (teamId, key, value) VALUES (0, 'global.register', ?)
           ON CONFLICT(teamId, key) DO UPDATE SET value = excluded.value`,
        ).run(JSON.stringify({ enabled: true, inviteCode: 'Legacy-77' }));
        db.close();
      }
      const g2 = await req('GET', '/auth/register-conf', null, adminToken);
      check('B-安14  legacy 行 GET 仍只返回 hasInviteCode', g2.status === 200 && g2.data?.hasInviteCode === true && !('inviteCode' in (g2.data || {})), JSON.stringify(g2.data));
      {
        const db = openDb();
        const row = db.prepare(`SELECT value FROM setting WHERE teamId = 0 AND key = 'global.register'`).get();
        db.close();
        check('B-安14 首次读取后库里已是哈希、无明文', typeof row?.value === 'string' && row.value.includes('scrypt$') && !row.value.includes('Legacy-77'), String(row?.value).slice(0, 80));
      }
      r = await registerPost({ username: 'legacyuser', password: 'Legacy!User1', inviteCode: 'Legacy-77', teamName: '迁移甲' });
      check('B-安14 迁移后的哈希可校验旧邀请码', r.status === 200 && !!r.data?.token, `status=${r.status} ${r.data?.error || ''}`);
      r = await registerPost({ username: 'legacyuser2', password: 'Legacy!User2', inviteCode: 'Legacy-78' });
      check('B-安14 迁移后错误邀请码被拒', r.status === 400 && r.data?.error === '邀请码不正确', `status=${r.status} ${r.data?.error || ''}`);
      r = await req('POST', '/auth/register-conf', { enabled: false }, adminToken);
      check('B-安14 收尾关闭注册', r.status === 200 && r.data?.enabled === false, JSON.stringify(r.data));
    }

    /* ===== Phase 10：B-安1 注销吊销持久化（重启后仍 401） ===== */
    {
      const tokenA = await loginAs(ADMIN.username, ADMIN.password);
      const payloadA = decodePayload(tokenA);
      let me = await req('GET', '/auth/me', null, tokenA);
      check('B-安1 注销前旧令牌可用', me.status === 200, `status=${me.status}`);
      r = await req('POST', '/auth/logout', null, tokenA);
      check('B-安1 注销成功', r.status === 200, `status=${r.status}`);
      me = await req('GET', '/auth/me', null, tokenA);
      check('B-安1 注销后旧令牌 401（同进程）', me.status === 401, `status=${me.status}`);
      const tokenB = await loginAs(ADMIN.username, ADMIN.password);
      me = await req('GET', '/auth/me', null, tokenB);
      check('B-安1 注销后同用户新登录不受影响', me.status === 200, `status=${me.status}`);
      {
        const db = openDb();
        const row = db.prepare(`SELECT value FROM setting WHERE teamId = 0 AND key = 'auth.revoked'`).get();
        db.close();
        let arr = [];
        try { arr = JSON.parse(row?.value || '[]'); } catch { /* ignore */ }
        check('B-安1 吊销已持久化到 setting 表', Array.isArray(arr) && arr.includes(`${payloadA.userId}:${payloadA.exp}:${payloadA.jti}`), String(row?.value).slice(0, 120));
      }
      console.log('[B-安1] 重启服务，验证吊销跨重启……');
      await restartServer();
      me = await req('GET', '/auth/me', null, tokenA);
      check('B-安1 重启后旧令牌仍 401', me.status === 401, `status=${me.status}`);
      me = await req('GET', '/auth/me', null, tokenB);
      check('B-安1 重启后新令牌仍可用', me.status === 200, `status=${me.status}`);
      const tokenC = await loginAs(ADMIN.username, ADMIN.password);
      me = await req('GET', '/auth/me', null, tokenC);
      check('B-安1 重启后可重新登录', me.status === 200, `status=${me.status}`);
    }

    /* ===== Phase 11：B-安19 静态检查 ===== */
    {
      const authSrc = fs.readFileSync(path.join(ROOT, 'server', 'src', 'auth.ts'), 'utf8');
      const shSrc = fs.readFileSync(path.join(ROOT, 'server', 'src', 'safe-handler.ts'), 'utf8');
      const settingsSrc = fs.readFileSync(path.join(ROOT, 'server', 'src', 'settings.ts'), 'utf8');
      check('B-安19① auth.ts 引用 ./safe-handler', authSrc.includes("from './safe-handler'") && authSrc.includes('safeHandler('));
      check('B-安19① auth.ts 已无本地 safe(', !/function safe\(/.test(authSrc));
      check('B-安19① safe-handler.ts 导出 safeHandler', shSrc.includes('export function safeHandler'));
      check('B-安19② settings.ts 导出 BILL_NO_PREFIXES', settingsSrc.includes('export const BILL_NO_PREFIXES'));
      check('B-安19② BILL_NO_PREFIXES 与 DEFAULT_PREFIX 同源', settingsSrc.includes('BILL_NO_PREFIXES: Record<string, string> = DEFAULT_PREFIX'));
    }

    st = await getStatus();
    check('收尾 服务仍健康', st.teamCount === 4, `teamCount=${st.teamCount}`);
  } catch (e) {
    console.error('[测试异常]', e);
    fail++;
  } finally {
    await stopServer();
  }

  console.log(`\n===== PASS ${pass} / FAIL ${fail} =====`);
  process.exit(fail ? 1 : 0);
})();
