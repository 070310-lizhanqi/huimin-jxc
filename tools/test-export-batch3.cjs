/**
 * 回归测试：第三批第二波 B-前4 导出批量接口。
 *
 * 覆盖：
 *  §1 单据导出默认：CSV 表头/行数/金额（元，两位小数）/往来单位/仓库/状态文案与创建数据一致；
 *  §2 筛选一致：type/status/partnerId/日期区间/kw 与 /doc/list 同条件返回同一批单号；
 *  §3 权限：未登录 401；teamId=999 查询参数不越权（仍只返回本账套）；clerk 可导出（与列表同权）；
 *  §4 分页边界：1200 条（直连 SQL 种子）一次请求全量返回；20100 条触发 20000 上限 400；
 *  §5 CSV 内容：含逗号/引号的备注正确加引号还原；以 = 开头的备注加 \\t 防公式注入；
 *  §6 流水导出：表头/方向/成本单价（元）/关联单号正确，productId/warehouseId/日期筛选与 /stock/ledger 一致；
 *  §7 单请求：导出不走分页信封（首行即表头，无 total/rows JSON）。
 *
 * 运行：需服务已启动（本文件不自启服务），OC_BASE 指向测试服务。
 * 清理：finally 直连 SQLite，按 remark/name 前缀 B3W4-EX% 删本轮数据（单据先于商品删，
 * bill_seq 故意不清理），并核对 11 张表行数回到跑前。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { api, authHeader, login } = require('./test-helpers.cjs');

const OC_BASE = process.env.OC_BASE || 'http://127.0.0.1:7741/api';
const DATA_DIR = process.env.ORANGE_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'huimin-clone.db');
const TAG = 'B3W4-EX';
const TAG_DOC = 'B3W4-EXD-';
const TAG_BULK_A = 'B3W4-EXB-A-';
const TAG_BULK_B = 'B3W4-EXB-B-';

const CLEAN_TABLES = ['doc', 'doc_item', 'product', 'customer', 'vendor', 'warehouse',
  'stock', 'stock_ledger', 'settlement', 'partner_balance', 'price_memory'];

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : '')); }
}

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
async function fetchCsv(pathname) {
  const h = await authHeader();
  const r = await fetch(OC_BASE + pathname, { headers: h });
  const text = await r.text();
  return { status: r.status, text, type: r.headers.get('content-type') || '', disp: r.headers.get('content-disposition') || '', total: r.headers.get('x-export-total') || '' };
}
/** 最小 CSV 解析：处理引号字段与 \r\n 行分隔，返回二维数组（表头 + 行）。 */
function parseCsv(text) {
  const s = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); cur = ''; rows.push(row); row = []; }
    else if (c === '\r') { /* 随 \n 处理 */ }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}
const rowsByBillNo = (rows) => {
  const head = rows[0] || [];
  const bi = head.indexOf('单号');
  const m = new Map();
  for (const r of rows.slice(1)) m.set(r[bi], r);
  return { head, map: m };
};
const colOf = (rows, name) => {
  const head = rows[0] || [];
  const i = head.indexOf(name);
  return (r) => (i >= 0 ? r[i] : undefined);
};

async function main() {
  console.log('[test-export-batch3] B-前4：单据/流水批量导出接口（一次请求返回筛选结果 CSV）');
  const teamId = (await api('GET', '/auth/me')).body.user.teamId;
  let before = null;
  let db0 = null;
  try { db0 = openTestDb(); before = countAll(db0); } catch (e) { console.log('  （直连 DB 快照失败，清理核对将跳过：' + e.message + '）'); } finally { try { if (db0) db0.close(); } catch { /* ignore */ } }

  const createdDocIds = [];
  let prod = null, cus = null, ven = null, wh = null, clerkId = null;
  try {
    wh = (await api('POST', '/warehouse', { teamId, name: TAG + '-仓' })).body;
    cus = (await api('POST', '/customer', { teamId, name: TAG + '-客户' })).body;
    ven = (await api('POST', '/vendor', { teamId, name: TAG + '-供应商' })).body;
    prod = (await api('POST', '/product', { teamId, name: TAG + '-商品', unit: '件', salePrice: 10000, purchasePrice: 5000 })).body;
    if (!wh.id || !cus.id || !ven.id || !prod.id) throw new Error('档案创建失败');
    const mkDoc = async (type, extra, items, remark) => {
      const r = await api('POST', '/doc/create', { teamId, type, warehouseId: wh.id, items, remark, ...extra });
      if (r.status !== 200 || !r.body.id) throw new Error(`建单 ${type} 失败: ` + JSON.stringify(r.body));
      createdDocIds.push(r.body.id);
      return r.body;
    };
    const audit = async (id) => {
      const r = await api('POST', '/doc/audit', { teamId, id });
      if (r.status !== 200) throw new Error(`审核 ${id} 失败: ` + JSON.stringify(r.body));
    };
    // d1 采购入库（已审核，10 件 @5 元）→ 产生入库流水；d2 销售出库（已审核，2 件 @10 元）
    const d1 = await mkDoc('stockin', { date: '2026-10-10', partnerType: 'ven', partnerId: ven.id },
      [{ productId: prod.id, qty: 10, price: 500 }], TAG_DOC + 'A');
    await audit(d1.id);
    const d2 = await mkDoc('stockout', { date: '2026-10-11', partnerType: 'cus', partnerId: cus.id },
      [{ productId: prod.id, qty: 2, price: 1000 }], TAG_DOC + 'B');
    await audit(d2.id);
    // d3 草稿销售单；d4 采购入库后作废；d5 含逗号/引号备注；d6 以 = 开头的备注
    const d3 = await mkDoc('stockout', { date: '2026-10-18', partnerType: 'cus', partnerId: cus.id },
      [{ productId: prod.id, qty: 1, price: 1000 }], TAG_DOC + 'C');
    const d4 = await mkDoc('stockin', { date: '2026-10-12', partnerType: 'ven', partnerId: ven.id },
      [{ productId: prod.id, qty: 3, price: 500 }], TAG_DOC + 'D');
    await audit(d4.id);
    const vr = await api('POST', '/doc/void', { teamId, id: d4.id });
    if (vr.status !== 200) throw new Error('作废失败: ' + JSON.stringify(vr.body));
    const d5 = await mkDoc('stockout', { date: '2026-10-13', partnerType: 'cus', partnerId: cus.id },
      [{ productId: prod.id, qty: 1, price: 1000 }], TAG_DOC + 'Q, "引号" 测试');
    const d6 = await mkDoc('stockout', { date: '2026-10-14', partnerType: 'cus', partnerId: cus.id },
      [{ productId: prod.id, qty: 1, price: 1000 }], '=B3W4-EXD-F-HYPERLINK("x")');
    const docs = { d1, d2, d3, d4, d5, d6 };
    const byId = new Map(Object.values(docs).map((d) => [d.id, d]));

    // ================= §1 单据导出默认 =================
    {
      const r = await fetchCsv(`/doc/export?teamId=${teamId}&kw=${encodeURIComponent(TAG_DOC)}`);
      check('§1 导出 200 且为 CSV', r.status === 200 && /text\/csv/i.test(r.type), { status: r.status, type: r.type });
      check('§1 Content-Disposition 带 .csv 文件名', /\.csv/i.test(r.disp), r.disp);
      check('§1 X-Export-Total = 6', r.total === '6', r.total);
      const rows = parseCsv(r.text);
      check('§1 表头与前端列表导出一致', JSON.stringify(rows[0]) === JSON.stringify(['单号', '日期', '往来单位', '仓库', '合计数量', '合计金额(元)', '状态', '备注']), rows[0]);
      check('§1 行数 = 6（不分页截断）', rows.length === 7, rows.length);
      const { map } = rowsByBillNo(rows);
      const amt = colOf(rows, '合计金额(元)'), st = colOf(rows, '状态'), pn = colOf(rows, '往来单位'), whn = colOf(rows, '仓库');
      check('§1 d1 金额 50.00（10 件×5 元）', map.get(d1.billNo) && amt(map.get(d1.billNo)) === '50.00', map.get(d1.billNo));
      check('§1 d2 金额 20.00（2 件×10 元）', map.get(d2.billNo) && amt(map.get(d2.billNo)) === '20.00', map.get(d2.billNo));
      check('§1 状态文案：已审核/草稿/已作废', map.get(d1.billNo) && st(map.get(d1.billNo)) === '已审核' && st(map.get(d3.billNo)) === '草稿' && st(map.get(d4.billNo)) === '已作废', { d1: st(map.get(d1.billNo) || []), d3: st(map.get(d3.billNo) || []), d4: st(map.get(d4.billNo) || []) });
      check('§1 往来单位/仓库取中文名', map.get(d2.billNo) && pn(map.get(d2.billNo)) === cus.name && whn(map.get(d2.billNo)) === wh.name, map.get(d2.billNo));
    }

    // ================= §2 筛选与列表一致 =================
    {
      const listBillNos = async (q) => {
        const r = await api('GET', `/doc/list?teamId=${teamId}&rows=200&page=1&${q}`);
        return new Set((r.body.rows || []).map((d) => d.billNo));
      };
      const expBillNos = async (q) => {
        const r = await fetchCsv(`/doc/export?teamId=${teamId}&${q}`);
        if (r.status !== 200) return { status: r.status, set: new Set() };
        return { status: 200, set: new Set([...rowsByBillNo(parseCsv(r.text)).map.keys()]) };
      };
      const cases = [
        ['type=stockin', `type=stockin&kw=${encodeURIComponent(TAG_DOC)}`],
        ['status=audit', `status=audit&kw=${encodeURIComponent(TAG_DOC)}`],
        ['status=draft', `status=draft&kw=${encodeURIComponent(TAG_DOC)}`],
        ['status=void', `status=void&kw=${encodeURIComponent(TAG_DOC)}`],
        ['partnerId=客户', `partnerId=${cus.id}&kw=${encodeURIComponent(TAG_DOC)}`],
        ['日期 10-11..10-12', `from=2026-10-11&to=2026-10-12&kw=${encodeURIComponent(TAG_DOC)}`],
        ['kw=EXD-B', `kw=${encodeURIComponent(TAG_DOC + 'B')}`],
      ];
      for (const [name, q] of cases) {
        const want = await listBillNos(q);
        const got = await expBillNos(q);
        const same = got.status === 200 && want.size === got.set.size && [...want].every((b) => got.set.has(b));
        check(`§2 筛选一致：${name}`, same, { want: [...want], got: [...got.set], status: got.status });
      }
    }

    // ================= §3 权限 =================
    {
      const noAuth = await fetch(OC_BASE + `/doc/export?teamId=${teamId}&kw=${encodeURIComponent(TAG_DOC)}`);
      check('§3 未登录导出 401', noAuth.status === 401, noAuth.status);
      const r = await fetchCsv(`/doc/export?teamId=999&kw=${encodeURIComponent(TAG_DOC)}`);
      const rows = r.status === 200 ? parseCsv(r.text) : [];
      const { map } = rowsByBillNo(rows);
      check('§3 teamId=999 不越权（仍只返回本账套 6 条）', r.status === 200 && rows.length === 7 && [...map.keys()].every((b) => byId.has(Object.values(docs).find((d) => d.billNo === b)?.id)), { status: r.status, n: rows.length });
      // clerk：与列表同权，可导出
      const cu = await api('POST', '/auth/users', { username: TAG + '-clerk', password: 'B2cost!9Xq', role: 'clerk' });
      if (cu.status === 200 && cu.body.id) {
        clerkId = cu.body.id;
        const lr = await fetch(OC_BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: TAG + '-clerk', password: 'B2cost!9Xq' }) });
        const lj = await lr.json().catch(() => ({}));
        if (lr.ok && lj.token) {
          const cr = await fetch(OC_BASE + `/doc/export?teamId=${teamId}&kw=${encodeURIComponent(TAG_DOC)}`, { headers: { Authorization: 'Bearer ' + lj.token } });
          const ct = await cr.text();
          check('§3 clerk 可导出（与列表同权）', cr.status === 200 && parseCsv(ct).length === 7, cr.status);
        } else check('§3 clerk 可导出（与列表同权）', false, 'clerk 登录失败');
      } else check('§3 clerk 可导出（与列表同权）', false, '建 clerk 失败: ' + JSON.stringify(cu.body));
    }

    // ================= §5 CSV 内容 =================
    {
      const r = await fetchCsv(`/doc/export?teamId=${teamId}&kw=${encodeURIComponent(TAG_DOC)}`);
      const rows = parseCsv(r.text);
      const { map } = rowsByBillNo(rows);
      const remark = colOf(rows, '备注');
      check('§5 含逗号/引号的备注解析还原', map.get(d5.billNo) && remark(map.get(d5.billNo)) === TAG_DOC + 'Q, "引号" 测试', map.get(d5.billNo));
      const rawLine = r.text.split('\n').find((l) => l.includes(d6.billNo));
      check('§5 以 = 开头的备注加 \\t 防公式注入', !!rawLine && /,"\t=B3W4-EXD-F/.test(rawLine), rawLine);
      check('§5 备注解析后仍为原值（去 \\t）', map.get(d6.billNo) && remark(map.get(d6.billNo)).replace(/^\t/, '') === '=B3W4-EXD-F-HYPERLINK("x")', map.get(d6.billNo));
    }

    // ================= §6 流水导出 =================
    {
      const r = await fetchCsv(`/stock/ledger/export?teamId=${teamId}&productId=${prod.id}`);
      check('§6 流水导出 200 且为 CSV', r.status === 200 && /text\/csv/i.test(r.type), { status: r.status, type: r.type });
      const rows = parseCsv(r.text);
      check('§6 流水表头', JSON.stringify(rows[0]) === JSON.stringify(['时间', '商品', '仓库', '批次', '方向', '数量', '成本单价(元)', '关联单据']), rows[0]);
      const doc = colOf(rows, '关联单据'), dir = colOf(rows, '方向'), cost = colOf(rows, '成本单价(元)'), pn = colOf(rows, '商品');
      const inRow = rows.slice(1).find((x) => doc(x) === docs.d1.billNo && dir(x) === '入库');
      const outRow = rows.slice(1).find((x) => doc(x) === docs.d2.billNo && dir(x) === '出库');
      check('§6 含 d1 入库行（成本 5.00）', !!inRow && cost(inRow) === '5.00' && pn(inRow) === prod.name, inRow);
      check('§6 含 d2 出库行', !!outRow, outRow);
      // 筛选一致：与 /stock/ledger 同条件比关联单号集合
      const lr = await api('GET', `/stock/ledger?teamId=${teamId}&productId=${prod.id}&warehouseId=${wh.id}&rows=200&page=1`);
      const wantDocs = new Set((lr.body.rows || []).map((l) => l.refDocId));
      const r2 = await fetchCsv(`/stock/ledger/export?teamId=${teamId}&productId=${prod.id}&warehouseId=${wh.id}`);
      const rows2 = parseCsv(r2.text);
      const billNos = new Set();
      for (const x of rows2.slice(1)) billNos.add(doc(x));
      const docIdByBillNo = new Map(Object.values(docs).map((d) => [d.billNo, d.id]));
      const gotDocs = new Set([...billNos].map((b) => docIdByBillNo.get(b)).filter(Boolean));
      check('§6 仓库筛选与列表一致', wantDocs.size === gotDocs.size && [...wantDocs].every((id) => gotDocs.has(id)), { want: [...wantDocs], got: [...gotDocs] });
      const _d = new Date();
      const today = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;
      const r3 = await fetchCsv(`/stock/ledger/export?teamId=${teamId}&productId=${prod.id}&from=${today}&to=${today}`);
      check('§6 今日日期筛选含本轮流水', r3.status === 200 && parseCsv(r3.text).length >= 3, parseCsv(r3.text).length);
      const r4 = await fetchCsv(`/stock/ledger/export?teamId=${teamId}&productId=${prod.id}&from=2099-01-01&to=2099-01-02`);
      check('§6 未来日期筛选为空（仅表头）', r4.status === 200 && parseCsv(r4.text).length === 1, parseCsv(r4.text).length);
    }

    // ================= §4 分页边界（直连 SQL 种子） =================
    {
      const db = openTestDb();
      try {
        db.exec('BEGIN');
        try {
          const ins = db.prepare(`INSERT INTO doc (teamId, type, status, date, billNo, totalAmount, totalQty, partnerType, partnerId, warehouseId, remark, createdAt) VALUES (1, 'stockout', 'audit', '2026-10-15', ?, ?, 1, 'cus', NULL, 1, ?, '2026-10-15 10:00:00')`);
          for (let i = 0; i < 1200; i++) ins.run(`${TAG_BULK_A}${String(i).padStart(5, '0')}`, 10000 + i, TAG_BULK_A);
          for (let i = 0; i < 20100; i++) ins.run(`${TAG_BULK_B}${String(i).padStart(5, '0')}`, 10000 + i, TAG_BULK_B);
          db.exec('COMMIT');
        } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
      } finally { db.close(); }
      const ra = await fetchCsv(`/doc/export?teamId=${teamId}&kw=${encodeURIComponent(TAG_BULK_A)}`);
      const rowsA = parseCsv(ra.text);
      check('§4 1200 条一次请求全量返回（无分页截断）', ra.status === 200 && rowsA.length === 1201 && ra.total === '1200', { status: ra.status, n: rowsA.length, total: ra.total });
      const rb = await fetchCsv(`/doc/export?teamId=${teamId}&kw=${encodeURIComponent(TAG_BULK_B)}`);
      check('§4 20100 条触发 20000 上限 400', rb.status === 400, { status: rb.status, body: rb.text.slice(0, 120) });
      // §7：首行即表头（无 JSON 分页信封）
      check('§7 导出为纯 CSV（首行表头，无 total/rows 信封）', ra.text.replace(/^\uFEFF/, '').startsWith('单号,日期,往来单位'), ra.text.slice(0, 40));
    }
  } finally {
    // ---------- 清理：直连 SQLite，按前缀删本轮数据 ----------
    try {
      const db = openTestDb();
      try {
        db.exec('PRAGMA foreign_keys = OFF');
        db.exec('BEGIN');
        try {
          // 备注可能以 = 开头（§5 公式注入用例），用含 tag 匹配而不用前缀匹配
          const docIds = db.prepare(`SELECT id FROM doc WHERE remark LIKE ?`).all(`%${TAG}%`).map((r) => r.id);
          if (docIds.length) {
            const ph = docIds.map(() => '?').join(',');
            db.prepare(`DELETE FROM settlement WHERE refDocId IN (${ph})`).run(...docIds);
            db.prepare(`DELETE FROM stock_ledger WHERE refDocId IN (${ph})`).run(...docIds);
            db.prepare(`DELETE FROM doc_item WHERE docId IN (${ph})`).run(...docIds);
            db.prepare(`DELETE FROM doc WHERE id IN (${ph})`).run(...docIds);
          }
          const prodIds = db.prepare(`SELECT id FROM product WHERE name LIKE ?`).all(`${TAG}%`).map((r) => r.id);
          if (prodIds.length) {
            const ph = prodIds.map(() => '?').join(',');
            db.prepare(`DELETE FROM stock WHERE productId IN (${ph})`).run(...prodIds);
            db.prepare(`DELETE FROM price_memory WHERE productId IN (${ph})`).run(...prodIds);
          }
          // 本轮新建往来单位的 partner_balance 行：单位是新建的，跑前不存在，按 id 精确删
          const cusIds = db.prepare(`SELECT id FROM customer WHERE name LIKE ?`).all(`${TAG}%`).map((r) => r.id);
          const venIds = db.prepare(`SELECT id FROM vendor WHERE name LIKE ?`).all(`${TAG}%`).map((r) => r.id);
          if (cusIds.length) db.prepare(`DELETE FROM partner_balance WHERE partnerType='cus' AND partnerId IN (${cusIds.map(() => '?').join(',')})`).run(...cusIds);
          if (venIds.length) db.prepare(`DELETE FROM partner_balance WHERE partnerType='ven' AND partnerId IN (${venIds.map(() => '?').join(',')})`).run(...venIds);
          db.prepare(`DELETE FROM product WHERE name LIKE ?`).run(`${TAG}%`);
          db.prepare(`DELETE FROM customer WHERE name LIKE ?`).run(`${TAG}%`);
          db.prepare(`DELETE FROM vendor WHERE name LIKE ?`).run(`${TAG}%`);
          db.prepare(`DELETE FROM warehouse WHERE name LIKE ?`).run(`${TAG}%`);
          db.exec('COMMIT');
        } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
        if (clerkId) {
          try { await api('DELETE', `/auth/users/${clerkId}`); } catch { /* 清理失败不阻塞 */ }
        }
        if (before) {
          const after = countAll(db);
          const allBack = CLEAN_TABLES.every((t) => before[t] === after[t]);
          check('清理：11 张表行数回到跑前', allBack, { before, after });
        }
      } finally { db.close(); }
    } catch (e) {
      check('清理：删除本轮数据', false, String((e && e.message) || e));
    }
  }
  console.log(`[test-export-batch3] 通过 ${pass} / ${pass + fail}`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
