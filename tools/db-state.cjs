/** 打印当前库状态（团队/用户/档案/单据），用于演示数据前核对。 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'orange-clone.db'));
const q = (sql) => db.prepare(sql).all();

console.log('=== 表 ===');
console.log(q("select name from sqlite_master where type='table' order by name").map((r) => r.name).join(', '));

console.log('\n=== user 结构 ===');
const u = db.prepare("select sql from sqlite_master where name = 'user'").get();
console.log(u && u.sql);

console.log('\n=== team ===', q('select id, name from team'));
console.log('=== user ===', q('select * from user'));
console.log('=== 档案行数 ===');
for (const t of ['product', 'customer', 'vendor', 'warehouse', 'reservoir', 'cat', 'unit', 'clerk', 'account']) {
  const n = db.prepare(`select count(*) c from ${t}`).get();
  console.log(`  ${t}: ${n.c}`);
}
console.log('=== 单据 ===', q('select type, status, count(*) c from doc group by type, status'));
console.log('=== 仓库 ===', q('select id, name from warehouse'));
console.log('=== 账户 ===', q('select id, name from account'));
console.log('=== 业务员 ===', q('select id, name from clerk'));
console.log('=== 库存 ===', q('select count(*) c from stock'));
