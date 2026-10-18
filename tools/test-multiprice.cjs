// 多价格 + 客户价格等级实测
const BASE = 'http://127.0.0.1:7741/api';
const TEAM = 67;

async function api(path, method, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  try { return { status: r.status, j: JSON.parse(t) }; } catch { return { status: r.status, t }; }
}
const get = (p) => api(p, 'GET');
const post = (p, b) => api(p, 'POST', b);
const put = (p, b) => api(p, 'PUT', b);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS | ' + name + (extra ? ' | ' + extra : '')); }
  else { fail++; console.log('FAIL | ' + name + ' | ' + JSON.stringify(extra)); }
}

(async () => {
  const uniq = Date.now().toString().slice(-6);

  // 0) 清理历史脏数据
  const cs = await get(`/customer?teamId=${TEAM}`);
  for (const c of cs.j) {
    if (/\?/.test(c.name)) {
      await fetch(`${BASE}/customer/${c.id}?teamId=${TEAM}`, { method: 'DELETE' });
    }
  }

  // 1) 建批发价格等级客户
  const cus1 = await post('/customer', { teamId: TEAM, name: '批发客户' + uniq, mobile: '1390000' + uniq, priceLevel: 'wholePrice' });
  check('客户价格等级落库', cus1.j.priceLevel === 'wholePrice', cus1.j);
  const cus2 = await post('/customer', { teamId: TEAM, name: '标准客户' + uniq, mobile: '1380000' + uniq, priceLevel: 'salePrice' });
  check('默认标准售价', cus2.j.priceLevel === 'salePrice', cus2.j);
  const cus3 = await post('/customer', { teamId: TEAM, name: '零售客户' + uniq, mobile: '1370000' + uniq, priceLevel: 'retailPrice' });
  check('零售价等级', cus3.j.priceLevel === 'retailPrice', cus3.j);

  // 2) 建商品，三档价
  const cat = (await get(`/cat?teamId=${TEAM}`)).j[0];
  const prod = await post('/product', {
    teamId: TEAM, name: '多价商品' + uniq, catId: cat?.id ?? null, unit: '个',
    purchasePrice: 5000, salePrice: 8000, wholePrice: 6000, retailPrice: 10000, lowQty: 0, archived: 0,
  });
  check('批发价落库', prod.j.wholePrice === 6000, prod.j.wholePrice);
  check('零售价落库', prod.j.retailPrice === 10000, prod.j.retailPrice);
  check('标准售价落库', prod.j.salePrice === 8000, prod.j.salePrice);

  // 3) 期初入库备货
  const wh = (await get(`/warehouse?teamId=${TEAM}`)).j[0];
  const wh2 = (await get(`/warehouse?teamId=${TEAM}`)).j[1] || wh;
  const init = await post('/doc/create', {
    teamId: TEAM, type: 'stockinit', warehouseId: wh.id, date: '2026-10-17', remark: '多价测试备货' + uniq,
    items: [{ productId: prod.j.id, qty: 100, price: 5000 }],
  });
  await post('/doc/audit', { teamId: TEAM, id: init.j.id });
  const sl = await get(`/stock/list?teamId=${TEAM}&productId=${prod.j.id}`);
  check('期初入库 100', sl.j.some(s => s.qty === 100), sl.j);

  // 4) 三档价格各出一单，验证按客户等级取价（模拟前端 onPick 逻辑）
  async function pickPrice(cusId, level) {
    const p = (await get(`/product?teamId=${TEAM}`)).j.find(x => x.id === prod.j.id);
    const c = (await get(`/customer?teamId=${TEAM}`)).j.find(x => x.id === cusId);
    const f = c && c.priceLevel && c.priceLevel in p ? c.priceLevel : 'salePrice';
    return { field: f, price: p[f] || 0 };
  }
  const q1 = await pickPrice(cus1.j.id);
  check('批发客户 → 批发价 6000', q1.field === 'wholePrice' && q1.price === 6000, q1);
  const q2 = await pickPrice(cus2.j.id);
  check('标准客户 → 标准售价 8000', q2.field === 'salePrice' && q2.price === 8000, q2);
  const q3 = await pickPrice(cus3.j.id);
  check('零售客户 → 零售价 10000', q3.field === 'retailPrice' && q3.price === 10000, q3);

  // 5) 批发客户真实开单，价格 6000，审核后核对金额
  const sd1 = await post('/doc/create', {
    teamId: TEAM, type: 'stockout', partnerType: 'cus', partnerId: cus1.j.id,
    warehouseId: wh.id, date: '2026-10-17', remark: '批发单' + uniq,
    items: [{ productId: prod.j.id, qty: 10, price: q1.price }],
  });
  check('批发单创建', sd1.status === 200 && !!sd1.j.id, sd1.j.billNo);
  // create 只返回 {id,billNo}，金额要从 doc/info 或列表取
  const sdInfo = await get(`/doc/info?teamId=${TEAM}&id=${sd1.j.id}`);
  check('批发单金额 600 元', sdInfo.j.doc.totalAmount === 60000, {
    totalAmount: sdInfo.j.doc.totalAmount,
    items: sdInfo.j.items.map(i => ({ qty: i.qty, price: i.price, amount: i.amount })),
  });
  await post('/doc/audit', { teamId: TEAM, id: sd1.j.id });

  // 6) 价格记忆应记录 6000（批发价而非标准价）
  const mem = await get(`/price/memory?teamId=${TEAM}&partnerId=${cus1.j.id}`);
  const memRow = Array.isArray(mem.j) ? mem.j.find(x => x.productId === prod.j.id)
    : (mem.j.list || []).find(x => x.productId === prod.j.id);
  check('价格记忆记录批发价', memRow?.price === 6000, { memRow, raw: mem.j });

  // 7) 库存扣减
  const sl2 = await get(`/stock/list?teamId=${TEAM}&productId=${prod.j.id}`);
  const remain = sl2.j.reduce((s, x) => s + x.qty, 0);
  check('库存 100-10=90', remain === 90, remain);

  // 8) 改客户价格等级 → 取价跟着变
  await put(`/customer/${cus1.j.id}`, { teamId: TEAM, name: cus1.j.name, mobile: cus1.j.mobile, priceLevel: 'retailPrice' });
  const q4 = await pickPrice(cus1.j.id);
  check('改等级后 → 零售价 10000', q4.field === 'retailPrice' && q4.price === 10000, q4);

  // 9) 涨价改批发价，取价跟随
  await put(`/product/${prod.j.id}`, {
    teamId: TEAM, name: prod.j.name, unit: '个', catId: cat?.id ?? null,
    purchasePrice: 5000, salePrice: 8000, wholePrice: 5500, retailPrice: 10000, lowQty: 0,
  });
  await put(`/customer/${cus1.j.id}`, { teamId: TEAM, name: cus1.j.name, mobile: cus1.j.mobile, priceLevel: 'wholePrice' });
  const q5 = await pickPrice(cus1.j.id);
  check('改批发价为 5500 后取价跟随', q5.price === 5500, q5);

  // 10) 无价格等级的旧客户（null）→ 回退标准售价
  const cus4 = await post('/customer', { teamId: TEAM, name: '无等级客户' + uniq, mobile: '1360000' + uniq });
  const raw = (await get(`/customer?teamId=${TEAM}`)).j.find(x => x.id === cus4.j.id);
  const q6 = await pickPrice(cus4.j.id);
  check('null 等级回退标准售价', q6.price === 8000, { level: raw.priceLevel, q6 });

  console.log(`\n===== ${pass} PASS / ${fail} FAIL =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SUITE ERROR', e); process.exit(1); });
