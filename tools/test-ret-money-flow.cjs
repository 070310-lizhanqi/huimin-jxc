/**
 * 回归测试：销售退货 / 采购退货的收支流向（阶段一 bug① 修复）。
 * 正确流向：
 *   销售退货（sret）= 退款给客户 → settlement.type=payment，账户余额减少；
 *   采购退货（pin） = 收回供应商货款 → settlement.type=receipt，账户余额增加。
 * 同时验证作废后账户与往来余额完整回滚。
 */
const { api } = require('./test-helpers.cjs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail ? ' :: ' + JSON.stringify(detail) : '')); }
}

const TODAY = new Date().toISOString().slice(0, 10);

async function main() {
  console.log('[test-ret-money-flow] 退货收支流向');
  const whs = (await api('GET', '/warehouse?teamId=1')).body;
  const prods = (await api('GET', '/product?teamId=1')).body;
  const cuss = (await api('GET', '/customer?teamId=1')).body;
  const vens = (await api('GET', '/vendor?teamId=1')).body;
  const accs = (await api('GET', '/account?teamId=1')).body;
  const wh = whs[0], prod = prods[0], cus = cuss[0], ven = vens[0], acc = accs[0];
  if (!wh || !prod || !cus || !ven || !acc) throw new Error('演示档案不全，请先 rebuild-clean');

  const balOf = async (pt, pid) => {
    const rows = (await api('GET', '/partner/balance?teamId=1')).body;
    const r = rows.find((b) => b.partnerType === pt && b.partnerId === pid);
    return r ? r.balance : 0;
  };
  const accBal = async () => (await api('GET', '/account?teamId=1')).body.find((x) => x.id === acc.id).balance;
  const settleOf = async (docId) =>
    (await api('GET', '/settlement/list?teamId=1')).body.filter((s) => s.refDocId === docId);

  // ---------- 场景一：销售退货 = 退款（payment），账户减少 ----------
  let accBefore = await accBal();
  let cusBefore = await balOf('cus', cus.id);
  const r1 = await api('POST', '/doc/create', {
    teamId: 1, type: 'sret', date: TODAY, partnerType: 'cus', partnerId: cus.id,
    warehouseId: wh.id, paidAmount: 8000, accountId: acc.id,
    items: [{ productId: prod.id, qty: 1, price: 8000 }],
  });
  check('创建销售退货单（含退款）', r1.status === 200 && r1.body.id, r1.body);
  const a1 = await api('POST', '/doc/audit', { teamId: 1, id: r1.body.id, auditBy: 'ret-flow-test' });
  check('销售退货审核成功', a1.status === 200, a1.body);
  const s1 = await settleOf(r1.body.id);
  check('生成 payment 类型结算（退款）', s1.length === 1 && s1[0].type === 'payment', s1);
  check('审核后账户 -8000 分', (await accBal()) === accBefore - 8000, { accBefore, now: await accBal() });
  check('客户余额净变化为 0（退货 -8000，退款 +8000）', (await balOf('cus', cus.id)) === cusBefore, {
    cusBefore, now: await balOf('cus', cus.id),
  });

  const v1 = await api('POST', '/doc/void', { teamId: 1, id: r1.body.id });
  check('销售退货作废成功', v1.status === 200, v1.body);
  check('作废后账户回滚', (await accBal()) === accBefore, { accBefore, now: await accBal() });
  check('作废后自动结算记录删除', (await settleOf(r1.body.id)).length === 0);

  // ---------- 场景二：采购退货 = 回款（receipt），账户增加 ----------
  // 先采购入库攒库存与应付
  const si = await api('POST', '/doc/create', {
    teamId: 1, type: 'stockin', date: TODAY, partnerType: 'ven', partnerId: ven.id,
    warehouseId: wh.id, items: [{ productId: prod.id, qty: 2, price: 6000 }],
  });
  check('准备：采购入库创建', si.status === 200 && si.body.id, si.body);
  await api('POST', '/doc/audit', { teamId: 1, id: si.body.id, auditBy: 'ret-flow-test' });

  accBefore = await accBal();
  const venBefore = await balOf('ven', ven.id);
  const r2 = await api('POST', '/doc/create', {
    teamId: 1, type: 'pin', date: TODAY, partnerType: 'ven', partnerId: ven.id,
    warehouseId: wh.id, paidAmount: 6000, accountId: acc.id,
    items: [{ productId: prod.id, qty: 1, price: 6000 }],
  });
  check('创建采购退货单（含回款）', r2.status === 200 && r2.body.id, r2.body);
  const a2 = await api('POST', '/doc/audit', { teamId: 1, id: r2.body.id, auditBy: 'ret-flow-test' });
  check('采购退货审核成功', a2.status === 200, a2.body);
  const s2 = await settleOf(r2.body.id);
  check('生成 receipt 类型结算（回款）', s2.length === 1 && s2[0].type === 'receipt', s2);
  check('审核后账户 +6000 分', (await accBal()) === accBefore + 6000, { accBefore, now: await accBal() });
  check('供应商余额净变化为 0（退货 -6000，回款 +6000）', (await balOf('ven', ven.id)) === venBefore, {
    venBefore, now: await balOf('ven', ven.id),
  });

  const v2 = await api('POST', '/doc/void', { teamId: 1, id: r2.body.id });
  check('采购退货作废成功', v2.status === 200, v2.body);
  check('作废后账户回滚', (await accBal()) === accBefore, { accBefore, now: await accBal() });

  // 清理：作废准备用的采购入库，避免影响其他测试的库存/往来
  await api('POST', '/doc/void', { teamId: 1, id: si.body.id });

  console.log(`[test-ret-money-flow] 通过 ${pass} / ${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('[test-ret-money-flow] 异常:', e.message); process.exit(1); });
