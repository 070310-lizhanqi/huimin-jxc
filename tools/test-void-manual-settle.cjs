/**
 * 回归测试：作废链路数据正确性（B-数1 + A-数1 + A-数4，另含 A-数2 / A-数5）。
 *
 * B-数1：单据存在 isAuto=0 且 refDocId=本单 的手工结算记录时，作废必须被拒，
 *   并在报错里列出这些手工记录（不做级联删除）；删掉手工记录后作废恢复成功。
 *   ① 部分结算后作废被拒；② 全部结清后作废被拒；③ 退货单后续手工结算后作废被拒；
 *   ④ 无后续手工结算时作废仍成功。
 * A-数1：作废反冲自动收款时，账户余额不足以扣回的，作废必须被拒（不造负账户）；
 *   补足余额后作废恢复成功。
 * A-数4：锁内重读——并发双作废恰好一成一拒，拒绝方报“仅已审核单据可作废”或“单据状态已变化”（取决于时序），不重复冲回。
 * A-数2：未来业务日期的单不进 /stats/trend。
 * A-数5：复制负合计单（组装耗用行）时 totalAmount 不被钳为 0，头/明细一致。
 *
 * 注意：/settlement/create 只允许 receipt↔客户 / payment↔供应商配对，
 * 退货退款方向的手工 payment+客户会被配对校验拒绝登记；场景③因此用一笔
 * 关联到退货单的手工收款记录验证拦截逻辑本身（拦截与结算方向无关）。
 */
const { api } = require('./test-helpers.cjs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail ? ' :: ' + JSON.stringify(detail) : '')); }
}

const TODAY_UTC = new Date().toISOString().slice(0, 10);

async function main() {
  console.log('[test-void-manual-settle] 作废链路：手工结算拦截 / 余额不足拦截 / 锁内重读 / 趋势 / 复制负合计');
  // 自备档案，不依赖演示数据
  const wh = (await api('POST', '/warehouse', { teamId: 1, name: '作废拦截测试仓' })).body;
  const prod = (await api('POST', '/product', { teamId: 1, name: '作废拦截测试品', spec: '件', unit: '件', purchasePrice: 5000, salePrice: 10000 })).body;
  const cus = (await api('POST', '/customer', { teamId: 1, name: '作废拦截测试客户' })).body;
  const ven = (await api('POST', '/vendor', { teamId: 1, name: '作废拦截测试供应商' })).body;
  const acc = (await api('POST', '/account', { teamId: 1, name: '作废拦截测试账户', type: 'cash', balance: 0 })).body;
  if (!wh.id || !prod.id || !cus.id || !ven.id || !acc.id) throw new Error('档案创建失败');

  const accBal = async () => (await api('GET', '/account?teamId=1')).body.find((x) => x.id === acc.id).balance;
  const balOf = async (pt, pid) => {
    const rows = (await api('GET', '/partner/balance?teamId=1')).body;
    const r = rows.find((b) => b.partnerType === pt && b.partnerId === pid);
    return r ? r.balance : 0;
  };
  const settleOf = async (docId) =>
    (await api('GET', `/settlement/list?teamId=1&refDocId=${docId}`)).body;
  const docStatus = async (id) => (await api('GET', `/doc/info?teamId=1&id=${id}`)).body.doc.status;
  const mkSale = async (paid, remark) => {
    const c = await api('POST', '/doc/create', {
      teamId: 1, type: 'stockout', date: '2026-10-20', partnerType: 'cus', partnerId: cus.id,
      warehouseId: wh.id, paidAmount: paid, accountId: acc.id, remark,
      items: [{ productId: prod.id, qty: 1, price: 10000 }],
    });
    if (c.status !== 200 || !c.body.id) throw new Error('建销售单失败: ' + JSON.stringify(c.body));
    const a = await api('POST', '/doc/audit', { teamId: 1, id: c.body.id, auditBy: 'void-manual-test' });
    if (a.status !== 200) throw new Error('审核销售单失败: ' + JSON.stringify(a.body));
    return c.body.id;
  };

  // 备货 20 件
  const si = await api('POST', '/doc/create', {
    teamId: 1, type: 'stockin', date: '2026-10-20', partnerType: 'ven', partnerId: ven.id,
    warehouseId: wh.id, remark: '作废拦截测试-备货',
    items: [{ productId: prod.id, qty: 20, price: 5000 }],
  });
  check('备货采购入库审核成功', si.status === 200, si.body);
  const siA = await api('POST', '/doc/audit', { teamId: 1, id: si.body.id, auditBy: 'void-manual-test' });
  check('备货审核成功', siA.status === 200, siA.body);

  // ---------- ① 部分结算后作废被拒 ----------
  {
    const accBefore = await accBal();
    const cusBefore = await balOf('cus', cus.id);
    const docId = await mkSale(2000, '作废拦截测试-场景①部分结算');
    const manual = await api('POST', '/settlement/create', {
      teamId: 1, type: 'receipt', partnerType: 'cus', partnerId: cus.id,
      accountId: acc.id, amount: 8000, date: '2026-10-20', refDocId: docId, remark: '作废拦截测试-后续收款①',
    });
    check('场景①：手工收款 8000 关联本单', manual.status === 200 && manual.body.id, manual.body);
    const v = await api('POST', '/doc/void', { teamId: 1, id: docId });
    check('场景①：部分结算后作废被拒', v.status === 400, v.body);
    check('场景①：报错列出手工结算记录 id', typeof v.body.error === 'string' && v.body.error.includes(`#${manual.body.id}`), v.body);
    check('场景①：报错提示先处理手工结算', typeof v.body.error === 'string' && /手工/.test(v.body.error), v.body);
    check('场景①：单据仍为已审核', (await docStatus(docId)) === 'audit', await docStatus(docId));
    check('场景①：自动结算记录未被删除', (await settleOf(docId)).some((s) => s.isAuto === 1), await settleOf(docId));
    check('场景①：账户余额未变', (await accBal()) === accBefore + 2000 + 8000, { accBefore, now: await accBal() });
    check('场景①：往来余额未变', (await balOf('cus', cus.id)) === cusBefore, { cusBefore, now: await balOf('cus', cus.id) });
    // 按报错指引删掉手工结算后，作废恢复成功
    const del = await api('DELETE', `/settlement/${manual.body.id}?teamId=1`);
    check('场景①：删除手工结算成功', del.status === 200, del.body);
    const v2 = await api('POST', '/doc/void', { teamId: 1, id: docId });
    check('场景①：删手工结算后作废成功', v2.status === 200, v2.body);
    check('场景①：作废后账户回到开单前', (await accBal()) === accBefore, { accBefore, now: await accBal() });
  }

  // ---------- ② 全部结清后作废被拒（开单即收 0 元，拦截不依赖 paid+dep） ----------
  {
    const accBefore = await accBal();
    const docId = await mkSale(0, '作废拦截测试-场景②全部结清');
    const manual = await api('POST', '/settlement/create', {
      teamId: 1, type: 'receipt', partnerType: 'cus', partnerId: cus.id,
      accountId: acc.id, amount: 10000, date: '2026-10-20', refDocId: docId, remark: '作废拦截测试-后续收款②',
    });
    check('场景②：手工收款 10000 全额结清', manual.status === 200 && manual.body.id, manual.body);
    const v = await api('POST', '/doc/void', { teamId: 1, id: docId });
    check('场景②：全部结清后作废被拒', v.status === 400, v.body);
    check('场景②：报错列出手工结算记录 id', typeof v.body.error === 'string' && v.body.error.includes(`#${manual.body.id}`), v.body);
    check('场景②：单据仍为已审核', (await docStatus(docId)) === 'audit');
    check('场景②：账户余额未变', (await accBal()) === accBefore + 10000, { accBefore, now: await accBal() });
    const del = await api('DELETE', `/settlement/${manual.body.id}?teamId=1`);
    check('场景②：删除手工结算成功', del.status === 200, del.body);
    const v2 = await api('POST', '/doc/void', { teamId: 1, id: docId });
    check('场景②：删手工结算后作废成功', v2.status === 200, v2.body);
    check('场景②：作废后账户回到开单前', (await accBal()) === accBefore, { accBefore, now: await accBal() });
  }

  // ---------- ③ 退货单后续手工结算后作废被拒 ----------
  {
    const accBefore = await accBal();
    const r = await api('POST', '/doc/create', {
      teamId: 1, type: 'sret', date: '2026-10-20', partnerType: 'cus', partnerId: cus.id,
      warehouseId: wh.id, remark: '作废拦截测试-场景③退货单',
      items: [{ productId: prod.id, qty: 1, price: 3000 }],
    });
    check('场景③：销售退货单创建成功', r.status === 200 && r.body.id, r.body);
    const a = await api('POST', '/doc/audit', { teamId: 1, id: r.body.id, auditBy: 'void-manual-test' });
    check('场景③：销售退货审核成功', a.status === 200, a.body);
    const manual = await api('POST', '/settlement/create', {
      teamId: 1, type: 'receipt', partnerType: 'cus', partnerId: cus.id,
      accountId: acc.id, amount: 3000, date: '2026-10-20', refDocId: r.body.id, remark: '作废拦截测试-退货后续③',
    });
    check('场景③：后续手工结算关联退货单', manual.status === 200 && manual.body.id, manual.body);
    const v = await api('POST', '/doc/void', { teamId: 1, id: r.body.id });
    check('场景③：退货单后续手工结算后作废被拒', v.status === 400, v.body);
    check('场景③：报错列出手工结算记录 id', typeof v.body.error === 'string' && v.body.error.includes(`#${manual.body.id}`), v.body);
    check('场景③：单据仍为已审核', (await docStatus(r.body.id)) === 'audit');
    check('场景③：账户余额未变', (await accBal()) === accBefore + 3000, { accBefore, now: await accBal() });
    const del = await api('DELETE', `/settlement/${manual.body.id}?teamId=1`);
    check('场景③：删除手工结算成功', del.status === 200, del.body);
    const v2 = await api('POST', '/doc/void', { teamId: 1, id: r.body.id });
    check('场景③：删手工结算后作废成功', v2.status === 200, v2.body);
    check('场景③：作废后账户回到开单前', (await accBal()) === accBefore, { accBefore, now: await accBal() });
  }

  // ---------- ④ 无后续手工结算时作废仍成功 ----------
  {
    const accBefore = await accBal();
    const cusBefore = await balOf('cus', cus.id);
    const docId = await mkSale(5000, '作废拦截测试-场景④无后续结算');
    check('场景④：审核后账户 +5000', (await accBal()) === accBefore + 5000, { accBefore, now: await accBal() });
    const v = await api('POST', '/doc/void', { teamId: 1, id: docId });
    check('场景④：无后续手工结算时作废成功', v.status === 200, v.body);
    check('场景④：作废后账户扣回', (await accBal()) === accBefore, { accBefore, now: await accBal() });
    check('场景④：自动结算记录已删除', (await settleOf(docId)).length === 0, await settleOf(docId));
    check('场景④：客户余额回到开单前', (await balOf('cus', cus.id)) === cusBefore, { cusBefore, now: await balOf('cus', cus.id) });
  }

  // ---------- ⑤ A-数1：账户余额不足时作废被拒 ----------
  {
    const accBefore = await accBal();
    const docId = await mkSale(10000, '作废拦截测试-场景⑤余额不足');
    check('场景⑤：审核后账户 +10000', (await accBal()) === accBefore + 10000, { accBefore, now: await accBal() });
    // 把账户里的钱支用掉：手工付款 9000 给供应商（不关联本单），账户只剩 1000
    const pay = await api('POST', '/settlement/create', {
      teamId: 1, type: 'payment', partnerType: 'ven', partnerId: ven.id,
      accountId: acc.id, amount: 9000, date: '2026-10-20', remark: '作废拦截测试-支用⑤',
    });
    check('场景⑤：手工付款支用 9000', pay.status === 200 && pay.body.id, pay.body);
    check('场景⑤：账户只剩 1000', (await accBal()) === accBefore + 1000, { accBefore, now: await accBal() });
    const v = await api('POST', '/doc/void', { teamId: 1, id: docId });
    check('场景⑤：余额不足时作废被拒', v.status === 400, v.body);
    check('场景⑤：报错说明余额不足以冲回', typeof v.body.error === 'string' && /不足以冲回/.test(v.body.error), v.body);
    check('场景⑤：报错指引先调账', typeof v.body.error === 'string' && /调整资金/.test(v.body.error), v.body);
    check('场景⑤：单据仍为已审核', (await docStatus(docId)) === 'audit');
    check('场景⑤：账户余额未变（未造负账户）', (await accBal()) === accBefore + 1000, { accBefore, now: await accBal() });
    check('场景⑤：自动结算记录未被删除', (await settleOf(docId)).some((s) => s.isAuto === 1), await settleOf(docId));
    // 删掉支用付款（钱回账户）后，作废恢复成功
    const del = await api('DELETE', `/settlement/${pay.body.id}?teamId=1`);
    check('场景⑤：删除支用付款成功', del.status === 200, del.body);
    const v2 = await api('POST', '/doc/void', { teamId: 1, id: docId });
    check('场景⑤：补足余额后作废成功', v2.status === 200, v2.body);
    check('场景⑤：作废后账户回到开单前', (await accBal()) === accBefore, { accBefore, now: await accBal() });
  }

  // ---------- A-数4：锁内重读——并发双作废恰好一成一拒 ----------
  {
    const docId = await mkSale(0, '作废拦截测试-锁内重读双作废');
    const [v1, v2] = await Promise.all([
      api('POST', '/doc/void', { teamId: 1, id: docId }),
      api('POST', '/doc/void', { teamId: 1, id: docId }),
    ]);
    const statuses = [v1.status, v2.status].sort();
    check('锁内重读：并发双作废恰好一个成功一个失败', statuses[0] === 200 && statuses[1] === 400, [v1.body, v2.body]);
    const loser = v1.status === 400 ? v1 : v2;
    // 失败方可能在锁外预检就读到已作废（“仅已审核单据可作废”），也可能进锁内才发现
    // （“单据状态已变化”），取决于两请求的时序；两种都是正确的拒绝，关键是恰好一成一拒且无重复冲回。
    check('锁内重读：失败方被拒绝（预检或锁内复核任一文案）', typeof loser.body.error === 'string' && /(仅已审核单据可作废|状态已变化)/.test(loser.body.error), loser.body);
    check('锁内重读：单据最终为作废', (await docStatus(docId)) === 'void');
    check('锁内重读：自动结算无残留（无重复冲回）', (await settleOf(docId)).length === 0, await settleOf(docId));
  }

  // ---------- A-数2：未来业务日期的单不进趋势 ----------
  {
    const f = await api('POST', '/doc/create', {
      teamId: 1, type: 'stockin', date: '2027-06-01', partnerType: 'ven', partnerId: ven.id,
      warehouseId: wh.id, remark: '作废拦截测试-未来日期趋势',
      items: [{ productId: prod.id, qty: 1, price: 5000 }],
    });
    check('趋势：未来日期入库单创建成功', f.status === 200 && f.body.id, f.body);
    const fa = await api('POST', '/doc/audit', { teamId: 1, id: f.body.id, auditBy: 'void-manual-test' });
    check('趋势：未来日期入库单审核成功', fa.status === 200, fa.body);
    const trend = (await api('GET', '/stats/trend?teamId=1')).body;
    check('趋势：返回数组', Array.isArray(trend), trend);
    check('趋势：不含未来日期 2027-06-01', Array.isArray(trend) && !trend.some((r) => r.day === '2027-06-01'), trend);
    check('趋势：无任何晚于今天的行', Array.isArray(trend) && !trend.some((r) => r.day > TODAY_UTC), trend);
    const v = await api('POST', '/doc/void', { teamId: 1, id: f.body.id });
    check('趋势：清理未来日期单作废成功', v.status === 200, v.body);
  }

  // ---------- A-数5：复制负合计单不钳为 0 ----------
  {
    const a = await api('POST', '/doc/create', {
      teamId: 1, type: 'assembly', date: '2026-10-20', warehouseId: wh.id, remark: '作废拦截测试-负合计组装',
      items: [{ productId: prod.id, qty: -2, price: 5000 }],
    });
    check('复制：负合计组装单创建成功', a.status === 200 && a.body.id, a.body);
    const info0 = (await api('GET', `/doc/info?teamId=1&id=${a.body.id}`)).body;
    check('复制：原单合计为 -10000', info0.doc.totalAmount === -10000, info0.doc);
    const cp = await api('POST', '/doc/copy', { teamId: 1, id: a.body.id });
    check('复制：复制负合计单成功', cp.status === 200 && cp.body.id, cp.body);
    const info = (await api('GET', `/doc/info?teamId=1&id=${cp.body.id}`)).body;
    check('复制：新单合计仍为 -10000（未钳为 0）', info.doc.totalAmount === -10000, info.doc);
    const itemSum = (info.items || []).reduce((s, it) => s + it.amount, 0);
    check('复制：新单头/明细一致', itemSum === info.doc.totalAmount, { itemSum, total: info.doc.totalAmount });
  }

  // 备货采购入库单不作废清理：其 20 件货已有 5 件被本文件各场景售出，
  // 按原流水冲回规则（reverseStockByLedger）它本身就作废不了，留作已审核状态即可。

  console.log(`[test-void-manual-settle] 通过 ${pass} / ${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('[test-void-manual-settle] 异常:', e.message); process.exit(1); });
