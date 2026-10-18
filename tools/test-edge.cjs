/* 边界用例回归：跑前先建新团队，逐步断言 */
const BASE = 'http://127.0.0.1:7741/api';
const results = [];
function report(name, pass, detail) { results.push({ name, pass, detail }); console.log((pass ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); }
const post = async (p, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({ error: 'non-json' })) }; };
const put = async (p, body) => { const r = await fetch(BASE + p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({ error: 'non-json' })) }; };
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.json().catch(() => ({ error: 'non-json' })) }; };
const del = async (p) => { const r = await fetch(BASE + p, { method: 'DELETE' }); return { status: r.status, body: await r.json().catch(() => ({ error: 'non-json' })) }; };

(async () => {
  // 新团队
  const boot = await post('/bootstrap', { name: '边界测试套' });
  const T = boot.body.teamId;
  const cat = (await post('/cat', { teamId: T, name: '测试分类' })).body;
  const prod = (await post('/product', { teamId: T, catId: cat.id, name: '边界商品', unit: '个', salePrice: 1000, purchasePrice: 500 })).body;
  const whs = (await get('/warehouse?teamId=' + T)).body;
  const wh1 = whs[0].id;
  const wh2 = (await post('/warehouse', { teamId: T, name: '第二仓库' })).body.id;
  const ven = (await post('/vendor', { teamId: T, name: '供应商' })).body;
  const cus = (await post('/customer', { teamId: T, name: '客户' })).body;

  // 1. 入库 qty=0 → 400
  let r = await post('/doc/create', { teamId: T, type: 'stockin', warehouseId: wh1, items: [{ productId: prod.id, qty: 0, price: 500 }] });
  report('入库 qty=0 拒绝', r.status === 400, JSON.stringify(r.body));

  // 2. 入库负数 → 400
  r = await post('/doc/create', { teamId: T, type: 'stockin', warehouseId: wh1, items: [{ productId: prod.id, qty: -5, price: 500 }] });
  report('入库 qty<0 拒绝', r.status === 400, JSON.stringify(r.body));

  // 3. 入库缺 items → 400
  r = await post('/doc/create', { teamId: T, type: 'stockin', warehouseId: wh1, items: [] });
  report('入库空 items 拒绝', r.status === 400, JSON.stringify(r.body));

  // 4. 缺仓库 → 400
  r = await post('/doc/create', { teamId: T, type: 'stockin', items: [{ productId: prod.id, qty: 1, price: 100 }] });
  report('缺仓库拒绝', r.status === 400, JSON.stringify(r.body));

  // 5. 不存在的商品 → 创建成功但审核应报错？
  r = await post('/doc/create', { teamId: T, type: 'stockin', warehouseId: wh1, items: [{ productId: 999999, qty: 1, price: 100 }] });
  let createOk = r.status === 200;
  if (createOk) {
    const au = await post('/doc/audit', { teamId: T, id: r.body.id });
    report('幽灵商品审核报错', au.status !== 200 || au.body.error, JSON.stringify(au.body));
    await post('/doc/void', { teamId: T, id: r.body.id }).catch(() => {});
  } else {
    report('幽灵商品创建拒绝', true, JSON.stringify(r.body));
  }

  // 正常入库 10
  const rk = await post('/doc/create', { teamId: T, type: 'stockin', warehouseId: wh1, items: [{ productId: prod.id, qty: 10, price: 500 }], partnerType: 'ven', partnerId: ven.id });
  await post('/doc/audit', { teamId: T, id: rk.body.id });

  // 6. 重复审核 → 400
  r = await post('/doc/audit', { teamId: T, id: rk.body.id });
  report('重复审核拒绝', r.status === 400 || r.body.error, JSON.stringify(r.body));

  // 7. 编辑已审核单 → 400
  r = await put('/doc/edit', { teamId: T, id: rk.body.id, type: 'stockin', warehouseId: wh1, items: [{ productId: prod.id, qty: 99, price: 500 }] });
  report('编辑已审核拒绝', r.status === 400 || r.body.error, JSON.stringify(r.body));

  // 8. 删除已审核单 → 400
  r = await del(`/doc/${rk.body.id}?teamId=${T}`);
  report('删除已审核拒绝', r.status === 400 || r.body.error, JSON.stringify(r.body));

  // 9. 作废草稿 → 400
  const dr = await post('/doc/create', { teamId: T, type: 'stockin', warehouseId: wh1, items: [{ productId: prod.id, qty: 1, price: 100 }] });
  r = await post('/doc/void', { teamId: T, id: dr.body.id });
  report('作废草稿拒绝', r.status === 400 || r.body.error, JSON.stringify(r.body));

  // 10. 出库超库存（只有 10，出 100）→ 审核时应报库存不足
  const ck = await post('/doc/create', { teamId: T, type: 'stockout', warehouseId: wh1, items: [{ productId: prod.id, qty: 100, price: 1000 }] });
  r = await post('/doc/audit', { teamId: T, id: ck.body.id });
  report('出库超库存审核拒绝', (r.status !== 200 || r.body.error), JSON.stringify(r.body));

  // 11. 出库后库存不能为负（若 10 通过了说明没校验）
  let stock = (await get(`/stock/list?teamId=${T}`)).body;
  const row = stock.rows ? stock.rows.find(s => s.productId === prod.id && s.warehouseId === wh1) : stock.find(s => s.productId === prod.id && s.warehouseId === wh1);
  report('库存不为负', row && row.qty >= 0, 'qty=' + (row && row.qty));

  // 12. 调拨同仓库 → 拒绝或库存不变
  const tr = await post('/doc/create', { teamId: T, type: 'transfer', warehouseId: wh1, items: [{ productId: prod.id, qty: 2, price: 0, toWarehouseId: wh1 }] });
  if (tr.status === 200) {
    const au = await post('/doc/audit', { teamId: T, id: tr.body.id });
    stock = (await get(`/stock/list?teamId=${T}`)).body;
    const rows = stock.rows || stock;
    const wh1qty = rows.filter(s => s.warehouseId === wh1).reduce((s, x) => s + x.qty, 0);
    report('调拨同仓库校验', au.body.error || wh1qty === 10, 'wh1qty=' + wh1qty + ' audit=' + JSON.stringify(au.body));
  } else {
    report('调拨同仓库拒绝', true, JSON.stringify(tr.body));
  }

  // 13. 正常调拨 3 到 wh2
  const tr2 = await post('/doc/create', { teamId: T, type: 'transfer', warehouseId: wh1, items: [{ productId: prod.id, qty: 3, price: 0, toWarehouseId: wh2 }] });
  await post('/doc/audit', { teamId: T, id: tr2.body.id });
  stock = (await get(`/stock/list?teamId=${T}`)).body;
  const rows2 = stock.rows || stock;
  const q = (wh) => rows2.filter(s => s.warehouseId === wh).reduce((s, x) => s + x.qty, 0);
  report('正常调拨', q(wh1) === 7 && q(wh2) === 3, `wh1=${q(wh1)} wh2=${q(wh2)}`);

  // 14. settlement 金额 0 → 400
  r = await post('/settlement/create', { teamId: T, type: 'receipt', partnerType: 'cus', partnerId: cus.id, amount: 0 });
  report('收款金额0拒绝', r.status === 400 || r.body.error, JSON.stringify(r.body));

  // 15. settlement 负数 → 400
  r = await post('/settlement/create', { teamId: T, type: 'receipt', partnerType: 'cus', partnerId: cus.id, amount: -100 });
  report('收款负数拒绝', r.status === 400 || r.body.error, JSON.stringify(r.body));

  // 16. settlement 不存在的 partner → 报错还是记账（宽松可接受）
  r = await post('/settlement/create', { teamId: T, type: 'receipt', partnerType: 'cus', partnerId: 999999, amount: 100 });
  report('幽灵客户收款行为', true, JSON.stringify(r.body));

  // 18. billNo 唯一性（连续两次创建作废后再创建，序号不重复）
  const d1 = await post('/doc/create', { teamId: T, type: 'stockin', warehouseId: wh1, items: [{ productId: prod.id, qty: 1, price: 100 }] });
  await del(`/doc/${d1.body.id}?teamId=${T}`);
  const d2 = await post('/doc/create', { teamId: T, type: 'stockin', warehouseId: wh1, items: [{ productId: prod.id, qty: 1, price: 100 }] });
  report('billNo 不重复', d1.body.billNo !== d2.body.billNo, `${d1.body.billNo} vs ${d2.body.billNo}`);
  await del(`/doc/${d2.body.id}?teamId=${T}`).catch(() => {});
  // 19. 调整单正数盘盈（此时 wh1 库存 7）
  const adj = await post('/doc/create', { teamId: T, type: 'adjust', warehouseId: wh1, items: [{ productId: prod.id, qty: 2, price: 0 }] });
  r = await post('/doc/audit', { teamId: T, id: adj.body.id });
  stock = (await get(`/stock/list?teamId=${T}`)).body;
  const rows3 = stock.rows || stock;
  report('盘盈+2', rows3.filter(s => s.warehouseId === wh1).reduce((s, x) => s + x.qty, 0) === 9, JSON.stringify(r.body));

  // 20. 批次扣减：入库两批（A 先 B 后），出库不带批次 → FIFO 先扣最早入库的 NULL 行再扣 A
  const rkA = await post('/doc/create', { teamId: T, type: 'stockin', warehouseId: wh1, items: [{ productId: prod.id, qty: 5, price: 100, batchNo: 'A' }] });
  await post('/doc/audit', { teamId: T, id: rkA.body.id });
  // sleep 1s 保证 created_at 排序
  await new Promise(rr => setTimeout(rr, 1100));
  const rkB = await post('/doc/create', { teamId: T, type: 'stockin', warehouseId: wh1, items: [{ productId: prod.id, qty: 5, price: 200, batchNo: 'B' }] });
  await post('/doc/audit', { teamId: T, id: rkB.body.id });
  // 此时库存：NULL 行 9（7 调拨后+2 盘盈）+ A 5 + B 5 = 19；出库 12 → NULL 9 扣完 + A 扣 3 → A 剩 2
  const ck2 = await post('/doc/create', { teamId: T, type: 'stockout', warehouseId: wh1, items: [{ productId: prod.id, qty: 12, price: 1000 }] });
  r = await post('/doc/audit', { teamId: T, id: ck2.body.id });
  stock = (await get(`/stock/list?teamId=${T}`)).body;
  const rows4 = stock.rows || stock;
  const batchA = rows4.find(s => s.batchNo === 'A' && s.warehouseId === wh1);
  const nullRow = rows4.find(s => !s.batchNo && s.warehouseId === wh1);
  const passFifo = !r.body.error && batchA && batchA.qty === 2 && (!nullRow || nullRow.qty === 0);
  report('FIFO 批次扣减（先 NULL 后 A，A 5→2）', passFifo, 'batchA=' + JSON.stringify(batchA) + ' null=' + JSON.stringify(nullRow) + ' audit=' + JSON.stringify(r.body));

  // 17. 档案删除被引用商品（放最后：商品已被单据引用 + 有库存）→ 应被拒绝
  r = await del(`/product/${prod.id}?teamId=${T}`);
  const passDelRef = !!r.body.error;
  report('删除被引用商品被拒绝', passDelRef, JSON.stringify(r.body));

  // 汇总
  const fails = results.filter(x => !x.pass);
  console.log(`\n===== ${results.length - fails.length}/${results.length} PASS =====`);
  if (fails.length) { console.log('FAILED:'); fails.forEach(f => console.log(' -', f.name, f.detail || '')); }
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('SUITE ERROR', e); process.exit(2); });