/* 订单转化链 + 新单据类型端到端 */
const BASE = 'http://127.0.0.1:7741/api';
const results = [];
function report(name, pass, detail) { results.push({ name, pass }); console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); }
const post = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({ error: 'non-json' })) }; };
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.json().catch(() => ({ error: 'non-json' })) }; };

(async () => {
  const boot = await post('/bootstrap', { name: '订单链测试' });
  const T = boot.body.teamId;
  const cat = (await post('/cat', { teamId: T, name: '分类' })).body;
  const prod = (await post('/product', { teamId: T, catId: cat.id, name: '商品X', unit: '个', salePrice: 2000, purchasePrice: 1000 })).body;
  const whs = (await get('/warehouse?teamId=' + T)).body;
  const wh1 = whs[0].id;
  const ven = (await post('/vendor', { teamId: T, name: '供应商X' })).body;
  const cus = (await post('/customer', { teamId: T, name: '客户X' })).body;

  // 1. 创建采购订单（订单不需要仓库）
  let r = await post('/doc/create', { teamId: T, type: 'porder', items: [{ productId: prod.id, qty: 20, price: 1000 }], partnerType: 'ven', partnerId: ven.id });
  report('采购订单创建（无仓库）', r.status === 200 && r.body.billNo?.startsWith('CG'), JSON.stringify(r.body));
  const poId = r.body.id;

  // 2. 未审核订单不能转化
  r = await post('/doc/convert', { teamId: T, id: poId });
  report('未审核订单转化拒绝', r.status === 400, JSON.stringify(r.body));

  // 3. 审核订单（不写库存）
  r = await post('/doc/audit', { teamId: T, id: poId });
  let stock = (await get(`/stock/list?teamId=${T}`)).body;
  report('订单审核不动库存', r.status === 200 && stock.length === 0, 'stock rows=' + stock.length);

  // 4. 转化为采购入库草稿
  r = await post('/doc/convert', { teamId: T, id: poId });
  report('订单转化入库单', r.status === 200 && r.body.type === 'stockin' && r.body.billNo?.startsWith('RK'), JSON.stringify(r.body));
  const inId = r.body.id;

  // 5. 入库单带原单引用
  const info = await get(`/doc/info?teamId=${T}&id=${inId}`);
  report('转化单携带 refOrderId', info.body.doc.refOrderId === poId, 'refOrderId=' + info.body.doc.refOrderId);

  // 6. 转化单缺仓库 → 补仓库后审核（转化单 warehouseId 继承订单，订单没仓库则为 null）
  // 直接 edit 补仓库
  r = await fetch(BASE + '/doc/edit', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teamId: T, id: inId, type: 'stockin', warehouseId: wh1, items: info.body.items.map(i => ({ productId: i.productId, qty: i.qty, price: i.price })) }) });
  report('补仓库编辑', r.status === 200, JSON.stringify(await r.json().catch(() => ({}))));
  r = await post('/doc/audit', { teamId: T, id: inId });
  report('入库单审核', r.status === 200, JSON.stringify(r.body));
  stock = (await get(`/stock/list?teamId=${T}`)).body;
  report('库存 20', stock.length === 1 && stock[0].qty === 20, JSON.stringify(stock.map(s => s.qty)));

  // 7. 销售订单 → 转销售出库
  r = await post('/doc/create', { teamId: T, type: 'sorder', items: [{ productId: prod.id, qty: 5, price: 2000 }], partnerType: 'cus', partnerId: cus.id });
  const soId = r.body.id;
  await post('/doc/audit', { teamId: T, id: soId });
  r = await post('/doc/convert', { teamId: T, id: soId });
  report('销售订单转化出库单', r.status === 200 && r.body.type === 'stockout', JSON.stringify(r.body));
  const outId = r.body.id;
  const info2 = await get(`/doc/info?teamId=${T}&id=${outId}`);
  await fetch(BASE + '/doc/edit', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teamId: T, id: outId, type: 'stockout', warehouseId: wh1, items: info2.body.items.map(i => ({ productId: i.productId, qty: i.qty, price: i.price })) }) });
  r = await post('/doc/audit', { teamId: T, id: outId });
  report('出库单审核', r.status === 200, JSON.stringify(r.body));
  stock = (await get(`/stock/list?teamId=${T}`)).body;
  report('库存 15', stock[0].qty === 15, 'qty=' + stock[0].qty);

  // 8. 采购退货 pin（退给供应商，出库）
  r = await post('/doc/create', { teamId: T, type: 'pin', warehouseId: wh1, items: [{ productId: prod.id, qty: 3, price: 1000 }], partnerType: 'ven', partnerId: ven.id });
  report('采购退货创建', r.status === 200 && r.body.billNo?.startsWith('CT'), JSON.stringify(r.body));
  await post('/doc/audit', { teamId: T, id: r.body.id });
  stock = (await get(`/stock/list?teamId=${T}`)).body;
  report('退货后库存 12', stock[0].qty === 12, 'qty=' + stock[0].qty);

  // 9. 销售退货 sret（客户退回，入库）
  r = await post('/doc/create', { teamId: T, type: 'sret', warehouseId: wh1, items: [{ productId: prod.id, qty: 2, price: 2000 }], partnerType: 'cus', partnerId: cus.id });
  report('销售退货创建', r.status === 200 && r.body.billNo?.startsWith('XT'), JSON.stringify(r.body));
  await post('/doc/audit', { teamId: T, id: r.body.id });
  stock = (await get(`/stock/list?teamId=${T}`)).body;
  report('退货入库后 14', stock[0].qty === 14, 'qty=' + stock[0].qty);

  // 10. dashboard 统计
  r = await get(`/stats/dashboard?teamId=${T}`);
  const d = r.body;
  report('dashboard 字段齐全', d.totalQty === 14 && d.skuCount === 1 && typeof d.stockValue === 'number' && typeof d.todayIn === 'number' && typeof d.todayOut === 'number', JSON.stringify(d));

  // 11. trend
  r = await get(`/stats/trend?teamId=${T}`);
  report('trend 返回数组', Array.isArray(r.body) && r.body.length >= 1, JSON.stringify(r.body));

  // 12. 非订单类型转化拒绝
  r = await post('/doc/convert', { teamId: T, id: inId });
  report('非订单转化拒绝', r.status === 400, JSON.stringify(r.body));

  const fails = results.filter(x => !x.pass);
  console.log(`\n===== ${results.length - fails.length}/${results.length} PASS =====`);
  fails.forEach(f => console.log(' - FAIL', f.name));
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('SUITE ERROR', e); process.exit(2); });