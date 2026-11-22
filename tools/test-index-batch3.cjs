/**
 * 回归测试：第三批 B-安11 —— 档案表 teamId 索引。
 *
 * 问题：customer/vendor/clerk/account/warehouse/reservoir/unit/cat 全无 teamId 索引，
 * crud.ts 的 `SELECT * FROM <表> WHERE teamId=?` 与 docimport.ts 的往来单位按名查询
 * 每次都是全表扫描。改法：补 CREATE INDEX IF NOT EXISTS idx_<表>_team ON <表>(teamId)；
 * customer/vendor 再补 (teamId, name)。product 已有 idx_product_team_name (teamId, name)
 * 覆盖 teamId 前缀，不用再补；barcode 的 LIKE %…% 本来就走不了索引，不在此列。
 *
 * 运行：先 pnpm build，再 node tools/test-index-batch3.cjs；退出码 0=全过。
 * 本文件直接用 dist/server/db.js 的 openDb + migrate 在临时库上验证，
 * 不依赖已启动的服务；每次运行重建临时库 /tmp/huimin-b3-index-test。
 *
 * 覆盖：
 *  ① 10 个新索引存在于 sqlite_master（customer/vendor 各 2 个，其余 6 表各 1 个）；
 *  ② 1 万行客户 + 1 万行供应商（10 个 team × 1000 行）下，
 *     EXPLAIN QUERY PLAN SELECT id FROM customer/vendor WHERE teamId=? AND name=?
 *     从 SCAN 变 SEARCH（改前跑本文件应 FAIL 并打印 SCAN 原文）；
 *  ③ clerk/account/warehouse/reservoir/unit/cat 的 teamId 查询同样走 SEARCH；
 *  ④ 计时对比：按名点查 2000 次、按 teamId 列表 200 次的总耗时（改前/改后两次运行对照）；
 *  ⑤ migrate 幂等：同一库上再跑一次 migrate 不报错、索引数不变（老库启动自动建索引）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = '/tmp/huimin-b3-index-test';
const DB_PATH = path.join(TEST_DIR, 'huimin-clone.db');

// dist 必须先由 pnpm build 生成；直接用生产 migrate，保证测的是真实建库路径。
const { openDb, migrate } = require(path.join(ROOT, 'dist', 'server', 'db.js'));

let pass = 0, fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`PASS ${label}`); }
  else { fail++; console.log(`FAIL ${label} ${extra}`); }
}

function plan(db, sql, params) {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
  return rows.map((r) => r.detail).join(' | ');
}

function main() {
  console.log('[test-index-batch3] B-安11：档案表 teamId 索引');
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = openDb(DB_PATH);
  migrate(db);

  // ---- 造数：customer/vendor 各 1 万行（10 team × 1000 行），其余 6 表各 1000 行 ----
  const seed = (table, prefix, n, extraCols = [], extraVals = () => []) => {
    const cols = ['teamId', 'name', ...extraCols].join(', ');
    const placeholders = ['teamId', 'name', ...extraCols].map(() => '?').join(', ');
    const stmt = db.prepare(`INSERT INTO ${table} (${cols}) VALUES (${placeholders})`);
    db.exec('BEGIN');
    try {
      for (let i = 0; i < n; i++) {
        stmt.run((i % 10) + 1, `${prefix}${String(i).padStart(5, '0')}`, ...extraVals(i));
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  seed('customer', '客户', 10000);
  seed('vendor', '供应商', 10000);
  seed('clerk', '业务员', 1000);
  seed('account', '账户', 1000, ['type'], () => ['cash']);
  seed('warehouse', '仓库', 1000);
  seed('reservoir', '库位', 1000, ['warehouseId'], (i) => [(i % 100) + 1]);
  seed('unit', '单位', 1000);
  seed('cat', '分类', 1000, ['parentId'], () => [null]);

  ok(db.prepare('SELECT COUNT(*) c FROM customer').get().c === 10000, '造数：customer 10000 行');
  ok(db.prepare('SELECT COUNT(*) c FROM vendor').get().c === 10000, '造数：vendor 10000 行');

  // ---- ① 索引存在 ----
  const indexNames = db.prepare("SELECT name FROM sqlite_master WHERE type='index'")
    .all().map((r) => r.name);
  const expectIdx = [
    'idx_customer_team', 'idx_customer_team_name',
    'idx_vendor_team', 'idx_vendor_team_name',
    'idx_clerk_team', 'idx_account_team', 'idx_warehouse_team',
    'idx_reservoir_team', 'idx_unit_team', 'idx_cat_team',
  ];
  for (const name of expectIdx) ok(indexNames.includes(name), `索引存在：${name}`);
  // product 不应多出新索引：仍只有 idx_product_team_name 一个 (teamId, name) 索引
  const prodIdx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='product'")
    .all().map((r) => r.name);
  ok(prodIdx.length === 1 && prodIdx[0] === 'idx_product_team_name',
    'product 不新增索引（已有 idx_product_team_name 覆盖）', JSON.stringify(prodIdx));

  // ---- ②③ EXPLAIN：改前 SCAN，改后 SEARCH（原文打印出来，供改前/改后对照） ----
  const cases = [
    ['customer 按名', 'SELECT id FROM customer WHERE teamId=? AND name=?', [7, '客户07006']],
    ['vendor 按名', 'SELECT id FROM vendor WHERE teamId=? AND name=?', [7, '供应商07006']],
    ['customer 按 teamId', 'SELECT * FROM customer WHERE teamId=?', [7]],
    ['vendor 按 teamId', 'SELECT * FROM vendor WHERE teamId=?', [7]],
    ['clerk 按 teamId', 'SELECT * FROM clerk WHERE teamId=?', [7]],
    ['account 按 teamId', 'SELECT * FROM account WHERE teamId=?', [7]],
    ['warehouse 按 teamId', 'SELECT * FROM warehouse WHERE teamId=?', [7]],
    ['reservoir 按 teamId', 'SELECT * FROM reservoir WHERE teamId=?', [7]],
    ['unit 按 teamId', 'SELECT * FROM unit WHERE teamId=?', [7]],
    ['cat 按 teamId', 'SELECT * FROM cat WHERE teamId=?', [7]],
  ];
  for (const [label, sql, params] of cases) {
    const p = plan(db, sql, params);
    console.log(`  EXPLAIN ${label}: ${p}`);
    ok(/SEARCH/.test(p) && !/SCAN/.test(p), `走索引 SEARCH：${label}`, p);
  }

  // 点查正确性：按名查到的应是同一行
  const hit = db.prepare('SELECT id, name FROM customer WHERE teamId=? AND name=?').get(7, '客户07006');
  ok(hit && hit.name === '客户07006', '按名点查返回正确行', JSON.stringify(hit));

  // ---- ④ 计时对比（同一脚本改前/改后各跑一次，对照数字） ----
  const byName = db.prepare('SELECT id FROM customer WHERE teamId=? AND name=?');
  const t0 = performance.now();
  for (let k = 0; k < 2000; k++) byName.get(7, '客户07006');
  const tByName = performance.now() - t0;
  console.log(`  TIMING 按名点查 2000 次：${tByName.toFixed(1)} ms（平均 ${(tByName / 2000).toFixed(4)} ms/次）`);

  const byTeam = db.prepare('SELECT * FROM customer WHERE teamId=?');
  const t1 = performance.now();
  for (let k = 0; k < 200; k++) byTeam.all(7);
  const tByTeam = performance.now() - t1;
  console.log(`  TIMING 按 teamId 列表 200 次（每 team 1000 行）：${tByTeam.toFixed(1)} ms（平均 ${(tByTeam / 200).toFixed(2)} ms/次）`);

  // ---- ⑤ migrate 幂等：同一库再跑一次不报错，索引数不变 ----
  db.close();
  const db2 = openDb(DB_PATH);
  let secondOk = true;
  try { migrate(db2); } catch (e) { secondOk = false; console.log('  第二次 migrate 抛错：' + e.message); }
  const idxCount2 = db2.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index'").get().c;
  ok(secondOk, 'migrate 第二次执行不报错（老库重启建索引幂等）');
  ok(idxCount2 === indexNames.length, 'migrate 第二次后索引总数不变', `${idxCount2} vs ${indexNames.length}`);
  // 幂等后旧数据仍可读写
  const stillThere = db2.prepare('SELECT COUNT(*) c FROM customer WHERE teamId=? AND name=?').get(7, '客户07006').c;
  ok(stillThere === 1, '二次 migrate 后旧数据仍可读');
  db2.close();

  console.log(`\n[test-index-batch3] ${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main();
