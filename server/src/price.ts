import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, Router } from 'express';
import { escapeLike } from './crud';

/**
 * 客户价格记忆（price_memory）
 *
 * 业务语义：同一个客户买同一个商品，下次开单自动带出上次的成交价。
 * 惠民云把它当核心卖点（「价格记忆」），因为批发客户的价格经常一客一价。
 *
 * 记忆写入时机：销售类单据（stockout / sret / sorder / quo）审核通过时，
 * 按「客户 + 商品」记录最后一次的成交单价与成交日期（覆盖式，只留最新一条）。
 * 读取时机：开单选客户/商品时，前端查 /price/memory 批量取回，优先级高于商品默认售价。
 */
export function mountPriceMemory(router: Router, db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teamId INTEGER NOT NULL,
      partnerId INTEGER NOT NULL,
      productId INTEGER NOT NULL,
      price INTEGER NOT NULL,
      lastDate TEXT,
      times INTEGER DEFAULT 1,
      UNIQUE (teamId, partnerId, productId)
    );
  `);

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

/** 审核单据时调用：把这张单的每一行价格记入客户价格记忆 */
export function rememberPrices(
  db: DatabaseSync,
  doc: { teamId: number; type: string; partnerType: string | null; partnerId: number | null; date: string },
  docId: number,
): void {
  if (doc.partnerType !== 'cus' || !doc.partnerId) return;
  if (!['stockout', 'sret', 'sorder', 'quo'].includes(doc.type)) return;
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
