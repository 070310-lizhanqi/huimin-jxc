/**
 * P0 复现：作废出库单时 deduct 仍按当前 FIFO 检查可用量——
 * 库存已被后续销售消耗时，作废被「库存不足」错误拒绝（尽管作废本身是往回加库存）。
 * 前置：服务已启动，账套已初始化（admin/B2cost!9Xq）。
 * 基址走 test-helpers 的 OC_BASE（B-安8 实测：写死 7741 会在端口自适应后移时连错端口）。
 */
const { BASE } = require('./test-helpers.cjs');
let token = '';

async function req(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${data && data.error}`);
  return data;
}

(async () => {
  const login = await req('POST', '/auth/login', { username: 'admin', password: 'B2cost!9Xq' });
  token = login.token;
  const teamId = login.team?.id ?? login.user.teamId;

  const prods = await req('GET', `/product?teamId=${teamId}&rows=500`);
  const cuss = await req('GET', `/customer?teamId=${teamId}`);
  const vens = await req('GET', `/vendor?teamId=${teamId}`);
  const whs = await req('GET', `/warehouse?teamId=${teamId}`);
  const wh = whs[0], cus = cuss[0], ven = vens[0];
  // 用全新商品：保证期初为 0，库存路径完全受控
  const prodName = '作废冲回验证' + Date.now() % 100000;
  const prod = await req('POST', `/product`, { teamId, name: prodName, unit: '件' });
  console.log('[准备] 商品:', prod.name, '仓库:', wh.name);

  // 1. 采购入库 100（先清该商品在主仓的存量影响？不清理——只看相对变化）
  const pin = await req('POST', '/doc/create', {
    teamId, type: 'stockin', date: '2026-10-24', partnerType: 'ven', partnerId: ven.id,
    warehouseId: wh.id,
    items: [{ productId: prod.id, qty: 100, price: 1000 }],
  });
  await req('POST', '/doc/audit', { teamId, id: pin.id });

  // 2. 销售出库 80
  const sout = await req('POST', '/doc/create', {
    teamId, type: 'stockout', date: '2026-10-24', partnerType: 'cus', partnerId: cus.id,
    warehouseId: wh.id,
    items: [{ productId: prod.id, qty: 80, price: 2000 }],
  });
  await req('POST', '/doc/audit', { teamId, id: sout.id });

  const stockOf = async () => {
    const rows = await req('GET', `/stock/list?teamId=${teamId}&productId=${prod.id}&warehouseId=${wh.id}`);
    return rows.reduce((s, r) => s + r.qty, 0);
  };
  const mid = await stockOf();
  console.log('[中态] 审核出库后库存 =', mid, '（期望 = 期初 + 20）');

  // 3. 作废那张销售出库单 —— 作废是把 80 加回去，不应受「当前可用量」限制
  try {
    await req('POST', '/doc/void', { teamId, id: sout.id });
    const after = await stockOf();
    console.log('[结果] 作废成功，库存 =', after, '（期望 = 期初 + 100）', after === mid + 80 ? '✓' : '✗ 数量不对');
  } catch (e) {
    console.log('[结果] 作废被拒绝：', e.message);
    console.log('>>>> P0 确认：出库单作废被当前 FIFO 可用量阻断');
    process.exitCode = 1;
  }
})().catch((e) => { console.error('[脚本异常]', e.message); process.exit(2); });
