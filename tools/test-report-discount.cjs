/**
 * 回归测试：报表整单折扣分摊口径（阶段一 bug④ 修复）。
 * 场景：销售出库 A 商品 100 元 + B 商品 200 元，整单折扣 60 元 → 单据总额 240 元。
 * 验证（增量法，消除期间内其他单据干扰）：
 *   商品销售报表中 A 销售额增量 = 80（100-20 分摊折扣）、B 增量 = 160（200-40），
 *   合计增量 = 单据 totalAmount = 按日/客户报表口径；毛利也随之基于净额。
 */
const { api } = require('./test-helpers.cjs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail ? ' :: ' + JSON.stringify(detail) : '')); }
}

const TODAY = new Date().toISOString().slice(0, 10);

async function main() {
  console.log('[test-report-discount] 报表折扣分摊口径');
  const whs = (await api('GET', '/warehouse?teamId=1')).body;
  const prods = (await api('GET', '/product?teamId=1')).body;
  const cuss = (await api('GET', '/customer?teamId=1')).body;
  const wh = whs[0], cus = cuss[0];
  const pa = prods[0], pb = prods[1];
  if (!wh || !pa || !pb || !cus) throw new Error('演示档案不全，请先 rebuild-clean');

  const report = async () => (await api('GET', `/report/product?teamId=1&from=${TODAY}&to=${TODAY}`)).body;
  const saleOf = (rep, pid) => (rep.rows.find((r) => r.productId === pid) || { saleAmount: 0 }).saleAmount;

  // 基线快照
  const base = await report();
  const baseA = saleOf(base, pa.id), baseB = saleOf(base, pb.id);

  // 备货
  const si = await api('POST', '/doc/create', {
    teamId: 1, type: 'stockin', date: TODAY, warehouseId: wh.id,
    items: [
      { productId: pa.id, qty: 1, price: 5000 },
      { productId: pb.id, qty: 1, price: 10000 },
    ],
  });
  await api('POST', '/doc/audit', { teamId: 1, id: si.body.id, auditBy: 'discount-test' });

  // 销售出库：A 10000分 + B 20000分，整单折扣 6000分 → 总额 24000分
  const so = await api('POST', '/doc/create', {
    teamId: 1, type: 'stockout', date: TODAY, partnerType: 'cus', partnerId: cus.id,
    warehouseId: wh.id, discount: 6000,
    items: [
      { productId: pa.id, qty: 1, price: 10000 },
      { productId: pb.id, qty: 1, price: 20000 },
    ],
  });
  check('创建带整单折扣的销售出库', so.status === 200 && so.body.id, so.body);
  const docInfo = (await api('GET', `/doc/info?teamId=1&id=${so.body.id}`)).body;
  check('单据总额 = 30000 - 6000 = 24000', docInfo.doc.totalAmount === 24000, docInfo.doc.totalAmount);
  const aso = await api('POST', '/doc/audit', { teamId: 1, id: so.body.id, auditBy: 'discount-test' });
  check('审核成功', aso.status === 200, aso.body);

  // 增量断言：A 分摊 2000（1/3）、B 分摊 4000（2/3）
  const after = await report();
  const deltaA = saleOf(after, pa.id) - baseA;
  const deltaB = saleOf(after, pb.id) - baseB;
  check('A 商品销售额增量 = 10000 - 2000 = 8000', deltaA === 8000, { deltaA });
  check('B 商品销售额增量 = 20000 - 4000 = 16000', deltaB === 16000, { deltaB });
  check('A+B 增量合计 = 单据总额 24000（与按日/客户口径一致）', deltaA + deltaB === 24000, { deltaA, deltaB });

  // 清理：作废销售单与入库单
  await api('POST', '/doc/void', { teamId: 1, id: so.body.id });
  await api('POST', '/doc/void', { teamId: 1, id: si.body.id });

  console.log(`[test-report-discount] 通过 ${pass} / ${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('[test-report-discount] 异常:', e.message); process.exit(1); });
