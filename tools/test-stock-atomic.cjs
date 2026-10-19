/**
 * 回归测试：审核扣库存的原子条件（阶段一 bug② 修复）。
 * 场景：库存 5 件 → 审核出库 5 件成功（库存归零）→ 再审核出库 1 件必须失败，
 *   且库存保持 0、不出现负库存行，失败单据状态不被误改。
 */
const { api } = require('./test-helpers.cjs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail ? ' :: ' + JSON.stringify(detail) : '')); }
}

const TODAY = new Date().toISOString().slice(0, 10);

async function main() {
  console.log('[test-stock-atomic] 审核扣库存原子性');
  const whs = (await api('GET', '/warehouse?teamId=1')).body;
  const prods = (await api('GET', '/product?teamId=1')).body;
  const cuss = (await api('GET', '/customer?teamId=1')).body;
  const wh = whs[0], cus = cuss[0];
  // 用一个当前库存较低的商品不好找，直接入库 5 件到独立商品（取最后一个商品降低干扰）
  const prod = prods[prods.length - 1];
  if (!wh || !prod || !cus) throw new Error('演示档案不全，请先 rebuild-clean');

  const stockQty = async () => {
    const rows = (await api('GET', `/stock/list?teamId=1&productId=${prod.id}&warehouseId=${wh.id}`)).body;
    const arr = Array.isArray(rows) ? rows : rows.rows || [];
    return arr.reduce((s, r) => s + (r.qty || 0), 0);
  };

  const before = await stockQty();
  // 入库 5 件
  const si = await api('POST', '/doc/create', {
    teamId: 1, type: 'stockin', date: TODAY, warehouseId: wh.id,
    items: [{ productId: prod.id, qty: 5, price: 1000 }],
  });
  check('入库单创建', si.status === 200 && si.body.id, si.body);
  const asi = await api('POST', '/doc/audit', { teamId: 1, id: si.body.id, auditBy: 'atomic-test' });
  check('入库审核成功', asi.status === 200, asi.body);
  check('库存 +5', (await stockQty()) === before + 5, { before, now: await stockQty() });

  // 出库 5 件（恰好扣完）
  const so1 = await api('POST', '/doc/create', {
    teamId: 1, type: 'stockout', date: TODAY, partnerType: 'cus', partnerId: cus.id,
    warehouseId: wh.id, items: [{ productId: prod.id, qty: 5, price: 2000 }],
  });
  check('出库单1创建（5件）', so1.status === 200 && so1.body.id, so1.body);
  const ao1 = await api('POST', '/doc/audit', { teamId: 1, id: so1.body.id, auditBy: 'atomic-test' });
  check('出库单1审核成功（库存归零）', ao1.status === 200, ao1.body);
  check('库存回到入库前', (await stockQty()) === before, { before, now: await stockQty() });

  // 再出库 1 件：必须被原子条件拦截
  const so2 = await api('POST', '/doc/create', {
    teamId: 1, type: 'stockout', date: TODAY, partnerType: 'cus', partnerId: cus.id,
    warehouseId: wh.id, items: [{ productId: prod.id, qty: before + 1, price: 2000 }],
  });
  check('出库单2创建（超额）', so2.status === 200 && so2.body.id, so2.body);
  const ao2 = await api('POST', '/doc/audit', { teamId: 1, id: so2.body.id, auditBy: 'atomic-test' });
  check('超额审核被拒绝', ao2.status === 400 && /库存不足/.test(ao2.body.error || ''), ao2.body);
  check('库存未被扣成负数', (await stockQty()) === before, { before, now: await stockQty() });
  const info = (await api('GET', `/doc/info?teamId=1&id=${so2.body.id}`)).body;
  check('失败单据状态未被误改（仍为 draft）', info.doc.status === 'draft', info.doc.status);

  // 清理：删除失败草稿，作废入库单恢复库存
  await api('DELETE', `/doc/${so2.body.id}?teamId=1`);
  await api('POST', '/doc/void', { teamId: 1, id: si.body.id });

  console.log(`[test-stock-atomic] 通过 ${pass} / ${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('[test-stock-atomic] 异常:', e.message); process.exit(1); });
