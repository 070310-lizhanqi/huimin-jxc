/** 报表/单据复制/商品导入 三个新功能的端到端测试 */
const BASE = 'http://127.0.0.1:7741/api';
let pass = 0, fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`PASS ${label}`); }
  else { fail++; console.log(`FAIL ${label} ${extra}`); }
}
async function j(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body: data };
}

(async () => {
  // 准备独立团队
  const bs = await j('POST', '/bootstrap', { name: '报表测试套' });
  const teamId = bs.body.teamId;
  ok(bs.status === 200 && teamId > 0, 'bootstrap 建团队');

  // 档案：商品2个 + 客户
  const p1 = await j('POST', '/product', { teamId, name: '报表商品A', unit: '个', purchasePrice: 300, salePrice: 500, lowQty: 0 });
  const p2 = await j('POST', '/product', { teamId, name: '报表商品B', unit: '箱', purchasePrice: 100, salePrice: 200 });
  const cus = await j('POST', '/customer', { teamId, name: '报表客户甲' });
  const p1Id = p1.body.id, p2Id = p2.body.id, cusId = cus.body.id;

  // 两笔采购入库：10×300 + 5×400 → 加权平均成本 (3000+2000)/15 = 333.33
  const d1 = await j('POST', '/doc/create', { teamId, type: 'stockin', partnerType: 'ven', partnerId: null, warehouseId: 1, date: '2026-10-20', items: [{ productId: p1Id, qty: 10, price: 300 }] });
  await j('POST', '/doc/audit', { teamId, id: d1.body.id });
  const d2 = await j('POST', '/doc/create', { teamId, type: 'stockin', warehouseId: 1, date: '2026-10-21', items: [{ productId: p1Id, qty: 5, price: 400 }] });
  await j('POST', '/doc/audit', { teamId, id: d2.body.id });

  // 销售出库 8×500=4000（客户甲）+ 销售退货 3×500=1500
  const so = await j('POST', '/doc/create', { teamId, type: 'stockout', partnerType: 'cus', partnerId: cusId, warehouseId: 1, date: '2026-10-22', items: [{ productId: p1Id, qty: 8, price: 500 }] });
  await j('POST', '/doc/audit', { teamId, id: so.body.id });
  const sr = await j('POST', '/doc/create', { teamId, type: 'sret', partnerType: 'cus', partnerId: cusId, warehouseId: 1, date: '2026-10-23', items: [{ productId: p1Id, qty: 3, price: 500 }] });
  await j('POST', '/doc/audit', { teamId, id: sr.body.id });

  // ---- /report/sales ----
  let r = await j('GET', `/report/sales?teamId=${teamId}&from=2026-10-01&to=2026-10-31`);
  ok(r.status === 200, 'report/sales 200');
  const t = r.body.totals;
  ok(t.saleAmount === 4000 && t.retAmount === 1500, `sales totals 金额 sale=${t.saleAmount} ret=${t.retAmount}`, JSON.stringify(t));
  ok(t.saleQty === 8 && t.retQty === 3, `sales totals 数量 sale=${t.saleQty} ret=${t.retQty}`);
  ok(t.orderCount === 1, `orderCount=${t.orderCount}`);
  ok(r.body.days.length === 2, `days 行数=${r.body.days.length}（10-22 与 10-23）`);
  ok(r.body.from === '2026-10-01' && r.body.to === '2026-10-31', '返回请求范围');

  // 默认范围（本月）应能取到
  r = await j('GET', `/report/sales?teamId=${teamId}`);
  ok(r.status === 200, 'report/sales 默认范围 200');

  // 范围外 → 空
  r = await j('GET', `/report/sales?teamId=${teamId}&from=2099-01-01&to=2099-12-31`);
  ok(r.body.days.length === 0 && r.body.totals.saleAmount === 0, '范围外为空');

  // 缺 teamId → 400
  r = await j('GET', '/report/sales');
  ok(r.status === 400, 'report/sales 缺 teamId 400');

  // ---- /report/product ----
  r = await j('GET', `/report/product?teamId=${teamId}&from=2026-10-01&to=2026-10-31`);
  const row = r.body.rows.find((x) => x.productId === p1Id);
  ok(!!row, 'product 报表含商品A');
  if (row) {
    ok(row.saleQty === 8 && row.retQty === 3, `product saleQty=${row.saleQty} retQty=${row.retQty}`);
    ok(row.netAmount === 2500, `netAmount=${row.netAmount}`);
    ok(row.avgCost === 333, `avgCost=${row.avgCost}（期望 333.33 取整）`);
    ok(row.estCost === 1667, `estCost=${row.estCost}（5×333.33=1666.67 取整）`);
    ok(row.estProfit === 833, `estProfit=${row.estProfit}（2500-1667）`);
  }
  ok(!r.body.rows.find((x) => x.productId === p2Id), '未销售商品不在报表');

  // 作废一笔入库后成本应回退：再入库 5×600 → 平均 (5000+3000)/20=400；作废 → 回到 333.33
  const d3 = await j('POST', '/doc/create', { teamId, type: 'stockin', warehouseId: 1, items: [{ productId: p1Id, qty: 5, price: 600 }] });
  await j('POST', '/doc/audit', { teamId, id: d3.body.id });
  r = await j('GET', `/report/product?teamId=${teamId}&from=2026-10-01&to=2026-10-31`);
  ok(r.body.rows.find((x) => x.productId === p1Id).avgCost === 400, '作废前 avgCost=400');
  await j('POST', '/doc/void', { teamId, id: d3.body.id });
  r = await j('GET', `/report/product?teamId=${teamId}&from=2026-10-01&to=2026-10-31`);
  ok(r.body.rows.find((x) => x.productId === p1Id).avgCost === 333, '作废后 avgCost 回退 333');
  // 库存回退：10+5-8+3=10
  const st = await j('GET', `/stock/list?teamId=${teamId}`);
  ok(st.body.find((x) => x.productId === p1Id).qty === 10, `作废后库存=10（实际 ${st.body.find((x) => x.productId === p1Id)?.qty}）`);

  // ---- /report/customer ----
  r = await j('GET', `/report/customer?teamId=${teamId}&from=2026-10-01&to=2026-10-31`);
  const crow = r.body.rows.find((x) => x.cusId === cusId);
  ok(!!crow && crow.cusName === '报表客户甲', 'customer 报表含客户甲');
  if (crow) {
    ok(crow.saleAmount === 4000 && crow.retAmount === 1500, `customer sale=${crow.saleAmount} ret=${crow.retAmount}`);
    ok(crow.orderCount === 1, `customer orderCount=${crow.orderCount}`);
  }

  // ---- /doc/copy ----
  r = await j('POST', '/doc/copy', { teamId, id: so.body.id });
  ok(r.status === 200 && r.body.billNo && r.body.billNo.startsWith('CK'), `copy 生成 ${r.body.billNo}`);
  const copyId = r.body?.id;
  const info = await j('GET', `/doc/info?teamId=${teamId}&id=${copyId}`);
  ok(info.body.doc.status === 'draft', '副本是草稿');
  ok(info.body.doc.type === 'stockout', '副本同类型');
  ok(info.body.doc.partnerId === cusId, '副本保留客户');
  ok(String(info.body.doc.remark).includes('复制'), `副本备注含「复制」（${info.body.doc.remark}）`);
  ok(info.body.doc.refOrderId === null, '副本不带原单引用');
  const cit = info.body.items[0];
  ok(cit.productId === p1Id && cit.qty === 8 && cit.price === 500, '副本明细数量单价一致');
  ok(cit.batchNo === null && cit.reservoirId === null, '副本明细不带批次/库位');
  ok(info.body.doc.billNo !== so.body.billNo, '新单号');

  // 复制草稿、作废单也可以
  const draftCopy = await j('POST', '/doc/copy', { teamId, id: d1.body.id });
  ok(draftCopy.status === 200, '复制已审核入库单 OK');
  const voidedCopy = await j('POST', '/doc/copy', { teamId, id: sr.body.id });
  ok(voidedCopy.status === 200, '复制退货单 OK');
  // 复制不存在的单 → 404
  r = await j('POST', '/doc/copy', { teamId, id: 99999999 });
  ok(r.status === 404, 'copy 不存在单 404');
  // 跨团队 → 404
  r = await j('POST', '/doc/copy', { teamId: 1, id: so.body.id });
  ok(r.status === 404, 'copy 跨团队 404');

  // ---- /product/import ----
  r = await j('POST', '/product/import', { teamId, rows: [
    { name: '导入商品C', unit: '瓶', catName: '饮料', barcode: '690001', spec: '500ml', purchasePrice: '1.50', salePrice: '3', retailPrice: '3.5', lowQty: '10', remark: '进口' },
    { name: '报表商品A' },               // 重名 → 错误
    { name: '导入商品D', salePrice: 'abc' }, // 价格非法 → 错误
    { unit: '个' },                       // 缺名称 → 错误
    { name: '导入商品E', catName: '饮料', purchasePrice: '¥2,5', salePrice: '4' }, // 带 ¥ 逗号 → 250 分
  ] });
  ok(r.status === 200, 'import 200');
  ok(r.body.total === 5 && r.body.success === 2, `success=${r.body.success}（期望 2）`, JSON.stringify(r.body));
  ok(r.body.errors.length === 3, `errors=3（实际 ${r.body.errors.length}）`);
  ok(r.body.errors.some((e) => e.row === 2 && e.msg.includes('已存在')), '行2 重名报错');
  ok(r.body.errors.some((e) => e.row === 3 && e.msg.includes('价格')), '行3 价格报错');
  ok(r.body.errors.some((e) => e.row === 4 && e.msg.includes('名称')), '行4 名称报错');

  // 验证导入结果
  const plist = await j('GET', `/product?teamId=${teamId}`);
  const pc = plist.body.find((x) => x.name === '导入商品C');
  const pe = plist.body.find((x) => x.name === '导入商品E');
  ok(!!pc, '导入商品C 已入库');
  if (pc) {
    ok(pc.purchasePrice === 150 && pc.salePrice === 300 && pc.retailPrice === 350, `C 三价格 ${pc.purchasePrice}/${pc.salePrice}/${pc.retailPrice}`);
    ok(pc.lowQty === 10 && pc.unit === '瓶' && pc.barcode === '690001', 'C 属性正确');
    ok(pc.catId > 0, 'C 关联新分类');
  }
  ok(!!pe && pe.purchasePrice === 2500 && pe.salePrice === 400, `E 价格解析 ¥2,5 → 2500/400（实际 ${pe?.purchasePrice}/${pe?.salePrice}）`);
  const cats = await j('GET', `/cat?teamId=${teamId}`);
  ok(cats.body.some((c) => c.name === '饮料'), '分类「饮料」自动创建');
  // C 和 E 应同分类
  if (pc && pe) ok(pc.catId === pe.catId, 'C/E 同分类复用');

  // 空行数组 → 400
  r = await j('POST', '/product/import', { teamId, rows: [] });
  ok(r.status === 400, 'import 空 rows 400');
  // 超过 1000 行 → 400
  const big = Array.from({ length: 1001 }, () => ({ name: 'x' }));
  r = await j('POST', '/product/import', { teamId, rows: big });
  ok(r.status === 400, 'import 超 1000 行 400');

  console.log(`\n== ${pass} PASS / ${fail} FAIL ==`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
