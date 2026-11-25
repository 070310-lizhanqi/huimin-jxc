import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, Router } from 'express';
import { escapeLike } from './crud';

/**
 * 客户价格记忆（price_memory）
 *
 * 业务语义：同一个客户买同一个商品，下次开单自动带出上次的成交价。
 * 原产品把它当核心卖点（「价格记忆」），因为批发客户的价格经常一客一价。
 *
 * 记忆写入时机：销售类单据（stockout / sret / sorder / quo）审核通过时，
 * 按「客户 + 商品」记录最后一次的成交单价与成交日期（覆盖式，只留最新一条）。
 * 读取时机：开单选客户/商品时，前端查 /price/memory 批量取回，优先级高于商品默认售价。
 */
export function mountPriceMemory(router: Router, db: DatabaseSync): void {
  // price_memory 表结构已由 db.ts V002_price_memory_schema 统一迁移管理

  /** 取某客户对一批商品的历史价（开单时一次性批量查，避免逐行请求） */
  router.get('/price/memory', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    const partnerId = Number(req.query.partnerId);
    if (!teamId || !partnerId) return res.json({ list: [] });
    const rows = db
      .prepare(`SELECT productId, price, lastDate, times FROM price_memory WHERE teamId = ? AND partnerId = ?`)
      .all(teamId, partnerId);
    return res.json({ list: rows });
  });

  /** 某客户的全部价格记忆（商品管理里的「客户价格」页用） */
  router.get('/price/list', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    const partnerId = Number(req.query.partnerId);
    const kw = String(req.query.kw ?? '').trim();
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const where: string[] = ['m.teamId = ?'];
    const args: Array<string | number> = [teamId];
    if (partnerId) { where.push('m.partnerId = ?'); args.push(partnerId); }
    if (kw) { where.push('p.name LIKE ? ESCAPE \'\\\''); args.push(`%${escapeLike(kw)}%`); }
    const rows = db
      .prepare(
        `SELECT m.*, p.name AS prodName, p.spec, p.unit, p.salePrice,
                c.name AS cusName
         FROM price_memory m
         JOIN product p ON p.id = m.productId AND p.teamId = m.teamId
         LEFT JOIN customer c ON c.id = m.partnerId AND c.teamId = m.teamId
         WHERE ${where.join(' AND ')}
         ORDER BY m.lastDate DESC, m.id DESC LIMIT 500`,
      )
      .all(...args);
    // total 让前端能识别「被 LIMIT 500 静默截断」的情况并提示筛选
    const total = (
      db.prepare(`SELECT COUNT(*) AS c FROM price_memory m WHERE ${where.join(' AND ')}`).get(...args) as { c: number }
    ).c;
    return res.json({ rows, total, truncated: total > rows.length });
  });

  /** 手工改价记忆（也允许删除单条） */
  router.post('/price/set', (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const partnerId = Number(req.body.partnerId);
    const productId = Number(req.body.productId);
    const price = Number(req.body.price);
    if (!teamId || !partnerId || !productId) return res.status(400).json({ error: '缺少必填参数' });
    if (!(price >= 0)) return res.status(400).json({ error: '价格不能为负' });
    // 金额上限与结算侧同量级：误录 15 位数会成为该客户的默认开单价
    if (!Number.isFinite(price) || price > 1e11) return res.status(400).json({ error: '价格超出上限（10 亿元），请核对后重试' });
    // 归属校验：客户与商品必须属于本团队（记忆行带 teamId，但引用的档案可以是跨团队 id）
    const cus = db.prepare(`SELECT id FROM customer WHERE id = ? AND teamId = ?`).get(partnerId, teamId);
    if (!cus) return res.status(400).json({ error: '客户不存在' });
    const prod = db.prepare(`SELECT id FROM product WHERE id = ? AND teamId = ?`).get(productId, teamId);
    if (!prod) return res.status(400).json({ error: '商品不存在' });
    // 手工改价不冒充「最近成交」：已有 lastDate（真实成交日）时保留，仅首次记忆记今天
    db.prepare(
      `INSERT INTO price_memory (teamId, partnerId, productId, price, lastDate, times)
       VALUES (?, ?, ?, ?, date('now','localtime'), 1)
       ON CONFLICT (teamId, partnerId, productId)
       DO UPDATE SET price = excluded.price,
         lastDate = CASE WHEN price_memory.lastDate IS NULL OR price_memory.lastDate = '' THEN excluded.lastDate ELSE price_memory.lastDate END`,
    ).run(teamId, partnerId, productId, Math.round(price));
    return res.json({ ok: true });
  });

  router.delete('/price/:id', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    const id = Number(req.params.id);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    db.prepare(`DELETE FROM price_memory WHERE id = ? AND teamId = ?`).run(id, teamId);
    return res.json({ ok: true });
  });
}

/** 写价格记忆的单据类型（B-数2 重算时类型范围必须与此对齐） */
const PRICE_MEMORY_TYPES = ['stockout', 'sret', 'sorder', 'quo'];

/** 审核单据时调用：把这张单的每一行价格记入客户价格记忆 */
export function rememberPrices(
  db: DatabaseSync,
  doc: { teamId: number; type: string; partnerType: string | null; partnerId: number | null; date: string },
  docId: number,
): void {
  if (doc.partnerType !== 'cus' || !doc.partnerId) return;
  if (!PRICE_MEMORY_TYPES.includes(doc.type)) return;
  const items = db
    .prepare(`SELECT productId, price FROM doc_item WHERE docId = ? AND price > 0`)
    .all(docId) as Array<{ productId: number; price: number }>;
  const up = db.prepare(
    `INSERT INTO price_memory (teamId, partnerId, productId, price, lastDate, times)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT (teamId, partnerId, productId)
     DO UPDATE SET price = excluded.price, lastDate = excluded.lastDate, times = times + 1
     WHERE excluded.lastDate >= price_memory.lastDate`,
  );
  for (const it of items) {
    up.run(doc.teamId, doc.partnerId, it.productId, Math.round(it.price), doc.date);
  }
}

/**
 * 作废回滚价格记忆（B-数2）：按剩余已审核单重算该客户该商品的最新价。
 * 调用方（/doc/void）在写锁事务内、状态改为 void 之前调用，本函数按 docId 排除被作废单。
 * 口径与 rememberPrices 一致：只看 partnerType='cus'、类型属于 PRICE_MEMORY_TYPES、
 * price > 0 的明细行；最新价按业务日期倒序、再按单据 id 倒序取（同日后审核的覆盖先审核的，
 * 与 lastDate >= 守卫的“同日可覆盖”语义一致）；无剩余已审核单则删除记忆行。
 * times 口径：剩余已审核单中该商品 price > 0 的明细行数，与 rememberPrices 每次审核按行 +1
 * 的口径一致。已知微小偏差：后补一张更早日期的单，审核时会被 lastDate >= 守卫拦下未计次，
 * 重算会把它计入，times 可能比“实际计次”多——价格与 lastDate 本身不受影响。
 */
export function recomputePriceMemory(
  db: DatabaseSync,
  doc: { teamId: number; type: string; partnerType: string | null; partnerId: number | null; date: string },
  docId: number,
): void {
  if (doc.partnerType !== 'cus' || !doc.partnerId) return;
  if (!PRICE_MEMORY_TYPES.includes(doc.type)) return;
  const products = db
    .prepare(`SELECT DISTINCT productId FROM doc_item WHERE docId = ? AND price > 0`)
    .all(docId) as Array<{ productId: number }>;
  const typePlaceholders = PRICE_MEMORY_TYPES.map(() => '?').join(',');
  const latestStmt = db.prepare(
    `SELECT i.price, d.date FROM doc_item i JOIN doc d ON d.id = i.docId
     WHERE d.teamId = ? AND d.status = 'audit' AND d.type IN (${typePlaceholders})
       AND d.partnerType = 'cus' AND d.partnerId = ? AND i.productId = ? AND i.price > 0 AND d.id <> ?
     ORDER BY d.date DESC, d.id DESC LIMIT 1`,
  );
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS c FROM doc_item i JOIN doc d ON d.id = i.docId
     WHERE d.teamId = ? AND d.status = 'audit' AND d.type IN (${typePlaceholders})
       AND d.partnerType = 'cus' AND d.partnerId = ? AND i.productId = ? AND i.price > 0 AND d.id <> ?`,
  );
  const upsert = db.prepare(
    `INSERT INTO price_memory (teamId, partnerId, productId, price, lastDate, times)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (teamId, partnerId, productId)
     DO UPDATE SET price = excluded.price, lastDate = excluded.lastDate, times = excluded.times`,
  );
  const del = db.prepare(`DELETE FROM price_memory WHERE teamId = ? AND partnerId = ? AND productId = ?`);
  for (const { productId } of products) {
    const latest = latestStmt.get(
      doc.teamId, ...PRICE_MEMORY_TYPES, doc.partnerId, productId, docId,
    ) as { price: number; date: string } | undefined;
    if (!latest) {
      del.run(doc.teamId, doc.partnerId, productId);
      continue;
    }
    const times = (
      countStmt.get(doc.teamId, ...PRICE_MEMORY_TYPES, doc.partnerId, productId, docId) as { c: number }
    ).c;
    upsert.run(doc.teamId, doc.partnerId, productId, Math.round(latest.price), latest.date, times);
  }
}
