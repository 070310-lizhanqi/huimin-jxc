/**
 * 通用 CRUD 工厂：为档案表生成 list/create/update/delete 路由。
 * 约定：所有表带 teamId 隔离；id 自增。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, Router } from 'express';

type Value = string | number | null;

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
}

export function mountCrud(router: Router, db: DatabaseSync, cfg: CrudConfig): void {
  const cols = cfg.fields.join(', ');
  const holders = cfg.fields.map(() => '?').join(', ');
  const updateFields = cfg.fields.filter((f) => !(cfg.createOnlyFields ?? []).includes(f));
  const sets = updateFields.map((f) => `${f} = ?`).join(', ');

  router.get(`/${cfg.table}`, (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const kw = String(req.query.kw ?? '').trim();
    let sql = `SELECT * FROM ${cfg.table} WHERE teamId = ?`;
    const args: Value[] = [teamId];
    if (kw) {
      sql += ` AND name LIKE ?`;
      args.push(`%${kw}%`);
    }
    sql += ` ORDER BY ${cfg.orderBy ?? 'id'}`;
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
    const info = db
      .prepare(`INSERT INTO ${cfg.table} (teamId, ${cols}) VALUES (?, ${holders})`)
      .run(teamId, ...values);
    const row = db.prepare(`SELECT * FROM ${cfg.table} WHERE id = ?`).get(info.lastInsertRowid);
    return res.json(row);
  });

  router.put(`/${cfg.table}/:id`, (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const id = Number(req.params.id);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    if (cfg.validate) {
      const err = cfg.validate(req.body as Record<string, unknown>);
      if (err) return res.status(400).json({ error: err });
    }
    const values: Value[] = updateFields.map((f) => normalize(req.body[f]));
    const info = db
      .prepare(`UPDATE ${cfg.table} SET ${sets} WHERE id = ? AND teamId = ?`)
      .run(...values, id, teamId);
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
    db.prepare(`DELETE FROM ${cfg.table} WHERE id = ? AND teamId = ?`).run(id, teamId);
    return res.json({ ok: true });
  });
}

function normalize(v: unknown): Value {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  return String(v);
}