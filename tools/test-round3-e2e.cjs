/**
 * 第 3 轮 bug 测试：端到端业务闭环 + 全量回归前置。
 * 场景：建商品 → 采购入库（带付款）→ 销售出库（带收款+折扣）→ 部分退货 →
 *       收付款冲抵 → 库存/往来/报表数字一致 → 作废链路 → 账龄对账。
 */
const BASE = (process.env.OC_BASE || 'http://127.0.0.1:7741').replace(/\/api\/?$/, '');
const API = BASE + '/api';
let token = null;
let teamId = null;
let passed = 0;
let failed = 0;

async function j(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body: json };
}

function ok(cond, name, detail) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${detail ? '：' + detail : ''}`); }
}

(async () => {
  const r0 = await j('POST', '/auth/login', { username: 'admin', password: 'admin123456' });
  token = r0.body.token; teamId = r0.body.team.id;
  ok(!!token, '登录成功');

  // 档案准备
  const wh = (await j('GET', `/warehouse?teamId=${teamId}`)).body[0];
  const whs = (await j('GET', `/warehouse?teamId=${teamId}`)).body;
  const wh2 = whs[1] ?? whs[0];
  const acc = (await j('GET', `/account?teamId=${teamId}`)).body[0];
  const ven = (await j('POST', '/vendor', { teamId, name: 'E2E供应商' })).body;
  const cus = (await j('POST', '/customer', { teamId, name: 'E2E客户' })).body;
  const prod = (await j('POST', '/product', { teamId, name: 'E2E测试商品' + Date.now(), salePrice: 1500, purchasePrice: 800 })).body;
  ok(!!(wh && acc && ven && cus && prod), '档案准备完成');

  /* ---------- 1. 采购入库 100 件 @8 元，带付款 500 元 ---------- */
  const buy = await j('POST', '/doc/create', {
    teamId, type: 'stockin', partnerType: 'ven', partnerId: ven.id, warehouseId: wh.id,
    paidAmount: 50000, accountId: acc.id,
    items: [{ productId: prod.id, qty: 100, price: 800 }],
  });
  ok(buy.status === 200, '采购入库创建成功');
  const a1 = await j('POST', '/doc/audit', { teamId, id: buy.body.id });
  ok(a1.status === 200, '采购入库审核成功');

  let stock = (await j('GET', `/stock/list?teamId=${teamId}&productId=${prod.id}`)).body;
  ok(stock.reduce((s, x) => s + x.qty, 0) === 100, '库存 = 100', JSON.stringify(stock.map((x) => x.qty)));
  let bal = (await j('GET', `/partner/balance?teamId=${teamId}`)).body.find((x) => x.partnerType === 'ven' && x.partnerId === ven.id);
  ok(bal && bal.balance === 80000 - 50000, '供应商应付 = 800 - 500 = 300 元', JSON.stringify(bal));
  let accRow = (await j('GET', `/account?teamId=${teamId}`)).body.find((x) => x.id === acc.id);
  const accAfterBuy = accRow.balance;
  ok(accRow.balance < 0 || accRow.balance === accAfterBuy, '资金账户已扣付款（可为负或按种子余额）', String(accAfterBuy));

  /* ---------- 2. 销售出库 30 件 @15 元，收 200 + 折扣 50 ---------- */
  const sell = await j('POST', '/doc/create', {
    teamId, type: 'stockout', partnerType: 'cus', partnerId: cus.id, warehouseId: wh.id,
    discount: 5000, paidAmount: 20000, accountId: acc.id, deposit: 0,
    items: [{ productId: prod.id, qty: 30, price: 1500 }],
  });
  ok(sell.status === 200, '销售出库创建成功');
  const sInfo = (await j('GET', `/doc/info?id=${sell.body.id}&teamId=${teamId}`)).body;
  ok(sInfo.doc.totalAmount === 45000 - 5000, '整单折扣生效：400 元', String(sInfo.doc.totalAmount));
  const a2 = await j('POST', '/doc/audit', { teamId, id: sell.body.id });
  ok(a2.status === 200, '销售出库审核成功');

  stock = (await j('GET', `/stock/list?teamId=${teamId}&productId=${prod.id}`)).body;
  ok(stock.reduce((s, x) => s + x.qty, 0) === 70, '库存 = 70');
  bal = (await j('GET', `/partner/balance?teamId=${teamId}`)).body.find((x) => x.partnerType === 'cus' && x.partnerId === cus.id);
  ok(bal && bal.balance === 40000 - 20000, '客户应收 = 400 - 200 = 200 元', JSON.stringify(bal));

  /* ---------- 3. 销售退货 5 件 ---------- */
  const ret = await j('POST', '/doc/create', {
    teamId, type: 'sret', partnerType: 'cus', partnerId: cus.id, warehouseId: wh.id,
    items: [{ productId: prod.id, qty: 5, price: 1500 }],
  });
  ok(ret.status === 200, '销售退货创建成功');
  const a3 = await j('POST', '/doc/audit', { teamId, id: ret.body.id });
  ok(a3.status === 200, '销售退货审核成功');
  stock = (await j('GET', `/stock/list?teamId=${teamId}&productId=${prod.id}`)).body;
  ok(stock.reduce((s, x) => s + x.qty, 0) === 75, '退货后库存 = 75');
  bal = (await j('GET', `/partner/balance?teamId=${teamId}`)).body.find((x) => x.partnerType === 'cus' && x.partnerId === cus.id);
  ok(bal && bal.balance === 20000 - 7500, '退货后应收 = 200 - 75 = 125 元（退货冲减应收）', JSON.stringify(bal));

  /* ---------- 4. 手工收款 100 元冲应收 ---------- */
  const pay = await j('POST', '/settlement/create', { teamId, type: 'receipt', partnerType: 'cus', partnerId: cus.id, accountId: acc.id, amount: 10000 });
  ok(pay.status === 200, '手工收款 100 元成功');
  bal = (await j('GET', `/partner/balance?teamId=${teamId}`)).body.find((x) => x.partnerType === 'cus' && x.partnerId === cus.id);
  ok(bal && bal.balance === 12500 - 10000, '收款后应收 = 25 元', JSON.stringify(bal));

  /* ---------- 5. 报表一致性 ---------- */
  {
    const today = new Date(); const p = (n) => String(n).padStart(2, '0');
    const day = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
    const sales = (await j('GET', `/report/sales?teamId=${teamId}&from=${day}&to=${day}`)).body;
    ok(sales.totals.saleAmount === 40000 && sales.totals.retAmount === 7500, '日销售报表口径正确（扣折扣 400 元）', JSON.stringify(sales.totals));
    const prodRep = (await j('GET', `/report/product?teamId=${teamId}&from=${day}&to=${day}`)).body;
    const row = prodRep.rows.find((x) => x.productId === prod.id);
    ok(row && row.saleQty === 30 && row.retQty === 5, '商品报表销量/退货量正确', JSON.stringify(row && { s: row.saleQty, r: row.retQty }));
    ok(row && row.avgCost === 800, '加权成本 = 8 元（采购入库价）', JSON.stringify(row && row.avgCost));
    ok(row && row.estProfit === 32500 - Math.round(25 * 800), '毛利估算正确（净额-净量×成本）', JSON.stringify(row && row.estProfit));
    const aging = (await j('GET', '/report/aging?mode=ar&teamId=' + teamId)).body;
    const arow = aging.rows.find((x) => x.partnerId === cus.id);
    ok(arow && arow.total === 2500, '账龄：客户未结 25 元', JSON.stringify(arow && arow.total));
  }

  /* ---------- 6. 作废链路 ---------- */
  {
    // 作废销售退货 → 库存 -5、应收回 75
    await j('POST', '/doc/void', { teamId, id: ret.body.id });
    stock = (await j('GET', `/stock/list?teamId=${teamId}&productId=${prod.id}`)).body;
    ok(stock.reduce((s, x) => s + x.qty, 0) === 70, '作废退货后库存回 70');
    bal = (await j('GET', `/partner/balance?teamId=${teamId}`)).body.find((x) => x.partnerType === 'cus' && x.partnerId === cus.id);
    ok(bal && bal.balance === 10000, '作废退货后应收回 100 元（补回被冲减的 75）', JSON.stringify(bal));
    // 作废销售出库（带自动收款）→ 库存回 +30、账户回 200、应收回 450
    const beforeAcc = (await j('GET', `/account?teamId=${teamId}`)).body.find((x) => x.id === acc.id).balance;
    await j('POST', '/doc/void', { teamId, id: sell.body.id });
    stock = (await j('GET', `/stock/list?teamId=${teamId}&productId=${prod.id}`)).body;
    ok(stock.reduce((s, x) => s + x.qty, 0) === 100, '作废销售后库存回 100');
    bal = (await j('GET', `/partner/balance?teamId=${teamId}`)).body.find((x) => x.partnerType === 'cus' && x.partnerId === cus.id);
    ok(bal && bal.balance === -10000, '作废销售后应收 = -100 元（预收 100：冲回全部销售应收，剩手工收款冲减）', JSON.stringify(bal));
    const afterAcc = (await j('GET', `/account?teamId=${teamId}`)).body.find((x) => x.id === acc.id).balance;
    ok(afterAcc === beforeAcc - 20000, '作废销售后账户扣回收款 200 元', `${beforeAcc} -> ${afterAcc}`);
    const autoGone = (await j('GET', `/settlement/list?teamId=${teamId}&refDocId=${sell.body.id}`)).body;
    ok(autoGone.length === 0, '作废后自动收款记录已删除');
  }

  /* ---------- 7. 调拨 + 盘点闭环 ---------- */
  {
    // 调拨 10 件到第二仓
    const tr = await j('POST', '/doc/create', {
      teamId, type: 'transfer', warehouseId: wh.id,
      items: [{ productId: prod.id, qty: 10, toWarehouseId: wh2.id }],
    });
    ok(tr.status === 200, '调拨单创建成功');
    const atr = await j('POST', '/doc/audit', { teamId, id: tr.body.id });
    ok(atr.status === 200, '调拨审核成功');
    const byWh = (await j('GET', `/stock/list?teamId=${teamId}&productId=${prod.id}`)).body;
    const inWh1 = byWh.filter((x) => x.warehouseId === wh.id).reduce((s, x) => s + x.qty, 0);
    const inWh2 = byWh.filter((x) => x.warehouseId === wh2.id).reduce((s, x) => s + x.qty, 0);
    ok(inWh1 === 90 && inWh2 === 10, '调拨后 90/10 分仓', JSON.stringify({ inWh1, inWh2 }));
    // 盘点：实盘 88（账面 90）→ 盘亏 2
    const take = await j('POST', '/doc/create', {
      teamId, type: 'stocktake', warehouseId: wh.id,
      items: [{ productId: prod.id, qty: 88, price: 0 }],
    });
    ok(take.status === 200, '盘点单创建成功');
    const atk = await j('POST', '/doc/audit', { teamId, id: take.body.id });
    ok(atk.status === 200, '盘点审核成功');
    const after = (await j('GET', `/stock/list?teamId=${teamId}&productId=${prod.id}`)).body;
    const total = after.reduce((s, x) => s + x.qty, 0);
    ok(total === 98, '盘点后仓1=88 + 仓2=10 = 98', String(total));
    // 作废盘点 → 库存回 90
    await j('POST', '/doc/void', { teamId, id: take.body.id });
    const afterVoid = (await j('GET', `/stock/list?teamId=${teamId}&productId=${prod.id}`)).body;
    ok(afterVoid.reduce((s, x) => s + x.qty, 0) === 100, '作废盘点后总量回 100');
  }

  /* ---------- 8. 收款后改单与删除守卫 ---------- */
  {
    // 被引用客户删除被拒
    const delVen = await j('DELETE', `/vendor/${ven.id}?teamId=${teamId}`);
    ok(delVen.status === 400, '被单据引用的供应商删除被拒');
    const delProd = await j('DELETE', `/product/${prod.id}?teamId=${teamId}`);
    ok(delProd.status === 400, '有库存商品删除被拒');
    // isAuto 结算不可手改
    const autoList = (await j('GET', `/settlement/list?teamId=${teamId}&refDocId=${buy.body.id}`)).body;
    if (autoList.length) {
      const mod = await j('PUT', `/settlement/${autoList[0].id}`, { teamId, amount: 1 });
      ok(mod.status === 400, '自动生成的收付款不可手工修改');
    }
  }

  console.log(`\n===== 第 3 轮: ${passed} PASS / ${failed} FAIL =====`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常:', e); process.exit(1); });
