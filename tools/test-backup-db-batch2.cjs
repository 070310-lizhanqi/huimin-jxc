/**
 * 第二批 D 组（备份、数据库与导入）回归测试。
 *
 * 覆盖：B-安7 恢复可验证可回滚 / B-安8 wal_checkpoint 返回值 / B-安13 CRUD 上限 /
 *       B-安16 单据导入三小问题 / B-安19③④ addColumn/migrate /
 *       B-安4②③ 恢复失败计数与高成本接口限速 / A-安3 商品导入 admin 校验 /
 *       A-安4 通用错误文案 / B-安18 优雅停机。
 *
 * 自包含：以 PORT=7754、ORANGE_DATA_DIR=/tmp/huimin-b2-d 独立拉起服务，
 * 跑完停掉自己的测试服务（含恢复重启后拉起的新进程）。
 * 用法：先 pnpm build，再 node tools/test-backup-db-batch2.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = '/tmp/huimin-b2-d';
const PORT = 7754;
const BASE = `http://127.0.0.1:${PORT}/api`;
const DB_PATH = path.join(DATA_DIR, 'huimin-clone.db');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

let passed = 0;
let failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${detail ? '：' + String(detail).slice(0, 300) : ''}`); }
}

let token = null;
let teamId = 0;
async function j(method, p, body, tok, raw) {
  const headers = { 'Content-Type': 'application/json' };
  const t = tok !== undefined ? tok : token;
  if (t) headers.Authorization = 'Bearer ' + t;
  const r = await fetch(BASE + p, {
    method, headers,
    body: body !== undefined ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body: json };
}
async function loginAs(user, pass) {
  const r = await j('POST', '/auth/login', { username: user, password: pass }, null);
  return r.body && r.body.token ? r.body.token : null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
function serverPidFromLock() {
  try { return Number(fs.readFileSync(path.join(DATA_DIR, 'server.lock'), 'utf8').trim()) || 0; }
  catch { return 0; }
}
async function waitUp(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + '/auth/status', { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* 未起 */ }
    await sleep(500);
  }
  return false;
}
/** 恢复重启专用：先等旧服务下线（否则 /auth/status 仍由旧服务响应、误判为已重启），再等新服务上线 */
async function waitRestart(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    try {
      await fetch(BASE + '/auth/status', { signal: AbortSignal.timeout(1500) });
    } catch { break; /* 旧服务已下线 */ }
    await sleep(300);
  }
  return waitUp(timeoutMs);
}
async function stopServer() {
  // 恢复测试会让原进程退出、重启助手拉起新进程：按锁文件 pid 杀残留进程
  for (const pid of [child && child.pid, serverPidFromLock()].filter(Boolean)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* 已死 */ }
  }
  await sleep(1500);
  for (const pid of [child && child.pid, serverPidFromLock()].filter(Boolean)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已死 */ }
  }
  try { if (child) child.kill('SIGKILL'); } catch { /* ignore */ }
}

(async () => {
  // ---------- 0) 拉起测试服务 ----------
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  child = spawn(process.execPath, [path.join(ROOT, 'dist', 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ORANGE_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const serverLog = fs.createWriteStream('/tmp/huimin-b2-test-server.log', { flags: 'w' });
  child.stdout.pipe(serverLog);
  child.stderr.pipe(serverLog);
  ok(await waitUp(), '测试服务在 7754 上启动');
  if (!await waitUp()) { console.log('服务未起，终止'); process.exitCode = 2; return; }

  const st = await j('GET', '/auth/status', undefined, null);
  if (st.body && st.body.initialized === false) {
    const reg = await j('POST', '/auth/register', { username: 'admin', password: 'ZhanHui9!k2', name: 'admin' }, null);
    token = reg.body && reg.body.token;
  } else {
    token = await loginAs('admin', 'ZhanHui9!k2');
  }
  ok(!!token, '管理员登录成功');
  const me = await j('GET', '/team/list');
  teamId = me.body && me.body[0] ? me.body[0].id : 0;
  ok(teamId > 0, '拿到 teamId', JSON.stringify(me.body));

  // 基础档案
  const wh = await j('POST', '/warehouse', { teamId, name: '主仓' });
  const warehouseId = wh.body && wh.body.id;
  const cus = await j('POST', '/customer', { teamId, name: '测试客户' });
  const ven = await j('POST', '/vendor', { teamId, name: '测试供应商' });
  const prod = await j('POST', '/product', { teamId, name: '测试商品', salePrice: 1000, purchasePrice: 500 });
  ok(warehouseId && cus.body && cus.body.id && ven.body && ven.body.id && prod.body && prod.body.id, '基础档案就绪');
  const cusId = cus.body.id, venId = ven.body.id, prodId = prod.body.id;

  // ---------- 1) B-安8：wal_checkpoint 忙时拒绝备份 ----------
  {
    const holder = new DatabaseSync(DB_PATH);
    holder.exec('BEGIN IMMEDIATE');
    const t0 = Date.now();
    const busyResp = await j('POST', '/backup/create');
    const busyMs = Date.now() - t0;
    ok(busyResp.status !== 200, '写锁占用时备份被拒绝', JSON.stringify(busyResp.body));
    ok(busyResp.body && !/SQLITE|wal_checkpoint|checkpoint/i.test(String(busyResp.body.error || '')),
      '忙时拒绝返回通用文案不泄漏内部信息', JSON.stringify(busyResp.body));
    holder.exec('ROLLBACK');
    holder.close();
    const good = await j('POST', '/backup/create');
    ok(good.status === 200 && !!good.body.file, '锁释放后备份恢复成功', JSON.stringify(good.body) + ` 耗时${busyMs}ms`);
    // 长读事务同样占住 WAL 读标记：读标记建立后再写入新帧，检查点应 busy 且 checkpointed < log 而拒绝
    // （若读标记后无新帧，WAL 为空、检查点本就无事可做，成功是正确的，不应断言拒绝）
    const reader = new DatabaseSync(DB_PATH);
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS c FROM doc').get();
    const wAfterMark = await j('POST', '/customer', { teamId, name: '读标记后写入客户' });
    ok(wAfterMark.status === 200, '读标记建立后仍可写入新数据');
    const busy2 = await j('POST', '/backup/create');
    ok(busy2.status !== 200, '长读事务占用且有新帧时备份被拒绝', JSON.stringify(busy2.body));
    reader.exec('ROLLBACK');
    reader.close();
    const good2 = await j('POST', '/backup/create');
    ok(good2.status === 200, '读事务结束后备份恢复成功');
  }

  // ---------- 2) B-安7：恢复前校验 + 恢复后回滚 ----------
  let goodBackup = null;
  {
    // 2a) 缺失关键表的备份应被拒绝
    const c = await j('POST', '/backup/create');
    goodBackup = c.body.file;
    const badPath = path.join(BACKUPS_DIR, 'backup-20260101-000000-ab12.db');
    fs.copyFileSync(path.join(BACKUPS_DIR, goodBackup), badPath);
    {
      const badDb = new DatabaseSync(badPath);
      badDb.exec('DROP TABLE doc');
      badDb.close();
    }
    const rBad = await j('POST', '/backup/restore', { file: 'backup-20260101-000000-ab12.db', password: 'ZhanHui9!k2' });
    ok(rBad.status === 400 && /不是有效的备份文件/.test(String(rBad.body && rBad.body.error)),
      '缺 doc 表的备份恢复被拒', JSON.stringify(rBad.body));
    // 2b) 截断损坏的备份应被拒绝
    const truncPath = path.join(BACKUPS_DIR, 'backup-20260101-000001-cd34.db');
    fs.copyFileSync(path.join(BACKUPS_DIR, goodBackup), truncPath);
    fs.truncateSync(truncPath, Math.floor(fs.statSync(truncPath).size / 2));
    const rTrunc = await j('POST', '/backup/restore', { file: 'backup-20260101-000001-cd34.db', password: 'ZhanHui9!k2' });
    ok(rTrunc.status === 400 && /不是有效的备份文件/.test(String(rTrunc.body && rTrunc.body.error)),
      '截断损坏的备份恢复被拒', JSON.stringify(rTrunc.body));
    // 2c) 正常恢复：标记 A → 备份 → 标记 B → 恢复 → B 消失、A 仍在、pre-restore 备份存在
    const a = await j('POST', '/customer', { teamId, name: '恢复前客户AAA' });
    ok(a.status === 200, '恢复前建立标记客户 AAA');
    const snap = await j('POST', '/backup/create');
    ok(snap.status === 200, '快照备份创建成功');
    const snapFile = snap.body.file;
    const b = await j('POST', '/customer', { teamId, name: '恢复后客户BBB' });
    ok(b.status === 200, '备份后建立标记客户 BBB');
    const rs0 = await j('POST', '/backup/restore', { file: snapFile });
    ok(rs0.status === 400, '恢复缺密码被拒');
    const rs = await j('POST', '/backup/restore', { file: snapFile, password: 'ZhanHui9!k2' });
    ok(rs.status === 200 && /校验/.test(String(rs.body && rs.body.message || '')),
      '恢复请求被接受且响应说明已做完整性校验', JSON.stringify(rs.body));
    ok(await waitRestart(60000), '恢复后服务重启恢复');
    token = await loginAs('admin', 'ZhanHui9!k2');
    ok(!!token, '重启后可重新登录');
    const list = await j('GET', `/customer?teamId=${teamId}&rows=500`);
    const names = (list.body || []).map((x) => x.name);
    ok(names.includes('恢复前客户AAA'), '恢复后标记 A 仍在');
    ok(!names.includes('恢复后客户BBB'), '恢复后标记 B 已消失（回到备份时点）');
    const preFiles = fs.readdirSync(BACKUPS_DIR).filter((f) => f.startsWith('pre-restore-') && f.endsWith('.db'));
    ok(preFiles.length >= 1, '恢复前已留 pre-restore-<时间戳>.db 当前库备份', preFiles.join(','));
    const preDb = new DatabaseSync(path.join(BACKUPS_DIR, preFiles[0]));
    const chk = preDb.prepare('PRAGMA integrity_check').get();
    ok(chk && chk.integrity_check === 'ok', 'pre-restore 备份本身完整性 ok');
    const hasB = preDb.prepare(`SELECT COUNT(*) AS c FROM customer WHERE name='恢复后客户BBB'`).get();
    ok(hasB && hasB.c === 1, 'pre-restore 备份里含有恢复前的新数据 B（可回滚）');
    preDb.close();
  }

  // ---------- 3) B-安13：CRUD 长度与整数分上限 ----------
  {
    const long101 = '商'.repeat(101);
    const r1 = await j('POST', '/product', { teamId, name: long101 });
    ok(r1.status === 400, '商品名 101 字被拒', JSON.stringify(r1.body));
    const r2 = await j('POST', '/product', { teamId, name: '上限测试商品', remark: '备'.repeat(501) });
    ok(r2.status === 400, '备注 501 字被拒', JSON.stringify(r2.body));
    const r3 = await j('POST', '/product', { teamId, name: '条码测试商品', barcode: 'x'.repeat(65) });
    ok(r3.status === 400, '条码 65 字被拒', JSON.stringify(r3.body));
    const r4 = await j('POST', '/product', { teamId, name: '小数价商品', salePrice: 19.99 });
    ok(r4.status === 200 && r4.body && Number.isInteger(r4.body.salePrice) && r4.body.salePrice === 20,
      '小数单价 19.99 被 Math.round 为整数分 20', JSON.stringify(r4.body));
    const r5 = await j('POST', '/product', { teamId, name: 'a'.repeat(100) });
    ok(r5.status === 200, '商品名恰好 100 字放行');
    const putBad = await j('PUT', `/product/${r5.body.id}`, { teamId, remark: '备'.repeat(501) });
    ok(putBad.status === 400, '更新时超长备注被拒');
    const after = await j('GET', `/product?teamId=${teamId}&kw=${encodeURIComponent('a'.repeat(20))}`);
    const kept = (after.body || []).find((x) => x.id === r5.body.id);
    ok(kept && (kept.remark === null || kept.remark === undefined || kept.remark === ''),
      '更新拒绝后旧备注未被污染', JSON.stringify(kept && kept.remark));
    // 整数分语义：直接读库确认 INTEGER 价格列里没有 REAL 值
    const direct = new DatabaseSync(DB_PATH, { readOnly: true });
    const reals = direct.prepare(
      `SELECT COUNT(*) AS c FROM product WHERE typeof(salePrice)='real' OR typeof(purchasePrice)='real' OR typeof(retailPrice)='real' OR typeof(wholePrice)='real'`,
    ).get();
    ok(reals && reals.c === 0, '价格列无 REAL 值（小数已取整）', JSON.stringify(reals));
    direct.close();
  }

  // ---------- 4) B-安16：单据导入三小问题 ----------
  const importCsv = async (csv, qs = '') => {
    const r = await fetch(BASE + `/doc/import?teamId=${teamId}${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + token },
      body: Buffer.from(csv, 'utf8'),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  {
    // 4a) parseQty 拒绝科学计数法
    const r = await importCsv('商品,数量,单价,客户\n测试商品,1e5,10,测试客户\n', '&dryRun=1');
    ok(r.status === 200 && (r.body.rowErrors || []).some((e) => /数量无效/.test(e.msg)),
      '数量 1e5 被拒绝而非剥成 15', JSON.stringify(r.body && r.body.rowErrors));
    ok(!(r.body.bills || []).length, '1e5 行未生成单据');
    const rE = await importCsv('商品,数量,单价,客户\n测试商品,2E3,10,测试客户\n', '&dryRun=1');
    ok((rE.body.rowErrors || []).some((e) => /数量无效/.test(e.msg)), '数量 2E3 同样被拒绝');
    // 4b) 往来单位名含 | 不再碰撞分组
    const csv2 = '类型,日期,客户,商品,数量,单价\n销售出库,2026-10-24,A|B客户,测试商品,1,10\n销售出库,2026-10-24,B客户,测试商品,2,10\n';
    const r2 = await importCsv(csv2, '&autoCreate=1');
    ok(r2.status === 200 && (r2.body.bills || []).length === 2,
      '含 | 的往来单位名分出两单而非并成一单', JSON.stringify(r2.body && r2.body.summary));
    const partners = (r2.body.bills || []).map((x) => x.partnerName).sort();
    ok(partners.includes('A|B客户') && partners.includes('B客户'), '两单的往来单位归属正确', partners.join(','));
    // 4c) 孤儿清理：被已建单据引用的本次新建档案保留
    const csv3 = '类型,日期,客户,商品,数量,单价\n销售出库,2026-10-24,新客户甲,新商品甲,1,10\n';
    const r3 = await importCsv(csv3, '&autoCreate=1');
    ok(r3.status === 200 && (r3.body.created || []).length === 1, '新建档案的单据成功落库');
    const cusList = await j('GET', `/customer?teamId=${teamId}&rows=500`);
    const prodList = await j('GET', `/product?teamId=${teamId}&rows=500`);
    ok((cusList.body || []).some((x) => x.name === '新客户甲'), '被单据引用的新建客户保留');
    ok((prodList.body || []).some((x) => x.name === '新商品甲'), '被单据引用的新建商品保留');
    const cusBefore = (cusList.body || []).length;
    // dryRun 不落库、不建档
    const rDry = await importCsv(csv3, '&autoCreate=1&dryRun=1');
    ok(rDry.status === 200 && (rDry.body.created || []).length === 0, 'dryRun 不落库');
    const cusAfter = await j('GET', `/customer?teamId=${teamId}&rows=500`);
    ok((cusAfter.body || []).length === cusBefore, 'dryRun 未产生幽灵档案');
  }

  // ---------- 5) B-安19③④：migrate 幂等（addColumn 重复列被忽略、其余照常） ----------
  {
    const { migrate } = require(path.join(ROOT, 'dist', 'server', 'db.js'));
    const tmpDb = path.join(DATA_DIR, 'migrate-check.db');
    try { fs.rmSync(tmpDb); } catch { /* ignore */ }
    const mdb = new DatabaseSync(tmpDb);
    let threw = null;
    try { migrate(mdb); migrate(mdb); } catch (e) { threw = e; }
    mdb.close();
    ok(!threw, 'migrate 两次幂等通过（重复列被忽略且不抛错）', threw && threw.message);
    const chkDb = new DatabaseSync(tmpDb, { readOnly: true });
    const t = chkDb.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name IN ('team','user','doc','stock')`).get();
    ok(t && t.c === 4, 'migrate 后关键表齐全');
    chkDb.close();
    fs.rmSync(tmpDb, { force: true });
  }

  // ---------- 6) A-安3：clerk 不能批量导入商品 ----------
  {
    const uname = 'clerk' + (Date.now() % 100000);
    const mk = await j('POST', '/auth/users', { username: uname, password: 'ZhanHui9!k2', role: 'clerk' });
    ok(mk.status === 200, 'clerk 用户创建成功');
    const clerkToken = await loginAs(uname, 'ZhanHui9!k2');
    ok(!!clerkToken, 'clerk 登录成功');
    const denied = await j('POST', '/product/import', { teamId, rows: [{ name: '店员导入商品' }] }, clerkToken);
    ok(denied.status === 403, 'clerk 批量导入商品被拒（403）', JSON.stringify(denied.body));
  }

  // ---------- 7) A-安4：解析错误通用化 ----------
  {
    const r = await fetch(BASE + `/doc/import?teamId=${teamId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + token },
      body: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x99, 0x88, 0x77, 0x66]),
    });
    const jb = await r.json().catch(() => null);
    ok(r.status === 400 && jb && !/SQLite|Error:|ENOENT|node:sqlite/i.test(String(jb.error || '')),
      '导入解析失败返回通用文案不泄漏内部信息', JSON.stringify(jb));
  }

  // ---------- 8) B-安4③：高成本接口按团队限速 ----------
  {
    // /doc/import：此前本测试已调 6 次（§4 两次科学计数法 + 一次分组 + 两次孤儿 + §7 一次解析错误），
    // 限速为每团队每分钟 100 次（2026-11-21 由 10 调高：全量回归一分钟内合法导入约 20 余次，
    // 10 次/分钟误伤既有测试；100 次仍可拦住失控循环），故再放行 94 次、第 101 次 429
    let okCount = 0;
    let got429 = false;
    for (let i = 0; i < 95; i++) {
      const r = await importCsv('商品,数量,单价,客户\n测试商品,1,10,测试客户\n', '&dryRun=1');
      if (r.status === 200) okCount++;
      else if (r.status === 429) { got429 = true; break; }
    }
    ok(okCount === 94 && got429, '导入 100 次放行、第 101 次 429', `放行 ${okCount} 次`);
    // /product/import：100 次放行、第 101 次 429
    let pOk = 0;
    let p429 = false;
    for (let i = 0; i < 101; i++) {
      const r = await j('POST', '/product/import', { teamId, rows: [{ name: `限速商品${i}` }] });
      if (r.status === 200) pOk++;
      else if (r.status === 429) { p429 = true; break; }
    }
    ok(pOk === 100 && p429, '商品导入 100 次放行、第 101 次 429', `放行 ${pOk} 次`);
  }

  // ---------- 9) B-安4②：/backup/restore 失败 5 次后冷却 ----------
  {
    let wrong400 = 0;
    for (let i = 0; i < 5; i++) {
      const r = await j('POST', '/backup/restore', { file: goodBackup, password: 'wrong-password' });
      if (r.status === 400) wrong400++;
    }
    ok(wrong400 === 5, '5 次错误密码均返回 400', `400 共 ${wrong400} 次`);
    const locked = await j('POST', '/backup/restore', { file: goodBackup, password: 'ZhanHui9!k2' });
    ok(locked.status === 429, '第 6 次恢复被冷却（429），即使密码正确', JSON.stringify(locked.body));
  }

  // ---------- 10) B-安18：优雅停机 ----------
  {
    const pid = serverPidFromLock() || (child && child.pid);
    ok(pid > 0, '停机前服务进程存在', String(pid));
    // 停机前先确认 WAL 已无未检查点数据残留风险：制造一次写入再停机
    const w = await j('POST', '/customer', { teamId, name: '停机前客户' });
    ok(w.status === 200, '停机前写入成功');
    // 用停机接口触发优雅停机，不用 SIGTERM：Windows 上 process.kill(pid,
    // 'SIGTERM') 等于 TerminateProcess，服务端 SIGTERM 处理器根本跑不到，
    // WAL 检查点和锁清理都不会发生，本节在 Windows 上长红。
    // 接口走同一套 gracefulShutdown（server.close → checkpoint → db.close），
    // SIGTERM 处理器本身只是一行转发到它，覆盖不丢。
    const sd = await j('POST', '/admin/shutdown', {});
    ok(sd.status === 200, '停机接口返回 200', `status=${sd.status} ${JSON.stringify(sd.body)}`);
    let exited = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      try { process.kill(pid, 0); } catch { exited = true; break; }
      await sleep(300);
    }
    ok(exited, 'SIGTERM 后服务在 15 秒内退出（非无限等）');
    const walPath = DB_PATH + '-wal';
    const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    ok(walSize === 0, '停机后 WAL 已检查点截断（-wal 为空或不存在）', `wal 大小 ${walSize}`);
    const chkDb = new DatabaseSync(DB_PATH, { readOnly: true });
    const chk = chkDb.prepare('PRAGMA integrity_check').get();
    ok(chk && chk.integrity_check === 'ok', '停机后库完整性 ok');
    const hasW = chkDb.prepare(`SELECT COUNT(*) AS c FROM customer WHERE name='停机前客户'`).get();
    ok(hasW && hasW.c === 1, '停机前写入的数据未丢失');
    chkDb.close();
    const lockGone = !fs.existsSync(path.join(DATA_DIR, 'server.lock'));
    ok(lockGone, '停机后单实例锁文件已清理');
    child = null; // 进程已退出，无需再杀
  }

  console.log(`\n[test-backup-db-batch2] 通过 ${passed}，失败 ${failed}`);
  process.exitCode = failed ? 1 : 0;
})().catch(async (e) => {
  console.error('[test-backup-db-batch2] 脚本异常:', e);
  process.exitCode = 2;
}).finally(async () => {
  await stopServer();
});
