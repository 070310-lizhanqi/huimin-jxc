/**
 * 清理回归测试产生的业务数据，但保留演示基础档案（团队/用户/仓库/账户/分类/单位/商品/客户/供应商）。
 * 用法：node tools/clean-test-data.cjs
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'huimin-clone.db'));
// 只清业务流水，保留档案
const flowTables = [
  'doc_item', 'doc', 'stock_ledger', 'stock', 'settlement', 'partner_balance',
  'price_memory', 'bill_seq', 'setting',
];
db.exec('PRAGMA foreign_keys = OFF;');
db.exec('BEGIN');
try {
  for (const t of flowTables) {
    try {
      const n = db.prepare(`DELETE FROM ${t}`).run().changes;
      if (n) console.log(`${t}: 清理 ${n} 行`);
    } catch (e) { console.log(`跳过 ${t}: ${e.message}`); }
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('清理失败:', e.message);
  process.exit(1);
}
db.exec('PRAGMA foreign_keys = ON;');

// 清掉回归脚本建出来的测试档案（保留重建脚本写入的演示档案）
const testNames = {
  product: ['回归商品', '隔离测试商品'],
  customer: ['回归客户'],
  vendor: ['回归供应商'],
  clerk: ['回归业务员'],
  account: ['回归现金账户'],
  unit: ['回归单位'],
  cat: ['回归分类'],
};
for (const [t, names] of Object.entries(testNames)) {
  for (const n of names) {
    try {
      const r = db.prepare(`DELETE FROM ${t} WHERE name = ?`).run(n);
      if (r.changes) console.log(`${t}: 删除测试档案「${n}」${r.changes} 行`);
    } catch { /* 表或列不存在就跳过 */ }
  }
}
// 回归新增的非演示用户
const users = db.prepare(`SELECT id, name FROM "user" WHERE name LIKE 'clerk%' OR name LIKE 'x%'`).all();
for (const u of users) {
  db.prepare(`DELETE FROM "user" WHERE id = ?`).run(u.id);
  console.log(`user: 删除测试账号「${u.name}」`);
}

const tables = ['team', 'user', 'warehouse', 'reservoir', 'account', 'cat', 'unit', 'clerk', 'product', 'customer', 'vendor', 'doc', 'doc_item', 'settlement', 'stock', 'stock_ledger'];
const counts = {};
for (const t of tables) {
  try { counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; } catch { counts[t] = 'n/a'; }
}
console.log('\n各表行数:', JSON.stringify(counts));
db.close();
