// 查看当前商品清单，确认是否有测试残留
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'orange-clone.db'));
console.log('products:');
for (const p of db.prepare('SELECT id, name, spec, unit, salePrice, teamId FROM product ORDER BY id').all()) {
  console.log(`  #${p.id} ${p.name} ${p.spec ?? ''} ${p.unit} sale=${p.salePrice} team=${p.teamId}`);
}
console.log('\nusers:', JSON.stringify(db.prepare('SELECT id, name, role, teamId FROM "user"').all()));
console.log('teams:', JSON.stringify(db.prepare('SELECT id, name FROM team').all()));
db.close();
