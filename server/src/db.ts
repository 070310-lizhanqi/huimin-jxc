/**
 * 数据库初始化与连接（node:sqlite，零原生依赖）
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export type DB = DatabaseSync;

/** 本地时区 YYYY-MM-DD：不能用 toISOString（UTC，东八区 0-8 点会差一天） */
export function localDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 业务日期合理区间：早于 2000 或晚于 2100 视为录错（多为手滑多打/少打一位数字） */
const MIN_BIZ_YEAR = 2000;
const MAX_BIZ_YEAR = 2100;

/**
 * 业务日期校验（单据 / 收付款共用一处口径）：
 * 1) 严格 YYYY-MM-DD 格式——下游报表/账龄/看板全部按字符串比较与 substr 取日期
 * 2) 真实日历——2026-02-30 / 2099-13-45 这类「格式对但日子不存在」的脏日期
 *    会污染账龄分桶与对账单期初，且事后无法用普通查询筛出
 * 3) 合理年份区间——挡住 1900 / 9999 这类明显录错
 * 返回 null 表示合法，否则返回中文错误文案。
 */
export function validBizDate(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null; // 缺省由调用方决定是否用当天
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '日期格式必须为 YYYY-MM-DD';
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < MIN_BIZ_YEAR || y > MAX_BIZ_YEAR) return `日期年份应在 ${MIN_BIZ_YEAR}~${MAX_BIZ_YEAR} 之间`;
  if (mo < 1 || mo > 12) return '日期月份非法';
  if (d < 1 || d > 31) return '日期天数非法';
  // round-trip 校验：JS Date 会把 2026-02-30 归一化成 2026-03-02，比对回读值即知是否真实存在
  const dt = new Date(`${s}T00:00:00`);
  const p = (n: number) => String(n).padStart(2, '0');
  if (`${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}` !== s) return '日期不存在（如 2 月 30 日）';
  return null;
}

/**
 * 数据目录：环境变量 ORANGE_DATA_DIR 优先（安装版由启动器指向 %APPDATA%\huimin-yun），
 * 缺省保持「当前工作目录/data」的开发行为（测试脚本与手工运行不受影响）。
 */
export function dataDir(): string {
  const envDir = process.env.ORANGE_DATA_DIR;
  if (envDir && envDir.trim()) return path.resolve(envDir.trim());
  return path.join(process.cwd(), 'data');
}

/**
 * 应用挂起的恢复请求：restore.pending 存在于库文件旁时，
 * 用它整体替换当前库（含 WAL/SHM 副产物）后删除标记。
 * 必须在 openDb 之前执行——WAL 文件一旦生成就不能再换库文件。
 */
function applyPendingRestore(dbPath: string): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const pending = `${dbPath}.restore-pending`;
  if (!fs.existsSync(pending)) return;
  for (const suffix of ['-wal', '-shm']) {
    const side = dbPath + suffix;
    if (fs.existsSync(side)) fs.rmSync(side, { force: true });
  }
  fs.rmSync(dbPath, { force: true });
  fs.renameSync(pending, dbPath);
  console.log('[恢复] 已从备份文件还原数据库，服务以恢复后的数据启动。');
}

export function openDb(dbPath?: string): DB {
  const p = dbPath ?? path.join(dataDir(), 'huimin-clone.db');
  const fs = require('node:fs') as typeof import('node:fs');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  applyPendingRestore(p);
  const db = new DatabaseSync(p);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // 多连接（服务进程 + 外部工具/多进程）并发写时等待锁而非立刻抛 SQLITE_BUSY
  db.exec('PRAGMA busy_timeout = 5000;');
  // WAL 模式下 synchronous=NORMAL 事务只在检查点落盘，写入提速数倍且崩溃不损库完整性
  db.exec('PRAGMA synchronous = NORMAL;');
  // 缓存页 64MB（默认 2MB），报表聚合与盘点差额计算显著减少磁盘读
  db.exec('PRAGMA cache_size = -65536;');
  return db;
}

export function migrate(db: DB): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS team (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    startPeriod TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS "user" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teamId INTEGER NOT NULL REFERENCES team(id),
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    password TEXT,
    createdAt TEXT
  );
  CREATE TABLE IF NOT EXISTS cat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teamId INTEGER NOT NULL,
    parentId INTEGER,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS product (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teamId INTEGER NOT NULL,
    catId INTEGER,
    name TEXT NOT NULL,
    barcode TEXT,
    unit TEXT DEFAULT '件',
    spec TEXT,
    salePrice INTEGER DEFAULT 0,
    retailPrice INTEGER DEFAULT 0,
    purchasePrice INTEGER DEFAULT 0,
    wholePrice INTEGER DEFAULT 0,
    remark TEXT,
    archived INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS warehouse (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teamId INTEGER NOT NULL,
    name TEXT NOT NULL,
    remark TEXT
  );
  CREATE TABLE IF NOT EXISTS reservoir (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teamId INTEGER NOT NULL,
    warehouseId INTEGER NOT NULL REFERENCES warehouse(id),
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS customer (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teamId INTEGER NOT NULL,
    name TEXT NOT NULL,
    mobile TEXT,
    address TEXT,
    remark TEXT,
    priceLevel TEXT DEFAULT 'salePrice'
  );
  CREATE TABLE IF NOT EXISTS vendor (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teamId INTEGER NOT NULL,
    name TEXT NOT NULL,
    mobile TEXT,
    address TEXT,
    remark TEXT
  );
  CREATE TABLE IF NOT EXISTS clerk (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teamId INTEGER NOT NULL,
    name TEXT NOT NULL,
    mobile TEXT
  );
  CREATE TABLE IF NOT EXISTS account (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teamId INTEGER NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'cash',
    balance INTEGER DEFAULT 0
  );
  -- 商品单位档案（对齐惠民云「资料 - 商品单位」，建档案后开单可下拉选择）
  CREATE TABLE IF NOT EXISTS unit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teamId INTEGER NOT NULL,
    name TEXT NOT NULL,
    remark TEXT
  );
  CREATE TABLE IF NOT EXISTS doc (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teamId INTEGER NOT NULL,
    billNo TEXT NOT NULL,
    type TEXT NOT NULL,
    date TEXT NOT NULL,
    partnerType TEXT,
    partnerId INTEGER,
    clerkId INTEGER,
    warehouseId INTEGER,
    status TEXT NOT NULL DEFAULT 'draft',
    remark TEXT,
    totalAmount INTEGER DEFAULT 0,
    totalQty REAL DEFAULT 0,
    receiverName TEXT,
    receiverMobile TEXT,
    receiverAddress TEXT,
    discount INTEGER DEFAULT 0,
    paidAmount INTEGER DEFAULT 0,
    accountId INTEGER,
    deposit INTEGER DEFAULT 0,
    userId INTEGER,
    refOrderId INTEGER,
    auditAt TEXT,
    auditUserId INTEGER,
    createdAt TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_doc_billno ON doc(teamId, billNo);
  CREATE TABLE IF NOT EXISTS doc_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    docId INTEGER NOT NULL REFERENCES doc(id),
    productId INTEGER NOT NULL,
    qty REAL NOT NULL,
    price INTEGER NOT NULL DEFAULT 0,
    amount INTEGER NOT NULL DEFAULT 0,
    batchNo TEXT,
    productionDate TEXT,
    expiryDate TEXT,
    reservoirId INTEGER,
    toWarehouseId INTEGER,
    toReservoirId INTEGER,
    remark TEXT,
    postQty REAL
  );
  CREATE INDEX IF NOT EXISTS idx_doc_item_doc ON doc_item(docId);
  CREATE TABLE IF NOT EXISTS stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teamId INTEGER NOT NULL,
    productId INTEGER NOT NULL,
    warehouseId INTEGER NOT NULL,
    reservoirId INTEGER,
    batchNo TEXT DEFAULT '',
    qty REAL NOT NULL DEFAULT 0,
    UNIQUE(teamId, productId, warehouseId, reservoirId, batchNo)
  );
  CREATE TABLE IF NOT EXISTS stock_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teamId INTEGER NOT NULL,
    productId INTEGER NOT NULL,
    warehouseId INTEGER NOT NULL,
    reservoirId INTEGER,
    batchNo TEXT DEFAULT '',
    direction TEXT NOT NULL,
    qty REAL NOT NULL,
    unitCost INTEGER DEFAULT 0,
    refDocId INTEGER,
    createdAt TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS settlement (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teamId INTEGER NOT NULL,
    type TEXT NOT NULL,
    partnerType TEXT NOT NULL,
    partnerId INTEGER NOT NULL,
    accountId INTEGER,
    amount INTEGER NOT NULL,
    date TEXT NOT NULL,
    refDocId INTEGER,
    remark TEXT,
    status TEXT NOT NULL DEFAULT 'audit',
    createdAt TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS partner_balance (
    teamId INTEGER NOT NULL,
    partnerType TEXT NOT NULL,
    partnerId INTEGER NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (teamId, partnerType, partnerId)
  );
  CREATE TABLE IF NOT EXISTS bill_seq (
    k TEXT PRIMARY KEY,
    seq INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS setting (
    teamId INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (teamId, key)
  );
  `);
  // 轻量列迁移：老库补新列（列已存在时报错则忽略）
  const addColumn = (table: string, col: string, ddl: string) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    } catch {
      /* 列已存在 */
    }
  };
  addColumn('product', 'lowQty', 'REAL DEFAULT 0');
  addColumn('product', 'wholePrice', 'INTEGER DEFAULT 0');
  addColumn('customer', 'priceLevel', "TEXT DEFAULT 'salePrice'");
  addColumn('doc', 'refOrderId', 'INTEGER');
  // 审批流：提交时间 / 审核人 / 驳回原因
  addColumn('doc', 'submitAt', 'TEXT');
  addColumn('doc', 'auditBy', 'TEXT');
  addColumn('doc', 'rejectReason', 'TEXT');
  // 单据扩展字段（对齐惠民云开单页）：收件人信息 / 整单折扣 / 本次收款 / 收款账户 / 抵扣订金
  addColumn('doc', 'receiverName', 'TEXT');
  addColumn('doc', 'receiverMobile', 'TEXT');
  addColumn('doc', 'receiverAddress', 'TEXT');
  addColumn('doc', 'discount', 'INTEGER DEFAULT 0');
  addColumn('doc', 'paidAmount', 'INTEGER DEFAULT 0');
  addColumn('doc', 'accountId', 'INTEGER');
  addColumn('doc', 'deposit', 'INTEGER DEFAULT 0');
  // 盘点单过账差额：审核前固化「实盘 - 账面」，作废时据此反向冲回
  addColumn('doc_item', 'postQty', 'REAL');
  // Excel 导入：外部原始单号（用于重复导入幂等跳过）
  addColumn('doc', 'srcBillNo', 'TEXT');
  // 作废留痕：账务系统作废应可追溯（谁在何时因何作废）
  addColumn('doc', 'voidAt', 'TEXT');
  addColumn('doc', 'voidReason', 'TEXT');
  addColumn('doc', 'voidUserId', 'INTEGER');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_doc_src_billno ON doc(teamId, type, srcBillNo)`);
  // 登录认证：密码哈希（scrypt）、创建时间与令牌版本（改密/删号后吊销旧令牌）
  addColumn('user', 'password', 'TEXT');
  addColumn('user', 'createdAt', 'TEXT');
  addColumn('user', 'tokenVer', 'INTEGER NOT NULL DEFAULT 0');
  // 结算记录：服务端专用标识（单据审核自动生成的「开单即收付」置 1）。
  // 客户端不可伪造，作废冲回与改删守卫按此列判断，替代可被冒充的 remark 字符串。
  addColumn('settlement', 'isAuto', 'INTEGER NOT NULL DEFAULT 0');
  // 热门查询索引：仪表盘/报表按 团队+状态+类型 过滤、对账单按往来单位过滤、成本估价按商品流水
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_doc_team_status_type ON doc(teamId, status, type);
    CREATE INDEX IF NOT EXISTS idx_doc_team_partner ON doc(teamId, partnerId, status);
    CREATE INDEX IF NOT EXISTS idx_settlement_team_partner ON settlement(teamId, partnerType, partnerId);
    CREATE INDEX IF NOT EXISTS idx_ledger_team_prod_dir ON stock_ledger(teamId, productId, direction);
  `);
  // 报表/账龄/趋势按日期区间过滤与排序；库存流水按商品回溯；收付款按日期统计
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_doc_team_date ON doc(teamId, date);
    CREATE INDEX IF NOT EXISTS idx_doc_item_product ON doc_item(productId);
    CREATE INDEX IF NOT EXISTS idx_settlement_team_date ON settlement(teamId, date);
    CREATE INDEX IF NOT EXISTS idx_ledger_team_wh_prod ON stock_ledger(teamId, warehouseId, productId);
  `);
  // 热门复合查询：
  // - /doc/list 状态统计按 (teamId, status, type, date) 过滤
  // - 账龄 FIFO 按 partnerId + 日期 拉单
  // - 库存货值估算按 (teamId, productId, direction) 找最近流水
  // - /doc/list 明细聚合按 docId 回表
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_doc_team_status_type_date ON doc(teamId, status, type, date);
    CREATE INDEX IF NOT EXISTS idx_doc_team_partner_date ON doc(teamId, partnerId, status, date);
    CREATE INDEX IF NOT EXISTS idx_ledger_team_prod_dir_id ON stock_ledger(teamId, productId, direction, id);
    CREATE INDEX IF NOT EXISTS idx_doc_item_doc_prod ON doc_item(docId, productId);
    CREATE INDEX IF NOT EXISTS idx_doc_ref_order ON doc(refOrderId, teamId, status);
  `);
  // 用户名唯一性兜底：注册/新增用户处有 SELECT 预检，但并发双击仍可能撞出重名
  // （重名会让登录 SELECT name=? 命中错误行）。老库已有重名时本索引创建失败，忽略即可。
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_name ON "user"(name)`);
  } catch {
    /* 老库存在重名用户：跳过唯一索引，业务层预检仍然生效 */
  }
  // 商品名唯一性兜底：商品导入预检 + 手工建档都按 (teamId, name) 判重，
  // 并发写入仍可能撞出同名商品（报表按名称归组时会裂成两行）。老库已有重名时跳过。
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_product_team_name ON product(teamId, name)`);
  } catch {
    /* 老库存在同名商品：跳过唯一索引，业务层预检仍然生效 */
  }
}