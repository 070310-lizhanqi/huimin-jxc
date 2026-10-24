/**
 * 通用 CRUD 工厂：为档案表生成 list/create/update/delete 路由。
 * 约定：所有表带 teamId 隔离；id 自增。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, Router } from 'express';

type Value = string | number | null;

/** 列表分页保护：单页行数上限（防止恶意大分页拖垮内存） */
export const CRUD_MAX_ROWS = 500;

/** LIKE 通配符转义：% _ 与 ESCAPE 字符本身按字面匹配（关键词含 % 时不再全表模糊） */
export function escapeLike(v: string): string {
  return v.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface CrudConfig {
  table: string;
  fields: string[]; // 可写字段（不含 id/teamId）
  /** 仅创建时可写、更新时忽略（如账户期初余额——余额只能由收付款/结算变动） */
  createOnlyFields?: string[];
  orderBy?: string;
  /** 删除前引用检查：返回错误信息则拒绝删除（自动限定本团队） */
  deleteGuard?: (db: DatabaseSync, id: number, teamId: number) => string | null;
  /** 创建/更新前校验：返回错误信息则拒绝写入（body 含 teamId） */
  validate?: (body: Record<string, unknown>) => string | null;
  /** 额外的关键词搜索列（如商品的 barcode/spec），与 name 一并 LIKE */
  kwFields?: string[];
}

export function mountCrud(router: Router, db: DatabaseSync, cfg: CrudConfig): void {
  const cols = cfg.fields.join(', ');
  const holders = cfg.fields.map(() => '?').join(', ');
  const updateFields = cfg.fields.filter((f) => !(cfg.createOnlyFields ?? []).includes(f));

  router.get(`/${cfg.table}`, (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const kw = String(req.query.kw ?? '').trim();
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    // 行数保护：0~500，缺省全量（小账套档案量不大，兼容旧客户端不带分页）
    const rawRows = Number(req.query.rows ?? 0);
    const rows = Math.min(CRUD_MAX_ROWS, Math.max(0, Number.isFinite(rawRows) ? Math.floor(rawRows) : 0));
    let sql = `SELECT * FROM ${cfg.table} WHERE teamId = ?`;
    const args: Value[] = [teamId];
    if (kw) {
      // 名称 + 附加字段（条码/规格）模糊匹配；通配符按字面处理
      const like = `%${escapeLike(kw)}%`;
      const fields = ['name', ...(cfg.kwFields ?? [])];
      sql += ` AND (${fields.map((f) => `IFNULL(${f}, '') LIKE ? ESCAPE '\\'`).join(' OR ')})`;
      for (let i = 0; i < fields.length; i++) args.push(like);
    }
    sql += ` ORDER BY ${cfg.orderBy ?? 'id'}`;
    if (rows > 0) {
      sql += ` LIMIT ? OFFSET ?`;
      args.push(rows, (page - 1) * rows);
    } else {
      // 全量兜底上限：极端情况下（误把档案当导入用）也不会一次性吐几十万行。
      // 用占位符而非字符串插值：与上方分页写法一致，防止维护者照搬 ${} 模式引入注入。
      sql += ` LIMIT ?`;
      args.push(CRUD_MAX_ROWS);
    }
    return res.json(db.prepare(sql).all(...args));
  });

  router.post(`/${cfg.table}`, (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    if (cfg.validate) {
      const err = cfg.validate(req.body as Record<string, unknown>);
      if (err) return res.status(400).json({ error: err });
    }
    const values: Value[] = cfg.fields.map((f) => normalize(req.body[f]));
    let info: { lastInsertRowid: number | bigint };
    try {
      info = db
        .prepare(`INSERT INTO ${cfg.table} (teamId, ${cols}) VALUES (?, ${holders})`)
        .run(teamId, ...values);
    } catch {
      // 唯一索引兜底（如商品同名）触发时返回友好错误而非 500
      return res.status(400).json({ error: '保存失败：名称可能已存在' });
    }
    const row = db.prepare(`SELECT * FROM ${cfg.table} WHERE id = ?`).get(info.lastInsertRowid);
    return res.json(row);
  });

  router.put(`/${cfg.table}/:id`, (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const id = Number(req.params.id);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    if (cfg.validate) {
      // PUT 语义补充路由 id：validate 需要区分「新建」与「编辑自身」
      // （如分类父级成环检测依赖被编辑记录的 id）。
      const err = cfg.validate({ ...(req.body as Record<string, unknown>), id });
      if (err) return res.status(400).json({ error: err });
    }
    // PATCH 式更新：请求体未携带的字段（undefined）保持旧值，显式传 null/'' 才清空。
    // 原实现把 undefined 一律 normalize 成 NULL——局部更新会静默清掉未携带的字段
    // （前端目前总发全量字段所以未触发，但 API 是对外契约，不能埋这个雷）
    const present = updateFields.filter((f) => (req.body as Record<string, unknown>)[f] !== undefined);
    if (!present.length) return res.status(400).json({ error: '没有可更新的字段' });
    const values: Value[] = present.map((f) => normalize(req.body[f]));
    let info: { changes: number | bigint };
    try {
      info = db
        .prepare(`UPDATE ${cfg.table} SET ${present.map((f) => `${f} = ?`).join(', ')} WHERE id = ? AND teamId = ?`)
        .run(...values, id, teamId);
    } catch {
      return res.status(400).json({ error: '保存失败：名称可能已存在' });
    }
    if (info.changes === 0) return res.status(404).json({ error: '记录不存在' });
    const row = db
      .prepare(`SELECT * FROM ${cfg.table} WHERE id = ? AND teamId = ?`)
      .get(id, teamId);
    return res.json(row);
  });

  router.delete(`/${cfg.table}/:id`, (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    const id = Number(req.params.id);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    if (cfg.deleteGuard) {
      // guard 带 teamId：引用检查只看本团队的记录，跨团队 id 不构成删除障碍也不泄露他队数据
      const err = cfg.deleteGuard(db, id, teamId);
      if (err) return res.status(400).json({ error: err });
    }
    // 删除带归属校验返回影响行数：目标不存在/跨团队时返回 404（此前静默返回 ok 语义失真）
    const info = db.prepare(`DELETE FROM ${cfg.table} WHERE id = ? AND teamId = ?`).run(id, teamId);
    if (info.changes === 0) return res.status(404).json({ error: '记录不存在' });
    return res.json({ ok: true });
  });
}

function normalize(v: unknown): Value {
  if (v === undefined || v === null || v === '') return null;
  // number：NaN/Infinity 会被 better-sqlite3 拒绝或落 NULL，显式转 null 防怪数据
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v;
  // boolean/object 静默 String() 化会落库成 "true"/"[object Object]" 污染档案，显式置 null
  return null;
}
