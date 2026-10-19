/**
 * 回归测试：订单转单履约数量跟踪与超额拦截（阶段一 bug③ 修复）。
 * 场景：销售订单 10 件审核 → 第一次转单得全部 10 件草稿；把草稿改成 4 件并审核
 *   → 第二次转单只得剩余 6 件 → 第三次转单被拦截「已全部转单」。
 *   同时验证 /doc/info 返回的 fulfillment 进度。
 */
const { api } = require('./test-helpers.cjs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail ? ' :: ' + JSON.stringify(detail) : '')); }
}

const TODAY = new Date().toISOString().slice(0, 10);

async function main() {
  console.log('[test-convert-fulfill] 订单转单履约跟踪');
  const whs = (await api('GET', '/warehouse?teamId=1')).body;
  const prods = (await api('GET', '/product?teamId=1')).body;
  const cuss = (await api('GET', '/customer?teamId=1')).body;
  const wh = whs[0], prod = prods[prods.length - 2] || prods[0], cus = cuss[0];
  if (!wh || !prod || !cus) throw new Error('演示档案不全，请先 rebuild-clean');

  // 建销售订单 10 件并审核
  const od = await api('POST', '/doc/create', {
    teamId: 1, type: 'sorder', date: TODAY, partnerType: 'cus', partnerId: cus.id,
    warehouseId: wh.id, items: [{ productId: prod.id, qty: 10, price: 3000 }],
  });
  check('创建销售订单 10 件', od.status === 200 && od.body.id, od.body);
  const ao = await api('POST', '/doc/audit', { teamId: 1, id: od.body.id, auditBy: 'convert-test' });
  check('订单审核成功', ao.status === 200, ao.body);

  // 第一次转单：得 10 件出库草稿
  const cv1 = await api('POST', '/doc/convert', { teamId: 1, id: od.body.id });
  check('第一次转单成功', cv1.status === 200 && cv1.body.id, cv1.body);
  const cv1Info = (await api('GET', `/doc/info?teamId=1&id=${cv1.body.id}`)).body;
  check('转单草稿数量为 10', cv1Info.items.length === 1 && cv1Info.items[0].qty === 10, cv1Info.items);

  // 把草稿改成 4 件并审核（部分履约）
  const ed = await api('PUT', '/doc/edit', {
    teamId: 1, id: cv1.body.id, type: 'stockout', date: TODAY, partnerType: 'cus', partnerId: cus.id,
    warehouseId: wh.id, items: [{ productId: prod.id, qty: 4, price: 3000 }],
  });
  check('转单草稿改为 4 件', ed.status === 200, ed.body);
  // 先确保有库存再审核（入库 10 件）
  const si = await api('POST', '/doc/create', {
    teamId: 1, type: 'stockin', date: TODAY, warehouseId: wh.id,
    items: [{ productId: prod.id, qty: 10, price: 1000 }],
  });
  await api('POST', '/doc/audit', { teamId: 1, id: si.body.id, auditBy: 'convert-test' });
  const ac1 = await api('POST', '/doc/audit', { teamId: 1, id: cv1.body.id, auditBy: 'convert-test' });
  check('第一张转单审核成功（履约 4 件）', ac1.status === 200, ac1.body);

  // fulfillment 进度：已转 4、剩余 6
  const odInfo = (await api('GET', `/doc/info?teamId=1&id=${od.body.id}`)).body;
  const f = odInfo.fulfillment && odInfo.fulfillment[0];
  check('订单履约进度：ordered=10 converted=4 remain=6',
    !!f && f.ordered === 10 && f.converted === 4 && f.remain === 6, odInfo.fulfillment);

  // 第二次转单：只得剩余 6 件
  const cv2 = await api('POST', '/doc/convert', { teamId: 1, id: od.body.id });
  check('第二次转单成功（部分）', cv2.status === 200 && cv2.body.id, cv2.body);
  const cv2Info = (await api('GET', `/doc/info?teamId=1&id=${cv2.body.id}`)).body;
  check('第二次转单数量为剩余 6 件', cv2Info.items.length === 1 && cv2Info.items[0].qty === 6, cv2Info.items);

  // 第二张转单审核（履约完）
  const ac2 = await api('POST', '/doc/audit', { teamId: 1, id: cv2.body.id, auditBy: 'convert-test' });
  check('第二张转单审核成功', ac2.status === 200, ac2.body);

  // 第三次转单：必须被拦截
  const cv3 = await api('POST', '/doc/convert', { teamId: 1, id: od.body.id });
  check('全部履约后再次转单被拦截', cv3.status === 400 && /已全部转单/.test(cv3.body.error || ''), cv3.body);

  // 清理：作废转单与入库（订单审核不写库存，无需作废）
  await api('POST', '/doc/void', { teamId: 1, id: cv2.body.id });
  await api('POST', '/doc/void', { teamId: 1, id: cv1.body.id });
  await api('POST', '/doc/void', { teamId: 1, id: si.body.id });

  console.log(`[test-convert-fulfill] 通过 ${pass} / ${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('[test-convert-fulfill] 异常:', e.message); process.exit(1); });
