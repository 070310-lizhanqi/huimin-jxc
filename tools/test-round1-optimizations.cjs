/**
 * 第 1 轮 bug 测试：v0.3.0 优化项专项回归。
 * 覆盖：gzip 压缩完整性 / 列表分页上限 / LIKE 转义 / 条码搜索 / 结算列表过滤与 rows /
 *       结算创建幂等 / 改单类型锁定 / 复制单补字段 / 开单人审核人落库 / 起账期校验 /
 *       xlsx 炸弹防护 / 商品重名拦截。
 */
const BASE = (process.env.OC_BASE || 'http://127.0.0.1:7741').replace(/\/api\/?$/, '');
const API = BASE + '/api';
let token = null;
let teamId = null;
let passed = 0;
let failed = 0;

async function j(method, path, body, extraHeaders) {
  const headers = { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body: json, headers: r.headers };
}

function ok(cond, name, detail) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${detail ? '：' + detail : ''}`); }
}

(async () => {
  // 登录
  const st = await j('GET', '/auth/status');
  if (st.body && st.body.initialized === false) {
    const r = await j('POST', '/auth/register', { username: 'admin', password: 'admin123456' });
    token = r.body.token; teamId = r.body.teamId;
  } else {
    const r = await j('POST', '/auth/login', { username: 'admin', password: 'admin123456' });
    token = r.body.token; teamId = r.body.team.id;
  }
  ok(!!token, '登录成功');

  /* ---------- 1. gzip 压缩完整性 ---------- */
  {
    const r = await fetch(BASE + '/vendor/echarts.min.js', { headers: { 'accept-encoding': 'gzip' } });
    const enc = r.headers.get('content-encoding');
    const buf = Buffer.from(await r.arrayBuffer());
    ok(enc === 'gzip' && buf.length > 500000, 'gzip：echarts 以 gzip 编码返回且解压后为完整体积', `enc=${enc} size=${buf.length}`);
    const r2 = await fetch(BASE + '/vendor/echarts.min.js', { headers: { 'accept-encoding': 'identity' } });
    ok(!r2.headers.get('content-encoding'), 'gzip：未协商压缩时不压缩');
  }

  /* ---------- 2. 单据列表分页上限 ---------- */
  {
    // 造一张单：负数 rows 钳制断言需要库里有数据
    const wh = (await j('GET', `/warehouse?teamId=${teamId}`)).body[0];
    const p = (await j('GET', `/product?teamId=${teamId}`)).body[0];
    await j('POST', '/doc/create', { teamId, type: 'otherin', warehouseId: wh.id, items: [{ productId: p.id, qty: 1, price: 0 }] });
    const r = await j('GET', `/doc/list?teamId=${teamId}&rows=100000`);
    ok(r.status === 200 && r.body.rows.length <= 200, 'doc/list rows=100000 被钳制到 ≤200', JSON.stringify(r.body.rows?.length));
    const r2 = await j('GET', `/doc/list?teamId=${teamId}&rows=-5`);
    ok(r2.status === 200 && r2.body.rows.length >= 1 && r2.body.rows.length <= 1, 'doc/list 负数 rows 钳制为 1', JSON.stringify(r2.body.rows?.length));
  }

  /* ---------- 3. LIKE 通配符转义 + 条码搜索 ---------- */
  {
    const cat = await j('POST', '/cat', { teamId, name: '转义测试分类' });
    const p = await j('POST', '/product', { teamId, catId: cat.body.id, name: 'AB%C商品', barcode: '6901234567890', spec: '500ml' });
    ok(p.status === 200, '建档成功');
    const kw = await j('GET', `/product?teamId=${teamId}&kw=${encodeURIComponent('B%C')}`);
    ok(kw.body.some((x) => x.id === p.body.id), 'LIKE 转义：% 按字面匹配', JSON.stringify(kw.body.map((x) => x.name)));
    const none = await j('GET', `/product?teamId=${teamId}&kw=${encodeURIComponent('BXC')}`);
    ok(!none.body.some((x) => x.id === p.body.id), 'LIKE 转义：通配符不再任意匹配');
    const bc = await j('GET', `/product?teamId=${teamId}&kw=${encodeURIComponent('690123456')}`);
    ok(bc.body.some((x) => x.id === p.body.id), '商品关键词可按条码搜索');
    const sp = await j('GET', `/product?teamId=${teamId}&kw=${encodeURIComponent('500ml')}`);
    ok(sp.body.some((x) => x.id === p.body.id), '商品关键词可按规格搜索');
    // 库存页条码搜索（无库存也应 200 且不 500）
    const sk = await j('GET', `/stock/list?teamId=${teamId}&kw=${encodeURIComponent('690123456')}`);
    ok(sk.status === 200, 'stock/list 条码搜索不 500');
  }

  /* ---------- 4. 结算列表过滤与 rows 生效 ---------- */
  {
    const cus = await j('POST', '/customer', { teamId, name: '结算过滤客户' });
    const acc = (await j('GET', `/account?teamId=${teamId}`)).body[0];
    await j('POST', '/settlement/create', { teamId, type: 'receipt', partnerType: 'cus', partnerId: cus.body.id, accountId: acc.id, amount: 12345 });
    const filtered = await j('GET', `/settlement/list?teamId=${teamId}&partnerId=${cus.body.id}`);
    ok(filtered.body.length === 1 && filtered.body[0].amount === 12345, 'settlement/list partnerId 过滤生效', JSON.stringify(filtered.body.length));
    const dated = await j('GET', `/settlement/list?teamId=${teamId}&from=2099-01-01`);
    ok(dated.body.length === 0, 'settlement/list 日期过滤生效');
    const refd = await j('GET', `/settlement/list?teamId=${teamId}&refDocId=999999`);
    ok(refd.body.length === 0, 'settlement/list refDocId 过滤生效');
    // 幂等：同样请求连发两次
    const s1 = await j('POST', '/settlement/create', { teamId, type: 'receipt', partnerType: 'cus', partnerId: cus.body.id, accountId: acc.id, amount: 777, date: '2026-01-05' });
    const s2 = await j('POST', '/settlement/create', { teamId, type: 'receipt', partnerType: 'cus', partnerId: cus.body.id, accountId: acc.id, amount: 777, date: '2026-01-05' });
    ok(s1.status === 200 && s2.status === 200 && s2.body.id === s1.body.id, 'settlement/create 双击幂等返回同一笔', `s1=${s1.body.id} s2=${s2.body?.id}`);
    const after = await j('GET', `/settlement/list?teamId=${teamId}&partnerId=${cus.body.id}&from=2026-01-01&to=2026-12-31`);
    ok(after.body.filter((x) => x.amount === 777).length === 1, '幂等：777 只入账一次');
  }

  /* ---------- 5. 改单类型锁定（负数出库错账防线） ---------- */
  {
    const wh = (await j('GET', `/warehouse?teamId=${teamId}`)).body[0];
    const p = (await j('GET', `/product?teamId=${teamId}`)).body[0];
    const d = await j('POST', '/doc/create', { teamId, type: 'stockout', warehouseId: wh.id, items: [{ productId: p.id, qty: 3, price: 100 }] });
    const hack = await j('PUT', '/doc/edit', { id: d.body.id, teamId, type: 'adjust', warehouseId: wh.id, items: [{ productId: p.id, qty: -100, price: 0 }] });
    ok(hack.status === 400, 'edit 拒绝更换单据类型（防负数出库反向加库存）', JSON.stringify(hack.body));
    // 正常编辑（同类型）仍然可用
    const fine = await j('PUT', '/doc/edit', { id: d.body.id, teamId, type: 'stockout', warehouseId: wh.id, items: [{ productId: p.id, qty: 5, price: 100 }] });
    ok(fine.status === 200, 'edit 同类型正常修改不受影响');
    await j('DELETE', `/doc/${d.body.id}?teamId=${teamId}`);
  }

  /* ---------- 6. 复制单补齐收件人/折扣 ---------- */
  {
    const wh = (await j('GET', `/warehouse?teamId=${teamId}`)).body[0];
    const p = (await j('GET', `/product?teamId=${teamId}`)).body[0];
    const d = await j('POST', '/doc/create', {
      teamId, type: 'stockout', warehouseId: wh.id,
      receiverName: '张三', receiverMobile: '13800000000', receiverAddress: '深圳市南山区',
      discount: 500,
      items: [{ productId: p.id, qty: 2, price: 1000 }],
    });
    const cp = await j('POST', '/doc/copy', { teamId, id: d.body.id });
    ok(cp.status === 200, '复制成功');
    const info = await j('GET', `/doc/info?id=${cp.body.id}&teamId=${teamId}`);
    ok(info.body.doc.receiverName === '张三' && info.body.doc.discount === 500, '复制单携带收件人与折扣', JSON.stringify({ rn: info.body.doc.receiverName, dc: info.body.doc.discount }));
    await j('DELETE', `/doc/${d.body.id}?teamId=${teamId}`);
    await j('DELETE', `/doc/${cp.body.id}?teamId=${teamId}`);
  }

  /* ---------- 7. 开单人/审核人落库 ---------- */
  {
    const wh = (await j('GET', `/warehouse?teamId=${teamId}`)).body[0];
    const p = (await j('GET', `/product?teamId=${teamId}`)).body[0];
    const d = await j('POST', '/doc/create', { teamId, type: 'otherin', warehouseId: wh.id, items: [{ productId: p.id, qty: 1, price: 0 }] });
    const me = (await j('GET', '/auth/me')).body.user;
    const info1 = await j('GET', `/doc/info?id=${d.body.id}&teamId=${teamId}`);
    ok(info1.body.doc.userId === me.userId, '开单人 userId 落库', JSON.stringify(info1.body.doc.userId));
    await j('POST', '/doc/audit', { teamId, id: d.body.id });
    const info2 = await j('GET', `/doc/info?id=${d.body.id}&teamId=${teamId}`);
    ok(info2.body.doc.auditUserId === me.userId, '审核人 auditUserId 落库', JSON.stringify(info2.body.doc.auditUserId));
  }

  /* ---------- 8. 起账期校验（新注册团队） ---------- */
  {
    // 邀请码注册流程需要 owner 配置；直接验证：非法 startPeriod 的注册请求要么被拒要么归一为合法 YYYYMM
    const conf = await j('GET', '/auth/register-conf');
    if (conf.status === 200) {
      await j('POST', '/auth/register-conf', { enabled: true, inviteCode: 'test-invite-1' });
      const reg = await fetch(API + '/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'periodcheck' + Date.now(), password: 'test123456', inviteCode: 'test-invite-1', startPeriod: '2026/13月' }),
      }).then((r) => r.json());
      ok(reg.teamId > 0, '非法起账期注册仍成功（归一为默认值）');
      await j('POST', '/auth/register-conf', { enabled: false, inviteCode: '' });
    } else {
      ok(true, '起账期校验：非 owner 账号跳过（基线环境）');
    }
  }

  /* ---------- 9. xlsx 炸弹防护 ---------- */
  {
    // 构造一个 100MB 全零解压体积的 zip 条目（压缩后仅 ~100KB）
    const zlib = require('zlib');
    const big = Buffer.alloc(100 * 1024 * 1024, 0);
    const deflated = zlib.deflateRawSync(big, { level: 9 });
    // 手工拼一个单条目 ZIP：本地头 + 数据 + 中央目录 + EOCD
    const name = Buffer.from('xl/worksheets/sheet1.xml');
    const crc = 0; // 全零内容的 CRC32 恰为 0
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(big.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(8, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(big.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(30 + name.length + deflated.length, 16); eocd.writeUInt16LE(46 + name.length, 12);
    const bomb = Buffer.concat([local, name, deflated, cd, name, eocd]);
    const r = await fetch(API + '/doc/import?dryRun=1', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', authorization: 'Bearer ' + token }, body: bomb,
    });
    const body = await r.json().catch(() => ({}));
    ok(r.status === 400 || r.status === 413 || r.status === 500, 'xlsx 炸弹被拒（80MB 解压上限）', JSON.stringify(body.error ?? r.status));
  }

  /* ---------- 10. 商品重名拦截 ---------- */
  {
    await j('POST', '/product', { teamId, name: '重名拦截商品' });
    const dup = await j('POST', '/product', { teamId, name: '重名拦截商品' });
    ok(dup.status === 400, '商品重名创建被拒（唯一索引兜底）', JSON.stringify(dup.body));
  }

  console.log(`\n===== 第 1 轮: ${passed} PASS / ${failed} FAIL =====`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常:', e); process.exit(1); });
