/**
 * 验证：整页开单「开单即收付」审核后，自动生成的 settlement 必须带 refDocId。
 */
const BASE = process.env.OC_BASE || 'http://127.0.0.1:7741/api';
const { authHeader } = require('./test-helpers.cjs');

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await res.json(); } catch { j = { error: 'non-json' }; }
  return { status: res.status, body: j };
}

(async () => {
  const me = (await api('GET', '/auth/me')).body;
  const teamId = me.user.teamId;
  const cus = (await api('POST', '/customer', { teamId, name: '客户A' })).body;
  const wh = (await api('POST', '/warehouse', { teamId, name: '主仓' })).body;
  const cat = (await api('POST', '/cat', { teamId, name: '默认' })).body;
  const prod = (await api('POST', '/product', {
    teamId, catId: cat.id, name: '商品A', unit: '个', salePrice: 10000, purchasePrice: 5000,
  })).body;
  const acc = (await api('POST', '/account', { teamId, name: '现金', type: 'cash', balance: 0 })).body;

  // 先入库 10 个
  const in1 = (await api('POST', '/doc/create', {
    teamId, type: 'stockin', warehouseId: wh.id,
    items: [{ productId: prod.id, qty: 10, price: 5000 }],
  })).body;
  await api('POST', '/doc/audit', { teamId, id: in1.id });

  // 出库 3 个，开单即收 300 元
  const out = (await api('POST', '/doc/create', {
    teamId, type: 'stockout', warehouseId: wh.id,
    partnerType: 'cus', partnerId: cus.id, accountId: acc.id,
    paidAmount: 30000,
    items: [{ productId: prod.id, qty: 3, price: 10000 }],
  })).body;
  console.log('出库单:', out.billNo, 'id=', out.id);

  const au = await api('POST', '/doc/audit', { teamId, id: out.id });
  console.log('审核:', au.status === 200 ? 'ok' : JSON.stringify(au.body));

  const st = (await api('GET', `/settlement/list?teamId=${teamId}`)).body;
  console.log('\n自动生成的收付款记录:');
  for (const s of st) {
    console.log(`  #${s.id} ${s.type} 金额=${s.amount} refDocId=${s.refDocId} remark=${s.remark}`);
  }
  const hit = st.find((s) => s.refDocId === out.id);
  console.log('\n关联校验:', hit ? `PASS —— 找到关联单据 #${hit.refDocId}` : 'FAIL —— 未写入 refDocId');

  // 关联单据能查到单号
  if (hit) {
    const d = (await api('GET', `/doc/info?teamId=${teamId}&id=${hit.refDocId}`)).body;
    console.log('反查单号:', d.doc?.billNo, '状态:', d.doc?.status, '明细行数:', d.items?.length);
  }
})();
