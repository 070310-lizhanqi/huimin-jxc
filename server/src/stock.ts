/**
 * 库存查询：实时库存列表 / 商品当前成本 / 库存流水
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, Router } from 'express';
import { localDate } from './db';
import { centsToYuan, csvCell, MAX_EXPORT_ROWS } from './shared/csv';
import { HIST_AVG_COST_SQL } from './shared/money';

export function mountStockQueries(router: Router, db: DatabaseSync): void {
  // 实时库存（可按仓库/商品/关键词过滤，聚合同商品多仓位批次）
  //
  // B-前2 服务端分页：只有显式传 page 才返回分页对象
  //   { rows, total, page, rowsPerPage, totals: { totalQty, totalValue, lowCount } }；
  // 不传 page 时沿用旧行为返回全量数组（兼容 test-doc-import*.cjs 的 rows=50 用法与
  // 13-doc-editor.js 的旧调用；rows 单独传时不改变形状）。
  // 分页时 rows 缺省 50、钳制 1~500。
  // totals 在全量过滤集上聚合（不是当前页），否则前端合计只算当前页；
  // lowCount 是商品级低库存商品数（总量 <= 安全库存），与 /stats/dashboard 同口径。
  // group=prod：按商品汇总分页（每商品一行，qty 为跨仓总量），供库存页汇总视图用——
  // 行级分页会把同一商品拆到不同页，汇总视图无法正确分组，故汇总视图必须在商品级分页。
  // onlyLow=1：只看低库存商品；sort=qtyAsc|qtyDesc：按数量排序（默认按商品名，与旧口径一致）。
  router.get('/stock/list', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const warehouseId = req.query.warehouseId ? Number(req.query.warehouseId) : 0;
    const productId = req.query.productId ? Number(req.query.productId) : 0;
    const kw = typeof req.query.kw === 'string' ? req.query.kw : '';
    const hideZero = req.query.ifShowZero === '0';
    const onlyLow = req.query.onlyLow === '1' || req.query.onlyLow === 'true';
    const sort = String(req.query.sort ?? '');
    const groupProd = req.query.group === 'prod';
    const paged = req.query.page !== undefined;
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const rowsPerPage = Math.min(
      500,
      Math.max(1, Number(req.query.rows) > 0 ? Math.floor(Number(req.query.rows)) : 50),
    );

    // 共享过滤条件（明细/汇总/合计/低库存子查询共用同一口径）
    const conds: string[] = ['s.teamId = ?'];
    const args: Array<string | number> = [teamId];
    if (warehouseId) {
      conds.push('s.warehouseId = ?');
      args.push(warehouseId);
    }
    if (productId) {
      conds.push('s.productId = ?');
      args.push(productId);
    }
    if (kw) {
      // 名称/条码/规格任一命中（扫码查库存时手上只有条码）
      const like = `%${kw.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conds.push(`(p.name LIKE ? ESCAPE '\\' OR IFNULL(p.barcode,'') LIKE ? ESCAPE '\\' OR IFNULL(p.spec,'') LIKE ? ESCAPE '\\')`);
      args.push(like, like, like);
    }
    if (hideZero) {
      conds.push('s.qty != 0');
    }
    const where = conds.join(' AND ');

    /**
     * 低库存商品 id 集：商品级口径（同一商品在筛选范围内的库存总量 <= 安全库存），
     * 与 /stats/dashboard 的低库存判定一致，但限定在本次请求的仓库/kw/产品过滤内；
     * ifShowZero=0 时总量为 0 的商品不计入（与前端汇总视图过滤零库存后算 lowCount 一致）。
     * 既用于 onlyLow 过滤，也用于给明细行打 isLow 标记与 totals.lowCount。
     */
    const lowConds: string[] = ['s2.teamId = ?'];
    const lowArgs: Array<string | number> = [teamId];
    if (warehouseId) {
      lowConds.push('s2.warehouseId = ?');
      lowArgs.push(warehouseId);
    }
    if (productId) {
      lowConds.push('s2.productId = ?');
      lowArgs.push(productId);
    }
    if (kw) {
      const like = `%${kw.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      lowConds.push(`(p2.name LIKE ? ESCAPE '\\' OR IFNULL(p2.barcode,'') LIKE ? ESCAPE '\\' OR IFNULL(p2.spec,'') LIKE ? ESCAPE '\\')`);
      lowArgs.push(like, like, like);
    }
    const lowHaving = hideZero
      ? `HAVING COALESCE(SUM(s2.qty), 0) <= MAX(p2.lowQty) AND MAX(p2.lowQty) > 0 AND COALESCE(SUM(s2.qty), 0) != 0`
      : `HAVING COALESCE(SUM(s2.qty), 0) <= MAX(p2.lowQty) AND MAX(p2.lowQty) > 0`;
    const lowSql = `SELECT s2.productId FROM stock s2 JOIN product p2 ON p2.id = s2.productId WHERE ${lowConds.join(' AND ')} GROUP BY s2.productId ${lowHaving}`;

    const orderBy =
      sort === 'qtyAsc'
        ? ' ORDER BY qty ASC, p.name ASC'
        : sort === 'qtyDesc'
          ? ' ORDER BY qty DESC, p.name ASC'
          : ' ORDER BY p.name';

    let baseSelect: string;
    let allArgs: Array<string | number>;
    if (groupProd) {
      // 按商品汇总：qty 为跨仓总量；whs 是去重后的仓库名（逗号分隔，前端再按 '、' 展示）；
      // batchNo 取首个非空批次（与旧前端汇总取首个非空批次一致）；value 为货值（qty × 估价成本）。
      // hideZero 在汇总口径下是 HAVING 总量 != 0（行级 s.qty != 0 已在 WHERE 里，
      // 但 +5/-5 两行合计为 0 的商品旧前端汇总视图也会过滤掉）。
      const having: string[] = [];
      if (onlyLow) having.push('COALESCE(SUM(s.qty), 0) <= MAX(p.lowQty) AND MAX(p.lowQty) > 0');
      if (hideZero) having.push('SUM(s.qty) != 0');
      baseSelect = `SELECT s.productId, p.name AS prodName, p.spec, p.unit, p.lowQty,
              SUM(s.qty) AS qty, COUNT(*) AS rows, COUNT(s.reservoirId) AS locs,
              GROUP_CONCAT(DISTINCT w.name) AS whs, MIN(NULLIF(s.batchNo, '')) AS batchNo,
              COALESCE(${HIST_AVG_COST_SQL}, p.purchasePrice) AS estUnitCost,
              SUM(s.qty) * COALESCE(${HIST_AVG_COST_SQL}, p.purchasePrice) AS value
       FROM stock s
       JOIN product p ON p.id = s.productId
       LEFT JOIN warehouse w ON w.id = s.warehouseId
       WHERE ${where}
       GROUP BY s.productId${having.length ? ` HAVING ${having.join(' AND ')}` : ''}`;
      allArgs = args;
    } else {
      baseSelect = `SELECT s.productId, p.name AS prodName, p.spec, p.unit, p.lowQty, s.warehouseId, w.name AS warehouseName,
              s.reservoirId, s.batchNo, SUM(s.qty) AS qty,
              COALESCE(${HIST_AVG_COST_SQL}, p.purchasePrice) AS estUnitCost
       FROM stock s
       JOIN product p ON p.id = s.productId
       LEFT JOIN warehouse w ON w.id = s.warehouseId
       WHERE ${where}${onlyLow ? ` AND s.productId IN (${lowSql})` : ''}
       GROUP BY s.productId, s.warehouseId, s.reservoirId, s.batchNo`;
      allArgs = onlyLow ? [...args, ...lowArgs] : args;
    }

    if (!paged) {
      const list = db.prepare(`${baseSelect}${orderBy}`).all(...allArgs) as Array<Record<string, unknown>>;
      if (groupProd) {
        // 汇总行自带 isLow（导出/全量模式用，与分页口径一致）
        for (const r of list) r.isLow = (Number(r.lowQty) || 0) > 0 && (Number(r.qty) || 0) <= (Number(r.lowQty) || 0) ? 1 : 0;
      }
      return res.json(list);
    }

    // 分页：合计在全量过滤集上聚合（COUNT + SUM 一次查出），与当页行数无关
    const agg = (
      groupProd
        ? db
          .prepare(
            `SELECT COUNT(*) AS total, COALESCE(SUM(qty), 0) AS totalQty, COALESCE(SUM(value), 0) AS totalValue,
                    COALESCE(SUM(CASE WHEN lowQty > 0 AND qty <= lowQty THEN 1 ELSE 0 END), 0) AS lowCount
             FROM (${baseSelect})`,
          )
          .get(...allArgs)
        : db
          .prepare(
            `SELECT COUNT(*) AS total, COALESCE(SUM(qty), 0) AS totalQty,
                    COALESCE(SUM(qty * estUnitCost), 0) AS totalValue
             FROM (${baseSelect})`,
          )
          .get(...allArgs)
    ) as { total: number; totalQty: number; totalValue: number; lowCount?: number };
    // 明细口径的 lowCount 是商品级（不能从分组行直接加总），单独取低库存商品 id 集
    let lowCount = agg.lowCount ?? 0;
    let lowSet = new Set<number>();
    if (!groupProd) {
      lowSet = new Set(
        (db.prepare(lowSql).all(...lowArgs) as Array<{ productId: number }>).map((r) => r.productId),
      );
      lowCount = lowSet.size;
    }
    const pageRows = db
      .prepare(`${baseSelect}${orderBy} LIMIT ? OFFSET ?`)
      .all(...allArgs, rowsPerPage, (page - 1) * rowsPerPage) as Array<Record<string, unknown>>;
    for (const r of pageRows) {
      r.isLow = groupProd
        ? (Number(r.lowQty) || 0) > 0 && (Number(r.qty) || 0) <= (Number(r.lowQty) || 0)
          ? 1
          : 0
        : lowSet.has(Number(r.productId))
          ? 1
          : 0;
    }
    return res.json({
      rows: pageRows,
      total: agg.total,
      page,
      rowsPerPage,
      totals: { totalQty: agg.totalQty, totalValue: agg.totalValue, lowCount },
    });
  });

  /**
   * B-前3 轻量接口：开单编辑器换仓库时只建 productId → qty 的 Map，
   * 不需要 /stock/list 的商品名/规格/成本等列。只返回两列，口径与编辑器旧的
   * “全量 /stock/list 再本地 SUM”完全一致（同仓所有库存行按商品汇总，含零库存行）。
   */
  router.get('/stock/qty-by-product', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    const warehouseId = Number(req.query.warehouseId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    if (!warehouseId) return res.status(400).json({ error: 'warehouseId 不能为空' });
    const rows = db
      .prepare(
        `SELECT s.productId, SUM(s.qty) AS qty FROM stock s
         WHERE s.teamId = ? AND s.warehouseId = ? GROUP BY s.productId ORDER BY s.productId`,
      )
      .all(teamId, warehouseId);
    return res.json(rows);
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

  // 库存流水 CSV 导出（由 docs.ts 迁回库存模块，与 /stock/ledger 共用筛选口径）
  router.get('/stock/ledger/export', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const conds: string[] = ['l.teamId = ?'];
    const args: Array<string | number> = [teamId];
    const productId = Number(req.query.productId);
    const warehouseId = Number(req.query.warehouseId);
    if (productId) {
      conds.push('l.productId = ?');
      args.push(productId);
    }
    if (warehouseId) {
      conds.push('l.warehouseId = ?');
      args.push(warehouseId);
    }
    const from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : '';
    const to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : '';
    if (from) {
      conds.push('substr(l.createdAt,1,10) >= ?');
      args.push(from);
    }
    if (to) {
      conds.push('substr(l.createdAt,1,10) <= ?');
      args.push(to);
    }
    const where = conds.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) AS c FROM stock_ledger l WHERE ${where}`).get(...args) as { c: number };
    if (total.c > MAX_EXPORT_ROWS) {
      return res
        .status(400)
        .json({ error: `导出数据 ${total.c} 条，超过上限 ${MAX_EXPORT_ROWS} 条，请缩小筛选范围后再导出` });
    }
    const rows = db
      .prepare(
        `SELECT l.createdAt, l.direction, l.qty, l.unitCost, l.batchNo, l.refDocId,
           (SELECT name FROM product WHERE id = l.productId) AS prodName,
           (SELECT name FROM warehouse WHERE id = l.warehouseId) AS whName,
           (SELECT billNo FROM doc WHERE id = l.refDocId) AS billNo
         FROM stock_ledger l WHERE ${where} ORDER BY l.id DESC LIMIT ?`,
      )
      .all(...args, MAX_EXPORT_ROWS) as Array<{
      createdAt: string;
      direction: string;
      qty: number;
      unitCost: number | null;
      batchNo: string | null;
      refDocId: number;
      prodName: string | null;
      whName: string | null;
      billNo: string | null;
    }>;
    const filename = `库存流水导出_${localDate().replace(/-/g, '')}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('X-Export-Total', String(total.c));
    res.write(
      '\ufeff' + ['时间', '商品', '仓库', '批次', '方向', '数量', '成本单价(元)', '关联单据'].map(csvCell).join(',') + '\r\n',
    );
    for (const r of rows) {
      res.write(
        [
          r.createdAt,
          r.prodName || '',
          r.whName || '',
          r.batchNo || '',
          r.direction === 'in' ? '入库' : '出库',
          r.qty,
          centsToYuan(r.unitCost),
          r.billNo || '#' + r.refDocId,
        ]
          .map(csvCell)
          .join(',') + '\r\n',
      );
    }
    return res.end();
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