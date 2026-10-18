/**
 * 整页开单 + 结算区联动测试（对应橙子云「减整单折扣/减本次收款/设为全收/收款账户/抵扣订金」）
 * 用法：node tools/test-settle.cjs
 */
const BASE = process.env.OC_BASE || 'http://127.0.0.1:7741';
const { authHeader } = require('./test-helpers.cjs');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
}
const yuan = (c) => (c / 100).toFixed(2);

(async () => {
  const me = (await api('GET', '/api/auth/me')).json;
  const teamId = me.user.teamId;
  console.log('账套 teamId =', teamId);

  const wh = (await api('POST', '/api/warehouse', { teamId, name: '测试仓' })).json;
  const prod = (await api('POST', '/api/product', { teamId, name: '结算测试品', spec: '件', unit: '件', purchasePrice: 3000, salePrice: 5000 })).json;
  const cus = (await api('POST', '/api/customer', { teamId, name: '结算测试客户' })).json;
  const acc = (await api('POST', '/api/account', { teamId, name: '测试现金', type: 'cash', balance: 0 })).json;

  console.log('\n== 1. 基础校验 ==');
  {
    // 折扣超过金额
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'stockout', date: '2026-10-17', partnerType: 'cus', partnerId: cus.id,
      warehouseId: wh.id, discount: 999999, items: [{ productId: prod.id, qty: 1, price: 5000 }],
    });
    ok(r.status === 400 && /整单折扣/.test(r.text), '整单折扣超过单据金额被拒', r.text);
  }

  console.log('\n== 2. 先入库备货 ==');
  {
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'stockin', date: '2026-10-17', partnerType: 'ven', partnerId: null,
      warehouseId: wh.id, items: [{ productId: prod.id, qty: 20, price: 3000 }],
    });
    ok(r.status === 200, '采购入库建单成功', r.text);
    const a = await api('POST', '/api/doc/audit', { teamId, id: r.json.id });
    ok(a.status === 200, '采购入库审核成功', a.text);
    const s = (await api('GET', `/api/stock/list?teamId=${teamId}&warehouseId=${wh.id}&ifShowZero=1`)).json;
    const row = s.find((x) => x.productId === prod.id);
    ok(row && row.qty === 20, '库存 = 20', row && String(row.qty));
  }

  console.log('\n== 3. 折扣 + 全额减 ==');
  {
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'stockout', date: '2026-10-17', partnerType: 'cus', partnerId: cus.id,
      warehouseId: wh.id, discount: 2000,
      items: [{ productId: prod.id, qty: 2, price: 5000 }],
    });
    ok(r.status === 200, '带折扣建单成功', r.text);
    const info = (await api('GET', `/api/doc/info?id=${r.json.id}&teamId=${teamId}`)).json;
    ok(info.doc.totalAmount === 8000, '应收 = 10000 - 2000 = 8000', String(info.doc.totalAmount));
    ok(info.doc.discount === 2000, 'discount 落库 2000', String(info.doc.discount));
  }

  console.log('\n== 4. 开单即收付（审核联动） ==');
  {
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'stockout', date: '2026-10-17', partnerType: 'cus', partnerId: cus.id,
      warehouseId: wh.id, discount: 1000, paidAmount: 9000, accountId: acc.id,
      items: [{ productId: prod.id, qty: 2, price: 5000 }],
    });
    ok(r.status === 200, '含收款建单成功', r.text);
    const docId = r.json.id;
    const a = await api('POST', '/api/doc/audit', { teamId, id: docId });
    ok(a.status === 200, '审核成功（含收款）', a.text);

    const info = (await api('GET', `/api/doc/info?id=${docId}&teamId=${teamId}`)).json;
    ok(info.doc.totalAmount === 9000, '应收 = 10000 - 1000 = 9000', String(info.doc.totalAmount));
    ok(info.doc.paidAmount === 9000, 'paidAmount 落库 9000', String(info.doc.paidAmount));

    const st = (await api('GET', `/api/settlement/list?teamId=${teamId}&rows=50`)).json;
    const rec = st.find((x) => x.refDocId === docId);
    ok(!!rec, '审核自动生成收付单');
    ok(rec && rec.type === 'receipt', '收付单类型 = receipt', rec && rec.type);
    ok(rec && rec.amount === 9000, '收付单金额 = 9000', rec && String(rec.amount));
    ok(rec && rec.remark === '开单即收付', '备注 = 开单即收付', rec && rec.remark);
    ok(rec && rec.accountId === acc.id, '关联收款账户', rec && String(rec.accountId));

    const accounts = (await api('GET', `/api/account?teamId=${teamId}`)).json;
    const a2 = accounts.find((x) => x.id === acc.id);
    ok(a2 && a2.balance === 9000, '账户余额 = 9000', a2 && String(a2.balance));

    const bal = (await api('GET', `/api/partner/balance?teamId=${teamId}&partnerType=cus&partnerId=${cus.id}`)).json;
    ok(!!bal, '往来余额可查');
  }

  console.log('\n== 5. 无往来单位却填收款 → 拒绝 ==');
  {
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'stockout', date: '2026-10-17', partnerType: null, partnerId: null,
      warehouseId: wh.id, paidAmount: 5000,
      items: [{ productId: prod.id, qty: 1, price: 5000 }],
    });
    ok(r.status === 200, '无客户建单成功（草稿）', r.text);
    const a = await api('POST', '/api/doc/audit', { teamId, id: r.json.id });
    ok(a.status === 400 && /往来单位/.test(a.text), '审核时拒绝：无往来单位不能收付', a.text);
    // 清理该草稿
    await api('DELETE', `/api/doc/${r.json.id}?teamId=${teamId}`);
  }

  console.log('\n== 6. 收款超应收 → 拒绝 ==');
  {
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'stockout', date: '2026-10-17', partnerType: 'cus', partnerId: cus.id,
      warehouseId: wh.id, paidAmount: 999999, accountId: acc.id,
      items: [{ productId: prod.id, qty: 1, price: 5000 }],
    });
    ok(r.status === 400, '收款超过应收被拒', r.text);
  }

  console.log('\n== 7. 采购付款方向（payment） ==');
  {
    const ven = (await api('POST', '/api/vendor', { teamId, name: '结算测试供应商' })).json;
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'stockin', date: '2026-10-17', partnerType: 'ven', partnerId: ven.id,
      warehouseId: wh.id, paidAmount: 5000, accountId: acc.id,
      items: [{ productId: prod.id, qty: 2, price: 2500 }],
    });
    ok(r.status === 200, '采购含付款建单成功', r.text);
    const a = await api('POST', '/api/doc/audit', { teamId, id: r.json.id });
    ok(a.status === 200, '采购审核成功', a.text);
    const st = (await api('GET', `/api/settlement/list?teamId=${teamId}&rows=50`)).json;
    const pay = st.find((x) => x.refDocId === r.json.id);
    ok(pay && pay.type === 'payment', '采购生成 payment', pay && pay.type);
    const accounts = (await api('GET', `/api/account?teamId=${teamId}`)).json;
    const a2 = accounts.find((x) => x.id === acc.id);
    ok(a2 && a2.balance === 4000, '账户余额 9000 - 5000 = 4000', a2 && String(a2.balance));
  }

  console.log('\n== 8. 抵扣订金 ==');
  {
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'stockout', date: '2026-10-17', partnerType: 'cus', partnerId: cus.id,
      warehouseId: wh.id, deposit: 3000, paidAmount: 2000, accountId: acc.id,
      items: [{ productId: prod.id, qty: 1, price: 5000 }],
    });
    ok(r.status === 200, '订金建单成功', r.text);
    const docId = r.json.id;
    const a = await api('POST', '/api/doc/audit', { teamId, id: docId });
    ok(a.status === 200, '审核成功（含订金）', a.text);
    const info = (await api('GET', `/api/doc/info?id=${docId}&teamId=${teamId}`)).json;
    ok(info.doc.deposit === 3000, 'deposit 落库 3000', String(info.doc.deposit));
    // 订金是之前已收的钱，本次只冲往来余额、不进资金账户；
    // 因此收付单金额 = paid（2000），不含订金 3000
    const st = (await api('GET', `/api/settlement/list?teamId=${teamId}&rows=50`)).json;
    const rec = st.find((x) => x.refDocId === docId);
    ok(rec && rec.amount === 2000, '收付单金额 = 本次收款 2000（订金不进账户）', rec && String(rec.amount));
  }

  console.log('\n== 9. 收件人字段 ==');
  {
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'stockout', date: '2026-10-17', partnerType: 'cus', partnerId: cus.id,
      warehouseId: wh.id, receiverName: '李四', receiverMobile: '13900002222', receiverAddress: '北京市朝阳区某路 1 号',
      items: [{ productId: prod.id, qty: 1, price: 5000 }],
    });
    ok(r.status === 200, '带收件人建单成功', r.text);
    const info = (await api('GET', `/api/doc/info?id=${r.json.id}&teamId=${teamId}`)).json;
    ok(info.doc.receiverName === '李四', '收件人姓名落库', info.doc.receiverName);
    ok(info.doc.receiverMobile === '13900002222', '收件手机落库', info.doc.receiverMobile);
    ok(info.doc.receiverAddress === '北京市朝阳区某路 1 号', '收件地址落库', info.doc.receiverAddress);
    await api('DELETE', `/api/doc/${r.json.id}?teamId=${teamId}`);
  }

  console.log('\n== 10. 折扣不可为负 ==');
  {
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'stockout', date: '2026-10-17', partnerType: 'cus', partnerId: cus.id,
      warehouseId: wh.id, discount: -5000,
      items: [{ productId: prod.id, qty: 1, price: 5000 }],
    });
    const info = r.json && r.json.id ? (await api('GET', `/api/doc/info?id=${r.json.id}&teamId=${teamId}`)).json : null;
    ok(!info || (info.doc.discount || 0) >= 0, '负折扣被钳制为 0', info && String(info.doc.discount));
    if (r.json && r.json.id) await api('DELETE', `/api/doc/${r.json.id}?teamId=${teamId}`);
  }

  console.log('\n' + '='.repeat(46));
  console.log(`== ${pass} PASS / ${fail} FAIL ==`);
  if (fail) {
    console.log('失败项：');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
