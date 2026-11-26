# 数据库 Schema（zhanhui-jxc）

> 与 `server/src/db.ts`（迁移版本 `V1`–`V3`）保持严格同步。当前共 23 张 SQLite 表（含迁移记录表 `schema_migrations`），启动与 `pnpm run db:migrate` 均以 `PRAGMA foreign_keys = ON` + `WAL` 模式幂等迁移。

---

## 1. 账套、用户与基础档案（V1）

- **`team`**（团队/账套）：`id`, `name`, `startPeriod`（`YYYYMM` 期账）
- **`"user"`**（操作员）：`id`, `teamId` (`REFERENCES team(id)`), `name`（全局唯一索引 `idx_user_name`）, `role` (`'admin' | 'clerk'`, DEFAULT `'admin'`), `password`（`scrypt$<salt>$<hash>`）, `createdAt`, `tokenVer` (`INTEGER NOT NULL DEFAULT 0`)
- **`cat`**（商品分类）：`id`, `teamId`, `parentId`, `name`
- **`product`**（商品）：`id`, `teamId`, `catId`, `name`（团队级唯一索引 `idx_product_team_name(teamId, name)`）, `barcode`, `unit` (DEFAULT `'件'`), `spec`, `salePrice` (`INTEGER DEFAULT 0`), `retailPrice` (`INTEGER DEFAULT 0`), `purchasePrice` (`INTEGER DEFAULT 0`), `wholePrice` (`INTEGER DEFAULT 0`), `lowQty` (`REAL DEFAULT 0`), `remark`, `archived` (`INTEGER DEFAULT 0`)
- **`warehouse`**（仓库）：`id`, `teamId`, `name`, `remark`
- **`reservoir`**（仓位/库区）：`id`, `teamId`, `warehouseId` (`REFERENCES warehouse(id)`), `name`
- **`customer`**（客户）：`id`, `teamId`, `name`, `mobile`, `address`, `remark`, `priceLevel` (`TEXT DEFAULT 'salePrice'`, 枚举：`'salePrice' | 'retailPrice' | 'wholePrice' | 'purchasePrice'`)
- **`vendor`**（供应商）：`id`, `teamId`, `name`, `mobile`, `address`, `remark`
- **`clerk`**（业务员/员工）：`id`, `teamId`, `name`, `mobile`
- **`account`**（资金/结算账户）：`id`, `teamId`, `name`, `type` (`TEXT NOT NULL DEFAULT 'cash'`, 枚举：`'cash' | 'bank' | 'wechat' | 'alipay' | 'other'`), `balance` (`INTEGER DEFAULT 0`)
- **`unit`**（计量单位）：`id`, `teamId`, `name`, `remark`

---

## 2. 业务单据与明细（V1）

- **`doc`**（单据主表）：
  `id`, `teamId`, `billNo`（团队级唯一索引 `idx_doc_billno(teamId, billNo)`）, `type`, `date` (`YYYY-MM-DD`), `partnerType` (`'cus' | 'ven' | NULL`), `partnerId`, `clerkId`, `warehouseId`, `status` (`'draft' | 'pending' | 'audit' | 'void'`, DEFAULT `'draft'`), `remark`, `totalAmount` (`INTEGER DEFAULT 0`), `totalQty` (`REAL DEFAULT 0`), `receiverName`, `receiverMobile`, `receiverAddress`, `discount` (`INTEGER DEFAULT 0`), `paidAmount` (`INTEGER DEFAULT 0`), `accountId`, `deposit` (`INTEGER DEFAULT 0`), `userId`, `refOrderId`, `submitAt`, `auditAt`, `auditUserId`, `auditBy`, `rejectReason`, `srcBillNo`（部分唯一索引 `idx_doc_team_type_src_billno_uniq(teamId, type, srcBillNo) WHERE srcBillNo IS NOT NULL AND srcBillNo != ''`）, `voidAt`, `voidReason`, `voidUserId`, `createdAt`
  - **`doc.type` 枚举值（16 种，与 `settings.ts` `DEFAULT_PREFIX` / `services/doc-service.ts` 一致）**：
    - 采购类：`porder`（采购订单 `CG`）、`stockin`（采购入库 `RK`）、`pin`（采购退货 `CT`）
    - 销售类：`quo`（报价单 `BJ`）、`sorder`（销售订单 `XS`）、`outapply`（出库申请单 `SQ`）、`stockout`（销售出库 `CK`）、`sret`（销售退货 `XT`）
    - 库存/生产类：`stockinit`（期初库存 `QCQ`）、`transfer`（调拨单 `DB`）、`adjust`（库存调整 `TZ`）、`stocktake`（盘点单 `PD`）、`otherin`（其它入库 `QR`）、`otherout`（其它出库 `QC`）、`prodtask`（生产任务 `SC`）、`assembly`（生产组装 `ZZ`）
- **`doc_item`**（单据明细）：
  `id`, `docId` (`REFERENCES doc(id)`), `productId`, `qty` (`REAL`), `price` (`INTEGER DEFAULT 0`), `amount` (`INTEGER DEFAULT 0`), `batchNo`, `productionDate`, `expiryDate`, `reservoirId`, `toWarehouseId`, `toReservoirId`, `remark`, `postQty` (`REAL`, 盘点单过账前固化的盈亏差额)

---

## 3. 库存、流水与价格记忆（V1 & V2）

- **`stock`**（实时库存聚合）：
  `id`, `teamId`, `productId`, `warehouseId`, `reservoirId`, `batchNo` (DEFAULT `''`), `qty` (`REAL DEFAULT 0`), `UNIQUE(teamId, productId, warehouseId, reservoirId, batchNo)`
- **`stock_ledger`**（库存流水）：
  `id`, `teamId`, `productId`, `warehouseId`, `reservoirId`, `batchNo` (DEFAULT `''`), `direction` (`'in' | 'out'`), `qty` (`REAL`), `unitCost` (`INTEGER DEFAULT 0`), `refDocId`, `createdAt`
- **`price_memory`**（V2，客户最近成交记忆价）：
  `id`, `teamId`, `partnerId`, `productId`, `price` (`INTEGER`), `lastDate`, `times` (`INTEGER DEFAULT 1`), `UNIQUE(teamId, partnerId, productId)`

---

## 4. 往来账款与收付款（V1）

- **`settlement`**（收付款单）：
  `id`, `teamId`, `type` (`'receipt' | 'payment'`), `partnerType` (`'cus' | 'ven'`), `partnerId`, `accountId`, `amount` (`INTEGER`), `date` (`YYYY-MM-DD`), `refDocId`, `remark`, `status` (DEFAULT `'audit'`), `isAuto` (`INTEGER NOT NULL DEFAULT 0`, `1`=单据审核「开单即收付」自动生成), `createdAt`
- **`partner_balance`**（往来余额汇总）：
  `teamId`, `partnerType` (`'cus' | 'ven'`), `partnerId`, `balance` (`INTEGER NOT NULL DEFAULT 0`), `PRIMARY KEY (teamId, partnerType, partnerId)`
  - **符号约定**（与 `settlement.ts`、`services/stock-service.ts`、`web/js/15-finance.js` 一致）：
    - `partnerType = 'cus'`：**正数 = 我方应收（客户欠款）**，负数 = 客户预收/预付冲抵；
    - `partnerType = 'ven'`：**正数 = 我方应付（欠供应商款）**，负数 = 供应商预付冲抵。

---

## 5. 序号、系统配置、审计与幂等基础设施（V1 & V3）

- **`bill_seq`**（V1，单据流水号序列）：`k` (`PRIMARY KEY`, 形如 `${teamId}:${type}:${periodKey}`), `seq` (`INTEGER`)
- **`setting`**（V1，配置键值表）：`teamId`（`0` 为全局命名空间，存 `global.register`、`auth.revoked`；`>0` 为团队级配置，存 `prefix`、`noMode`、`print`）, `key`, `value`, `PRIMARY KEY (teamId, key)`
- **`audit_log`**（V3，操作审计日志）：`id`, `teamId`, `userId`, `username`, `action`, `entityType`, `entityId`, `requestId`, `ip`, `detail`, `createdAt`
- **`idempotency_key`**（V3，HTTP `Idempotency-Key` 24h 持久化幂等表）：`teamId`, `scope` (`'doc.create' | 'doc.audit' | 'doc.void' | 'settlement.create'`), `key`, `requestHash` (SHA-256), `statusCode`, `responseBody`, `createdAt` (epoch ms), `PRIMARY KEY (teamId, scope, key)`
- **`schema_migrations`**（迁移版本表）：`version` (`INTEGER PRIMARY KEY`), `name`, `appliedAt`

---

## 设计原则

- **金额与数量精度**：所有金额以 **INTEGER 分** 存储与运算；数量以 `REAL` 存储并按 `QTY_SCALE = 10_000`（4 位小数）缩放防浮点尾差。
- **单据过账原子性**：库存 (`stock` / `stock_ledger`)、往来 (`partner_balance`)、资金账户 (`account`) 仅在审核过账时通过 `withImmediateTx`（`BEGIN IMMEDIATE`）在同一事务内原子写入；作废按原流水/原自动结算精准冲回。
- **单据编号 `billNo`**：类型前缀 + 日期段（按 `noMode`：`none` / `day` / `month`）+ `bill_seq` 自增流水（默认前缀见 `server/src/settings.ts` `DEFAULT_PREFIX`）。
