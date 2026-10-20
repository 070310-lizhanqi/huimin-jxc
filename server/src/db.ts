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

export function openDb(dbPath?: string): DB {
  const p = dbPath ?? path.join(process.cwd(), 'data', 'orange-clone.db');
  const fs = require('node:fs') as typeof import('node:fs');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new DatabaseSync(p);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
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
  -- 商品单位档案（对齐橙子云「资料 - 商品单位」，建档案后开单可下拉选择）
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
  // 单据扩展字段（对齐橙子云开单页）：收件人信息 / 整单折扣 / 本次收款 / 收款账户 / 抵扣订金
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_doc_src_billno ON doc(teamId, type, srcBillNo)`);
  // 登录认证：密码哈希（scrypt）与创建时间
  addColumn('user', 'password', 'TEXT');
  addColumn('user', 'createdAt', 'TEXT');
  // 热门查询索引：仪表盘/报表按 团队+状态+类型 过滤、对账单按往来单位过滤、成本估价按商品流水
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_doc_team_status_type ON doc(teamId, status, type);
    CREATE INDEX IF NOT EXISTS idx_doc_team_partner ON doc(teamId, partnerId, status);
    CREATE INDEX IF NOT EXISTS idx_settlement_team_partner ON settlement(teamId, partnerType, partnerId);
    CREATE INDEX IF NOT EXISTS idx_ledger_team_prod_dir ON stock_ledger(teamId, productId, direction);
  `);
}