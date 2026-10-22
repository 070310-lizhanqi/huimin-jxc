# 数据库 Schema（huimin-clone）

对应惠民云 jxc 线业务模型，来源：逆向 API 结构（orange-reverse/web 接口文档）。

## 基础档案
- team（团队/账套）：id, name, startPeriod(YYYYMM 期账)
- user（操作员）：id, teamId, name, role(admin/clerk)
- cat（商品分类）：id, teamId, parentId, name
- product（商品）：id, teamId, catId, name, barcode, unit, spec(规格), salePrice, retailPrice, purchasePrice, ifDiscount, remark, archived
- warehouse（仓库）：id, teamId, name, remark
- reservoir（仓位）：id, teamId, warehouseId, name
- customer（客户）：id, teamId, name, mobile, address, remark
- vendor（供应商）：id, teamId, name, mobile, address, remark
- clerk（业务员/员工）：id, teamId, name, mobile
- account（结算账户）：id, teamId, name, type(cash/bank/wechat/alipay), balance

## 单据（核心，参考 jxc 单据模型）
- doc（单据主表）：id, teamId, billNo, type(stockin/stockout/sale/purchase/transfer/adjust/stocktake/receipt/payment), date, partnerId(客户或供应商，可空), clerkId, warehouseId, status(draft/pending/audit/void), remark, totalAmount, totalQty, userId, createdAt, auditAt, auditUserId
- doc_item（单据明细）：id, docId, productId, qty, price, amount, batchNo(批次), productionDate, expiryDate, reservoirId, remark
- transfer 单据明细额外：src_reservoir_id / dst_warehouse_id+dst_reservoir_id（用 doc_item 上的 toWarehouseId/toReservoirId 字段承载）

## 库存与流水
- stock（实时库存）：id, teamId, productId, warehouseId, reservoirId, batchNo, qty, UNIQUE(teamId,productId,warehouseId,reservoirId,batchNo)
- stock_ledger（库存流水）：id, teamId, productId, warehouseId, reservoirId, batchNo, direction(in/out), qty, unitCost, refDocId, createdAt, balanceAfter

## 应收应付/收付款
- doc 上的 receivable/payable 结算：
- settlement（收付款单）：id, teamId, type(receipt/payment), partnerId, accountId, amount, date, refDocId(可冲抵单据), remark, status
- partner_balance（往来余额）：teamId, partnerType(cus/ven), partnerId, balance（应收为正/应付为负）

## 设计原则
- 金额用 INTEGER 分存储（避免浮点）；qty 用 REAL（允许小数数量）。
- 所有库存变动只通过 stock_ledger 流水 + stock 聚合，单据审核时写入，作废/反审核冲回。
- 单据编号 billNo：类型前缀+日期+流水（RK/CK/XS/CG/DB/TZ/PD/SK/FK）。
