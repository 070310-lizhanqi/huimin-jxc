/**
 * v0.5.0 第八轮审查钉子测试：钉住本轮修复的回归面。
 *
 * 覆盖：
 *  1. stockinit（期初库存）禁止收付款 —— v0.4.0 修报价/订单类时漏了这个类型，
 *     单据显示已收款但结算为 0 的账实不符。
 *  2. 导入跳过单不得自动建档（孤儿档案）—— 仓库校验已挪到自动建档之前。
 *  3. 收付款编辑金额上限（10 亿）与创建同口径。
 *  4. 审核锁内重读：单据头字段以 BEGIN IMMEDIATE 之后的最新值为准（防「预检-过账」竞态）。
 *  5. 报表三接口脏日期（'2026/1/1'）拒绝 400 而非静默回落本月。
 *  6. 作废时间 voidAt 为本地时间格式（'YYYY-MM-DD HH:MM:SS'），不再存 UTC ISO。
 *  7. sale-rank limit 脏参（NaN）回落默认而不是 500。
 *  8. crud PUT 局部更新：未携带字段保持旧值。
 */
const { login, api } = require('./test-helpers.cjs');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ok - ' + name); }
  else { failed++; console.log('  FAIL - ' + name); }
}

(async () => {
  await login();
  const teamId = 1;
  const uniq = String(Date.now()).slice(-6);

  // ---------- 准备：商品/仓库/账户/客户 ----------
  const prod = await api('POST', '/product', { teamId, name: `钉子商品${uniq}`, unit: '件', purchasePrice: 4000, salePrice: 5000 });
  const cus = await api('POST', '/customer', { teamId, name: `钉子客户${uniq}` });
  const whs = await api('GET', '/warehouse?teamId=' + teamId);
  const whId = whs.body[0]?.id ?? 1;
  const acc = await api('POST', '/account', { teamId, name: `钉子账户${uniq}`, type: 'cash', balance: 100000 });

  // ---------- 1. stockinit 禁止收付款 ----------
  {
    const r = await api('POST', '/doc/create', {
      teamId, type: 'stockinit', warehouseId: whId, paidAmount: 5000, accountId: acc.body.id,
      items: [{ productId: prod.body.id, qty: 10, price: 10000 }],
    });
    ok(r.status === 400 && /纯库存/.test(r.body.error || ''), 'stockinit 带收款被拒绝（钱不落账缺口已堵）');
  }

  // ---------- 2. 导入跳过单不建档孤儿 ----------
  {
    const ghost = `幽灵${uniq}`;
    const csv = `客户,仓库,商品,数量,单价\n${ghost},不存在的仓库${uniq},${`钉子商品${uniq}`},10,100\n`;
    const token = (await login());
    const res = await fetch(require('./test-helpers.cjs').BASE + '/doc/import?teamId=' + teamId + '&autoCreate=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer ' + token },
      body: csv,
    });
    const j = await res.json().catch(() => ({}));
    ok(Array.isArray(j.skipped) && j.skipped.length === 1 && /仓库/.test(j.skipped[0]?.reason || ''), '无效仓库导入整单跳过');
    const cusList = await api('GET', `/customer?teamId=${teamId}&kw=${encodeURIComponent(ghost)}`);
    ok(!cusList.body.some((c) => c.name === ghost), '被跳过的单不产生孤儿客户档案');
  }

  // ---------- 3. 收付款编辑金额上限 ----------
  {
    const s = await api('POST', '/settlement/create', {
      teamId, type: 'receipt', partnerType: 'cus', partnerId: cus.body.id,
      accountId: acc.body.id, amount: 10000, date: '2026-01-05', remark: '钉子-编辑上限',
    });
    ok(s.status === 200 && s.body.id, '创建收款成功');
    const edit = await api('PUT', '/settlement/' + s.body.id, {
      teamId, amount: 5e12, date: '2026-01-05',
    });
    ok(edit.status === 400 && /上限/.test(edit.body.error || ''), '编辑收款金额 15 位被拒绝（与创建同口径）');
    await api('DELETE', '/settlement/' + s.body.id + '?teamId=' + teamId);
  }

  // ---------- 4. 审核锁内重读（正常审核链路不回归） ----------
  {
    const inDoc = await api('POST', '/doc/create', {
      teamId, type: 'stockin', partnerType: 'ven', partnerId: null, warehouseId: whId,
      items: [{ productId: prod.body.id, qty: 5, price: 4000 }],
    });
    const a = await api('POST', '/doc/audit', { teamId, id: inDoc.body.id });
    ok(a.status === 200, '入库单审核成功（锁内重读改造不破坏正常链路）');
    const stock = await api('GET', `/stock/list?teamId=${teamId}&productId=${prod.body.id}`);
    const qty = stock.body.reduce((s2, r) => s2 + (r.qty || 0), 0);
    ok(qty >= 5, `入库后库存 ≥ 5（实际 ${qty}）`);
  }

  // ---------- 5. 报表脏日期 400 ----------
  {
    for (const path of ['/report/sales', '/report/product', '/report/customer']) {
      const r = await api('GET', `${path}?teamId=${teamId}&from=2026/1/1&to=2026-01-31`);
      ok(r.status === 400 && /非法/.test(r.body.error || ''), `${path} 脏日期拒绝 400（不再静默回落本月）`);
    }
  }

  // ---------- 6. voidAt 本地时间格式 ----------
  {
    const outDoc = await api('POST', '/doc/create', {
      teamId, type: 'stockout', partnerType: 'cus', partnerId: cus.body.id, warehouseId: whId,
      items: [{ productId: prod.body.id, qty: 1, price: 5000 }],
    });
    await api('POST', '/doc/audit', { teamId, id: outDoc.body.id });
    await api('POST', '/doc/void', { teamId, id: outDoc.body.id, reason: '钉子-作废时间' });
    const info = await api('GET', `/doc/info?teamId=${teamId}&id=${outDoc.body.id}`);
    const v = info.body.doc.voidAt || '';
    ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v), `voidAt 为本地时间格式（${v}）`);
  }

  // ---------- 7. sale-rank limit 脏参回落 ----------
  {
    const r = await api('GET', `/report/sale-rank?teamId=${teamId}&dimension=out&by=cus&limit=abc`);
    ok(r.status === 200 && Array.isArray(r.body.rows), 'sale-rank limit=abc 回落默认（不再 500）');
  }

  // ---------- 8. crud PUT 局部更新 ----------
  {
    const c2 = await api('POST', '/customer', { teamId, name: `局部更新${uniq}`, mobile: '13800000000', remark: '原始备注' });
    const put = await api('PUT', '/customer/' + c2.body.id, { teamId, name: `局部更新改名${uniq}` });
    ok(put.status === 200, 'PUT 仅传 name 成功');
    const after = await api('GET', `/customer?teamId=${teamId}&kw=${encodeURIComponent(`局部更新改名${uniq}`)}`);
    const row = after.body[0];
    ok(row && row.mobile === '13800000000' && row.remark === '原始备注', '未携带字段保持旧值（不再被清成 NULL）');
  }

  console.log(`\n[v0.5.0 钉子] 通过 ${passed} / ${passed + failed}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('[v0.5.0 钉子] 异常:', e);
  process.exit(2);
});
