/**
 * 工作台统计：新增销售数据（订单/出库/收款/毛利）+ 销售排行（业务员/客户/商品）
 *
 * 口径
 * - 订单：已审核销售订单（type='sorder'）张数与金额
 * - 出库：已审核销售出库（type='stockout'）张数与金额（扣除销售退货 type='sret'）
 * - 收款：收款单（settlement type='receipt'）金额合计
 * - 毛利：销售出库净额 - 加权平均入库成本 × 净数量（与 /report/product 同口径）
 * - range: today / month / year，默认 month
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, Router } from 'express';
import { allocateDocDiscounts } from './report';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function rangeBounds(range: string): { from: string; to: string } {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const to = `${y}-${pad(m)}-${pad(day)}`;
  if (range === 'today') return { from: to, to };
  if (range === 'year') return { from: `${y}-01-01`, to };
  return { from: `${y}-${pad(m)}-01`, to };
}

export function mountDashboard(router: Router, db: DatabaseSync): void {
  /** 新增销售数据：订单 / 出库 / 收款 / 毛利 四项 KPI */
  router.get('/stats/sales-summary', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    const range = String(req.query.range ?? 'month');
    if (!teamId) {
      res.status(400).json({ error: 'teamId 不能为空' });
      return;
    }
    const { from, to } = rangeBounds(range);

    // 订单
    const order = db
      .prepare(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(totalAmount), 0) AS amt
         FROM doc WHERE teamId = ? AND status = 'audit' AND type = 'sorder'
           AND date >= ? AND date <= ?`,
      )
      .get(teamId, from, to) as { cnt: number; amt: number };

    // 出库（扣退货）
    const out = db
      .prepare(
        `SELECT
           COUNT(CASE WHEN type = 'stockout' THEN 1 END) AS cnt,
           COALESCE(SUM(CASE WHEN type = 'stockout' THEN totalAmount ELSE 0 END), 0) AS saleAmt,
           COALESCE(SUM(CASE WHEN type = 'sret' THEN totalAmount ELSE 0 END), 0) AS retAmt,
           COALESCE(SUM(CASE WHEN type = 'stockout' THEN totalQty ELSE 0 END), 0) AS saleQty,
           COALESCE(SUM(CASE WHEN type = 'sret' THEN totalQty ELSE 0 END), 0) AS retQty
         FROM doc WHERE teamId = ? AND status = 'audit' AND type IN ('stockout', 'sret')
           AND date >= ? AND date <= ?`,
      )
      .get(teamId, from, to) as {
      cnt: number;
      saleAmt: number;
      retAmt: number;
      saleQty: number;
      retQty: number;
    };

    // 收款（只统计客户收款：供应商退款也是 receipt 类型，混入会虚增收款 KPI）
    const receipt = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS amt, COUNT(*) AS cnt
         FROM settlement WHERE teamId = ? AND type = 'receipt' AND partnerType = 'cus'
           AND date >= ? AND date <= ?`,
      )
      .get(teamId, from, to) as { amt: number; cnt: number };

    // 毛利：商品维度净额 - 加权成本 × 净数量（只算 stockout/sret）
    // 明细取 (docId, productId) 级并带整单折扣：净额按行金额占比分摊折扣
    // （与 /report/product 完全同口径——否则带折扣的销售在两页算出两个毛利）
    const profitRows = db
      .prepare(
        `SELECT i.docId, i.productId, d.type, d.discount,
                SUM(i.qty) AS qty, SUM(i.amount) AS amount
         FROM doc_item i JOIN doc d ON d.id = i.docId
         WHERE d.teamId = ? AND d.status = 'audit' AND d.type IN ('stockout', 'sret')
           AND d.date >= ? AND d.date <= ?
         GROUP BY i.docId, i.productId`,
      )
      .all(teamId, from, to) as Array<{
      docId: number;
      productId: number;
      type: string;
      discount: number;
      qty: number;
      amount: number;
    }>;
    const costs = db
      .prepare(
        `SELECT l.productId, SUM(l.qty * l.unitCost) * 1.0 / SUM(l.qty) AS avgCost
         FROM stock_ledger l JOIN doc d ON d.id = l.refDocId
         WHERE l.teamId = ? AND l.direction = 'in' AND d.type = 'stockin' AND d.status = 'audit'
           AND d.date <= ?
         GROUP BY l.productId`,
      )
      .all(teamId, to) as Array<{ productId: number; avgCost: number }>;
    const costMap = new Map<number, number>(costs.map((c) => [c.productId, c.avgCost]));
    const priceRows = db
      .prepare('SELECT id, purchasePrice FROM product WHERE teamId = ?')
      .all(teamId) as Array<{ id: number; purchasePrice: number }>;
    const priceMap = new Map<number, number>(priceRows.map((p) => [p.id, p.purchasePrice]));

    // 毛利：整单折扣按行金额占比分摊（与 /report/product 同口径）后按商品归集净量净额，
    // 先累加精确浮点再一次性 round——每商品先 round 会累计 ±N/2 分舍入误差
    const netLine = allocateDocDiscounts(profitRows);
    const perProd = new Map<number, { qty: number; amt: number }>();
    for (const r of profitRows) {
      const a = perProd.get(r.productId) ?? { qty: 0, amt: 0 };
      const sign = r.type === 'stockout' ? 1 : -1;
      a.qty += sign * r.qty;
      a.amt += sign * (netLine.get(`${r.docId}:${r.productId}`) ?? r.amount);
      perProd.set(r.productId, a);
    }
    let grossProfitFloat = 0;
    for (const [pid, a] of perProd) {
      const unitCost = costMap.get(pid) ?? priceMap.get(pid) ?? 0;
      grossProfitFloat += a.amt - a.qty * unitCost;
    }
    const grossProfit = Math.round(grossProfitFloat);

    res.json({
      range,
      from,
      to,
      orderCount: order.cnt,
      orderAmount: order.amt,
      outCount: out.cnt,
      outAmount: out.saleAmt - out.retAmt,
      outQty: out.saleQty - out.retQty,
      receiptAmount: receipt.amt,
      receiptCount: receipt.cnt,
      grossProfit,
    });
  });

  /**
   * 销售排行。
   *   dimension=out      销售出库额（type IN stockout,sret）
   *   dimension=order    销售订单额（type IN sorder）—— 排的是「接单量」，不扣库存
   *   dimension=receipt  收款额（settlement receipt）
   *   by=clerk 业务员 | cus 客户 | product 商品
   */
  router.get('/report/sale-rank', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    const dimRaw = String(req.query.dimension ?? 'out');
    const dimension = dimRaw === 'receipt' ? 'receipt' : dimRaw === 'order' ? 'order' : 'out';
    const by = String(req.query.by ?? 'cus');
    // limit 守护：Number('abc')=NaN 绑进 SQLite 直接抛 datatype mismatch（500），
    // 与 aging/top 同款守护回落默认值
    const rawLimit = Number(req.query.limit ?? 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.floor(rawLimit))) : 10;
    const { from, to } = rangeBounds(String(req.query.range ?? 'month'));
    if (!teamId) {
      res.status(400).json({ error: 'teamId 不能为空' });
      return;
    }

    /** 订单维度看 sorder；出库维度看 stockout/sret */
    const docTypes = dimension === 'order' ? `('sorder')` : `('stockout', 'sret')`;
    const sign = dimension === 'order' ? '1' : `(CASE WHEN d.type = 'sret' THEN -1 ELSE 1 END)`;

    interface RankRow {
      key: number | null;
      name: string;
      amount: number;
      qty: number;
      count: number;
    }

    if (dimension === 'receipt') {
      // 收款排行：按业务员不可得（收款单无业务员），按客户归组
      // （限定 partnerType='cus'：供应商退款是 receipt+ven，LEFT JOIN customer 会错挂客户名上榜）
      const rows = db
        .prepare(
          `SELECT s.partnerId AS key, COALESCE(c.name, '未指定客户') AS name,
                  SUM(s.amount) AS amount, 0 AS qty, COUNT(*) AS count
           FROM settlement s
           LEFT JOIN customer c ON c.id = s.partnerId AND c.teamId = s.teamId
           WHERE s.teamId = ? AND s.type = 'receipt' AND s.partnerType = 'cus'
             AND s.date >= ? AND s.date <= ?
           GROUP BY s.partnerId ORDER BY amount DESC LIMIT ?`,
        )
        .all(teamId, from, to, limit) as unknown as RankRow[];
      res.json({ dimension, by: 'cus', from, to, rows });
      return;
    }

    if (by === 'product') {
      // 金额必须与单据净额口径一致：整单折扣会让 doc.totalAmount < 明细合计，
      // 因此按「该行金额 / 本单明细合计」比例把单据净额分摊到各商品行。
      // dt 派生表先按 (teamId,status,type,date) 过滤再聚合：原先全表扫 doc_item 再 JOIN，
      // 大团队卡死接口；NULLIF 防 sumAmt=0 除零（虽然 0 金额单罕见但导入数据可能存在）。
      const rows = db
        .prepare(
          `SELECT i.productId AS key, p.name AS name,
                  SUM(CASE WHEN dt.sumAmt IS NULL OR dt.sumAmt = 0 THEN 0
                           ELSE ${sign} * i.amount * 1.0 * d.totalAmount / NULLIF(dt.sumAmt, 0) END) AS amount,
                  SUM(CASE WHEN d.type = 'sret' THEN -i.qty ELSE i.qty END) AS qty,
                  COUNT(DISTINCT d.id) AS count
           FROM doc_item i
           JOIN doc d ON d.id = i.docId
           JOIN product p ON p.id = i.productId
           JOIN (
             SELECT i2.docId, SUM(i2.amount) AS sumAmt
             FROM doc_item i2
             JOIN doc d2 ON d2.id = i2.docId
             WHERE d2.teamId = ? AND d2.status = 'audit' AND d2.type IN ${docTypes}
               AND d2.date >= ? AND d2.date <= ?
             GROUP BY i2.docId
           ) dt ON dt.docId = i.docId
           WHERE d.teamId = ? AND d.status = 'audit' AND d.type IN ${docTypes}
             AND d.date >= ? AND d.date <= ?
           GROUP BY i.productId ORDER BY amount DESC LIMIT ?`,
        )
        .all(teamId, from, to, teamId, from, to, limit) as unknown as RankRow[];
      res.json({ dimension, by, from, to, rows });
      return;
    }

    if (by === 'clerk') {
      const rows = db
        .prepare(
          `SELECT d.clerkId AS key, COALESCE(k.name, '未指定业务员') AS name,
                  SUM(CASE WHEN d.type = 'sret' THEN -d.totalAmount ELSE d.totalAmount END) AS amount,
                  SUM(CASE WHEN d.type = 'sret' THEN -d.totalQty ELSE d.totalQty END) AS qty,
                  COUNT(*) AS count
           FROM doc d LEFT JOIN clerk k ON k.id = d.clerkId AND k.teamId = d.teamId
           WHERE d.teamId = ? AND d.status = 'audit' AND d.type IN ${docTypes}
             AND d.date >= ? AND d.date <= ?
           GROUP BY d.clerkId ORDER BY amount DESC LIMIT ?`,
        )
        .all(teamId, from, to, limit) as unknown as RankRow[];
      res.json({ dimension, by, from, to, rows });
      return;
    }

    // 默认按客户
    const rows = db
      .prepare(
        `SELECT d.partnerId AS key, COALESCE(c.name, '未指定客户') AS name,
                SUM(CASE WHEN d.type = 'sret' THEN -d.totalAmount ELSE d.totalAmount END) AS amount,
                SUM(CASE WHEN d.type = 'sret' THEN -d.totalQty ELSE d.totalQty END) AS qty,
                COUNT(*) AS count
         FROM doc d LEFT JOIN customer c ON c.id = d.partnerId AND c.teamId = d.teamId
         WHERE d.teamId = ? AND d.status = 'audit' AND d.type IN ${docTypes}
           AND d.date >= ? AND d.date <= ?
         GROUP BY d.partnerId ORDER BY amount DESC LIMIT ?`,
      )
      .all(teamId, from, to, limit) as unknown as RankRow[];
    res.json({ dimension, by: 'cus', from, to, rows });
  });
}
