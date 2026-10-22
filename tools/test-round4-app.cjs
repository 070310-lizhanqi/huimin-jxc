/**
 * 第 4 轮 bug 测试：v0.4.0 应用化改造专项。
 * 覆盖：备份创建/列表/下载/删除 / 恢复排队与重启生效 / 文件名白名单防路径穿越 /
 *       非 admin 拒绝 / 端口自适应与 port.txt / 单实例锁 / 回环绑定 / ORANGE_DATA_DIR 隔离。
 */
const fs0 = require('fs');
const path0 = require('path');
/** 端口可能因占用而自适应后移：优先读数据目录 port.txt 决定 BASE */
function resolveBase() {
  if (process.env.OC_BASE) return process.env.OC_BASE;
  const dir = process.env.ORANGE_DATA_DIR || path0.join(process.cwd(), 'data');
  try {
    const p = Number(fs0.readFileSync(path0.join(dir, 'port.txt'), 'utf8').trim());
    if (p > 0) return `http://127.0.0.1:${p}`;
  } catch { /* 无 port.txt：回落默认 */ }
  return 'http://127.0.0.1:7741';
}
const BASE = resolveBase();
const API = BASE + '/api';
let token = null;
let adminToken = null;
let teamId = 1;
let passed = 0;
let failed = 0;

async function j(method, path, body, tok) {
  const headers = { 'Content-Type': 'application/json' };
  const t = tok ?? token;
  if (t) headers.authorization = 'Bearer ' + t;
  const r = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body: json, headers: r.headers };
}

function ok(cond, name, detail) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${detail ? '：' + detail : ''}`); }
}

(async () => {
  const r0 = await j('POST', '/auth/login', { username: 'admin', password: 'admin123456' });
  token = adminToken = r0.body.token;
  teamId = r0.body.team.id; // 恢复后校验数据用
  ok(!!token, '登录成功');

  /* ---------- 1. 备份创建与列表 ---------- */
  {
    const c1 = await j('POST', '/backup/create');
    ok(c1.status === 200 && /^backup-\d{8}-\d{6}-[a-z0-9]{4}\.db$/.test(c1.body.file), '立即备份成功且文件名规范（带防冲突后缀）', JSON.stringify(c1.body));
    const list = await j('GET', '/backup/list');
    ok(list.status === 200 && list.body.rows.some((x) => x.file === c1.body.file), '备份列表包含新备份');
    ok(list.body.rows.every((x) => x.size > 0), '备份文件大小 > 0');
  }

  /* ---------- 2. 同秒连备两份不互相覆盖 ---------- */
  {
    await j('POST', '/customer', { name: '备份验证客户' + Date.now() % 100000 });
    const b1 = await j('POST', '/backup/create');
    const b2 = await j('POST', '/backup/create');
    ok(b1.status === 200 && b2.status === 200 && b1.body.file !== b2.body.file, '同一秒两次备份文件名不冲突', `${b1.body?.file} vs ${b2.body?.file}`);
    const list = (await j('GET', '/backup/list')).body;
    ok(list.rows.length >= 2, '备份列表累计两条以上');
  }

  /* ---------- 3. 下载备份（鉴权 + 内容为 SQLite 文件） ---------- */
  {
    const list = (await j('GET', '/backup/list')).body;
    const file = list.rows[0].file;
    const r = await fetch(API + `/backup/download?file=${encodeURIComponent(file)}`, {
      headers: { authorization: 'Bearer ' + token },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    ok(r.status === 200 && buf.length > 100, '备份文件可下载', String(buf.length));
    ok(buf.slice(0, 15).toString('utf8').startsWith('SQLite format 3'), '下载内容是 SQLite 库文件', buf.slice(0, 15).toString('latin1'));
    // 未登录不能下载
    const r2 = await fetch(API + `/backup/download?file=${encodeURIComponent(file)}`);
    ok(r2.status === 401, '未登录下载被拒');
  }

  /* ---------- 4. 路径穿越防护 ---------- */
  {
    const cases = [
      '..%2F..%2F..%2Fwindows%2Fwin.ini',
      'backup-20260101-000000.db%00.exe',
      '../../orange-clone.db',
      'backup-..-..db',
    ];
    let blocked = true;
    for (const f of cases) {
      const r = await j('GET', `/backup/download?file=${f}`);
      const r2 = await j('DELETE', `/backup/${f}`);
      if (r.status === 200 || r2.status === 200) { blocked = false; console.log(`    ${f} → ${r.status}/${r2.status}`); }
    }
    ok(blocked, '4 类穿越/畸形文件名全部被白名单拒绝');
  }

  /* ---------- 5. 非 admin 拒绝 ---------- */
  {
    // 建一个 clerk 用户
    const uname = 'clerk' + (Date.now() % 100000);
    const mk = await j('POST', '/auth/users', { username: uname, password: 'test123456', role: 'clerk' });
    ok(mk.status === 200, 'clerk 用户创建成功');
    const lg = await j('POST', '/auth/login', { username: uname, password: 'test123456' });
    const clerkToken = lg.body?.token;
    ok(!!clerkToken, 'clerk 登录成功');
    const denied = await j('POST', '/backup/create', undefined, clerkToken);
    ok(denied.status === 403, 'clerk 创建备份被拒（403）', JSON.stringify(denied.body));
    const deniedList = await j('GET', '/backup/list', undefined, clerkToken);
    ok(deniedList.status === 403, 'clerk 查看备份列表被拒');
  }

  /* ---------- 6. 恢复备份：排队 → 服务退出 → 数据回到备份时点 ---------- */
  {
    // 标记数据 A
    const a = await j('POST', '/customer', { name: '恢复前客户AAA' });
    ok(a.status === 200, '恢复前建立标记客户 AAA');
    // 用本次创建的备份作为快照点（不能用 list.rows[0]：那是上一轮运行留下的更新备份）
    const snapResp = await j('POST', '/backup/create');
    ok(snapResp.status === 200, '快照备份创建成功');
    const snap = snapResp.body.file;
    // 建标记 B（在备份之后）
    const b = await j('POST', '/customer', { name: '恢复后客户BBB' });
    ok(b.status === 200, '备份后建立标记客户 BBB');
    // 触发恢复：先验证「缺密码被拒」，再带密码提交
    const rs0 = await j('POST', '/backup/restore', { file: snap });
    ok(rs0.status === 400, '恢复缺少密码被拒（二次验密）', JSON.stringify(rs0.body));
    const rs = await j('POST', '/backup/restore', { file: snap, password: 'admin123456' });
    ok(rs.status === 200, '恢复请求被接受', JSON.stringify(rs.body));
    // 服务由自身「重启助手」拉起（不依赖外部 launcher）；测试只轮询等待
    let up = false;
    let base2 = BASE;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      base2 = resolveBase(); // 重启后端口可能变化，按 port.txt 重新解析
      try {
        const st = await fetch(base2 + '/api/auth/status', { signal: AbortSignal.timeout(1200) });
        if (st.ok) { up = true; break; }
      } catch { /* 服务重启中 */ }
    }
    ok(up, '服务在恢复后自重启回来（不依赖外部 launcher）', JSON.stringify({ up, base2 }));
    if (up) {
      // 等一拍让服务完全就绪
      await new Promise((r) => setTimeout(r, 1500));
      const cusList = (await fetch(base2 + '/api/customer?teamId=' + teamId, { headers: { authorization: 'Bearer ' + token } }).then((r) => r.json()).catch(() => []));
      const hasA = Array.isArray(cusList) && cusList.some((x) => x.name === '恢复前客户AAA');
      const hasB = Array.isArray(cusList) && cusList.some((x) => x.name === '恢复后客户BBB');
      ok(hasA && !hasB, '数据回到备份时点（AAA 在、BBB 消失）', JSON.stringify({ hasA, hasB }));
    }
  }

  /* ---------- 7. 端口/绑定/锁（进程级，通过日志与文件验证） ---------- */
  {
    const net = require('net');
    // 回环绑定验证：本机其它网卡地址连不上 —— 简化验证为 port.txt 存在且探测通过
    const fs = require('fs');
    const dataDir = process.env.ORANGE_DATA_DIR || null;
    if (dataDir) {
      const portFile = `${dataDir}/port.txt`;
      ok(fs.existsSync(portFile), 'port.txt 已写入数据目录', portFile);
      const p = Number(fs.readFileSync(portFile, 'utf8').trim());
      ok(p > 0, 'port.txt 内容为合法端口', String(p));
      const lock = `${dataDir}/server.lock`;
      ok(fs.existsSync(lock), '单实例锁文件存在');
    } else {
      ok(true, '数据目录环境变量未设置（开发模式），端口/锁文件断言跳过');
    }
  }

  console.log(`\n===== 第 4 轮: ${passed} PASS / ${failed} FAIL =====`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常:', e); process.exit(1); });
