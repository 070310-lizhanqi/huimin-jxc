/**
 * 逐个单据类型的端到端冒烟：确认每种类型都能建单、审核、影响库存方向正确。
 */
const BASE = process.env.OC_BASE || 'http://127.0.0.1:7741/api';
const { authHeader } = require('./test-helpers.cjs');
let pass = 0, fail = 0;
function ok(c, n, d) { if (c) { pass++; console.log('PASS |', n, d ?? ''); } else { fail++; console.log('FAIL |', n, '|', d ?? ''); } }

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
  const wh1 = (await api('POST', '/warehouse', { teamId, name: '主仓' })).body;
  const wh2 = (await api('POST', '/warehouse', { teamId, name: '二号仓' })).body;
  const cat = (await api('POST', '/cat', { teamId, name: '默认' })).body;
  const prod = (await api('POST', '/product', {
    teamId, catId: cat.id, name: '测试品', unit: '个', salePrice: 2000, purchasePrice: 1000,
  })).body;
  const cus = (await api('POST', '/customer', { teamId, name: '客户' })).body;
  const ven = (await api('POST', '/vendor', { teamId, name: '供应商' })).body;

  const qty = async (w) => {
    const rows = (await api('GET', `/stock/list?teamId=${teamId}&warehouseId=${w}`)).body;
    const r = rows.find((x) => x.productId === prod.id);
    return r ? r.qty : 0;
  };
  const mk = async (type, extra, items) => {
    const r = await api('POST', '/doc/create', { teamId, type, items, ...extra });
    if (r.status !== 200) return { err: r.body.error };
    const a = await api('POST', '/doc/audit', { teamId, id: r.body.id });
    return { id: r.body.id, billNo: r.body.billNo, auditErr: a.status !== 200 ? a.body.error : null };
  };

  // 期初 100
  let r = await mk('stockinit', { warehouseId: wh1.id }, [{ productId: prod.id, qty: 100, price: 1000 }]);
  ok(!r.err && !r.auditErr, '期初库存 100', r.err || r.auditErr || r.billNo);
  ok(await qty(wh1.id) === 100, '库存=100', String(await qty(wh1.id)));

  // 采购入库 +20 → 120
  r = await mk('stockin', { warehouseId: wh1.id, partnerType: 'ven', partnerId: ven.id }, [{ productId: prod.id, qty: 20, price: 1000 }]);
  ok(!r.err && !r.auditErr, '采购入库 +20', r.err || r.auditErr || r.billNo);
  ok(await qty(wh1.id) === 120, '库存=120', String(await qty(wh1.id)));

  // 采购退货 -5 → 115
  r = await mk('pin', { warehouseId: wh1.id, partnerType: 'ven', partnerId: ven.id }, [{ productId: prod.id, qty: 5, price: 1000 }]);
  ok(!r.err && !r.auditErr, '采购退货 -5', r.err || r.auditErr || r.billNo);
  ok(await qty(wh1.id) === 115, '库存=115', String(await qty(wh1.id)));

  // 销售出库 -10 → 105
  r = await mk('stockout', { warehouseId: wh1.id, partnerType: 'cus', partnerId: cus.id }, [{ productId: prod.id, qty: 10, price: 2000 }]);
  ok(!r.err && !r.auditErr, '销售出库 -10', r.err || r.auditErr || r.billNo);
  ok(await qty(wh1.id) === 105, '库存=105', String(await qty(wh1.id)));

  // 销售退货 +3 → 108
  r = await mk('sret', { warehouseId: wh1.id, partnerType: 'cus', partnerId: cus.id }, [{ productId: prod.id, qty: 3, price: 2000 }]);
  ok(!r.err && !r.auditErr, '销售退货 +3', r.err || r.auditErr || r.billNo);
  ok(await qty(wh1.id) === 108, '库存=108', String(await qty(wh1.id)));

  // 其它入库 +7 → 115
  r = await mk('otherin', { warehouseId: wh1.id }, [{ productId: prod.id, qty: 7, price: 1000 }]);
  ok(!r.err && !r.auditErr, '其它入库 +7', r.err || r.auditErr || r.billNo);
  ok(await qty(wh1.id) === 115, '库存=115', String(await qty(wh1.id)));

  // 其它出库 -2 → 113
  r = await mk('otherout', { warehouseId: wh1.id }, [{ productId: prod.id, qty: 2, price: 1000 }]);
  ok(!r.err && !r.auditErr, '其它出库 -2', r.err || r.auditErr || r.billNo);
  ok(await qty(wh1.id) === 113, '库存=113', String(await qty(wh1.id)));

  // 调拨 20：113 → 93 / 二号仓 20
  r = await mk('transfer', { warehouseId: wh1.id }, [{ productId: prod.id, qty: 20, toWarehouseId: wh2.id }]);
  ok(!r.err && !r.auditErr, '调拨 20', r.err || r.auditErr || r.billNo);
  ok(await qty(wh1.id) === 93, '主仓=93', String(await qty(wh1.id)));
  ok(await qty(wh2.id) === 20, '二号仓=20', String(await qty(wh2.id)));

  // 调整 +5 → 98
  r = await mk('adjust', { warehouseId: wh1.id }, [{ productId: prod.id, qty: 5, price: 1000 }]);
  ok(!r.err && !r.auditErr, '调整 +5', r.err || r.auditErr || r.billNo);
  ok(await qty(wh1.id) === 98, '库存=98', String(await qty(wh1.id)));

  // 调整 -3 → 95
  r = await mk('adjust', { warehouseId: wh1.id }, [{ productId: prod.id, qty: -3, price: 1000 }]);
  ok(!r.err && !r.auditErr, '调整 -3', r.err || r.auditErr || r.billNo);
  ok(await qty(wh1.id) === 95, '库存=95', String(await qty(wh1.id)));

  // 盘点：账面 95，实盘 90 → 差 -5 → 90
  r = await api('POST', '/doc/create', {
    teamId, type: 'stocktake', warehouseId: wh1.id,
    items: [{ productId: prod.id, qty: 90, price: 1000 }],
  });
  if (r.status !== 200) {
    ok(false, '盘点建单', r.body.error);
  } else {
    const a = await api('POST', '/doc/audit', { teamId, id: r.body.id });
    ok(a.status === 200, '盘点审核', a.status === 200 ? r.body.billNo : JSON.stringify(a.body));
    ok(await qty(wh1.id) === 90, '盘点后库存=90', String(await qty(wh1.id)));
  }

  // 生产组装：成品 +10（正），原料 -10（负）
  r = await mk('assembly', { warehouseId: wh1.id }, [
    { productId: prod.id, qty: 10, price: 1000 },
    { productId: prod.id, qty: -10, price: 1000 },
  ]);
  ok(!r.err && !r.auditErr, '生产组装 正负抵消', r.err || r.auditErr || r.billNo);
  ok(await qty(wh1.id) === 90, '组装后库存仍=90', String(await qty(wh1.id)));

  // 报价单：不动库存
  r = await mk('quo', {}, [{ productId: prod.id, qty: 1, price: 2000 }]);
  ok(!r.err && !r.auditErr, '报价单不动库存', r.err || r.auditErr || r.billNo);
  ok(await qty(wh1.id) === 90, '库存仍=90', String(await qty(wh1.id)));

  console.log(`\n===== ${pass}/${pass + fail} PASS =====`);
  process.exit(fail ? 1 : 0);
})();
