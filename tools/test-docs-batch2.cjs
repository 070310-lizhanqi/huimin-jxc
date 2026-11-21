/**
 * 回归测试：第二批 B 组（单据与库存核心）B-数2 / B-数3 / B-数6 / B-数9 / B-数10 / B-数7。
 *
 * B-数2：作废回滚客户价格记忆——按剩余已审核单重算最新价，无则删记忆行；
 *   口径与 rememberPrices 的 lastDate>= 守卫一致，sret/quo/sorder 同样覆盖。
 * B-数3：盘点单快照按 (productId, warehouseId, reservoirId, batchNo) 分组取账面数；
 *   同商品同批次两行在 validate 层直接拒绝（选了“拒绝”而非“合计分摊”）。
 *   覆盖：同商品两批各盘点、同一批次两行、只盘一个库位、盘点 0 件、盘亏定向扣批。
 * B-数6：单据总金额上限 1e11 分（与结算侧同量级），超限拒绝；负数行舍入对称
 *   （round half away from zero：-1.5→-2，与 +1.5→2 对称；-0.5→-1）。
 * B-数9：stock_ledger.unitCost——出库行按 FIFO 批次入库成本写，入库行区分成本价与售价；
 *   约束：unitCost 仅 stockin 入库行可信（成本查询的 d.type='stockin' 过滤不可少）。
 * B-数10：precheckStock 先按 (productId, warehouseId, reservoirId, batchNo) 汇总 need 再比对。
 * B-数7：jxc-stat 商品汇总走 allocateDocDiscounts；rows 与 byType 口径差异在返回里注明。
 *
 * 运行：需服务已启动（本文件不自启服务），OC_BASE 指向测试服务。
 */
const { api } = require('./test-helpers.cjs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail ? ' :: ' + JSON.stringify(detail) : '')); }
}

const D = '2026-10-20';

async function main() {
  console.log('[test-docs-batch2] 第二批 B 组：价格记忆作废回滚 / 盘点快照 / 总额上限与负数舍入 /  ledger 成本语义 / 预检汇总 / 进销存折扣口径');
  const teamId = (await api('GET', '/auth/me')).body.user.teamId;

  const wh = (await api('POST', '/warehouse', { teamId, name: 'B2测试仓' })).body;
  const wh2 = (await api('POST', '/warehouse', { teamId, name: 'B2测试二仓' })).body;
  const res1 = (await api('POST', '/reservoir', { teamId, warehouseId: wh.id, name: 'B2库位R1' })).body;
  const cus = (await api('POST', '/customer', { teamId, name: 'B2测试客户' })).body;
  const ven = (await api('POST', '/vendor', { teamId, name: 'B2测试供应商' })).body;
  if (!wh.id || !wh2.id || !res1.id || !cus.id || !ven.id) throw new Error('档案创建失败');

  const mkProd = async (name) => {
    const r = await api('POST', '/product', { teamId, name, unit: '件', salePrice: 10000, purchasePrice: 5000 });
    if (!r.body.id) throw new Error('建商品失败: ' + JSON.stringify(r.body));
    return r.body;
  };
  const mkDoc = async (type, extra, items) => {
    const r = await api('POST', '/doc/create', { teamId, type, date: D, warehouseId: wh.id, items, ...extra });
    if (r.status !== 200 || !r.body.id) throw new Error(`建单 ${type} 失败: ` + JSON.stringify(r.body));
    return r.body;
  };
  const audit = async (id) => {
    const r = await api('POST', '/doc/audit', { teamId, id });
    if (r.status !== 200) throw new Error(`审核 ${id} 失败: ` + JSON.stringify(r.body));
    return r.body;
  };
  const mkAudit = async (type, extra, items) => {
    const d = await mkDoc(type, extra, items);
    await audit(d.id);
    return d;
  };
  const stockRows = async (prodId) => {
    const r = await api('GET', `/stock/list?teamId=${teamId}&productId=${prodId}`);
    return Array.isArray(r.body) ? r.body : [];
  };
  const stockQty = async (prodId, batchNo, reservoirId) => {
    const rows = await stockRows(prodId);
    const row = rows.find((x) =>
      (batchNo === undefined || x.batchNo === batchNo) &&
      (reservoirId === undefined || x.reservoirId === reservoirId));
    return row ? row.qty : 0;
  };
  const memOf = async (prodId) => {
    const r = await api('GET', `/price/memory?teamId=${teamId}&partnerId=${cus.id}`);
    return (r.body.list || []).find((m) => m.productId === prodId) || null;
  };
  const ledgerOf = async (prodId) => {
    const r = await api('GET', `/stock/ledger?teamId=${teamId}&productId=${prodId}&rows=200&page=1`);
    return (r.body && r.body.rows) || r.body || [];
  };

  // ================= B-数2：作废回滚价格记忆 =================
  {
    const prod = await mkProd('B2价格记忆品');
    await mkAudit('stockin', { partnerType: 'ven', partnerId: ven.id }, [{ productId: prod.id, qty: 100, price: 5000 }]);
    const s1 = await mkAudit('stockout', { partnerType: 'cus', partnerId: cus.id, date: '2026-10-20' },
      [{ productId: prod.id, qty: 1, price: 10000 }]);
    let m = await memOf(prod.id);
    check('B2-数2：首单审核后记忆 10000', m && m.price === 10000, m);
    check('B2-数2：首单记忆 times=1', m && m.times === 1, m);
    const s2 = await mkAudit('stockout', { partnerType: 'cus', partnerId: cus.id, date: '2026-10-21' },
      [{ productId: prod.id, qty: 1, price: 12000 }]);
    m = await memOf(prod.id);
    check('B2-数2：次单审核后记忆 12000', m && m.price === 12000, m);
    check('B2-数2：次单记忆 times=2', m && m.times === 2, m);
    const v2 = await api('POST', '/doc/void', { teamId, id: s2.id });
    check('B2-数2：作废次单成功', v2.status === 200, v2.body);
    m = await memOf(prod.id);
    check('B2-数2：作废次单后记忆回到 10000', m && m.price === 10000, m);
    check('B2-数2：作废次单后 lastDate 回到 2026-10-20', m && m.lastDate === '2026-10-20', m);
    check('B2-数2：作废次单后 times 回到 1', m && m.times === 1, m);
    const v1 = await api('POST', '/doc/void', { teamId, id: s1.id });
    check('B2-数2：作废首单成功', v1.status === 200, v1.body);
    m = await memOf(prod.id);
    check('B2-数2：作废唯一剩余单后记忆行删除', m === null, m);

    // 作废旧单、新单记忆不受影响
    const s3 = await mkAudit('stockout', { partnerType: 'cus', partnerId: cus.id, date: '2026-10-20' },
      [{ productId: prod.id, qty: 1, price: 11000 }]);
    const s4 = await mkAudit('stockout', { partnerType: 'cus', partnerId: cus.id, date: '2026-10-21' },
      [{ productId: prod.id, qty: 1, price: 13000 }]);
    const v3 = await api('POST', '/doc/void', { teamId, id: s3.id });
    check('B2-数2：作废旧单成功', v3.status === 200, v3.body);
    m = await memOf(prod.id);
    check('B2-数2：作废旧单后记忆仍为新单 13000', m && m.price === 13000, m);
    check('B2-数2：作废旧单后 times=1（仅剩新单）', m && m.times === 1, m);

    // sret 也写记忆、作废也回滚（类型范围对齐）
    const sr = await mkAudit('sret', { partnerType: 'cus', partnerId: cus.id, date: '2026-10-22' },
      [{ productId: prod.id, qty: 1, price: 9000 }]);
    m = await memOf(prod.id);
    check('B2-数2：sret 审核后记忆 9000', m && m.price === 9000, m);
    const vsr = await api('POST', '/doc/void', { teamId, id: sr.id });
    check('B2-数2：作废 sret 成功', vsr.status === 200, vsr.body);
    m = await memOf(prod.id);
    check('B2-数2：作废 sret 后记忆回到 13000', m && m.price === 13000, m);

    // sorder 也写记忆、作废也回滚
    const so = await mkAudit('sorder', { partnerType: 'cus', partnerId: cus.id, date: '2026-10-23' },
      [{ productId: prod.id, qty: 1, price: 14000 }]);
    m = await memOf(prod.id);
    check('B2-数2：sorder 审核后记忆 14000', m && m.price === 14000, m);
    const vso = await api('POST', '/doc/void', { teamId, id: so.id });
    check('B2-数2：作废 sorder 成功', vso.status === 200, vso.body);
    m = await memOf(prod.id);
    check('B2-数2：作废 sorder 后记忆回到 13000', m && m.price === 13000, m);
    // 清理：作废 s4，记忆清空，不影响后续用例
    await api('POST', '/doc/void', { teamId, id: s4.id });
    m = await memOf(prod.id);
    check('B2-数2：清理作废后记忆清空', m === null, m);
  }

  // ================= B-数3：盘点单快照 =================
  {
    // 同商品两批各盘点：实盘与账面一致，应无差异、库存不动
    const prod = await mkProd('B2盘点两批品');
    await mkAudit('stockin', { partnerType: 'ven', partnerId: ven.id }, [
      { productId: prod.id, qty: 90, price: 1000, batchNo: 'A' },
      { productId: prod.id, qty: 10, price: 1000, batchNo: 'B' },
    ]);
    const st = await mkDoc('stocktake', {}, [
      { productId: prod.id, qty: 90, price: 0, batchNo: 'A' },
      { productId: prod.id, qty: 10, price: 0, batchNo: 'B' },
    ]);
    const a1 = await api('POST', '/doc/audit', { teamId, id: st.id });
    check('B2-数3：两批各盘点审核成功（旧口径会在此报库存不足）', a1.status === 200, a1.body);
    check('B2-数3：两批盘点后 A 批仍 90', (await stockQty(prod.id, 'A')) === 90, await stockRows(prod.id));
    check('B2-数3：两批盘点后 B 批仍 10', (await stockQty(prod.id, 'B')) === 10, await stockRows(prod.id));

    // 同一商品同一批次两行：validate 直接拒绝
    const dup = await api('POST', '/doc/create', {
      teamId, type: 'stocktake', date: D, warehouseId: wh.id,
      items: [
        { productId: prod.id, qty: 50, price: 0, batchNo: 'A' },
        { productId: prod.id, qty: 40, price: 0, batchNo: 'A' },
      ],
    });
    check('B2-数3：同一批次两行建单被拒', dup.status === 400, dup.body);
    check('B2-数3：拒绝文案提示同一批次/合并', typeof dup.body.error === 'string' && /同一批次|合并/.test(dup.body.error), dup.body);

    // 只盘一个库位：账面只算该库位，不含其他库位
    const prod2 = await mkProd('B2盘点库位品');
    await mkAudit('stockin', { partnerType: 'ven', partnerId: ven.id }, [
      { productId: prod2.id, qty: 100, price: 1000, batchNo: 'B1', reservoirId: res1.id },
      { productId: prod2.id, qty: 50, price: 1000, batchNo: 'B1' },
    ]);
    const st2 = await mkDoc('stocktake', {}, [{ productId: prod2.id, qty: 100, price: 0, batchNo: 'B1', reservoirId: res1.id }]);
    const a2 = await api('POST', '/doc/audit', { teamId, id: st2.id });
    check('B2-数3：只盘一个库位审核成功', a2.status === 200, a2.body);
    check('B2-数3：只盘库位后该库位仍 100', (await stockQty(prod2.id, 'B1', res1.id)) === 100, await stockRows(prod2.id));
    check('B2-数3：只盘库位后另一库位仍 50', (await stockQty(prod2.id, 'B1', null)) === 50, await stockRows(prod2.id));

    // 盘点 0 件：实盘 0、账面 90 → 盘亏 90 出库
    const prod3 = await mkProd('B2盘点零件品');
    await mkAudit('stockin', { partnerType: 'ven', partnerId: ven.id }, [{ productId: prod3.id, qty: 90, price: 1000, batchNo: 'A' }]);
    const st3 = await mkDoc('stocktake', {}, [{ productId: prod3.id, qty: 0, price: 0, batchNo: 'A' }]);
    const a3 = await api('POST', '/doc/audit', { teamId, id: st3.id });
    check('B2-数3：盘点 0 件审核成功', a3.status === 200, a3.body);
    check('B2-数3：盘点 0 件后库存为 0', (await stockQty(prod3.id, 'A')) === 0, await stockRows(prod3.id));

    // 盘亏定向扣批：A 盘亏 10 只扣 A 批，B 批不动
    const prod4 = await mkProd('B2盘点盘亏品');
    await mkAudit('stockin', { partnerType: 'ven', partnerId: ven.id }, [
      { productId: prod4.id, qty: 90, price: 1000, batchNo: 'A' },
      { productId: prod4.id, qty: 10, price: 1000, batchNo: 'B' },
    ]);
    const st4 = await mkDoc('stocktake', {}, [
      { productId: prod4.id, qty: 80, price: 0, batchNo: 'A' },
      { productId: prod4.id, qty: 10, price: 0, batchNo: 'B' },
    ]);
    const a4 = await api('POST', '/doc/audit', { teamId, id: st4.id });
    check('B2-数3：盘亏单审核成功', a4.status === 200, a4.body);
    check('B2-数3：盘亏后 A 批 80（只扣 A）', (await stockQty(prod4.id, 'A')) === 80, await stockRows(prod4.id));
    check('B2-数3：盘亏后 B 批仍 10', (await stockQty(prod4.id, 'B')) === 10, await stockRows(prod4.id));
  }

  // ================= B-数6：总额上限 + 负数行舍入 =================
  {
    const prod = await mkProd('B2总额上限品');
    const huge = await api('POST', '/doc/create', {
      teamId, type: 'stockout', date: D, partnerType: 'cus', partnerId: cus.id, warehouseId: wh.id,
      items: [{ productId: prod.id, qty: 9999999, price: 9999999 }],
    });
    check('B2-数6：单行约 1e14 分建单被拒', huge.status === 400, huge.body);
    check('B2-数6：超限文案提示上限', typeof huge.body.error === 'string' && /上限/.test(huge.body.error), huge.body);

    // 边界：总额恰好 1e11 分（20000 × 5000000）应放行
    const edge = await api('POST', '/doc/create', {
      teamId, type: 'stockout', date: D, partnerType: 'cus', partnerId: cus.id, warehouseId: wh.id,
      items: [{ productId: prod.id, qty: 20000, price: 5000000 }],
    });
    check('B2-数6：总额恰好 1e11 分建单放行', edge.status === 200 && !!edge.body.id, edge.body);
    if (edge.body.id) await api('DELETE', `/doc/${edge.body.id}?teamId=${teamId}`);

    // 编辑路径同样受上限约束
    const normal = await mkDoc('stockout', { partnerType: 'cus', partnerId: cus.id },
      [{ productId: prod.id, qty: 1, price: 10000 }]);
    const editHuge = await api('PUT', '/doc/edit', {
      id: normal.id, teamId, type: 'stockout', date: D, partnerType: 'cus', partnerId: cus.id, warehouseId: wh.id,
      items: [{ productId: prod.id, qty: 9999999, price: 9999999 }],
    });
    check('B2-数6：编辑改成超限总额被拒', editHuge.status === 400, editHuge.body);

    // 负数行舍入对称：-0.0001 × 5000 分 = -0.5 分 → -1 分（旧 Math.round 得 0）
    const neg = await mkDoc('assembly', {}, [{ productId: prod.id, qty: -0.0001, price: 5000 }]);
    const negInfo = (await api('GET', `/doc/info?teamId=${teamId}&id=${neg.id}`)).body;
    check('B2-数6：负数行 -0.5 分对称舍入为 -1', negInfo.items && negInfo.items[0].amount === -1, negInfo.items);
    // 正数对照：+0.5 分 → +1 分
    const pos = await mkDoc('assembly', {}, [{ productId: prod.id, qty: 0.0001, price: 5000 }]);
    const posInfo = (await api('GET', `/doc/info?teamId=${teamId}&id=${pos.id}`)).body;
    check('B2-数6：正数行 +0.5 分舍入为 +1', posInfo.items && posInfo.items[0].amount === 1, posInfo.items);

    // 转化路径回归：正常订单转化仍成功（总额上限不误伤正常单）
    const ord = await mkAudit('sorder', { partnerType: 'cus', partnerId: cus.id },
      [{ productId: prod.id, qty: 2, price: 10000 }]);
    const cv = await api('POST', '/doc/convert', { teamId, id: ord.id });
    check('B2-数6：正常订单转化成功', cv.status === 200 && !!cv.body.id, cv.body);
  }

  // ================= B-数9：unitCost 语义 =================
  {
    const prod = await mkProd('B2成本语义品');
    const si = await mkAudit('stockin', { partnerType: 'ven', partnerId: ven.id }, [
      { productId: prod.id, qty: 10, price: 1000, batchNo: 'A' },
      { productId: prod.id, qty: 10, price: 2000, batchNo: 'B' },
    ]);
    const so = await mkAudit('stockout', { partnerType: 'cus', partnerId: cus.id },
      [{ productId: prod.id, qty: 5, price: 5000 }]);
    const rows = await ledgerOf(prod.id);
    const outRow = rows.find((r) => r.refDocId === so.id && r.direction === 'out');
    check('B2-数9：出库行 unitCost 为 FIFO 批次入库成本 1000（非售价 5000）', !!outRow && outRow.unitCost === 1000, outRow);
    const inRows = rows.filter((r) => r.refDocId === si.id && r.direction === 'in');
    check('B2-数9：采购入库行 unitCost 为成本价 1000/2000', inRows.length === 2 && inRows.some((r) => r.unitCost === 1000) && inRows.some((r) => r.unitCost === 2000), inRows);

    // 销售退货入库行记的是售价，不是成本
    const sr = await mkAudit('sret', { partnerType: 'cus', partnerId: cus.id },
      [{ productId: prod.id, qty: 2, price: 5000 }]);
    const rows2 = await ledgerOf(prod.id);
    const sretIn = rows2.find((r) => r.refDocId === sr.id && r.direction === 'in');
    check('B2-数9：销售退货入库行 unitCost 为售价 5000（非成本）', !!sretIn && sretIn.unitCost === 5000, sretIn);

    // 约束测试：只有 stockin 入库行可信——按 refDocId 区分的加权均价
    const stockinIds = new Set([si.id]);
    const ins = rows2.filter((r) => r.direction === 'in');
    const avgAll = ins.reduce((s, r) => s + r.qty * r.unitCost, 0) / ins.reduce((s, r) => s + r.qty, 0);
    const insStockin = ins.filter((r) => stockinIds.has(r.refDocId));
    const avgStockin = insStockin.reduce((s, r) => s + r.qty * r.unitCost, 0) / insStockin.reduce((s, r) => s + r.qty, 0);
    check('B2-数9：仅 stockin 入库行加权均价为 1500', avgStockin === 1500, { avgStockin, avgAll });
    check('B2-数9：不加类型过滤的入库均价被售价行污染（≠1500）', avgAll !== 1500, { avgStockin, avgAll });

    // 调拨行也按 FIFO 成本写（原先写填入价 0）
    const tr = await mkAudit('transfer', {}, [{ productId: prod.id, qty: 3, price: 0, toWarehouseId: wh2.id }]);
    const rows3 = await ledgerOf(prod.id);
    const trOut = rows3.find((r) => r.refDocId === tr.id && r.direction === 'out');
    const trIn = rows3.find((r) => r.refDocId === tr.id && r.direction === 'in');
    check('B2-数9：调拨出库行 unitCost 为 FIFO 成本 1000（非填入价 0）', !!trOut && trOut.unitCost === 1000, trOut);
    check('B2-数9：调拨入库行 unitCost 与出库同批成本一致', !!trIn && trIn.unitCost === 1000, trIn);
  }

  // ================= B-数10：预检汇总 =================
  {
    const prod = await mkProd('B2预检汇总品');
    await mkAudit('stockin', { partnerType: 'ven', partnerId: ven.id }, [{ productId: prod.id, qty: 10, price: 1000 }]);
    // 同商品两行各 6 件、库存 10 件：逐行预检会假通过，汇总后必须拒绝
    const bad = await mkDoc('stockout', { partnerType: 'cus', partnerId: cus.id }, [
      { productId: prod.id, qty: 6, price: 10000 },
      { productId: prod.id, qty: 6, price: 10000 },
    ]);
    const badAudit = await api('POST', '/doc/audit', { teamId, id: bad.id });
    check('B2-数10：同商品两行合计 12 > 库存 10，审核被拒', badAudit.status === 400, badAudit.body);
    check('B2-数10：拒绝文案为库存不足', typeof badAudit.body.error === 'string' && /库存不足/.test(badAudit.body.error), badAudit.body);
    check('B2-数10：假通过未扣库存，仍为 10', (await stockQty(prod.id)) === 10, await stockRows(prod.id));

    // 多批次：A 6 + B 6，各批 10 件，应通过
    const prod2 = await mkProd('B2预检多批品');
    await mkAudit('stockin', { partnerType: 'ven', partnerId: ven.id }, [
      { productId: prod2.id, qty: 10, price: 1000, batchNo: 'A' },
      { productId: prod2.id, qty: 10, price: 1000, batchNo: 'B' },
    ]);
    const good = await mkDoc('stockout', { partnerType: 'cus', partnerId: cus.id }, [
      { productId: prod2.id, qty: 6, price: 10000, batchNo: 'A' },
      { productId: prod2.id, qty: 6, price: 10000, batchNo: 'B' },
    ]);
    const goodAudit = await api('POST', '/doc/audit', { teamId, id: good.id });
    check('B2-数10：多批次各 6 件审核通过', goodAudit.status === 200, goodAudit.body);
    check('B2-数10：多批次审核后 A 剩 4', (await stockQty(prod2.id, 'A')) === 4, await stockRows(prod2.id));
    check('B2-数10：多批次审核后 B 剩 4', (await stockQty(prod2.id, 'B')) === 4, await stockRows(prod2.id));
    // 同一批次两行合计超量：A 剩 4，两行各 3 → 合计 6 > 4，拒绝
    const bad2 = await mkDoc('stockout', { partnerType: 'cus', partnerId: cus.id }, [
      { productId: prod2.id, qty: 3, price: 10000, batchNo: 'A' },
      { productId: prod2.id, qty: 3, price: 10000, batchNo: 'A' },
    ]);
    const bad2Audit = await api('POST', '/doc/audit', { teamId, id: bad2.id });
    check('B2-数10：同一批次两行合计 6 > 剩余 4，审核被拒', bad2Audit.status === 400, bad2Audit.body);
  }

  // ================= B-数7：进销存统计折扣口径 =================
  {
    const p1 = await mkProd('B2折扣口径品1');
    const p2 = await mkProd('B2折扣口径品2');
    const p3 = await mkProd('B2折扣口径品3');
    for (const p of [p1, p2, p3]) {
      await mkAudit('stockin', { partnerType: 'ven', partnerId: ven.id }, [{ productId: p.id, qty: 20, price: 1000 }]);
    }
    // 两商品单：毛额各 10000，折扣 2000 → 各净 9000
    await mkAudit('stockout', { partnerType: 'cus', partnerId: cus.id, discount: 2000 }, [
      { productId: p1.id, qty: 1, price: 10000 },
      { productId: p2.id, qty: 1, price: 10000 },
    ]);
    // 三商品单：毛额各 10000，折扣 100 → 分摊 33/33/33，尾差 1 归首行（最大行并列取首行）
    await mkAudit('stockout', { partnerType: 'cus', partnerId: cus.id, discount: 100 }, [
      { productId: p1.id, qty: 1, price: 10000 },
      { productId: p2.id, qty: 1, price: 10000 },
      { productId: p3.id, qty: 1, price: 10000 },
    ]);
    const stat = (await api('GET', `/report/jxc-stat?teamId=${teamId}&from=2026-10-01&to=2026-10-31`)).body;
    const rowOf = (pid) => (stat.rows || []).find((r) => r.productId === pid);
    check('B2-数7：商品1出库净额 9000+9966=18966', rowOf(p1.id) && rowOf(p1.id).outAmount === 18966, rowOf(p1.id));
    check('B2-数7：商品2出库净额 9000+9967=18967', rowOf(p2.id) && rowOf(p2.id).outAmount === 18967, rowOf(p2.id));
    check('B2-数7：商品3出库净额 9967', rowOf(p3.id) && rowOf(p3.id).outAmount === 9967, rowOf(p3.id));
    check('B2-数7：商品1入库毛额仍为 20000（采购无折扣）', rowOf(p1.id) && rowOf(p1.id).inAmount === 20000, rowOf(p1.id));
    check('B2-数7：返回注明 rows 与 byType 口径差异', typeof stat.scopeNote === 'string' && /调拨|transfer/.test(stat.scopeNote), stat.scopeNote);
  }

  console.log(`[test-docs-batch2] 通过 ${pass} / ${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('[test-docs-batch2] 异常:', e.message); process.exit(1); });
