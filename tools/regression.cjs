// 进销系统回归脚本：只跑 API，不起浏览器。用法：node tools/regression.cjs
// 需要先登录：脚本启动时用 ORANGE_USER / ORANGE_PASS 换取令牌，后续所有请求自动携带
const BASE = process.env.BASE || 'http://127.0.0.1:7741/api';
const USER = process.env.ORANGE_USER || 'admin';
const PASS = process.env.ORANGE_PASS || 'admin123456';
let TOKEN = '';
let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; fails.push(name); console.log(`FAIL  ${name}${extra ? '  ' + extra : ''}`); }
}
async function call(method, path, body) {
  const headers = {};
  if (TOKEN) headers.authorization = 'Bearer ' + TOKEN;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + path, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
}

(async () => {
  // ---------- 0. 环境 ----------
  console.log('BASE =', BASE);

  // 登录换取令牌（鉴权改造后所有业务接口都需要令牌）
  const login = await call('POST', '/auth/login', { username: USER, password: PASS });
  if (login.status !== 200 || !login.json || !login.json.token) {
    console.error('登录失败，无法继续回归：', login.status, login.text);
    process.exit(2);
  }
  TOKEN = login.json.token;
  console.log('已登录：', login.json.user && login.json.user.name);

  const teams = await call('GET', '/team/list');
  ok('GET /team/list', teams.status === 200 && Array.isArray(teams.json));
  const TEAM = (teams.json && teams.json[0] && teams.json[0].id) || 1;
  console.log('teamId =', TEAM);

  // ---------- 1. 档案 ----------
  const p0 = await call('GET', `/product?teamId=${TEAM}`);
  ok('GET /product', p0.status === 200);
  const w0 = await call('GET', `/warehouse?teamId=${TEAM}`);
  ok('GET /warehouse', w0.status === 200);
  const c0 = await call('GET', `/customer?teamId=${TEAM}`);
  ok('GET /customer', c0.status === 200);
  const s0 = await call('GET', `/setting/get?teamId=${TEAM}`);
  ok('GET /setting/get', s0.status === 200);

  // 造基础数据（幂等：按名字查后建）
  async function ensure(table, where, payload) {
    const list = await call('GET', `/${table}?teamId=${TEAM}`);
    const hit = (list.json || []).find((x) => where(x));
    if (hit) return hit;
    return (await call('POST', `/${table}`, { teamId: TEAM, ...payload })).json;
  }
  const cat = await ensure('cat', (x) => x.name === '回归测试分类', { name: '回归测试分类' });
  ok('ensure cat', !!cat && !!cat.id);
  const prod = await ensure('product', (x) => x.name === '回归测试商品', {
    catId: cat.id, name: '回归测试商品', barcode: 'REG0001', unit: '件', spec: '1x12',
    salePrice: 10000, retailPrice: 12000, purchasePrice: 8000, wholePrice: 9000,
  });
  ok('ensure product', !!prod && !!prod.id);
  const wh = await ensure('warehouse', (x) => x.name === '回归仓库', { name: '回归仓库' });
  ok('ensure warehouse', !!wh && !!wh.id);
  const resv = await ensure('reservoir', (x) => x.name === 'A区' && x.warehouseId === wh.id, { warehouseId: wh.id, name: 'A区' });
  ok('ensure reservoir', !!resv && !!resv.id);
  const cus = await ensure('customer', (x) => x.name === '回归客户', { name: '回归客户', mobile: '13800000000' });
  ok('ensure customer', !!cus && !!cus.id);
  const ven = await ensure('vendor', (x) => x.name === '回归供应商', { name: '回归供应商' });
  ok('ensure vendor', !!ven && !!ven.id);
  const clerk = await ensure('clerk', (x) => x.name === '回归业务员', { name: '回归业务员' });
  ok('ensure clerk', !!clerk && !!clerk.id);
  const acct = await ensure('account', (x) => x.name === '回归现金账户', { name: '回归现金账户', type: 'cash', balance: 1000000 });
  ok('ensure account', !!acct && !!acct.id);
  const unit = await ensure('unit', (x) => x.name === '箱', { name: '箱' });
  ok('ensure unit', !!unit && !!unit.id);

  // ---------- 2. 单据全类型开单-审核链路 ----------
  const TYPES = [
    { type: 'stockin',    sign: +1, needs: ['warehouse'] },
    { type: 'stockout',   sign: -1, needs: ['warehouse', 'partner'] },
    { type: 'porder',     sign: +1, needs: ['partner'] },
    { type: 'sorder',     sign: -1, needs: ['partner'] },
    { type: 'quo',        sign: -1, needs: ['partner'] },
    { type: 'outapply',   sign: +1, needs: ['partner'] },
    { type: 'prodtask',   sign: +1, needs: [] },
    { type: 'transfer',   sign: +1, needs: ['toWarehouse'] },
    { type: 'adjust',     sign: 0, needs: ['warehouse'] },
    { type: 'stocktake',  sign: 0, needs: ['warehouse'] },
    { type: 'pin',        sign: -1, needs: ['warehouse', 'partner'] },
    { type: 'sret',       sign: -1, needs: ['warehouse', 'partner'] },
    { type: 'otherin',    sign: +1, needs: ['warehouse'] },
    { type: 'otherout',   sign: -1, needs: ['warehouse'] },
    { type: 'assembly',   sign: 0, needs: ['warehouse'] },
    { type: 'stockinit',  sign: +1, needs: ['warehouse'] },
  ];
  const created = {};
  for (const t of TYPES) {
    const doc = {
      teamId: TEAM, type: t.type, date: '2026-10-17',
      warehouseId: t.needs.includes('warehouse') || t.needs.includes('toWarehouse') ? wh.id : null,
      toWarehouseId: t.needs.includes('toWarehouse') ? (await ensure('warehouse', (x) => x.name === '回归仓库2', { name: '回归仓库2' })).id : null,
      partnerType: t.needs.includes('partner') ? (t.sign > 0 ? 'ven' : 'cus') : null,
      partnerId: t.needs.includes('partner') ? (t.sign > 0 ? ven.id : cus.id) : null,
      clerkId: clerk.id,
      remark: `回归-${t.type}`,
      items: [{ productId: prod.id, qty: 10, price: 100, remark: '回归明细' }],
    };
    const r = await call('POST', '/doc/create', doc);
    ok(`create ${t.type}`, r.status === 200 && r.json && r.json.id, r.json && r.json.error ? r.json.error : '');
    created[t.type] = r.json;
  }
  // ---------- 3. 转化链路：订单类必须先审核才能 convert（源码 docs.ts 347 行要求 status==='audit'） ----------
  for (const key of ['porder', 'sorder', 'quo', 'outapply', 'prodtask']) {
    const a = await call('POST', '/doc/audit', { teamId: TEAM, id: created[key].id });
    ok(`audit ${key}`, a.status === 200, a.json && a.json.error || '');
  }
  // 采购订单 -> 采购入库（转化）
  const cv1 = await call('POST', '/doc/convert', { teamId: TEAM, id: created.porder.id, to: 'stockin' });
  ok('convert porder->stockin', cv1.status === 200 && cv1.json && cv1.json.id, cv1.json && cv1.json.error || '');
  // 销售订单 -> 销售出库
  const cv2 = await call('POST', '/doc/convert', { teamId: TEAM, id: created.sorder.id, to: 'stockout' });
  ok('convert sorder->stockout', cv2.status === 200 && cv2.json && cv2.json.id, cv2.json && cv2.json.error || '');
  // 报价 -> 销售订单
  const cv3 = await call('POST', '/doc/convert', { teamId: TEAM, id: created.quo.id, to: 'sorder' });
  ok('convert quo->sorder', cv3.status === 200 && cv3.json && cv3.json.id, cv3.json && cv3.json.error || '');
  // 出库申请 -> 销售出库
  const cv4 = await call('POST', '/doc/convert', { teamId: TEAM, id: created.outapply.id, to: 'stockout' });
  ok('convert outapply->stockout', cv4.status === 200 && cv4.json && cv4.json.id, cv4.json && cv4.json.error || '');
  // 生产任务 -> 组装拆卸
  const cv5 = await call('POST', '/doc/convert', { teamId: TEAM, id: created.prodtask.id, to: 'assembly' });
  ok('convert prodtask->assembly', cv5.status === 200 && cv5.json && cv5.json.id, cv5.json && cv5.json.error || '');
  // 草稿订单转单必须被拦
  const cvDraft = await call('POST', '/doc/convert', { teamId: TEAM, id: created.stockin.id, to: 'stockout' });
  ok('convert 非订单/草稿被拦', cvDraft.status >= 400, `status=${cvDraft.status}`);
  // 下游单入库 100 / 出库 40
  const audCv1 = await call('POST', '/doc/audit', { teamId: TEAM, id: cv1.json.id });
  ok('audit 转化的 stockin', audCv1.status === 200, audCv1.json && audCv1.json.error || '');
  const audCv2 = await call('POST', '/doc/audit', { teamId: TEAM, id: cv2.json.id });
  ok('audit 转化的 stockout', audCv2.status === 200, audCv2.json && audCv2.json.error || '');

  // ---------- 4. 入库、出库、库存 ----------
  // 记录转化链路上的库存变化基线（转化单已入库 100、出库 40）
  const baseList = await call('GET', `/stock/list?teamId=${TEAM}&productId=${prod.id}`);
  const baseStock = (baseList.json || []).find((s) => s.warehouseId === wh.id && s.productId === prod.id);
  const baseQty = baseStock ? Number(baseStock.qty) : 0;
  const stkIn = await call('POST', '/doc/create', {
    teamId: TEAM, type: 'stockin', date: '2026-10-17', warehouseId: wh.id, clerkId: clerk.id,
    partnerType: 'ven', partnerId: ven.id, remark: '回归-入库',
    items: [{ productId: prod.id, qty: 100, price: 80 }],
  });
  ok('create stockin', stkIn.status === 200 && stkIn.json && stkIn.json.id, stkIn.json && stkIn.json.error || '');
  const audIn = await call('POST', '/doc/audit', { teamId: TEAM, id: stkIn.json.id });
  ok('audit stockin', audIn.status === 200, audIn.json && audIn.json.error || '');
  const stockList = await call('GET', `/stock/list?teamId=${TEAM}&productId=${prod.id}`);
  const myStock = (stockList.json || []).find((s) => s.warehouseId === wh.id && s.productId === prod.id);
  ok('stock qty after stockin = base+100', !!myStock && Number(myStock.qty) === baseQty + 100, `qty=${myStock && myStock.qty} base=${baseQty}`);

  // 出库（应足够）
  const stkOut = await call('POST', '/doc/create', {
    teamId: TEAM, type: 'stockout', date: '2026-10-17', warehouseId: wh.id, clerkId: clerk.id,
    partnerType: 'cus', partnerId: cus.id, remark: '回归-出库',
    items: [{ productId: prod.id, qty: 40, price: 100 }],
  });
  ok('create stockout', stkOut.status === 200 && stkOut.json && stkOut.json.id, stkOut.json && stkOut.json.error || '');
  const audOut = await call('POST', '/doc/audit', { teamId: TEAM, id: stkOut.json.id });
  ok('audit stockout', audOut.status === 200, audOut.json && audOut.json.error || '');
  const stockList2 = await call('GET', `/stock/list?teamId=${TEAM}&productId=${prod.id}`);
  const myStock2 = (stockList2.json || []).find((s) => s.warehouseId === wh.id && s.productId === prod.id);
  ok('stock qty after stockout = base+60', !!myStock2 && Number(myStock2.qty) === baseQty + 60, `qty=${myStock2 && myStock2.qty} base=${baseQty}`);

  // 库存不足必须被拦
  const stkOut2 = await call('POST', '/doc/create', {
    teamId: TEAM, type: 'stockout', date: '2026-10-17', warehouseId: wh.id, clerkId: clerk.id,
    partnerType: 'cus', partnerId: cus.id, remark: '回归-超发出库',
    items: [{ productId: prod.id, qty: 9999, price: 100 }],
  });
  const audBad = await call('POST', '/doc/audit', { teamId: TEAM, id: stkOut2.json && stkOut2.json.id });
  ok('audit 超发出库被拦(4xx/5xx)', audBad.status >= 400, `status=${audBad.status} body=${(audBad.json && audBad.json.error) || audBad.text}`);

  // 作废回冲
  const vd = await call('POST', '/doc/void', { teamId: TEAM, id: stkOut.json.id });
  ok('void stockout', vd.status === 200, vd.json && vd.json.error || '');
  const stockList3 = await call('GET', `/stock/list?teamId=${TEAM}&productId=${prod.id}`);
  const myStock3 = (stockList3.json || []).find((s) => s.warehouseId === wh.id && s.productId === prod.id);
  ok('stock qty after void = base+100', !!myStock3 && Number(myStock3.qty) === baseQty + 100, `qty=${myStock3 && myStock3.qty} base=${baseQty}`);

  // ---------- 4. 收付款 ----------
  const so = await call('POST', '/doc/create', {
    teamId: TEAM, type: 'sorder', date: '2026-10-17', clerkId: clerk.id,
    partnerType: 'cus', partnerId: cus.id, remark: '回归-收款单',
    items: [{ productId: prod.id, qty: 5, price: 100 }],
  });
  ok('create sorder', so.status === 200 && so.json && so.json.id, so.json && so.json.error || '');
  const soAudit = await call('POST', '/doc/audit', { teamId: TEAM, id: so.json.id });
  ok('audit sorder', soAudit.status === 200, soAudit.json && soAudit.json.error || '');
  const st = await call('POST', '/settlement/create', {
    teamId: TEAM, type: 'receipt', partnerType: 'cus', partnerId: cus.id,
    accountId: acct.id, amount: 20000, date: '2026-10-17', refDocId: so.json.id, remark: '回归收款',
  });
  ok('create settlement receipt', st.status === 200, st.json && st.json.error || '');
  const stList = await call('GET', `/settlement/list?teamId=${TEAM}`);
  const stId = (stList.json || []).find((x) => x.remark === '回归收款');
  ok('settlement list 可查到新建记录', !!stId && stId.id > 0);
  const stUpd = await call('PUT', `/settlement/${stId.id}`, { teamId: TEAM, amount: 15000 });
  ok('update settlement', stUpd.status === 200, stUpd.json && stUpd.json.error || '');
  // 付款超过账户余额必须被拦
  const stBad = await call('POST', '/settlement/create', {
    teamId: TEAM, type: 'payment', partnerType: 'ven', partnerId: ven.id,
    accountId: acct.id, amount: 999999999, date: '2026-10-17', remark: '回归超额付款',
  });
  ok('create settlement 超额付款被拦', stBad.status >= 400, `status=${stBad.status} body=${stBad.text}`);
  const stDel = await call('DELETE', `/settlement/${stId.id}?teamId=${TEAM}`);
  ok('delete settlement', stDel.status === 200, stDel.json && stDel.error || '');

  // 删除保护需要账户仍被引用：再建一笔付款（不删除），供后面断言「已引用账户不可删」
  const stKeep = await call('POST', '/settlement/create', {
    teamId: TEAM, type: 'payment', partnerType: 'ven', partnerId: ven.id,
    accountId: acct.id, amount: 1000, date: '2026-10-17', remark: '回归-账户引用占位',
  });
  ok('create settlement 账户引用占位', stKeep.status === 200, stKeep.json && stKeep.json.error || '');

  // ---------- 5. 价格记忆 ----------
  const pm = await call('POST', '/price/set', { teamId: TEAM, partnerType: 'cus', partnerId: cus.id, productId: prod.id, price: 8888 });
  ok('set price memory', pm.status === 200, pm.json && pm.json.error || '');
  const pmList = await call('GET', `/price/list?teamId=${TEAM}`);
  ok('list price memory', pmList.status === 200 && Array.isArray(pmList.json && pmList.json.rows) && pmList.json.rows.length > 0);

  // ---------- 7. 报表（不允许 500） ----------
  for (const rp of ['/report/sales', '/report/product', '/report/customer', '/report/aging', '/report/aging/top', '/report/stock-aging', '/report/jxc-stat', '/report/stock-forecast', '/stats/dashboard', '/stats/trend', '/stats/sales-summary', '/report/sale-rank', '/stock/ledger', '/stock/summary']) {
    const r = await call('GET', `${rp}?teamId=${TEAM}`);
    ok(`GET ${rp}`, r.status === 200, `status=${r.status}`);
  }
  // statement 需要 partnerId
  const stm = await call('GET', `/report/statement?teamId=${TEAM}&partnerType=cus&partnerId=${cus.id}`);
  ok('GET /report/statement', stm.status === 200, `status=${stm.status}`);
  const stmBad = await call('GET', `/report/statement?teamId=${TEAM}`);
  ok('GET /report/statement 缺 partnerId 应 400', stmBad.status === 400, `status=${stmBad.status}`);

  // ---------- 8. 删除保护 ----------
  const delProd = await call('DELETE', `/product/${prod.id}?teamId=${TEAM}`);
  ok('delete 已引用商品被拦', delProd.status >= 400, `status=${delProd.status}`);
  const delAcct = await call('DELETE', `/account/${acct.id}?teamId=${TEAM}`);
  ok('delete 已引用账户被拦', delAcct.status >= 400, `status=${delAcct.status}`);

  // ---------- 9. 草稿删除与单号不复用 ----------
  const dr = await call('POST', '/doc/create', {
    teamId: TEAM, type: 'stockout', date: '2026-10-17', warehouseId: wh.id, clerkId: clerk.id,
    partnerType: 'cus', partnerId: cus.id, remark: '回归-删草稿',
    items: [{ productId: prod.id, qty: 1, price: 100 }],
  });
  const drNo = dr.json && dr.json.billNo;
  const drDel = await call('DELETE', `/doc/${dr.json.id}?teamId=${TEAM}`);
  ok('delete 草稿', drDel.status === 200, drDel.json && drDel.json.error || '');
  const dr2 = await call('POST', '/doc/create', {
    teamId: TEAM, type: 'stockout', date: '2026-10-17', warehouseId: wh.id, clerkId: clerk.id,
    partnerType: 'cus', partnerId: cus.id, remark: '回归-删草稿2',
    items: [{ productId: prod.id, qty: 1, price: 100 }],
  });
  ok('删草稿后单号不复用', dr2.json && dr2.json.billNo !== drNo, `${drNo} vs ${dr2.json && dr2.json.billNo}`);

  // ---------- 10. 编辑草稿 ----------
  const ed = await call('PUT', '/doc/edit', { id: dr2.json.id, teamId: TEAM, type: 'stockout', date: '2026-10-17', warehouseId: wh.id, clerkId: clerk.id, partnerType: 'cus', partnerId: cus.id, remark: '回归-改后', items: [{ productId: prod.id, qty: 3, price: 120 }] });
  ok('edit 草稿', ed.status === 200, ed.json && ed.json.error || '');
  const info = await call('GET', `/doc/info?teamId=${TEAM}&id=${dr2.json.id}`);
  ok('info 返回 doc+items', info.status === 200 && info.json && info.json.doc && Array.isArray(info.json.items));

  // ---------- 11. 提交/驳回/批量提交 ----------
  const sb = await call('POST', '/doc/submit', { teamId: TEAM, id: dr2.json.id });
  ok('submit 草稿', sb.status === 200, sb.json && sb.json.error || '');
  const rj = await call('POST', '/doc/reject', { teamId: TEAM, id: dr2.json.id, reason: '回归驳回' });
  ok('reject 待审单', rj.status === 200, rj.json && rj.json.error || '');
  const sb2 = await call('POST', '/doc/submit-batch', { teamId: TEAM, ids: [dr2.json.id] });
  ok('submit-batch', sb2.status === 200, sb2.json && sb2.json.error || '');
  const pend = await call('GET', `/doc/pending?teamId=${TEAM}`);
  ok('pending 列表', pend.status === 200 && Array.isArray(pend.json && pend.json.rows), `status=${pend.status} rows=${pend.json && (pend.json.rows || []).length}`);
  // 已审核单不可再编辑/提交
  const edAudit = await call('PUT', '/doc/edit', { id: so.json.id, teamId: TEAM, type: 'sorder', date: '2026-10-17', partnerType: 'cus', partnerId: cus.id, items: [{ productId: prod.id, qty: 1, price: 100 }] });
  ok('edit 已审核单被拦', edAudit.status >= 400, `status=${edAudit.status}`);
  // 重复审核必须被拦
  const audTwice = await call('POST', '/doc/audit', { teamId: TEAM, id: so.json.id });
  ok('重复审核被拦', audTwice.status >= 400, `status=${audTwice.status} body=${audTwice.text}`);
  // 已作废单不可再作废
  const voidTwice = await call('POST', '/doc/void', { teamId: TEAM, id: stkOut.json.id });
  ok('重复作废被拦', voidTwice.status >= 400, `status=${voidTwice.status}`);
  // 单据不存在
  const noDoc = await call('POST', '/doc/audit', { teamId: TEAM, id: 99999999 });
  ok('审核不存在单据返回 404', noDoc.status === 404, `status=${noDoc.status}`);

  console.log(`\n===== 结果：PASS ${pass} / FAIL ${fail} =====`);
  if (fail) { console.log('失败项：'); fails.forEach((f) => console.log('  - ' + f)); process.exitCode = 1; }
})().catch((e) => { console.error('脚本异常：', e); process.exitCode = 2; });
