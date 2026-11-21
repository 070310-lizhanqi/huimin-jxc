/**
 * 回归测试：B-安10 导入 N+1 / 重复 prepare（第三批第一波）。
 *
 * 覆盖：
 *  §1 2000 行商品导入（2×1000 行）耗时 + 正确性：改前每行 2 次查询（4000 次），
 *     改后一次全量读 + 内存 Map。打印耗时供改前改后对比。
 *  §2 多单据导入耗时 + 正确性：100 单 × 3 行，单号按单据复用 prefix/noMode；
 *     断言单据号唯一、金额正确。
 *  §3 并发双导入同名商品：唯一索引冲突记为行错误而非整批 500；两批合计成功数 = 去重后行数。
 *  §4 分类成环检测仍生效（语句提到循环外后的回归）：父级挂到子孙下应被拒绝。
 *  §5 商品导入重复行：同批内重名记为行错误、其余行照常成功（部分成功模式不变）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { api, authHeader } = require('./test-helpers.cjs');
const OC_BASE = process.env.OC_BASE || 'http://127.0.0.1:7741/api';

// ---------- 本轮清理：直连 SQLite 删掉本轮新建的全部数据 ----------
// 服务运行时另开一个连接写库是安全的（busy_timeout 防 SQLITE_BUSY）。
// 删除顺序：doc_item → doc（按 srcBillNo 前缀 `${tag}D%` 定位本轮 100 张草稿单，
// billNo 是系统生成的 CK…号，匹配不上）→ 商品/客户 → 分类（先清商品再清分类）。
// 分类除 `${tag}%` 外还含商品导入按 catName 自动建的固定名 'B3PerfCat'
// （仅本文件使用该名；若历史脏跑残留了它也一并清掉，行数才回得去）。
// bill_seq 是单号计数器（删后单号会复用，代码明确要求不复用），不在清理范围，
// 故快照/核对不含 bill_seq；stock/stock_ledger/price_memory/settlement/
// partner_balance 本轮不应有新增（草稿单不审核），只快照核对、有变就报错。
const DATA_DIR = process.env.ORANGE_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'huimin-clone.db');
const CLEAN_TABLES = ['product', 'customer', 'cat', 'doc', 'doc_item',
  'stock', 'stock_ledger', 'price_memory', 'settlement', 'partner_balance'];
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
      db.prepare('DELETE FROM doc_item WHERE docId IN (SELECT id FROM doc WHERE teamId = 1 AND srcBillNo LIKE ?)').run(`${runTag}D%`);
      db.prepare('DELETE FROM doc WHERE teamId = 1 AND srcBillNo LIKE ?').run(`${runTag}D%`);
      db.prepare('DELETE FROM product WHERE teamId = 1 AND name LIKE ?').run(`${runTag}%`);
      db.prepare('DELETE FROM customer WHERE teamId = 1 AND name LIKE ?').run(`${runTag}%`);
      db.prepare('DELETE FROM cat WHERE teamId = 1 AND (name LIKE ? OR name = ?)').run(`${runTag}%`, 'B3PerfCat');
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
    const after = countAll(db);
    const allBack = CLEAN_TABLES.every((t) => before[t] === after[t]);
    check('清理：跑后相关表行数回到跑前', allBack, { before, after });
  } catch (e) {
    check('清理：删除本轮数据', false, String((e && e.message) || e));
  } finally {
    try { if (db) db.close(); } catch { /* ignore */ }
  }
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : '')); }
}

async function uploadImport(buf, qs) {
  const h = await authHeader();
  const res = await fetch(
    `${OC_BASE}/doc/import${qs || ''}`,
    { method: 'POST', headers: { ...h, 'content-type': 'application/octet-stream' }, body: buf },
  );
  const j = await res.json().catch(() => ({ error: 'non-json' }));
  return { status: res.status, body: j };
}

async function productImport(rows) {
  const h = await authHeader();
  const res = await fetch(`${OC_BASE}/product/import`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 1, rows }),
  });
  const j = await res.json().catch(() => ({ error: 'non-json' }));
  return { status: res.status, body: j };
}

function prodRows(prefix, n, catName) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      name: `${prefix}${String(i).padStart(4, '0')}`,
      catName: catName || 'B3PerfCat',
      barcode: '',
      unit: '件',
      spec: '',
      purchasePrice: '5.00',
      salePrice: '10.00',
      retailPrice: '12.00',
      wholePrice: '9.00',
      lowQty: '0',
      remark: '',
    });
  }
  return rows;
}

async function mainBody() {
  console.log('[test-import-perf-batch3] B-安10：导入 N+1 / 重复 prepare');
  const t0 = Date.now();
  const tag = `B3${Date.now().toString(36)}`; // 本轮唯一前缀，避免与历史数据重名
  runTag = tag;

  // 前置：自建客户（多单据导入用）
  const cus = await api('POST', '/customer', { teamId: 1, name: `${tag}Cus` });
  check('前置：自建客户', cus.status === 200, cus.body);

  // ---------- §1 2000 行商品导入耗时 ----------
  const rows1 = prodRows(`${tag}P1-`, 1000);
  const s1 = Date.now();
  const r1 = await productImport(rows1);
  const ms1 = Date.now() - s1;
  console.log(`  [info] 商品导入 1000 行耗时 ${ms1}ms（改前每行 2 次查询 = 2000 次，改后 2 次全量读 + 内存 Map）`);
  check('§1 第一批 1000 行导入 200', r1.status === 200, r1.body);
  check('§1 第一批 1000 行全部成功', r1.body.success === 1000 && r1.body.errors.length === 0, r1.body && { success: r1.body.success, errors: (r1.body.errors || []).slice(0, 3) });

  const rows2 = prodRows(`${tag}P2-`, 1000);
  const s2 = Date.now();
  const r2 = await productImport(rows2);
  const ms2 = Date.now() - s2;
  console.log(`  [info] 商品导入第二批 1000 行耗时 ${ms2}ms；2000 行合计 ${ms1 + ms2}ms`);
  check('§1 第二批 1000 行导入 200', r2.status === 200, r2.body);
  check('§1 第二批 1000 行全部成功', r2.body.success === 1000 && r2.body.errors.length === 0, r2.body && { success: r2.body.success, errors: (r2.body.errors || []).slice(0, 3) });
  // 抽查：第一批的商品确实在库里
  const probe = await api('GET', `/product?teamId=1&kw=${tag}P1-0001`);
  check('§1 抽查导入商品可查到', Array.isArray(probe.body) && probe.body.some((p) => p.name === `${tag}P1-0001`), probe.body);

  // ---------- §2 多单据导入耗时：100 单 × 3 行 ----------
  const prodA = `${tag}P1-0001`;
  const prodB = `${tag}P1-0002`;
  const prodC = `${tag}P1-0003`;
  const lines = ['单号,日期,客户,商品名称,数量,单价'];
  for (let b = 0; b < 100; b++) {
    const no = `${tag}D${String(b).padStart(3, '0')}`;
    lines.push(`${no},2026-10-20,${tag}Cus,${prodA},2,10.00`);
    lines.push(`${no},2026-10-20,${tag}Cus,${prodB},1,5.50`);
    lines.push(`${no},2026-10-20,${tag}Cus,${prodC},3,8.00`);
  }
  const csv = Buffer.from(lines.join('\r\n'), 'utf8');
  const s3 = Date.now();
  const doc = await uploadImport(csv, '');
  const ms3 = Date.now() - s3;
  console.log(`  [info] 单据导入 100 单 × 3 行 = 300 行耗时 ${ms3}ms（改前每单 2 次设置查询 + 逐单 prepare，改后导入开始时一次读出复用）`);
  check('§2 100 单导入 200', doc.status === 200, doc.body);
  check('§2 建了 100 张草稿', doc.body.created && doc.body.created.length === 100, doc.body && doc.body.summary);
  check('§2 无行错误', doc.body.rowErrors && doc.body.rowErrors.length === 0, doc.body.rowErrors);
  const billNos = (doc.body.created || []).map((c) => c.billNo);
  check('§2 单据号全部唯一', new Set(billNos).size === billNos.length, billNos.slice(0, 5));
  // 抽查一张单金额：2×1000 + 1×550 + 3×800 = 4950 分
  const c0 = doc.body.created[0];
  const info0 = (await api('GET', `/doc/info?teamId=1&id=${c0.id}`)).body;
  check('§2 抽查单据金额 4950 分', info0.doc && info0.doc.totalAmount === 4950, info0.doc && info0.doc.totalAmount);

  // ---------- §3 并发双导入同名商品 ----------
  const concRows = prodRows(`${tag}C-`, 200, `${tag}ConcCat`);
  const [ca, cb] = await Promise.all([productImport(concRows), productImport(concRows)]);
  console.log(`  [info] 并发双导入：A status=${ca.status} success=${ca.body.success} errors=${(ca.body.errors || []).length}；B status=${cb.status} success=${cb.body.success} errors=${(cb.body.errors || []).length}`);
  check('§3 并发双导入均未整批 500', ca.status === 200 && cb.status === 200, { a: ca.status, b: cb.status });
  check('§3 两批合计成功数 = 200（去重后）', (ca.body.success || 0) + (cb.body.success || 0) === 200, { a: ca.body.success, b: cb.body.success });
  const concErrs = [...(ca.body.errors || []), ...(cb.body.errors || [])];
  check('§3 冲突行记为行错误', concErrs.length === 200 && concErrs.every((e) => /已存在/.test(e.msg)), concErrs.slice(0, 2));
  // 再导一次同一批：应全部命中“已存在”，证明库里恰好 200 个、无重复建档
  const again = await productImport(concRows);
  check('§3 重导同一批：200 行全部报已存在', again.status === 200 && again.body.success === 0 && again.body.errors.length === 200, { success: again.body.success, errors: (again.body.errors || []).length });

  // ---------- §4 分类成环检测仍生效 ----------
  const catA = await api('POST', '/cat', { teamId: 1, name: `${tag}CatA` });
  check('§4 新建父分类', catA.status === 200 && catA.body.id, catA.body);
  const catB = await api('POST', '/cat', { teamId: 1, name: `${tag}CatB`, parentId: catA.body.id });
  check('§4 新建子分类', catB.status === 200 && catB.body.id, catB.body);
  const cyc = await api('PUT', `/cat/${catA.body.id}`, { teamId: 1, parentId: catB.body.id });
  check('§4 父级挂到子孙下被拒绝', cyc.status === 400 && /自己|环/.test(cyc.body.error || ''), cyc.body);
  const selfRef = await api('PUT', `/cat/${catA.body.id}`, { teamId: 1, parentId: catA.body.id });
  check('§4 父级挂到自己被拒绝', selfRef.status === 400, selfRef.body);
  // 合法改父级仍放行：把 B 的父级改回空
  const okMove = await api('PUT', `/cat/${catB.body.id}`, { teamId: 1, parentId: null });
  check('§4 合法改父级仍放行', okMove.status === 200, okMove.body);

  // ---------- §5 同批内重名记行错误、其余行成功 ----------
  const dupRows = [
    { name: `${tag}Dup`, catName: '', unit: '件', purchasePrice: '1.00', salePrice: '2.00', retailPrice: '2.00', wholePrice: '1.50', lowQty: '0' },
    { name: `${tag}Dup`, catName: '', unit: '件', purchasePrice: '1.00', salePrice: '2.00', retailPrice: '2.00', wholePrice: '1.50', lowQty: '0' },
    { name: `${tag}DupOk`, catName: '', unit: '件', purchasePrice: '1.00', salePrice: '2.00', retailPrice: '2.00', wholePrice: '1.50', lowQty: '0' },
  ];
  const dup = await productImport(dupRows);
  check('§5 同批重名：部分成功模式不变', dup.status === 200 && dup.body.success === 2 && dup.body.errors.length === 1, dup.body);
  check('§5 重名行错误文案含已存在', dup.body.errors[0] && /已存在/.test(dup.body.errors[0].msg), dup.body.errors);

  return Date.now() - t0;
}

async function main() {
  // 跑前快照相关表行数；无论本体通过/失败/抛错，finally 里都先清掉本轮数据再退出
  // （本体末尾不再直接 process.exit(1)，否则 finally 的清理跑不到）。
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
  // 汇总放在清理断言之后打印，数字才含清理断言
  if (completed) console.log(`[test-import-perf-batch3] 通过 ${pass} / ${pass + fail}，总耗时 ${ms}ms`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('[test-import-perf-batch3] 异常:', e); process.exit(1); });
