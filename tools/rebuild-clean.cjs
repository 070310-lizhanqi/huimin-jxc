/**
 * 一键重建干净账套：
 * 1) 清空全部业务数据并重置自增序列
 * 2) 创建团队「鲜果批发部」
 * 3) 创建管理员 admin（密码 admin123456，scrypt 哈希与后端一致）
 * 4) 写入演示基础档案：仓库/库位、账户、分类、单位、商品、客户、供应商、业务员
 *
 * 用法：node tools/rebuild-clean.cjs
 */
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

// 数据目录解析与服务端 dataDir() 保持一致：ORANGE_DATA_DIR 优先，否则仓库内 data/
// （此前只写死仓库 data/，用自定义数据目录起的服务重建后仍是旧库，测出来的全是脏数据）
const DATA_DIR = process.env.ORANGE_DATA_DIR || path.join(__dirname, '..', 'data');
const dbPath = path.join(DATA_DIR, 'orange-clone.db');
if (!fs.existsSync(dbPath)) {
  console.error(`[rebuild-clean] 数据库不存在：${dbPath}`);
  console.error('请先启动一次服务（node dist/server/index.js）让 migrate 建表，或检查 ORANGE_DATA_DIR。');
  process.exit(2);
}
const db = new DatabaseSync(dbPath);

/** 与 server/src/auth.ts 的 hashPassword 保持一致 */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plain, salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

// ---------- 1. 清空 ----------
const order = [
  'doc_item', 'doc', 'stock_ledger', 'stock', 'settlement', 'partner_balance',
  'price_memory', 'bill_seq', 'setting', 'reservoir', 'warehouse', 'product',
  'cat', 'unit', 'clerk', 'account', 'customer', 'vendor', 'user', 'team',
];
db.exec('PRAGMA foreign_keys = OFF;');
db.exec('BEGIN');
try {
  for (const t of order) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch (e) { console.log(`跳过 ${t}: ${e.message}`); }
  }
  db.exec('DELETE FROM sqlite_sequence');
  db.exec('COMMIT');
  console.log('已清空全部业务数据');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('清空失败，已回滚:', e.message);
  process.exit(1);
}

// ---------- 2~4. 建账套与演示档案 ----------
db.exec('BEGIN');
try {
  const now = new Date().toISOString();
  // 本地时区年月（与后端 localDate() 口径一致，避免东八区 0-8 点跑测试时账期错月）
  const period = (() => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();

  const teamId = Number(
    db.prepare('INSERT INTO team (name, startPeriod) VALUES (?, ?)').run('鲜果批发部', period).lastInsertRowid,
  );
  db.prepare(`INSERT INTO "user" (teamId, name, role, password, createdAt) VALUES (?, ?, 'admin', ?, ?)`)
    .run(teamId, 'admin', hashPassword('admin123456'), now);

  // 仓库 + 库位
  const wh = (name) => Number(db.prepare('INSERT INTO warehouse (teamId, name) VALUES (?, ?)').run(teamId, name).lastInsertRowid);
  const mainWh = wh('主仓库');
  const coldWh = wh('冷链仓');
  const resv = (warehouseId, name) =>
    Number(db.prepare('INSERT INTO reservoir (teamId, warehouseId, name) VALUES (?, ?, ?)').run(teamId, warehouseId, name).lastInsertRowid);
  resv(mainWh, 'A区常温货架');
  resv(mainWh, 'B区散货区');
  resv(coldWh, '冷藏1号库');

  // 账户
  const acct = (name, type, balance) =>
    db.prepare('INSERT INTO account (teamId, name, type, balance) VALUES (?, ?, ?, ?)').run(teamId, name, type, balance);
  acct('现金', 'cash', 500000);
  acct('微信收款', 'wx', 0);
  acct('对公账户', 'bank', 2000000);

  // 分类
  const cat = (name, parentId = null) =>
    Number(db.prepare('INSERT INTO cat (teamId, parentId, name) VALUES (?, ?, ?)').run(teamId, parentId, name).lastInsertRowid);
  const cFruit = cat('水果');
  const cImport = cat('进口水果', cFruit);
  const cDomestic = cat('国产水果', cFruit);
  cat('礼盒');

  // 单位
  for (const u of ['斤', '箱', '件', '盒', 'kg']) {
    db.prepare('INSERT INTO unit (teamId, name) VALUES (?, ?)').run(teamId, u);
  }

  // 业务员
  const clerk = (name, mobile) =>
    Number(db.prepare('INSERT INTO clerk (teamId, name, mobile) VALUES (?, ?, ?)').run(teamId, name, mobile).lastInsertRowid);
  const cl1 = clerk('张伟', '13800138001');
  const cl2 = clerk('李娜', '13800138002');

  // 商品：name, spec, unit, catId, purchase(分), sale(分), whole(分), retail(分), lowQty, barcode
  const prod = (p) =>
    db.prepare(
      `INSERT INTO product (teamId, catId, name, barcode, unit, spec, purchasePrice, salePrice, wholePrice, retailPrice, lowQty, remark)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(teamId, p.catId, p.name, p.barcode ?? null, p.unit, p.spec ?? null, p.purchase, p.sale, p.whole, p.retail, p.low ?? 0, p.remark ?? null);

  prod({ name: '红富士苹果', spec: '80mm 精选', unit: '箱', catId: cDomestic, purchase: 8000, sale: 10800, whole: 9800, retail: 12000, low: 20, barcode: '6901001' });
  prod({ name: '智利车厘子', spec: 'JJ 级 2.5kg', unit: '箱', catId: cImport, purchase: 22000, sale: 29800, whole: 26800, retail: 32800, low: 10, barcode: '6901002' });
  prod({ name: '赣南脐橙', spec: '中果 10 斤', unit: '箱', catId: cDomestic, purchase: 4500, sale: 6500, whole: 5800, retail: 7200, low: 15, barcode: '6901003' });
  prod({ name: '泰国金枕榴莲', spec: 'A 果', unit: '箱', catId: cImport, purchase: 16000, sale: 21800, whole: 19800, retail: 24800, low: 8, barcode: '6901004' });
  prod({ name: '海南香蕉', spec: '一级', unit: '斤', catId: cDomestic, purchase: 320, sale: 500, whole: 420, retail: 580, low: 50, barcode: '6901005' });
  prod({ name: '阳光玫瑰葡萄', spec: '2 斤装', unit: '盒', catId: cDomestic, purchase: 3800, sale: 5800, whole: 5000, retail: 6600, low: 12, barcode: '6901006' });
  prod({ name: '新西兰奇异果', spec: '金果 12 粒', unit: '盒', catId: cImport, purchase: 5200, sale: 7800, whole: 6800, retail: 8800, low: 10, barcode: '6901007' });
  prod({ name: '精品水果礼盒', spec: '8 种混装', unit: '盒', catId: null, purchase: 12000, sale: 18800, whole: 16800, retail: 21800, low: 5, barcode: '6901008' });

  // 客户
  const cus = (name, mobile, address, priceLevel) =>
    Number(db.prepare('INSERT INTO customer (teamId, name, mobile, address, priceLevel) VALUES (?, ?, ?, ?, ?)').run(teamId, name, mobile, address, priceLevel).lastInsertRowid);
  cus('鲜果超市（总店）', '13900139001', '市区人民路 88 号', 'whole');
  cus('果篮水果店', '13900139002', '城东果蔬市场 A12', 'whole');
  cus('橙心橙意水果连锁', '13900139003', '新区商业街 26 号', 'whole');
  cus('王先生（个人）', '13900139004', '幸福小区 3 栋', 'retail');
  cus('甜蜜时光烘焙坊', '13900139005', '工业园北路 9 号', 'whole');

  // 供应商
  const ven = (name, mobile, address) =>
    Number(db.prepare('INSERT INTO vendor (teamId, name, mobile, address) VALUES (?, ?, ?, ?)').run(teamId, name, mobile, address).lastInsertRowid);
  ven('山东果源农产品合作社', '13700137001', '山东省烟台市栖霞市果源路 1 号');
  ven('广州进口果品贸易公司', '13700137002', '广东省广州市江南市场 B 区');
  ven('江西赣南脐橙基地', '13700137003', '江西省赣州市信丰县脐橙大道');

  db.exec('COMMIT');
  console.log(`已重建账套：鲜果批发部（teamId=${teamId}），管理员 admin / admin123456`);
  console.log(`演示数据：仓库 2、库位 3、账户 3、分类 4、单位 5、业务员 2、商品 8、客户 5、供应商 3`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('建账失败，已回滚:', e.message);
  process.exit(1);
}
db.exec('PRAGMA foreign_keys = ON;');
console.log(`数据目录：${DATA_DIR}`);

// 重新补齐索引/列：清数据不清结构，但老库若曾因重名数据跳过唯一索引创建，
// 清空后必须重跑 migrate 才能把唯一索引补回来（否则重名拦截失效）
try {
  const { migrate } = require(path.join(__dirname, '..', 'dist', 'server', 'db.js'));
  migrate(db);
  console.log('已重跑 migrate（补齐索引与列）');
} catch (e) {
  console.log('跳过 migrate（需先 pnpm build）: ' + e.message);
}

// 校验
const tables = ['team', 'user', 'warehouse', 'reservoir', 'account', 'cat', 'unit', 'clerk', 'product', 'customer', 'vendor', 'doc', 'settlement', 'stock'];
const counts = {};
for (const t of tables) {
  try { counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; } catch { counts[t] = 'n/a'; }
}
console.log('各表行数:', JSON.stringify(counts));
db.close();
