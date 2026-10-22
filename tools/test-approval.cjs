const B = process.env.OC_BASE || 'http://127.0.0.1:7741/api';
const { authHeader } = require('./test-helpers.cjs');
let T = null;
async function get(p) { const r = await fetch(B + p, { headers: await authHeader() }); return JSON.parse(await r.text()); }
async function post(p, b) { const r = await fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(await authHeader()) }, body: JSON.stringify(b) }); const t = await r.text(); try { return JSON.parse(t); } catch { return { error: 'non-json', raw: t.slice(0, 120) }; } }
async function put(p, b) { const r = await fetch(B + p, { method: 'PUT', headers: { 'content-type': 'application/json', ...(await authHeader()) }, body: JSON.stringify(b) }); const t = await r.text(); try { return JSON.parse(t); } catch { return { error: 'non-json', raw: t.slice(0, 120) }; } }
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`PASS | ${n}${e ? ' | ' + e : ''}`); } else { fail++; console.log(`FAIL | ${n}${e ? ' | ' + e : ''}`); } };

(async () => {
  T = (await get('/auth/me')).user.teamId;
  const wh = (await get(`/warehouse?teamId=${T}`))[0];
  const prods = await get(`/product?teamId=${T}`);
  const prod = prods.find((p) => p.name === '红富士苹果') || prods[0];
  const cus = await post('/customer', { teamId: T, name: '审批流客户' + (Date.now() % 10000) });
  const CUS_ID = cus.id;

  // 备货
  const d0 = await post('/doc/create', { teamId: T, type: 'stockin', warehouseId: wh.id, remark: '审批流备货', items: [{ productId: prod.id, qty: 30, price: 5000 }] });
  await post('/doc/audit', { teamId: T, id: d0.id });

  const stock0 = (await get(`/stock/list?teamId=${T}&productId=${prod.id}`)).reduce((s, r) => s + r.qty, 0);

  // 1. 建草稿
  const d = await post('/doc/create', {
    teamId: T, type: 'stockout', partnerType: 'cus', partnerId: CUS_ID, warehouseId: wh.id, remark: '审批流用例',
    items: [{ productId: prod.id, qty: 2, price: 8000 }],
  });
  ok('建草稿成功', !!d.id, d.billNo);
  const info1 = await get(`/doc/info?teamId=${T}&id=${d.id}`);
  ok('初始状态 draft', info1.doc.status === 'draft', info1.doc.status);

  // 2. 草稿不能驳回
  const rj0 = await post('/doc/reject', { teamId: T, id: d.id, reason: 'x' });
  ok('草稿不可驳回', !!rj0.error, rj0.error || '');

  // 3. 提交审核
  const sb = await post('/doc/submit', { teamId: T, id: d.id });
  ok('提交审核成功', sb.ok && sb.status === 'pending', JSON.stringify(sb));
  const info2 = await get(`/doc/info?teamId=${T}&id=${d.id}`);
  ok('状态变 pending', info2.doc.status === 'pending', info2.doc.status);
  ok('submitAt 已记录', !!info2.doc.submitAt, info2.doc.submitAt || '');

  // 4. 提交后不能编辑
  const ed = await put('/doc/edit', { teamId: T, id: d.id, type: 'stockout', warehouseId: wh.id, items: [{ productId: prod.id, qty: 1, price: 8000 }] });
  ok('待审核不可编辑', !!ed.error, ed.error || '');

  // 5. 待审核不动库存
  const stockA = (await get(`/stock/list?teamId=${T}&productId=${prod.id}`)).reduce((s, r) => s + r.qty, 0);
  ok('待审核不动库存', stockA === stock0, `${stockA} vs ${stock0}`);

  // 6. 驳回
  const rj = await post('/doc/reject', { teamId: T, id: d.id, reason: '价格录错' });
  ok('驳回成功', rj.ok && rj.status === 'draft', JSON.stringify(rj));
  const info3 = await get(`/doc/info?teamId=${T}&id=${d.id}`);
  ok('驳回后回草稿', info3.doc.status === 'draft', info3.doc.status);
  ok('驳回原因落库', info3.doc.rejectReason === '价格录错', info3.doc.rejectReason || '');

  // 7. 驳回后可编辑
  const ed2 = await put('/doc/edit', {
    teamId: T, id: d.id, type: 'stockout', partnerType: 'cus', partnerId: CUS_ID, warehouseId: wh.id,
    remark: '审批流用例-改价', items: [{ productId: prod.id, qty: 2, price: 9000 }],
  });
  ok('驳回后可编辑', ed2.ok, JSON.stringify(ed2));

  // 8. 再次提交后直接审核（pending 可审核）
  await post('/doc/submit', { teamId: T, id: d.id });
  const au = await post('/doc/audit', { teamId: T, id: d.id, auditBy: '张主管' });
  ok('待审核可直接审核', au.ok, JSON.stringify(au));
  const info4 = await get(`/doc/info?teamId=${T}&id=${d.id}`);
  ok('审核后状态 audit', info4.doc.status === 'audit', info4.doc.status);
  ok('审核人已记录', info4.doc.auditBy === '张主管', info4.doc.auditBy || '');

  // 9. 审核后库存扣减
  const stockB = (await get(`/stock/list?teamId=${T}&productId=${prod.id}`)).reduce((s, r) => s + r.qty, 0);
  ok('审核后扣库存 2', stockB === stock0 - 2, `${stockB} expect ${stock0 - 2}`);

  // 10. 已审核不可再审核
  const au2 = await post('/doc/audit', { teamId: T, id: d.id });
  ok('已审核不可重复审核', !!au2.error, au2.error || '');

  // 11. 已审核不可提交
  const sb2 = await post('/doc/submit', { teamId: T, id: d.id });
  ok('已审核不可提交', !!sb2.error, sb2.error || '');

  // 12. 批量提交
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const x = await post('/doc/create', {
      teamId: T, type: 'stockout', partnerType: 'cus', partnerId: CUS_ID, warehouseId: wh.id, remark: '批量提交' + i,
      items: [{ productId: prod.id, qty: 1, price: 8000 }],
    });
    ids.push(x.id);
  }
  ids.push(d.id); // 已审核的应被跳过
  const bb = await post('/doc/submit-batch', { teamId: T, ids });
  ok('批量提交 3 张', bb.ok && bb.done === 3, JSON.stringify(bb));
  ok('已审核被跳过', Array.isArray(bb.skipped) && bb.skipped.includes(d.id), JSON.stringify(bb.skipped));

  // 清理：作废 + 删草稿
  await post('/doc/void', { teamId: T, id: d.id });
  for (const id of ids.slice(0, 3)) {
    const row = await get(`/doc/info?teamId=${T}&id=${id}`);
    if (row.doc.status === 'pending') await post('/doc/reject', { teamId: T, id, reason: '清理' });
    await fetch(`${B}/doc/${id}?teamId=${T}`, { method: 'DELETE' });
  }
  await post('/doc/void', { teamId: T, id: d0.id });

  console.log(`\n===== ${pass} PASS / ${fail} FAIL =====`);
  process.exit(fail ? 1 : 0);
})();
