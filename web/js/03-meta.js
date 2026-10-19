'use strict';
/* web/js/03-meta.js —— 由 app.js 拆分（lines 105-136） */
/* ================= 单据元信息 ================= */
const DOC_META = {
  stockinit: { label: '期初库存', warehouse: true, batch: true },  quo: { label: '报价单', partner: 'cus', warehouse: false, order: true, convertTo: 'sorder', convertLabel: '转销售订单', priceField: 'salePrice' },
  porder: { label: '采购订单', partner: 'ven', warehouse: false, order: true, convertTo: 'stockin', convertLabel: '生成采购入库', priceField: 'purchasePrice' },
  stockin: { label: '采购入库', partner: 'ven', warehouse: true, batch: true, priceField: 'purchasePrice',
    payLabel: '减本次付款', recvLabel: '应付金额' },
  pin: { label: '采购退货', partner: 'ven', warehouse: true, priceField: 'purchasePrice',
    payLabel: '减本次付款', recvLabel: '应付金额' },
  sorder: { label: '销售订单', partner: 'cus', warehouse: false, order: true, convertTo: 'stockout', convertLabel: '生成销售出库', priceField: 'salePrice' },
  stockout: { label: '销售出库', partner: 'cus', warehouse: true, priceField: 'salePrice' },
  sret: { label: '销售退货', partner: 'cus', warehouse: true, batch: true, priceField: 'salePrice' },
  transfer: { label: '调拨单', warehouse: true, toWarehouse: true },
  adjust: { label: '库存调整', warehouse: true, negative: true },
  // 盘点单明细填「实盘数量」（绝对数，可为 0），审核时按与账面差额自动盈亏
  stocktake: { label: '盘点单', warehouse: true, stocktake: true },
  otherin: { label: '其它入库', warehouse: true, batch: true },
  otherout: { label: '其它出库', warehouse: true },
  // 生产组装：正数行 = 产出成品入库，负数行 = 耗用原料出库
  assembly: { label: '生产组装', warehouse: true, negative: true, assemblyNote: '正数行产出成品入库，负数行耗用原料出库' },
  // 出库申请单：先申请后出库，不动库存，审核后可一键生成销售出库
  outapply: { label: '出库申请单', partner: 'cus', warehouse: false, order: true, convertTo: 'stockout', convertLabel: '生成销售出库', priceField: 'salePrice' },
  // 生产任务：下达生产计划，不动库存，审核后可一键生成生产组装单
  prodtask: { label: '生产任务', warehouse: false, order: true, convertTo: 'assembly', convertLabel: '生成生产组装单' },
};
const DOC_GROUPS = {
  purchase: { label: '采购管理', types: ['porder', 'stockin', 'pin'] },
  sale: { label: '销售管理', types: ['quo', 'sorder', 'stockout', 'sret'] },
  inventory: { label: '库存单据', types: ['stockinit', 'transfer', 'adjust', 'stocktake', 'otherin', 'otherout', 'assembly'] },
  // 出库申请 / 生产任务：申请类单据，走库存模块
  apply: { label: '申请与任务', types: ['outapply', 'prodtask'] },
};

