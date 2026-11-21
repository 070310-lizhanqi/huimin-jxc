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
 * B-安4③：简易固定窗口限速器（进程内，供高成本接口按用户/团队限流）。
 * 单机部署够用；返回 true 表示本次调用在限额内（并计数），false 表示超限。
 * 注意：调用方应在鉴权/参数校验通过后再计数，免得 400 也消耗配额。
 */
export function createWindowLimiter(limit: number, windowMs: number): (key: string) => boolean {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const cur = hits.get(key);
    if (!cur || now >= cur.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (cur.count >= limit) return false;
    cur.count++;
    return true;
  };
}

/**
 * 应用挂起的恢复请求：restore.pending 存在于库文件旁时，
 * 用它整体替换当前库（含 WAL/SHM 副产物）后删除标记。
 * 必须在 openDb 之前执行——WAL 文件一旦生成就不能再换库文件。
 *
 * B-安7：改为两步 rename（先把当前库 rename 到备份名，再把 pending rename 到位），
 * 任一步失败都能回退：已移走的文件按原路 rename 回来，失败时记日志并继续用当前库启动
 * （恢复可在服务起来后重试；pending 文件保留，下次启动会再试一次）。
 * 注意：scheduleRestore（backup.ts）已事先把当前库复制为 backups/pre-restore-<时间戳>.db，
 * 这里 rename 出的又是一份当前库快照，两者内容相同、互为冗余。
 */
function applyPendingRestore(dbPath: string): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const pending = `${dbPath}.restore-pending`;
  if (!fs.existsSync(pending)) return;
  const stamp = (() => {
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  })();
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  const backupName = path.join(backupDir, `pre-restore-${stamp}.db`);
  const moved: Array<[string, string]> = [];
  const move = (from: string, to: string): void => {
    if (!fs.existsSync(from)) return;
    fs.renameSync(from, to);
    moved.push([from, to]);
  };
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    move(dbPath, backupName);
    move(`${dbPath}-wal`, `${backupName}-wal`);
    move(`${dbPath}-shm`, `${backupName}-shm`);
    fs.renameSync(pending, dbPath);
  } catch (e) {
    // 回退：已到位的 dbPath（若有）先清掉，再把移走的文件按原路搬回
    try { if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true }); } catch { /* ignore */ }
    for (const [from, to] of moved.reverse()) {
      try { fs.renameSync(to, from); } catch { /* 尽力回退 */ }
    }
    console.error('[恢复] 替换库文件失败，已回滚到恢复前状态，本次启动继续使用当前库:', e);
    return;
  }
  // 成功：旧库已是 backups/pre-restore-<时间戳>.db（与 scheduleRestore 事先复制的那份互为冗余，
  // 均保留，用户确认恢复无误后可手工删除旧份）；-wal/-shm 副产物随旧库一并保留
  console.log(`[恢复] 已从备份文件还原数据库（旧库已备份为 ${backupName}），服务以恢复后的数据启动。`);
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
  // B-安17 实测（2026-11-21，真盘 btrfs，5000 次单行事务，各 3 轮）：
  //   NORMAL：533.0 / 582.8 / 441.0 ms（均约 0.52 秒，单事务约 0.1ms）
  //   FULL：121980.0 / 124455.4 / 132966.4 ms（均约 126 秒，单事务约 25ms，慢约 244 倍）
  // FULL 下降不可接受，故保持 NORMAL；折中：关键批量写（单据导入、商品导入、备份前）
  // 后显式 wal_checkpoint（见 tryCheckpoint；单据审核/收付款在 docs.ts/settlement.ts，
  // 不在本组可写文件内，需另派人在其 COMMIT 后调用 tryCheckpoint）。
  db.exec('PRAGMA synchronous = NORMAL;');
  // 缓存页 64MB（默认 2MB），报表聚合与盘点差额计算显著减少磁盘读
  db.exec('PRAGMA cache_size = -65536;');
  return db;
}

/** B-安17 折中：关键批量写后显式检查点（尽力而为，忙时返回 false 而不抛错）。 */
export function tryCheckpoint(db: DB): boolean {
  try {
    const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
      | { busy: number; log: number; checkpointed: number }
      | undefined;
    return !!row && row.busy !== 1 && row.checkpointed >= row.log;
  } catch {
    return false;
  }
}

export function migrate(db: DB): void {
  // B-安19④：migrate 包进事务（SQLite DDL 可事务化），中途失败整体回滚不留半迁移状态
  db.exec('BEGIN IMMEDIATE');
  try {
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
  -- 商品单位档案（对齐原产品「资料 - 商品单位」，建档案后开单可下拉选择）
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
  // B-安19③：catch 只忽略“duplicate column”错误，其余（如类型冲突、磁盘满）一律重抛，
  // 否则迁移一半失败会被静默吞掉，查不出来。
  const addColumn = (table: string, col: string, ddl: string) => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
    } catch (e) {
      if (/duplicate column/i.test((e as Error).message)) return; /* 列已存在 */
      throw e;
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
  // 单据扩展字段（对齐原产品开单页）：收件人信息 / 整单折扣 / 本次收款 / 收款账户 / 抵扣订金
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
  // B-安11：档案表 teamId 索引。crud.ts 的 SELECT * FROM <表> WHERE teamId=?
  // 与 docimport.ts 的往来单位按名查询此前全是全表扫描；product 已有
  // idx_product_team_name (teamId, name) 覆盖 teamId 前缀，不再补；
  // barcode 的 LIKE %…% 本来就走不了索引，不在此列。IF NOT EXISTS 幂等，
  // 老库启动时自动建索引。customer/vendor 另补 (teamId, name) 供按名点查。
  // 注：此处用普通索引而非唯一索引——存量档案可能已有同名行，唯一索引会在
  // 老库上创建失败；判重仍由业务层预检负责。
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_customer_team ON customer(teamId);
    CREATE INDEX IF NOT EXISTS idx_customer_team_name ON customer(teamId, name);
    CREATE INDEX IF NOT EXISTS idx_vendor_team ON vendor(teamId);
    CREATE INDEX IF NOT EXISTS idx_vendor_team_name ON vendor(teamId, name);
    CREATE INDEX IF NOT EXISTS idx_clerk_team ON clerk(teamId);
    CREATE INDEX IF NOT EXISTS idx_account_team ON account(teamId);
    CREATE INDEX IF NOT EXISTS idx_warehouse_team ON warehouse(teamId);
    CREATE INDEX IF NOT EXISTS idx_reservoir_team ON reservoir(teamId);
    CREATE INDEX IF NOT EXISTS idx_unit_team ON unit(teamId);
    CREATE INDEX IF NOT EXISTS idx_cat_team ON cat(teamId);
  `);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败时原错仍要抛出 */ }
    throw e;
  }
}