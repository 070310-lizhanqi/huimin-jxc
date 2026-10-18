const BASE = 'http://127.0.0.1:7741/api';
async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, text: t };
}
(async () => {
  const teamId = 67;
  // 建客户
  const c = await api('POST', '/customer', { teamId, name: '账龄客户' + Date.now() % 10000 });
  const cusId = c.json.id;
  console.log('cusId', cusId);
  // 备货
  const wh = (await api('GET', `/warehouse?teamId=${teamId}`)).json;
  const whId = wh[0].id;
  const prods = (await api('GET', `/product?teamId=${teamId}`)).json;
  const pid = prods[0].id;
  const inb = await api('POST', '/doc/create', { teamId, type: 'stockin', date: '2026-06-01', warehouseId: whId, items: [{ productId: pid, qty: 100, price: 1000 }] });
  await api('POST', '/doc/audit', { teamId, id: inb.json.id });
  // 赊销 2026-06-01 一张 500 元
  const p1 = await api('POST', '/doc/create', { teamId, type: 'stockout', date: '2026-06-01', partnerType: 'cus', partnerId: cusId, warehouseId: whId, remark: 'a1', items: [{ productId: pid, qty: 5, price: 10000 }] });
  await api('POST', '/doc/audit', { teamId, id: p1.json.id });
  // 赊销 2026-09-20 一张 300 元
  const p2 = await api('POST', '/doc/create', { teamId, type: 'stockout', date: '2026-09-20', partnerType: 'cus', partnerId: cusId, warehouseId: whId, remark: 'a2', items: [{ productId: pid, qty: 3, price: 10000 }] });
  await api('POST', '/doc/audit', { teamId, id: p2.json.id });
  // 收款 200（应冲最早的 6-01 单）
  const s = await api('POST', '/settlement/create', { teamId, type: 'receipt', partnerType: 'cus', partnerId: cusId, amount: 20000, date: '2026-10-01' });
  console.log('settle', s.status, s.text.slice(0, 120));
  const ag = (await api('GET', `/report/aging?teamId=${teamId}&mode=ar`)).json;
  console.log('总计', JSON.stringify(ag.totals));
  const row = ag.rows.find(r => r.partnerId === cusId);
  console.log('本客户', JSON.stringify(row));
  console.log('校验: 500元-200元=300元 在 180 天桶; 300元 在 30 天桶');
})();
