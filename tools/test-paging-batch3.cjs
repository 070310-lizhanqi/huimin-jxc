/**
 * 回归测试：B-前2 服务端分页 + B-前3 轻量库存接口（第三批第二波 W3）。
 *
 * 覆盖：
 *  §1 /product 分页（crud.ts page/rows 模式）：分页对象形状、页内容正确且无重叠、
 *     total 与全量一致、kw+分页、越界页、rows 单独传仍返回数组（兼容 test-backup-db-batch2
 *     与 test-gzip-batch3 的 rows=500 用法）。
 *  §2 /stock/list 分页（明细 GROUP BY 口径）：分页对象形状、页内容正确、合计行 totalQty/
 *     totalValue/lowCount 与全量一致、onlyLow/排序分页后正确、ifShowZero、越界页、
 *     rows 单独传仍返回数组（兼容 test-doc-import*.cjs 的 rows=50 用法）。
 *  §3 /stock/list group=prod（按商品汇总分页）：每商品一行、合计行与全量一致、
 *     onlyLow/排序分页后正确。
 *  §4 /stock/qty-by-product 新接口：只返回 productId,qty 两列、与全量口径一致、
 *     仓库过滤、参数校验。
 *  §5 规模对比（2000 商品 / 5000 库存行）：全量 vs 分页第 1 页的响应字节数与耗时；
 *     换仓全量 vs 轻量接口字节数。只打印数字 + 断言量级关系，不做脆弱的耗时断言。
 *
 * 数据准备：商品走 /product/import（每批上限 1000 行，分 2 批）；库存行走直连 SQLite
 * 批量插入（与 /stock/list 读同一张 stock 表，口径与单据审核落库一致；5000 行走单据
 * 审核太慢且无必要）。清理：finally 里按 tag 前缀删本轮库存行与商品，并核对行数回到跑前。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { api, authHeader } = require('./test-helpers.cjs');
const OC_BASE = process.env.OC_BASE || 'http://127.0.0.1:7741/api';

// ---------- 本轮清理：直连 SQLite，按 tag 前缀删本轮商品与库存行 ----------
const DATA_DIR = process.env.ORANGE_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'huimin-clone.db');
const CLEAN_TABLES = ['product', 'stock'];
let runTag = '';
function openTestDb() {
  if (!fs.existsSync(DB_PATH)) throw new Error('数据库文件不存在：' + DB_PATH + '（是否漏设 ORANGE_DATA_DIR？）');
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}
function countAll(db) {
  const out = {};
  for (const t of CLEAN_TABLES) {
    try { out[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; }
    catch { out[t] = -1; }
  }
  return out;
}
function cleanupAndVerify(before) {
  let db = null;
  try {
    db = openTestDb();
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      // 先删库存行（按商品 tag），再删商品
      db.prepare(`DELETE FROM stock WHERE productId IN (SELECT id FROM product WHERE teamId = 1 AND name LIKE ?)`).run(`${runTag}%`);
      db.prepare('DELETE FROM product WHERE teamId = 1 AND name LIKE ?').run(`${runTag}%`);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
    const after = countAll(db);
    const allBack = CLEAN_TABLES.every((t) => before[t] === after[t]);
    check('清理：跑后商品/库存行数回到跑前', allBack, { before, after });
  } catch (e) {
    check('清理：删除本轮商品与库存行', false, String((e && e.message) || e));
  } finally {
    try { if (db) db.close(); } catch { /* ignore */ }
  }
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : '')); }
}

async function getJson(p) {
  const h = await authHeader();
  const t0 = Date.now();
  const r = await fetch(`${OC_BASE}${p}`, { headers: h });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { status: r.status, body, bytes: Buffer.byteLength(text), ms: Date.now() - t0 };
}
function rowsOf(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.rows)) return body.rows;
  return null;
}
/** 分页对象的 rows（未分页时为 null，避免旧代码返回数组时直接 .rows.length 抛错） */
function pgRows(b) { return b && Array.isArray(b.rows) ? b.rows : null; }

async function mainBody() {
  console.log('[test-paging-batch3] B-前2 分页 + B-前3 /stock/qty-by-product');
  const t0 = Date.now();
  const tag = `B3W${Date.now().toString(36)}`;
  runTag = tag;

  // ---------- §0 数据准备：2000 商品（2 批导入）+ 5000 库存行（直连插入） ----------
  const whs = (await api('GET', '/warehouse?teamId=1')).body;
  if (!Array.isArray(whs) || whs.length < 2) throw new Error('需要至少 2 个仓库做分组，请先 rebuild-clean');
  const whA = whs[0], whB = whs[1];
  const N_PROD = 2000;
  // 既有库存快照（全量回归里前面的脚本会留下库存行/低库存商品，期望值必须相对化，
  // 不能假设库里只有本轮数据；快照取自同一份全量 /stock/list，口径与断言一致）
  const stockBefore = await getJson('/stock/list?teamId=1');
  const stockBeforeRows = Array.isArray(stockBefore.body) ? stockBefore.body : [];
  const stockBeforeCount = stockBeforeRows.length;
  const stockBeforeQty = stockBeforeRows.reduce((a, r) => a + (r.qty || 0), 0);
  const stockBeforeValue = stockBeforeRows.reduce((a, r) => a + (r.qty || 0) * (r.estUnitCost || 0), 0);
  const stockBeforeProdIds = new Set(stockBeforeRows.map((r) => r.productId));
  const stockBeforeWhQty = {};
  const stockBeforeWhRows = {};
  const stockBeforeWhProds = {};
  for (const r of stockBeforeRows) {
    stockBeforeWhQty[r.warehouseId] = (stockBeforeWhQty[r.warehouseId] || 0) + (r.qty || 0);
    stockBeforeWhRows[r.warehouseId] = (stockBeforeWhRows[r.warehouseId] || 0) + 1;
    (stockBeforeWhProds[r.warehouseId] = stockBeforeWhProds[r.warehouseId] || new Set()).add(r.productId);
  }
  const stockBeforeNonZero = stockBeforeRows.filter((r) => r.qty !== 0).length;
  // 既有低库存商品（商品级总量 <= 安全库存）：从快照按商品汇总后判定
  const beforeProdQty = {};
  const beforeProdLow = {};
  for (const r of stockBeforeRows) {
    beforeProdQty[r.productId] = (beforeProdQty[r.productId] || 0) + (r.qty || 0);
    if (r.lowQty > 0) beforeProdLow[r.productId] = r.lowQty;
  }
  const lowProdBeforeIds = new Set(Object.keys(beforeProdQty).map(Number).filter((id) => beforeProdLow[id] != null && beforeProdQty[id] <= beforeProdLow[id] && (beforeProdQty[id] !== 0 || true)));
  // 注意：ifShowZero=0 时总量为 0 的低商品不计入 lowCount（与服务端 HAVING 口径一致），
  // 上面集合含零总量商品；下面 lowCountBefore 按“总量 != 0 或总量为 0 但行非零”不拆分——
  // 零总量低商品在既有数据里极少见，且断言用 lowCountBefore 时只用于默认 ifShowZero=1 的口径
  const lowCountBefore = lowProdBeforeIds.size;
  const lowBeforeRows = stockBeforeRows.filter((r) => lowProdBeforeIds.has(r.productId)).length;
  const qtyABeforeCount = (stockBeforeWhProds[whA.id] || new Set()).size;
  const qtyABeforeSum = stockBeforeWhQty[whA.id] || 0;
  const qtyBBeforeCount = (stockBeforeWhProds[whB.id] || new Set()).size;
  const qtyBBeforeSum = stockBeforeWhQty[whB.id] || 0;
  const approx = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
  console.log(`  [info] 既有库存快照：${stockBeforeCount} 行，totalQty=${stockBeforeQty}，低库存商品 ${lowCountBefore} 个（低库存行 ${lowBeforeRows} 条）`);
  // 导入前商品总数（直连 DB 读，避免 /product 的 500 行兜底截断）
  const prodDb0 = openTestDb();
  const prodBefore = prodDb0.prepare('SELECT COUNT(*) AS c FROM product WHERE teamId = 1').get().c;
  prodDb0.close();
  const expectedProdTotal = prodBefore + N_PROD;
  // 低库存设计：商品 0..99 lowQty=1000（总量 ≤60，必低）；100..199 lowQty=1（总量 ≥2，不低）；其余 0
  const lowQtyOf = (i) => (i < 100 ? 1000 : i < 200 ? 1 : 0);
  for (let batch = 0; batch < 2; batch++) {
    const rows = [];
    for (let i = batch * 1000; i < (batch + 1) * 1000; i++) {
      rows.push({
        name: `${tag}P${String(i).padStart(4, '0')}`, catName: '', unit: '件',
        purchasePrice: '5.00', salePrice: '10.00', retailPrice: '12.00', wholePrice: '9.00',
        lowQty: String(lowQtyOf(i)),
      });
    }
    const imp = await api('POST', '/product/import', { teamId: 1, rows });
    check(`§0 前置：导入商品第 ${batch + 1} 批 1000 行`, imp.status === 200 && imp.body.success === 1000, { status: imp.status, success: imp.body && imp.body.success });
  }
  // 读回本轮商品 id（按 tag 前缀直连查，避免 /product 的 500 行兜底截断）
  const db = openTestDb();
  const prodIds = db.prepare('SELECT id FROM product WHERE teamId = 1 AND name LIKE ? ORDER BY name').all(`${tag}%`).map((r) => r.id);
  check('§0 前置：读回 2000 个本轮商品 id', prodIds.length === N_PROD, prodIds.length);
  // 库存行：每商品 A/B 各 1 行（4000）+ 商品 0..989 在 A 仓多一个批次行（990）
  //         + 商品 1000..1009 在 A 仓 1 行零库存（10）= 5000 行；qty 用 (i%20)+1 确定性取值
  let expectedTotalQty = 0;
  const expectedWhQty = { [whA.id]: 0, [whB.id]: 0 };
  const ins = db.prepare('INSERT INTO stock (teamId, productId, warehouseId, reservoirId, batchNo, qty) VALUES (1, ?, ?, NULL, ?, ?)');
  db.exec('BEGIN');
  try {
    for (let i = 0; i < N_PROD; i++) {
      const qA = (i % 20) + 1, qB = ((i + 7) % 20) + 1;
      ins.run(prodIds[i], whA.id, null, qA);
      ins.run(prodIds[i], whB.id, null, qB);
      expectedTotalQty += qA + qB;
      expectedWhQty[whA.id] += qA;
      expectedWhQty[whB.id] += qB;
      if (i < 990) {
        const qX = ((i + 3) % 20) + 1;
        ins.run(prodIds[i], whA.id, 'B1', qX);
        expectedTotalQty += qX;
        expectedWhQty[whA.id] += qX;
      }
      if (i >= 1000 && i < 1010) {
        ins.run(prodIds[i], whA.id, 'Z0', 0);
      }
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
  db.close();
  // 全量口径：进价 5.00 元 = 500 分（无入库单据，均价子查询为 NULL，回落 purchasePrice）
  const expectedTotalValue = expectedTotalQty * 500;
  const expectedRows = 5000;
  const expectedStockProdTotal = N_PROD; // 每个商品都有库存行
  const expectedLowCount = 100; // 商品 0..99
  const expectedLowRows = 300; // 低商品每商品 3 行（A、B、A-批次），本轮新增
  const expectedNonZeroRows = expectedRows - 10;
  console.log(`  [info] 规模：商品 ${N_PROD}，库存行 ${expectedRows}，期望 totalQty=${expectedTotalQty}，totalValue=${expectedTotalValue} 分，低库存商品 ${expectedLowCount} 个`);

  // ---------- §1 /product 分页 ----------
  const p1 = await getJson('/product?teamId=1&page=1&rows=50');
  check('§1 分页返回对象形状 {rows,total,page,rowsPerPage}', p1.status === 200 && p1.body && Array.isArray(p1.body.rows) && typeof p1.body.total === 'number' && p1.body.page === 1 && p1.body.rowsPerPage === 50,
    { status: p1.status, keys: p1.body && Object.keys(p1.body), total: p1.body && p1.body.total });
  const prodTotal = p1.body ? p1.body.total : -1;
  check('§1 total = 跑前商品数 + 2000', prodTotal === expectedProdTotal, { total: prodTotal, expected: expectedProdTotal });
  let allProdIds = [];
  let prodPagesOk = !!(pgRows(p1.body) && pgRows(p1.body).length === 50);
  if (p1.body && Array.isArray(p1.body.rows)) {
    const pages = Math.ceil(prodTotal / 50);
    for (let pg = 1; pg <= pages; pg++) {
      const r = pg === 1 ? p1 : await getJson(`/product?teamId=1&page=${pg}&rows=50`);
      if (!r.body || !Array.isArray(r.body.rows)) { prodPagesOk = false; break; }
      allProdIds.push(...r.body.rows.map((x) => x.id));
    }
    const lastLen = allProdIds.length - (pages - 1) * 50;
    check('§1 逐页取回全部行、id 无重叠、末页行数正确', prodPagesOk && allProdIds.length === prodTotal && new Set(allProdIds).size === prodTotal && lastLen === prodTotal - (pages - 1) * 50,
      { got: allProdIds.length, total: prodTotal, uniq: new Set(allProdIds).size, lastLen });
  } else {
    check('§1 逐页取回全部行、id 无重叠、末页行数正确', false, '第 1 页未返回分页对象');
  }
  const pOver = await getJson(`/product?teamId=1&page=999&rows=50`);
  check('§1 越界页返回空 rows 且 total 不变', pOver.status === 200 && pgRows(pOver.body) && pgRows(pOver.body).length === 0 && pOver.body.total === prodTotal, { status: pOver.status, rows: pgRows(pOver.body) && pgRows(pOver.body).length, total: pOver.body && pOver.body.total });
  const pRowsOnly = await getJson('/product?teamId=1&rows=50');
  check('§1 只传 rows（不传 page）仍返回数组（兼容旧调用）', pRowsOnly.status === 200 && Array.isArray(pRowsOnly.body) && pRowsOnly.body.length === 50, { status: pRowsOnly.status, isArray: Array.isArray(pRowsOnly.body), len: pRowsOnly.body && pRowsOnly.body.length });
  const pKw = await getJson(`/product?teamId=1&kw=${tag}&page=1&rows=50`);
  check('§1 kw+分页：total=2000 且当页全是本轮商品', pKw.status === 200 && pKw.body && pKw.body.total === N_PROD && pgRows(pKw.body) && pgRows(pKw.body).length === 50 && pgRows(pKw.body).every((x) => String(x.name || '').startsWith(tag)),
    { status: pKw.status, total: pKw.body && pKw.body.total, len: pgRows(pKw.body) && pgRows(pKw.body).length });
  const pClamp = await getJson('/product?teamId=1&page=0&rows=1000');
  check('§1 page=0 回落第 1 页、rows=1000 钳制到 500', pClamp.status === 200 && pClamp.body && pClamp.body.page === 1 && pClamp.body.rowsPerPage === 500 && pgRows(pClamp.body) && pgRows(pClamp.body).length === 500,
    { status: pClamp.status, page: pClamp.body && pClamp.body.page, rpp: pClamp.body && pClamp.body.rowsPerPage, len: pgRows(pClamp.body) && pgRows(pClamp.body).length });

  // ---------- §2 /stock/list 分页（明细口径） ----------
  const sFull = await getJson('/stock/list?teamId=1');
  const fullRows = rowsOf(sFull.body);
  check('§2 全量（不带 page）仍返回数组：既有行 + 5000', sFull.status === 200 && Array.isArray(fullRows) && fullRows.length === stockBeforeCount + expectedRows, { status: sFull.status, len: fullRows && fullRows.length, before: stockBeforeCount });
  const fullQty = fullRows ? fullRows.reduce((s, r) => s + (r.qty || 0), 0) : -1;
  check('§2 全量合计 qty 与插入期望一致', approx(fullQty, stockBeforeQty + expectedTotalQty, 1e-6), { fullQty, expected: stockBeforeQty + expectedTotalQty });
  const s1 = await getJson('/stock/list?teamId=1&page=1&rows=100');
  check('§2 分页返回对象形状 {rows,total,page,rowsPerPage,totals}', s1.status === 200 && s1.body && Array.isArray(s1.body.rows) && s1.body.total === stockBeforeCount + expectedRows && s1.body.page === 1 && s1.body.rowsPerPage === 100 && s1.body.totals,
    { status: s1.status, total: s1.body && s1.body.total, totals: s1.body && s1.body.totals });
  check('§2 合计行 totalQty 与全量一致', s1.body && s1.body.totals && approx(s1.body.totals.totalQty, stockBeforeQty + expectedTotalQty, 1e-6), s1.body && s1.body.totals);
  check('§2 合计行 totalValue 与全量一致（既有货值 + qty×500 分）', s1.body && s1.body.totals && approx(s1.body.totals.totalValue, stockBeforeValue + expectedTotalValue), s1.body && s1.body.totals);
  check('§2 合计行 lowCount=既有低库存商品 + 100', s1.body && s1.body.totals && s1.body.totals.lowCount === lowCountBefore + expectedLowCount, s1.body && s1.body.totals);
  let allStockKeys = [];
  let stockQtySum = 0;
  let myStockKeys = [];
  let myStockQtySum = 0;
  let stockPagesOk = !!(s1.body && Array.isArray(s1.body.rows));
  if (stockPagesOk) {
    const pages = Math.ceil((stockBeforeCount + expectedRows) / 100);
    for (let pg = 1; pg <= pages; pg++) {
      const r = pg === 1 ? s1 : await getJson(`/stock/list?teamId=1&page=${pg}&rows=100`);
      if (!r.body || !Array.isArray(r.body.rows)) { stockPagesOk = false; break; }
      for (const row of r.body.rows) {
        allStockKeys.push([row.productId, row.warehouseId, row.reservoirId || 0, row.batchNo || ''].join('|'));
        stockQtySum += row.qty || 0;
        if (prodIds.includes(row.productId)) {
          myStockKeys.push([row.productId, row.warehouseId, row.reservoirId || 0, row.batchNo || ''].join('|'));
          myStockQtySum += row.qty || 0;
        }
      }
    }
    check('§2 逐页取回全部行、分组键无重叠、本轮 5000 行 qty 之和 = totalQty', stockPagesOk && allStockKeys.length === stockBeforeCount + expectedRows && new Set(allStockKeys).size === stockBeforeCount + expectedRows && myStockKeys.length === expectedRows && new Set(myStockKeys).size === expectedRows && approx(myStockQtySum, expectedTotalQty, 1e-6),
      { got: allStockKeys.length, uniq: new Set(allStockKeys).size, myGot: myStockKeys.length, myQtySum: myStockQtySum });
  } else {
    check('§2 逐页取回全部行、分组键无重叠、本轮 5000 行 qty 之和 = totalQty', false, '第 1 页未返回分页对象');
  }
  const sOver = await getJson('/stock/list?teamId=1&page=999&rows=100');
  check('§2 越界页返回空 rows 且 total/totals 不变', sOver.status === 200 && pgRows(sOver.body) && pgRows(sOver.body).length === 0 && sOver.body.total === stockBeforeCount + expectedRows && sOver.body.totals && approx(sOver.body.totals.totalQty, stockBeforeQty + expectedTotalQty, 1e-6),
    { status: sOver.status, rows: pgRows(sOver.body) && pgRows(sOver.body).length });
  const sRowsOnly = await getJson('/stock/list?teamId=1&rows=50');
  check('§2 只传 rows（不传 page）仍返回全量数组（兼容旧调用）', sRowsOnly.status === 200 && Array.isArray(sRowsOnly.body) && sRowsOnly.body.length === stockBeforeCount + expectedRows, { status: sRowsOnly.status, isArray: Array.isArray(sRowsOnly.body), len: sRowsOnly.body && sRowsOnly.body.length });
  const sZero = await getJson('/stock/list?teamId=1&ifShowZero=0&page=1&rows=10');
  check('§2 ifShowZero=0：total=既有非零行 + 4990 且当页无零库存行', sZero.status === 200 && sZero.body && sZero.body.total === stockBeforeNonZero + expectedNonZeroRows && pgRows(sZero.body) && pgRows(sZero.body).every((r) => r.qty !== 0),
    { status: sZero.status, total: sZero.body && sZero.body.total, len: pgRows(sZero.body) && pgRows(sZero.body).length });
  const sLow = await getJson(`/stock/list?teamId=1&onlyLow=1&page=1&rows=500`);
  check('§2 onlyLow=1：total=既有低库存行 + 300 且当页全是低商品', sLow.status === 200 && sLow.body && sLow.body.total === lowBeforeRows + expectedLowRows && pgRows(sLow.body) && pgRows(sLow.body).length === lowBeforeRows + expectedLowRows && pgRows(sLow.body).every((r) => lowProdBeforeIds.has(r.productId) || prodIds.indexOf(r.productId) < 100),
    { status: sLow.status, total: sLow.body && sLow.body.total, len: pgRows(sLow.body) && pgRows(sLow.body).length });
  const sDesc = await getJson('/stock/list?teamId=1&sort=qtyDesc&page=1&rows=100');
  const descOk = pgRows(sDesc.body) && pgRows(sDesc.body).length === 100 && pgRows(sDesc.body).every((r, i, a) => i === 0 || (a[i - 1].qty || 0) >= (r.qty || 0));
  check('§2 sort=qtyDesc：当页按 qty 降序', sDesc.status === 200 && descOk, { status: sDesc.status, first: pgRows(sDesc.body) && pgRows(sDesc.body)[0] && pgRows(sDesc.body)[0].qty, last: pgRows(sDesc.body) && pgRows(sDesc.body)[99] && pgRows(sDesc.body)[99].qty });
  const sAsc = await getJson('/stock/list?teamId=1&sort=qtyAsc&page=1&rows=100');
  const ascOk = pgRows(sAsc.body) && pgRows(sAsc.body).length === 100 && pgRows(sAsc.body).every((r, i, a) => i === 0 || (a[i - 1].qty || 0) <= (r.qty || 0));
  check('§2 sort=qtyAsc：当页按 qty 升序', sAsc.status === 200 && ascOk, { status: sAsc.status, first: pgRows(sAsc.body) && pgRows(sAsc.body)[0] && pgRows(sAsc.body)[0].qty });
  const sWh = await getJson(`/stock/list?teamId=1&warehouseId=${whA.id}&page=1&rows=10`);
  check('§2 仓库过滤+分页：total 为 A 仓分组行数（既有 + 3000）', sWh.status === 200 && sWh.body && sWh.body.total === (stockBeforeWhRows[whA.id] || 0) + 3000 && sWh.body.totals && approx(sWh.body.totals.totalQty, (stockBeforeWhQty[whA.id] || 0) + expectedWhQty[whA.id], 1e-6),
    { status: sWh.status, total: sWh.body && sWh.body.total, totals: sWh.body && sWh.body.totals });

  // ---------- §3 /stock/list group=prod（按商品汇总分页） ----------
  const gFull = await getJson('/stock/list?teamId=1&group=prod');
  const gFullRows = rowsOf(gFull.body);
  check('§3 group=prod 不带 page 仍返回数组、每商品一行', gFull.status === 200 && Array.isArray(gFullRows) && gFullRows.length === stockBeforeProdIds.size + expectedStockProdTotal, { status: gFull.status, len: gFullRows && gFullRows.length });
  const g1 = await getJson('/stock/list?teamId=1&group=prod&page=1&rows=100');
  check('§3 group=prod 分页：total=既有商品 + 2000 且行带汇总字段', g1.status === 200 && g1.body && g1.body.total === stockBeforeProdIds.size + expectedStockProdTotal && pgRows(g1.body) && pgRows(g1.body).length === 100
    && pgRows(g1.body).every((r) => typeof r.productId === 'number' && typeof r.qty === 'number' && typeof r.rows === 'number' && 'whs' in r && typeof r.estUnitCost === 'number' && typeof r.value === 'number'),
    { status: g1.status, total: g1.body && g1.body.total, sample: pgRows(g1.body) && pgRows(g1.body)[0] });
  check('§3 group=prod 合计行与全量一致', g1.body && g1.body.totals && approx(g1.body.totals.totalQty, stockBeforeQty + expectedTotalQty, 1e-6) && approx(g1.body.totals.totalValue, stockBeforeValue + expectedTotalValue) && g1.body.totals.lowCount === lowCountBefore + expectedLowCount, g1.body && g1.body.totals);
  let gIds = [];
  let gQtySum = 0;
  let myGIds = [];
  let myGQtySum = 0;
  let gPagesOk = !!(g1.body && Array.isArray(g1.body.rows));
  if (gPagesOk) {
    const pages = Math.ceil((stockBeforeProdIds.size + expectedStockProdTotal) / 100);
    for (let pg = 1; pg <= pages; pg++) {
      const r = pg === 1 ? g1 : await getJson(`/stock/list?teamId=1&group=prod&page=${pg}&rows=100`);
      if (!r.body || !Array.isArray(r.body.rows)) { gPagesOk = false; break; }
      for (const row of r.body.rows) {
        gIds.push(row.productId); gQtySum += row.qty || 0;
        if (prodIds.includes(row.productId)) { myGIds.push(row.productId); myGQtySum += row.qty || 0; }
      }
    }
    check('§3 group=prod 逐页取回全部商品、productId 无重叠、本轮 2000 商品 qty 之和 = totalQty', gPagesOk && gIds.length === stockBeforeProdIds.size + expectedStockProdTotal && new Set(gIds).size === stockBeforeProdIds.size + expectedStockProdTotal && myGIds.length === expectedStockProdTotal && new Set(myGIds).size === expectedStockProdTotal && approx(myGQtySum, expectedTotalQty, 1e-6),
      { got: gIds.length, uniq: new Set(gIds).size, myGot: myGIds.length, myQtySum: myGQtySum });
  } else {
    check('§3 group=prod 逐页取回全部商品、productId 无重叠、本轮 2000 商品 qty 之和 = totalQty', false, '第 1 页未返回分页对象');
  }
  const gLow = await getJson('/stock/list?teamId=1&group=prod&onlyLow=1&page=1&rows=200');
  check('§3 group=prod onlyLow=1：total=既有低库存商品 + 100 且当页全是低商品', gLow.status === 200 && gLow.body && gLow.body.total === lowCountBefore + expectedLowCount && pgRows(gLow.body) && pgRows(gLow.body).length === lowCountBefore + expectedLowCount && pgRows(gLow.body).every((r) => lowProdBeforeIds.has(r.productId) || prodIds.indexOf(r.productId) < 100),
    { status: gLow.status, total: gLow.body && gLow.body.total, len: pgRows(gLow.body) && pgRows(gLow.body).length });
  const gDesc = await getJson('/stock/list?teamId=1&group=prod&sort=qtyDesc&page=1&rows=100');
  const gDescOk = pgRows(gDesc.body) && pgRows(gDesc.body).length === 100 && pgRows(gDesc.body).every((r, i, a) => i === 0 || (a[i - 1].qty || 0) >= (r.qty || 0));
  check('§3 group=prod sort=qtyDesc：当页按 qty 降序', gDesc.status === 200 && gDescOk, { status: gDesc.status });
  const gWh = await getJson(`/stock/list?teamId=1&group=prod&warehouseId=${whB.id}&page=1&rows=10`);
  check('§3 group=prod 仓库过滤：total=既有 B 仓商品 + 2000 且合计为 B 仓口径', gWh.status === 200 && gWh.body && gWh.body.total === (stockBeforeWhProds[whB.id] ? stockBeforeWhProds[whB.id].size : 0) + expectedStockProdTotal && gWh.body.totals && approx(gWh.body.totals.totalQty, (stockBeforeWhQty[whB.id] || 0) + expectedWhQty[whB.id], 1e-6),
    { status: gWh.status, total: gWh.body && gWh.body.total, totals: gWh.body && gWh.body.totals });

  // ---------- §4 /stock/qty-by-product ----------
  const qA = await getJson(`/stock/qty-by-product?teamId=1&warehouseId=${whA.id}`);
  check('§4 轻量接口返回数组、每项只有 productId,qty 两列', qA.status === 200 && Array.isArray(qA.body) && qA.body.length === qtyABeforeCount + expectedStockProdTotal
    && qA.body.every((r) => Object.keys(r).sort().join(',') === 'productId,qty'),
    { status: qA.status, len: qA.body && qA.body.length, sample: qA.body && qA.body[0] });
  const qASum = Array.isArray(qA.body) ? qA.body.reduce((s, r) => s + (r.qty || 0), 0) : -1;
  const qAMySum = Array.isArray(qA.body) ? qA.body.filter((r) => prodIds.includes(r.productId)).reduce((s, r) => s + (r.qty || 0), 0) : -1;
  check('§4 轻量接口 A 仓 qty 之和与全量口径一致', approx(qASum, qtyABeforeSum + expectedWhQty[whA.id], 1e-6) && approx(qAMySum, expectedWhQty[whA.id], 1e-6), { qASum, qAMySum, expected: expectedWhQty[whA.id] });
  const qB = await getJson(`/stock/qty-by-product?teamId=1&warehouseId=${whB.id}`);
  const qBSum = Array.isArray(qB.body) ? qB.body.reduce((s, r) => s + (r.qty || 0), 0) : -1;
  const qBMySum = Array.isArray(qB.body) ? qB.body.filter((r) => prodIds.includes(r.productId)).reduce((s, r) => s + (r.qty || 0), 0) : -1;
  check('§4 轻量接口 B 仓 qty 之和与全量口径一致', qB.status === 200 && approx(qBSum, qtyBBeforeSum + expectedWhQty[whB.id], 1e-6) && approx(qBMySum, expectedWhQty[whB.id], 1e-6), { status: qB.status, qBSum, qBMySum, expected: expectedWhQty[whB.id] });
  const qNoWh = await getJson('/stock/qty-by-product?teamId=1');
  check('§4 缺 warehouseId 返回 400', qNoWh.status === 400, { status: qNoWh.status });
  const qNoTeam = await getJson(`/stock/qty-by-product?warehouseId=${whA.id}`);
  check('§4 缺 teamId 时鉴权中间件注入令牌团队，仍返回 200 且数据正确', qNoTeam.status === 200 && Array.isArray(qNoTeam.body) && qNoTeam.body.length === qtyABeforeCount + expectedStockProdTotal, { status: qNoTeam.status, len: qNoTeam.body && qNoTeam.body.length });
  const qUnknown = await getJson('/stock/qty-by-product?teamId=1&warehouseId=999999');
  check('§4 未知仓库返回空数组 200', qUnknown.status === 200 && Array.isArray(qUnknown.body) && qUnknown.body.length === 0, { status: qUnknown.status, len: qUnknown.body && qUnknown.body.length });

  // ---------- §5 规模对比：全量 vs 分页第 1 页（字节数与耗时） ----------
  const prodFull = await getJson('/product?teamId=1&rows=500');
  const prodPage1 = await getJson('/product?teamId=1&page=1&rows=50');
  console.log(`  [info] /product 全量（上限 500 行）：${prodFull.bytes} 字节 / ${prodFull.ms}ms；分页第 1 页（50 行）：${prodPage1.bytes} 字节 / ${prodPage1.ms}ms；字节比 ${(prodFull.bytes / Math.max(1, prodPage1.bytes)).toFixed(1)}x`);
  check('§5 /product 分页第 1 页字节 < 全量 500 行的 30%', prodPage1.bytes < prodFull.bytes * 0.3, { page: prodPage1.bytes, full: prodFull.bytes });
  const stockFull = await getJson('/stock/list?teamId=1');
  const stockPage1 = await getJson('/stock/list?teamId=1&page=1&rows=50');
  console.log(`  [info] /stock/list 全量（5000 行）：${stockFull.bytes} 字节 / ${stockFull.ms}ms；分页第 1 页（50 行）：${stockPage1.bytes} 字节 / ${stockPage1.ms}ms；字节比 ${(stockFull.bytes / Math.max(1, stockPage1.bytes)).toFixed(1)}x`);
  check('§5 /stock/list 分页第 1 页字节 < 全量的 10%', stockPage1.bytes < stockFull.bytes * 0.1, { page: stockPage1.bytes, full: stockFull.bytes });
  const stockProdPage1 = await getJson('/stock/list?teamId=1&group=prod&page=1&rows=50');
  console.log(`  [info] /stock/list group=prod 第 1 页（50 商品）：${stockProdPage1.bytes} 字节 / ${stockProdPage1.ms}ms`);
  check('§5 /stock/list group=prod 第 1 页字节 < 全量的 10%', stockProdPage1.bytes < stockFull.bytes * 0.1, { page: stockProdPage1.bytes, full: stockFull.bytes });
  const stockWhFull = await getJson(`/stock/list?teamId=1&warehouseId=${whA.id}`);
  const qtyLight = await getJson(`/stock/qty-by-product?teamId=1&warehouseId=${whA.id}`);
  console.log(`  [info] 换仓：全量 /stock/list（A 仓 3000 行）：${stockWhFull.bytes} 字节 / ${stockWhFull.ms}ms；轻量 /stock/qty-by-product：${qtyLight.bytes} 字节 / ${qtyLight.ms}ms；字节比 ${(stockWhFull.bytes / Math.max(1, qtyLight.bytes)).toFixed(1)}x`);
  check('§5 换仓轻量接口字节 < 全量库存行的 20%', qtyLight.bytes < stockWhFull.bytes * 0.2, { light: qtyLight.bytes, full: stockWhFull.bytes });

  return Date.now() - t0;
}

async function main() {
  // 跑前快照相关表行数；无论本体通过/失败/抛错，finally 里都先清掉本轮数据再退出
  let before = null;
  try {
    const db = openTestDb();
    before = countAll(db);
    db.close();
  } catch (e) { console.log('[cleanup] 跑前行数快照失败：' + e.message); check('清理：跑前行数快照', false, e.message); }
  let ms = 0;
  let completed = false;
  try {
    ms = await mainBody();
    completed = true;
  } finally {
    if (before) cleanupAndVerify(before);
  }
  if (completed) console.log(`[test-paging-batch3] 通过 ${pass} / ${pass + fail}，总耗时 ${ms}ms`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('[test-paging-batch3] 异常:', e); process.exit(1); });
