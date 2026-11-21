/**
 * 库存查询：实时库存列表 / 商品当前成本 / 库存流水
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, Router } from 'express';
import { localDate } from './db';

/** 历史采购均价（估算）标量子查询（与 report.ts / dashboard.ts / aging.ts 同口径，B-数4 修后）：
 *  仅统计已审核采购入库单、入库日期 ≤ 今天的流水；零价入库（unitCost<=0，如赠品/价缺省）
 *  不计入分母；全零价商品返回 NULL，调用方用 COALESCE 回落到 purchasePrice。
 *  注意：这是按商品全局取价，未分仓库/批次，多仓不同采购价时仍失真——彻底修需按仓/批取价，见 C-数1。
 *  另：聚合均价不再取单条“最近价”，旧 ORDER BY l.id（插入顺序，补录早日期入库单会成
 *  “最近价”）的问题随之消除——均价与行选取顺序无关，不再需要 ORDER BY d.date DESC, l.id DESC。 */
const HIST_AVG_COST_SQL = `(SELECT SUM(CASE WHEN l.unitCost > 0 THEN l.qty * l.unitCost ELSE 0 END) * 1.0
     / NULLIF(SUM(CASE WHEN l.unitCost > 0 THEN l.qty ELSE 0 END), 0)
   FROM stock_ledger l JOIN doc d ON d.id = l.refDocId
   WHERE l.teamId = s.teamId AND l.productId = s.productId AND l.direction = 'in'
     AND d.type = 'stockin' AND d.status = 'audit' AND d.date <= date('now', 'localtime'))`;

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
      // 名称/条码/规格任一命中（扫码查库存时手上只有条码）
      const like = `%${String(req.query.kw).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conds.push(`(p.name LIKE ? ESCAPE '\\' OR IFNULL(p.barcode,'') LIKE ? ESCAPE '\\' OR IFNULL(p.spec,'') LIKE ? ESCAPE '\\')`);
      args.push(like, like, like);
    }
    if (req.query.ifShowZero === '0') {
      conds.push('s.qty != 0');
    }
    const list = db
      .prepare(
        `SELECT s.productId, p.name AS prodName, p.spec, p.unit, p.lowQty, s.warehouseId, w.name AS warehouseName,
                s.reservoirId, s.batchNo, SUM(s.qty) AS qty,
                COALESCE(${HIST_AVG_COST_SQL}, p.purchasePrice) AS estUnitCost
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
    // 库存成本：历史采购均价（估算）× 库存量，与报表 avgCost 同口径（B-数8）。
    // 注意不能 LEFT JOIN 全部入库流水——那会让每条库存行 × 每条流水相乘，货值虚增；
    // 也不能只看 direction='in'——销售退货(sret)的 unitCost 是售价，会污染货值
    const stockValue = (
      db
        .prepare(
          `SELECT COALESCE(SUM(s.qty * COALESCE(${HIST_AVG_COST_SQL},
               (SELECT p.purchasePrice FROM product p WHERE p.id = s.productId), 0)), 0) AS v
           FROM stock s
           WHERE s.teamId = ? AND s.qty > 0`,
        )
        .get(teamId) as { v: number }
    ).v;
    const today = localDate();
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
           AND date <= date('now', 'localtime')
           AND type IN ('stockin','stockout','pin','sret')
         GROUP BY day ORDER BY day`,
      )
      .all(teamId) as Array<{ day: string; inQty: number; outQty: number }>;
    return res.json(rows);
  });

  /**
   * 库存流水查询。
   * 原先固定 `LIMIT 200` 且只支持按商品过滤，超过 200 条的流水直接看不见，
   * 也没法按仓库/日期查。现在支持 warehouseId/from/to 过滤 + 分页：
   * 带 page/rows 时返回 { rows, total }，不带时仍返回数组（兼容旧调用）。
   */
  router.get('/stock/ledger', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const productId = Number(req.query.productId);
    const warehouseId = Number(req.query.warehouseId);
    const conds: string[] = ['teamId = ?'];
    const args: Array<string | number> = [teamId];
    if (productId) {
      conds.push('productId = ?');
      args.push(productId);
    }
    if (warehouseId) {
      conds.push('warehouseId = ?');
      args.push(warehouseId);
    }
    // 流水按 createdAt 存本地时间字符串（YYYY-MM-DD HH:mm:ss），日期区间直接比前缀
    const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : '';
    const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : '';
    if (from) {
      conds.push('substr(createdAt,1,10) >= ?');
      args.push(from);
    }
    if (to) {
      conds.push('substr(createdAt,1,10) <= ?');
      args.push(to);
    }
    const where = conds.join(' AND ');
    const paged = req.query.page !== undefined || req.query.rows !== undefined;
    if (!paged) {
      const list = db.prepare(`SELECT * FROM stock_ledger WHERE ${where} ORDER BY id DESC LIMIT 200`).all(...args);
      return res.json(list);
    }
    const rows = Math.min(Math.max(Number(req.query.rows) || 50, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM stock_ledger WHERE ${where}`).get(...args) as { c: number }).c;
    const list = db
      .prepare(`SELECT * FROM stock_ledger WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, rows, (page - 1) * rows);
    return res.json({ rows: list, total, page, rowsPerPage: rows });
  });

  // 汇总仪表盘：SKU 数、库存总量、库存货值（历史采购均价（估算），与报表同口径，B-数8）
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
        `SELECT SUM(s.qty * COALESCE(${HIST_AVG_COST_SQL},
               (SELECT p.purchasePrice FROM product p WHERE p.id = s.productId), 0)) AS v
         FROM stock s WHERE s.teamId=? AND s.qty != 0`,
      )
      .get(teamId) as { v: number | null };
    return res.json({ skuCount: sku.c, totalQty: total.q ?? 0, stockValue: value.v ?? 0 });
  });
}