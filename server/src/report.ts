/**
 * 报表：销售统计（按日汇总）/ 商品销售排行（含成本毛利估算）/ 客户销售排行
 * 口径：仅统计已审核（status='audit'）单据；作废单不计入。
 * 日期为 'YYYY-MM-DD' 字符串比较，默认范围本月 1 号至今。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, Router } from 'express';

type Value = string | number | null;

interface SalesDay {
  day: string;
  saleAmount: number;
  retAmount: number;
  saleQty: number;
  retQty: number;
  orderCount: number;
}

interface ProductReportRow {
  productId: number;
  prodName: string;
  unit: string | null;
  spec: string | null;
  purchasePrice: number;
  saleQty: number;
  retQty: number;
  saleAmount: number;
  retAmount: number;
  avgCost: number;
  netQty: number;
  netAmount: number;
  estCost: number;
  estProfit: number;
}

interface CustomerReportRow {
  cusId: number | null;
  cusName: string | null;
  saleAmount: number;
  retAmount: number;
  orderCount: number;
}

function rangeOf(req: Request): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return {
    from: String(req.query.from ?? `${y}-${m}-01`),
    to: String(req.query.to ?? `${y}-${m}-${String(now.getDate()).padStart(2, '0')}`),
  };
}

export function mountReports(router: Router, db: DatabaseSync): void {
  // 按日销售汇总（销售出库 + 销售退货）
  router.get('/report/sales', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const { from, to } = rangeOf(req);
    const days = db
      .prepare(
        `SELECT substr(d.date, 1, 10) AS day,
                SUM(CASE WHEN d.type = 'stockout' THEN d.totalAmount ELSE 0 END) AS saleAmount,
                SUM(CASE WHEN d.type = 'sret' THEN d.totalAmount ELSE 0 END) AS retAmount,
                SUM(CASE WHEN d.type = 'stockout' THEN d.totalQty ELSE 0 END) AS saleQty,
                SUM(CASE WHEN d.type = 'sret' THEN d.totalQty ELSE 0 END) AS retQty,
                COUNT(CASE WHEN d.type = 'stockout' THEN 1 END) AS orderCount
         FROM doc d
         WHERE d.teamId = ? AND d.status = 'audit' AND d.type IN ('stockout', 'sret')
           AND d.date >= ? AND d.date <= ?
         GROUP BY day ORDER BY day`,
      )
      .all(teamId, from, to) as unknown as SalesDay[];
    const totals = days.reduce(
      (s, r) => ({
        saleAmount: s.saleAmount + r.saleAmount,
        retAmount: s.retAmount + r.retAmount,
        saleQty: s.saleQty + r.saleQty,
        retQty: s.retQty + r.retQty,
        orderCount: s.orderCount + r.orderCount,
      }),
      { saleAmount: 0, retAmount: 0, saleQty: 0, retQty: 0, orderCount: 0 },
    );
    return res.json({ from, to, days, totals });
  });

  // 商品销售排行（含加权平均入库成本与毛利估算）
  router.get('/report/product', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const { from, to } = rangeOf(req);
    const rows = db
      .prepare(
        `SELECT i.productId, p.name AS prodName, p.unit, p.spec, p.purchasePrice,
                SUM(CASE WHEN d.type = 'stockout' THEN i.qty ELSE 0 END) AS saleQty,
                SUM(CASE WHEN d.type = 'sret' THEN i.qty ELSE 0 END) AS retQty,
                SUM(CASE WHEN d.type = 'stockout' THEN i.amount ELSE 0 END) AS saleAmount,
                SUM(CASE WHEN d.type = 'sret' THEN i.amount ELSE 0 END) AS retAmount
         FROM doc_item i
         JOIN doc d ON d.id = i.docId
         JOIN product p ON p.id = i.productId
         WHERE d.teamId = ? AND d.status = 'audit' AND d.type IN ('stockout', 'sret')
           AND d.date >= ? AND d.date <= ?
         GROUP BY i.productId
         ORDER BY saleAmount DESC, retAmount DESC`,
      )
      .all(teamId, from, to) as Array<{
      productId: number;
      prodName: string;
      unit: string | null;
      spec: string | null;
      purchasePrice: number;
      saleQty: number;
      retQty: number;
      saleAmount: number;
      retAmount: number;
    }>;
    // 加权平均入库成本：仅统计已审核采购入库单的入库流水
    // （作废采购入库的反冲流水 direction='out'，天然不影响；退货/盘盈也不计入）
    const costs = db
      .prepare(
        `SELECT l.productId, SUM(l.qty * l.unitCost) * 1.0 / SUM(l.qty) AS avgCost
         FROM stock_ledger l JOIN doc d ON d.id = l.refDocId
         WHERE l.teamId = ? AND l.direction = 'in' AND d.type = 'stockin' AND d.status = 'audit'
         GROUP BY l.productId`,
      )
      .all(teamId) as Array<{ productId: number; avgCost: number }>;
    const costMap = new Map<number, number>(costs.map((c) => [c.productId, c.avgCost]));
    const out: ProductReportRow[] = rows.map((r) => {
      const avgCost = costMap.get(r.productId) ?? r.purchasePrice;
      const netQty = r.saleQty - r.retQty;
      const netAmount = r.saleAmount - r.retAmount;
      const estCost = Math.round(netQty * avgCost);
      return {
        productId: r.productId,
        prodName: r.prodName,
        unit: r.unit,
        spec: r.spec,
        purchasePrice: r.purchasePrice,
        saleQty: r.saleQty,
        retQty: r.retQty,
        saleAmount: r.saleAmount,
        retAmount: r.retAmount,
        avgCost: Math.round(avgCost),
        netQty,
        netAmount,
        estCost,
        estProfit: netAmount - estCost,
      };
    });
    return res.json({ from, to, rows: out });
  });

  // 客户销售排行（所有销售向单据按客户归组；未选客户的单据归入「未指定客户」行，
  // 保证客户排行合计 = 净销售额，与按日/商品口径一致）
  router.get('/report/customer', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const { from, to } = rangeOf(req);
    const rows = db
      .prepare(
        `SELECT d.partnerId AS cusId, c.name AS cusName,
                SUM(CASE WHEN d.type = 'stockout' THEN d.totalAmount ELSE 0 END) AS saleAmount,
                SUM(CASE WHEN d.type = 'sret' THEN d.totalAmount ELSE 0 END) AS retAmount,
                COUNT(CASE WHEN d.type = 'stockout' THEN 1 END) AS orderCount
         FROM doc d LEFT JOIN customer c ON c.id = d.partnerId AND c.teamId = d.teamId
         WHERE d.teamId = ? AND d.status = 'audit' AND d.type IN ('stockout', 'sret')
           AND d.date >= ? AND d.date <= ?
         GROUP BY d.partnerId ORDER BY saleAmount DESC`,
      )
      .all(teamId, from, to) as unknown as CustomerReportRow[];
    return res.json({ from, to, rows });
  });
}
