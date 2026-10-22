/** 列出所有档案明细，找出回归/测试残留，供清理前核对。 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'huimin-clone.db'));
const q = (sql) => db.prepare(sql).all();

for (const [t, cols] of [
  ['product', 'id, name, unit, barcode, catId'],
  ['customer', 'id, name, mobile'],
  ['vendor', 'id, name, mobile'],
  ['warehouse', 'id, name'],
  ['reservoir', 'id, name, warehouseId'],
  ['cat', 'id, name, parentId'],
  ['unit', 'id, name'],
  ['clerk', 'id, name'],
  ['account', 'id, name'],
]) {
  console.log(`\n=== ${t} ===`);
  for (const r of q(`select ${cols} from ${t}`)) console.log('  ', JSON.stringify(r));
}
