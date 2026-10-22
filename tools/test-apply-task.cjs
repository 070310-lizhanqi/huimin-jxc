/* 出库申请单 + 生产任务 端到端测试 */
const BASE = process.env.OC_BASE || 'http://127.0.0.1:7741/api';
const { authHeader } = require('./test-helpers.cjs');
let pass = 0, fail = 0;
const results = [];
function ok(name, cond, detail) {
  if (cond) { pass++; results.push('PASS | ' + name + (detail ? ' | ' + detail : '')); }
  else { fail++; results.push('FAIL | ' + name + (detail ? ' | ' + detail : '')); }
}
async function api(method, path, body) {
  const opt = { method, headers: { ...(await authHeader()) } };
  if (body !== undefined) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, opt);
  let data = null;
  try { data = await r.json(); } catch { data = { error: 'non-json' }; }
  return { status: r.status, body: data };
}
const post = (p, b) => api('POST', p, b);
const get = (p) => api('GET', p);

(async () => {
  // 登录现有账套
  const t = await get('/auth/me');
  const teamId = t.body.user.teamId;
  // 分类：用第一个已有分类
  const cat = (await get('/cat?teamId=' + teamId)).body[0];
  const catId = cat ? cat.id : null;

  const p1 = await post('/product', { teamId, catId, name: '原料A', unit: '个', salePrice: 1000, purchasePrice: 500 });
  const p2 = await post('/product', { teamId, catId, name: '成品B', unit: '个', salePrice: 3000, purchasePrice: 1500 });
  const wh = (await get('/warehouse?teamId=' + teamId)).body[0];
  const cus = await post('/customer', { teamId, name: '客户X' });

  // 先入库原料
  const in1 = await post('/doc/create', {
    teamId, type: 'stockin', warehouseId: wh.id, date: '2026-10-17',
    items: [{ productId: p1.body.id, qty: 100, price: 500 }],
  });
  await post('/doc/audit', { teamId, id: in1.body.id });

  // ===== 出库申请单 =====
  const oa = await post('/doc/create', {
    teamId, type: 'outapply', partnerType: 'cus', partnerId: cus.body.id, date: '2026-10-17',
    items: [{ productId: p1.body.id, qty: 10, price: 1000 }],
  });
  ok('出库申请单创建（无仓库）', oa.status === 200, oa.body.billNo || JSON.stringify(oa.body));
  ok('出库申请单号前缀 SQ', String(oa.body.billNo || '').startsWith('SQ'), oa.body.billNo);

  const conv1 = await post('/doc/convert', { teamId, id: oa.body.id });
  ok('未审核申请单不能转化', conv1.status === 400 && /仅已审核/.test(conv1.body.error || ''), JSON.stringify(conv1.body));

  await post('/doc/audit', { teamId, id: oa.body.id });
  const stockAfterApply = (await get(`/stock/list?teamId=${teamId}`)).body;
  const q1 = stockAfterApply.find(s => s.productId === p1.body.id)?.qty ?? 0;
  ok('申请单审核不动库存', q1 === 100, 'qty=' + q1);

  const conv2 = await post('/doc/convert', { teamId, id: oa.body.id });
  ok('审核后转化为销售出库', conv2.status === 200 && conv2.body.type === 'stockout', JSON.stringify(conv2.body));
  ok('出库单号前缀 CK', String(conv2.body.billNo || '').startsWith('CK'), conv2.body.billNo);

  // 转化的出库单是草稿，需补仓库再审核
  const info = await get(`/doc/info?id=${conv2.body.id}&teamId=${teamId}`);
  ok('转化单回填默认仓库', !!info.body.doc.warehouseId, 'wh=' + info.body.doc.warehouseId);
  await post('/doc/audit', { teamId, id: conv2.body.id });
  const stockAfterOut = (await get(`/stock/list?teamId=${teamId}`)).body;
  const q2 = stockAfterOut.find(s => s.productId === p1.body.id)?.qty ?? 0;
  ok('出库后库存 100-10=90', q2 === 90, 'qty=' + q2);

  // ===== 生产任务 =====
  const pt = await post('/doc/create', {
    teamId, type: 'prodtask', date: '2026-10-17',
    items: [{ productId: p2.body.id, qty: 20, price: 1500 }],
  });
  ok('生产任务创建', pt.status === 200, pt.body.billNo || JSON.stringify(pt.body));
  ok('生产任务单号前缀 SC', String(pt.body.billNo || '').startsWith('SC'), pt.body.billNo);
  await post('/doc/audit', { teamId, id: pt.body.id });
  const stockAfterTask = (await get(`/stock/list?teamId=${teamId}`)).body;
  const q3 = stockAfterTask.find(s => s.productId === p2.body.id)?.qty ?? 0;
  ok('生产任务审核不动库存', q3 === 0, 'qty=' + q3);

  const conv3 = await post('/doc/convert', { teamId, id: pt.body.id });
  ok('生产任务转化为生产组装单', conv3.status === 200 && conv3.body.type === 'assembly', JSON.stringify(conv3.body));
  ok('组装单号前缀 ZZ', String(conv3.body.billNo || '').startsWith('ZZ'), conv3.body.billNo);

  // 组装单：正数产出成品、负数耗原料
  const asmInfo = await get(`/doc/info?id=${conv3.body.id}&teamId=${teamId}`);
  ok('组装单已带出生产任务明细', asmInfo.body.items.length === 1, 'items=' + asmInfo.body.items.length);

  console.log(results.join('\n'));
  console.log(`\n===== ${pass}/${pass + fail} PASS =====`);
  if (fail) process.exit(1);
})().catch((e) => { console.error('SUITE ERROR', e); process.exit(1); });
