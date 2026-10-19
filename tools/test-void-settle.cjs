/**
 * 回归测试：作废带收款单据的结算冲回（v0.2 bug② 修复）。
 * 场景一：销售出库 100 元全额收款审核 → 账户 +100、客户余额净 0；
 *   作废后 → 账户扣回 100、「开单即收付」结算记录删除、往来余额回到开单前。
 * 场景二：采购入库付款单作废冲回。
 */
const { api } = require('./test-helpers.cjs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail ? ' :: ' + JSON.stringify(detail) : '')); }
}

async function main() {
  console.log('[test-void-settle] 作废冲回结算');
  // 准备档案
  const whs = (await api('GET', '/warehouse?teamId=1')).body;
  const prods = (await api('GET', '/product?teamId=1')).body;
  const cuss = (await api('GET', '/customer?teamId=1')).body;
  const accs = (await api('GET', '/account?teamId=1')).body;
  const wh = whs[0], prod = prods.find((p) => p.name.includes('苹果')) || prods[0];
  const cus = cuss[0], acc = accs[0];
  if (!wh || !prod || !cus || !acc) throw new Error('演示档案不全，请先 rebuild-clean');

  const balOf = async (pt, pid) => {
    const rows = (await api('GET', '/partner/balance?teamId=1')).body;
    const r = rows.find((b) => b.partnerType === pt && b.partnerId === pid);
    return r ? r.balance : 0;
  };
  const settleOf = (rows, docId) => rows.filter((s) => s.refDocId === docId && s.remark === '开单即收付');

  // ---------- 场景一：销售出库全额收款 ----------
  const accBefore = acc.balance;
  const cusBalBefore = await balOf('cus', cus.id);
  const c1 = await api('POST', '/doc/create', {
    teamId: 1, type: 'stockout', date: '2026-10-20', partnerType: 'cus', partnerId: cus.id,
    warehouseId: wh.id, paidAmount: 10000, accountId: acc.id,
    items: [{ productId: prod.id, qty: 1, price: 10000 }],
  });
  check('创建带收款的销售出库', c1.status === 200 && c1.body.id, c1.body);
  const a1 = await api('POST', '/doc/audit', { teamId: 1, id: c1.body.id, auditBy: 'void-settle-test' });
  check('审核成功', a1.status === 200, a1.body);
  const accMid = (await api('GET', '/account?teamId=1')).body.find((x) => x.id === acc.id).balance;
  check('审核后账户 +10000 分', accMid === accBefore + 10000, { accBefore, accMid });
  const setMid = settleOf((await api('GET', '/settlement/list?teamId=1&page=1&rows=500')).body, c1.body.id);
  check('审核生成「开单即收付」结算记录', setMid.length === 1, setMid);

  const v1 = await api('POST', '/doc/void', { teamId: 1, id: c1.body.id });
  check('作废成功', v1.status === 200, v1.body);
  const accAfter = (await api('GET', '/account?teamId=1')).body.find((x) => x.id === acc.id).balance;
  check('作废后账户扣回 10000 分', accAfter === accBefore, { accBefore, accAfter });
  const setAfter = settleOf((await api('GET', '/settlement/list?teamId=1&page=1&rows=500')).body, c1.body.id);
  check('作废删除自动结算记录', setAfter.length === 0, setAfter);
  const cusBalAfter = await balOf('cus', cus.id);
  check('客户余额回到开单前', cusBalAfter === cusBalBefore, { cusBalBefore, cusBalAfter });

  // ---------- 场景二：采购入库付款 ----------
  const vens = (await api('GET', '/vendor?teamId=1')).body;
  const ven = vens[0];
  const accBefore2 = (await api('GET', '/account?teamId=1')).body.find((x) => x.id === acc.id).balance;
  const venBalBefore = await balOf('ven', ven.id);
  const c2 = await api('POST', '/doc/create', {
    teamId: 1, type: 'stockin', date: '2026-10-20', partnerType: 'ven', partnerId: ven.id,
    warehouseId: wh.id, paidAmount: 5000, accountId: acc.id,
    items: [{ productId: prod.id, qty: 1, price: 5000 }],
  });
  check('创建带付款的采购入库', c2.status === 200 && c2.body.id, c2.body);
  const a2 = await api('POST', '/doc/audit', { teamId: 1, id: c2.body.id, auditBy: 'void-settle-test' });
  check('采购入库审核成功', a2.status === 200, a2.body);
  const v2 = await api('POST', '/doc/void', { teamId: 1, id: c2.body.id });
  check('采购入库作废成功', v2.status === 200, v2.body);
  const accAfter2 = (await api('GET', '/account?teamId=1')).body.find((x) => x.id === acc.id).balance;
  const venBalAfter = await balOf('ven', ven.id);
  const setAfter2 = settleOf((await api('GET', '/settlement/list?teamId=1&page=1&rows=500')).body, c2.body.id);
  check('付款账户扣回', accAfter2 === accBefore2, { accBefore2, accAfter2 });
  check('供应商余额回到开单前', venBalAfter === venBalBefore, { venBalBefore, venBalAfter });
  check('付款结算记录已删除', setAfter2.length === 0, setAfter2);

  console.log(`[test-void-settle] 通过 ${pass} / ${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('[test-void-settle] 异常:', e.message); process.exit(1); });
