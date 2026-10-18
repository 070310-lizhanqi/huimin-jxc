/**
 * 新增单据类型测试：其它入库 / 其它出库 / 生产组装 / 盘点
 * 用法：node tools/test-doctypes.cjs
 */
const BASE = process.env.OC_BASE || 'http://127.0.0.1:7741';

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
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
}
const stockOf = async (teamId, whId, prodId) => {
  const s = (await api('GET', `/api/stock/list?teamId=${teamId}&warehouseId=${whId}&ifShowZero=1`)).json;
  const row = Array.isArray(s) ? s.find((x) => x.productId === prodId) : null;
  return row ? Number(row.qty) : 0;
};

(async () => {
  const boot = await api('POST', '/api/bootstrap', { name: '单据类型测试账套' });
  const teamId = boot.json.teamId;
  console.log('账套 teamId =', teamId);

  const wh = (await api('POST', '/api/warehouse', { teamId, name: '主仓' })).json;
  const wh2 = (await api('POST', '/api/warehouse', { teamId, name: '备仓' })).json;
  const prod = (await api('POST', '/api/product', { teamId, name: '物料A', spec: 'kg', unit: 'kg', purchasePrice: 1000, salePrice: 2000 })).json;
  const prod2 = (await api('POST', '/api/product', { teamId, name: '成品B', spec: '台', unit: '台', purchasePrice: 5000, salePrice: 9000 })).json;

  // 备货 100
  {
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'stockin', date: '2026-10-17', warehouseId: wh.id,
      items: [{ productId: prod.id, qty: 100, price: 1000 }],
    });
    await api('POST', '/api/doc/audit', { teamId, id: r.json.id });
    ok((await stockOf(teamId, wh.id, prod.id)) === 100, '备货 100 成功');
  }

  console.log('\n== 1. 其它入库 / 其它出库 ==');
  {
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'otherin', date: '2026-10-17', warehouseId: wh.id,
      items: [{ productId: prod.id, qty: 30, price: 1000 }],
    });
    ok(r.status === 200, '其它入库建单成功', r.text);
    ok(r.status === 200 && /^QR/.test(r.json.billNo), '单号前缀 QR', r.json && r.json.billNo);
    const a = await api('POST', '/api/doc/audit', { teamId, id: r.json.id });
    ok(a.status === 200, '其它入库审核成功', a.text);
    ok((await stockOf(teamId, wh.id, prod.id)) === 130, '库存 100 + 30 = 130', String(await stockOf(teamId, wh.id, prod.id)));
  }
  {
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'otherout', date: '2026-10-17', warehouseId: wh.id,
      items: [{ productId: prod.id, qty: 20, price: 1000 }],
    });
    ok(r.status === 200 && /^QC/.test(r.json.billNo), '其它出库建单成功且单号 QC', r.text);
    const a = await api('POST', '/api/doc/audit', { teamId, id: r.json.id });
    ok(a.status === 200, '其它出库审核成功', a.text);
    ok((await stockOf(teamId, wh.id, prod.id)) === 110, '库存 130 - 20 = 110');
  }
  {
    // 其它出库超库存应被拒
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'otherout', date: '2026-10-17', warehouseId: wh.id,
      items: [{ productId: prod.id, qty: 9999, price: 1000 }],
    });
    const a = await api('POST', '/api/doc/audit', { teamId, id: r.json.id });
    ok(a.status === 400 && /库存不足/.test(a.text), '其它出库超库存被拒', a.text);
    ok((await stockOf(teamId, wh.id, prod.id)) === 110, '失败审核不改变库存');
  }
  {
    // 作废其它入库应冲回
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'otherin', date: '2026-10-17', warehouseId: wh.id,
      items: [{ productId: prod.id, qty: 10, price: 1000 }],
    });
    await api('POST', '/api/doc/audit', { teamId, id: r.json.id });
    ok((await stockOf(teamId, wh.id, prod.id)) === 120, '其它入库 10 后库存 120');
    const v = await api('POST', '/api/doc/void', { teamId, id: r.json.id });
    ok(v.status === 200, '其它入库作废成功', v.text);
    ok((await stockOf(teamId, wh.id, prod.id)) === 110, '作废后库存回到 110');
  }

  console.log('\n== 2. 生产组装 ==');
  {
    // 耗用 40 物料A，产出 8 成品B
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'assembly', date: '2026-10-17', warehouseId: wh.id,
      items: [
        { productId: prod2.id, qty: 8, price: 5000 },
        { productId: prod.id, qty: -40, price: 1000 },
      ],
    });
    ok(r.status === 200, '生产组装建单成功', r.text);
    ok(r.status === 200 && /^ZZ/.test(r.json.billNo), '单号前缀 ZZ', r.json && r.json.billNo);
    const a = await api('POST', '/api/doc/audit', { teamId, id: r.json.id });
    ok(a.status === 200, '生产组装审核成功', a.text);
    ok((await stockOf(teamId, wh.id, prod.id)) === 70, '耗用后物料A 110 - 40 = 70', String(await stockOf(teamId, wh.id, prod.id)));
    ok((await stockOf(teamId, wh.id, prod2.id)) === 8, '产出入库成品B = 8', String(await stockOf(teamId, wh.id, prod2.id)));
  }
  {
    // 耗用超过库存应被拒
    // 注意：建单有 5 秒幂等窗口，同参数会命中缓存返回旧单 —— 这里加备注区分指纹
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'assembly', date: '2026-10-17', warehouseId: wh.id, remark: '超量耗用用例',
      items: [{ productId: prod.id, qty: -9999, price: 1000 }],
    });
    ok(r.status === 200, '超量耗用单建单成功', r.text);
    const a = await api('POST', '/api/doc/audit', { teamId, id: r.json.id });
    ok(a.status === 400 && /库存不足/.test(a.text), '生产组装耗用超库存被拒', a.text);
    ok((await stockOf(teamId, wh.id, prod.id)) === 70, '失败审核不改变库存');
    await api('POST', '/api/doc/void', { teamId, id: r.json.id }).catch(() => {});
  }
  {
    // 生产组装作废应双向冲回
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'assembly', date: '2026-10-17', warehouseId: wh.id,
      items: [
        { productId: prod2.id, qty: 2, price: 5000 },
        { productId: prod.id, qty: -10, price: 1000 },
      ],
    });
    await api('POST', '/api/doc/audit', { teamId, id: r.json.id });
    ok((await stockOf(teamId, wh.id, prod.id)) === 60, '再次耗用后物料A = 60');
    ok((await stockOf(teamId, wh.id, prod2.id)) === 10, '再次产出后成品B = 10');
    const v = await api('POST', '/api/doc/void', { teamId, id: r.json.id });
    ok(v.status === 200, '生产组装作废成功', v.text);
    ok((await stockOf(teamId, wh.id, prod.id)) === 70, '作废后物料A 回到 70');
    ok((await stockOf(teamId, wh.id, prod2.id)) === 8, '作废后成品B 回到 8');
  }

  console.log('\n== 3. 盘点单 ==');
  {
    // 账面 70，实盘 62 → 盘亏 8
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'stocktake', date: '2026-10-17', warehouseId: wh.id,
      items: [{ productId: prod.id, qty: 62, price: 1000 }],
    });
    ok(r.status === 200, '盘点单建单成功', r.text);
    ok(r.status === 200 && /^PD/.test(r.json.billNo), '单号前缀 PD', r.json && r.json.billNo);
    const a = await api('POST', '/api/doc/audit', { teamId, id: r.json.id });
    ok(a.status === 200, '盘点单审核成功', a.text);
    ok((await stockOf(teamId, wh.id, prod.id)) === 62, '盘亏后库存 = 实盘 62', String(await stockOf(teamId, wh.id, prod.id)));
  }
  {
    // 账面 62，实盘 80 → 盘盈 18
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'stocktake', date: '2026-10-17', warehouseId: wh.id,
      items: [{ productId: prod.id, qty: 80, price: 1000 }],
    });
    const a = await api('POST', '/api/doc/audit', { teamId, id: r.json.id });
    ok(a.status === 200, '盘盈审核成功', a.text);
    ok((await stockOf(teamId, wh.id, prod.id)) === 80, '盘盈后库存 = 实盘 80', String(await stockOf(teamId, wh.id, prod.id)));
  }
  {
    // 实盘数 = 账面数，不动库存
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'stocktake', date: '2026-10-17', warehouseId: wh.id,
      items: [{ productId: prod.id, qty: 80, price: 1000 }],
    });
    const a = await api('POST', '/api/doc/audit', { teamId, id: r.json.id });
    ok(a.status === 200, '账实相符审核成功', a.text);
    ok((await stockOf(teamId, wh.id, prod.id)) === 80, '账实相符库存不变 80');
  }
  {
    // 盘点允许数量为 0（全部盘亏）
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'stocktake', date: '2026-10-17', warehouseId: wh2.id,
      items: [{ productId: prod.id, qty: 0, price: 1000 }],
    });
    ok(r.status === 200, '盘点数量 0 允许建单', r.text);
    await api('POST', '/api/doc/void', { teamId, id: r.json.id });
  }
  {
    // 盘亏撤销（作废）应恢复库存
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'stocktake', date: '2026-10-17', warehouseId: wh.id,
      items: [{ productId: prod.id, qty: 50, price: 1000 }],
    });
    await api('POST', '/api/doc/audit', { teamId, id: r.json.id });
    ok((await stockOf(teamId, wh.id, prod.id)) === 50, '盘亏到 50');
    const v = await api('POST', '/api/doc/void', { teamId, id: r.json.id });
    ok(v.status === 200, '盘点单作废成功', v.text);
    ok((await stockOf(teamId, wh.id, prod.id)) === 80, '作废后库存回到 80', String(await stockOf(teamId, wh.id, prod.id)));
  }

  console.log('\n== 4. 校验边界 ==');
  {
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'otherout', date: '2026-10-17', warehouseId: wh.id,
      items: [{ productId: prod.id, qty: 0, price: 1000 }],
    });
    ok(r.status === 400 && /不能为 0/.test(r.text), '数量 0 被拒（非盘点）', r.text);
  }
  {
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'otherout', date: '2026-10-17', warehouseId: wh.id,
      items: [{ productId: prod.id, qty: -5, price: 1000 }],
    });
    ok(r.status === 400 && /非法/.test(r.text), '负数量被拒（非调整/组装）', r.text);
  }
  {
    const r = await api('POST', '/api/doc/create', {
      teamId, type: 'unknown', date: '2026-10-17', warehouseId: wh.id,
      items: [{ productId: prod.id, qty: 1, price: 1000 }],
    });
    ok(r.status === 400 && /不支持的单据类型/.test(r.text), '未知单据类型被拒', r.text);
  }

  console.log('\n' + '='.repeat(46));
  console.log(`== ${pass} PASS / ${fail} FAIL ==`);
  if (fail) {
    console.log('失败项：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
  }
})();
