/**
 * 库存查询：实时库存列表 / 商品当前成本 / 库存流水
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, Router } from 'express';

export function mountStockQueries(router: Router, db: DatabaseSync): void {
  // 实时库存（可按仓库/商品/关键词过滤，聚合同商品多仓位批次）
  router.get('/stock/list', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const conds: string[] = ['s.teamId = ?'];
    const args: Array<string | number> = [teamId];
    if (req.query.warehouseId) {
      conds.push('s.warehouseId = ?');
      args.push(Number(req.query.warehouseId));
    }
    if (req.query.productId) {
      conds.push('s.productId = ?');
      args.push(Number(req.query.productId));
    }
    if (req.query.kw) {
      conds.push('p.name LIKE ?');
      args.push(`%${String(req.query.kw)}%`);
    }
    if (req.query.ifShowZero === '0') {
      conds.push('s.qty != 0');
    }
    const list = db
      .prepare(
        `SELECT s.productId, p.name AS prodName, p.spec, p.unit, s.warehouseId, w.name AS warehouseName,
                s.reservoirId, s.batchNo, SUM(s.qty) AS qty
         FROM stock s
         JOIN product p ON p.id = s.productId
         LEFT JOIN warehouse w ON w.id = s.warehouseId
         WHERE ${conds.join(' AND ')}
         GROUP BY s.productId, s.warehouseId, s.reservoirId, s.batchNo
         ORDER BY p.name`,
      )
      .all(...args);
    return res.json(list);
  });

  // 工作台统计卡片
  router.get('/stats/dashboard', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const stockAgg = db
      .prepare(
        `SELECT COALESCE(SUM(qty),0) AS totalQty, COUNT(DISTINCT productId) AS skuCount
         FROM stock WHERE teamId = ? AND qty > 0`,
      )
      .get(teamId) as { totalQty: number; skuCount: number };
    // 库存成本：按最近一次入库单价估价
    const stockValue = (
      db
        .prepare(
          `SELECT COALESCE(SUM(s.qty * IFNULL(c.cost, 0)), 0) AS v
           FROM stock s
           LEFT JOIN (
             SELECT productId, unitCost AS cost FROM stock_ledger
             WHERE teamId = ? AND direction = 'in' AND refDocId IN (SELECT id FROM doc WHERE type IN ('stockin','sret') AND status = 'audit')
             ORDER BY id
           ) c ON c.productId = s.productId
           WHERE s.teamId = ? AND s.qty > 0`,
        )
        .all(teamId, teamId) as Array<{ v: number }>
    )[0].v;
    const today = new Date().toISOString().slice(0, 10);
    const todayIn = (
      db
        .prepare(
          `SELECT COALESCE(SUM(totalQty),0) AS q FROM doc
           WHERE teamId = ? AND type IN ('stockin','sret') AND status = 'audit' AND substr(date,1,10) = ?`,
        )
        .get(teamId, today) as { q: number }
    ).q;
    const todayOut = (
      db
        .prepare(
          `SELECT COALESCE(SUM(totalQty),0) AS q FROM doc
           WHERE teamId = ? AND type IN ('stockout','pin') AND status = 'audit' AND substr(date,1,10) = ?`,
        )
        .get(teamId, today) as { q: number }
    ).q;
    const docCount = (
      db.prepare(`SELECT COUNT(*) AS c FROM doc WHERE teamId = ? AND status = 'draft'`).get(teamId) as {
        c: number;
      }
    ).c;
    // 应收 = 客户正余额合计；应付 = 供应商正余额合计
    const receivable = (
      db
        .prepare(
          `SELECT COALESCE(SUM(balance),0) AS v FROM partner_balance
           WHERE teamId = ? AND partnerType = 'cus' AND balance > 0`,
        )
        .get(teamId) as { v: number }
    ).v;
    const payable = (
      db
        .prepare(
          `SELECT COALESCE(SUM(balance),0) AS v FROM partner_balance
           WHERE teamId = ? AND partnerType = 'ven' AND balance > 0`,
        )
        .get(teamId) as { v: number }
    ).v;
    // 低库存预警：按商品汇总库存，与安全库存比较（lowQty>0 且 总库存<=lowQty）
    const lowStockItems = db
      .prepare(
        `SELECT p.id AS productId, p.name, p.lowQty, COALESCE(SUM(s.qty), 0) AS qty
         FROM product p
         LEFT JOIN stock s ON s.teamId = p.teamId AND s.productId = p.id
         WHERE p.teamId = ? AND (p.archived = 0 OR p.archived IS NULL) AND p.lowQty > 0
         GROUP BY p.id
         HAVING COALESCE(SUM(s.qty), 0) <= p.lowQty
         ORDER BY (p.lowQty - COALESCE(SUM(s.qty), 0)) DESC`,
      )
      .all(teamId) as Array<{ productId: number; name: string; lowQty: number; qty: number }>;
    return res.json({
      totalQty: stockAgg.totalQty,
      skuCount: stockAgg.skuCount,
      stockValue,
      todayIn,
      todayOut,
      draftCount: docCount,
      receivable,
      payable,
      lowStockCount: lowStockItems.length,
      lowStockItems: lowStockItems.slice(0, 10),
    });
  });

  // 近 14 天出入库趋势（工作台图表用）
  router.get('/stats/trend', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const rows = db
      .prepare(
        `SELECT substr(date,1,10) AS day,
                SUM(CASE WHEN type IN ('stockin','sret') THEN totalQty ELSE 0 END) AS inQty,
                SUM(CASE WHEN type IN ('stockout','pin') THEN totalQty ELSE 0 END) AS outQty
         FROM doc
         WHERE teamId = ? AND status = 'audit'
           AND date >= date('now', '-14 day', 'localtime')
           AND type IN ('stockin','stockout','pin','sret')
         GROUP BY day ORDER BY day`,
      )
      .all(teamId) as Array<{ day: string; inQty: number; outQty: number }>;
    return res.json(rows);
  });

  // 单商品库存流水
  router.get('/stock/ledger', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const productId = Number(req.query.productId);
    const conds: string[] = ['teamId = ?'];
    const args: Array<string | number> = [teamId];
    if (productId) {
      conds.push('productId = ?');
      args.push(productId);
    }
    const list = db
      .prepare(`SELECT * FROM stock_ledger WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT 200`)
      .all(...args);
    return res.json(list);
  });

  // 汇总仪表盘：SKU 数、库存总量、库存货值（按最近入库成本估）
  router.get('/stock/summary', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const sku = db
      .prepare(`SELECT COUNT(DISTINCT productId) AS c FROM stock WHERE teamId=? AND qty != 0`)
      .get(teamId) as { c: number };
    const total = db
      .prepare(`SELECT SUM(qty) AS q FROM stock WHERE teamId=? AND qty != 0`)
      .get(teamId) as { q: number | null };
    const value = db
      .prepare(
        `SELECT SUM(s.qty * COALESCE((SELECT l.unitCost FROM stock_ledger l WHERE l.teamId=s.teamId AND l.productId=s.productId AND l.direction='in' ORDER BY l.id DESC LIMIT 1), 0)) AS v
         FROM stock s WHERE s.teamId=? AND s.qty != 0`,
      )
      .get(teamId) as { v: number | null };
    return res.json({ skuCount: sku.c, totalQty: total.q ?? 0, stockValue: value.v ?? 0 });
  });
}