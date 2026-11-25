/**
 * 审计日志查询路由（仅管理员）
 */
import type { Request, Response, Router } from 'express';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { escapeLike } from '../crud';
import { validBizDate } from '../db';
import { sendError } from '../infra/errors';
import { requireAdmin } from '../middleware/rbac';

export function mountAuditRoutes(router: Router, db: DatabaseSync): void {
  router.get('/audit-logs', requireAdmin('仅管理员可查看审计日志'), (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId ?? req.auth?.teamId ?? 0);
    if (!teamId) return sendError(req, res, 400, 'teamId 不能为空');

    const page = Math.max(1, Math.floor(Number(req.query.page ?? 1) || 1));
    const rawRows = Number(req.query.rows ?? 50);
    const rows = Math.min(200, Math.max(1, Number.isFinite(rawRows) && rawRows > 0 ? Math.floor(rawRows) : 50));

    const conds: string[] = ['teamId = ?'];
    const args: SQLInputValue[] = [teamId];

    const action = typeof req.query.action === 'string' ? req.query.action.trim() : '';
    if (action) {
      conds.push('action = ?');
      args.push(action);
    }
    const entityType = typeof req.query.entityType === 'string' ? req.query.entityType.trim() : '';
    if (entityType) {
      conds.push('entityType = ?');
      args.push(entityType);
    }
    const from = typeof req.query.from === 'string' ? req.query.from.trim() : '';
    if (from) {
      const err = validBizDate(from);
      if (err) return sendError(req, res, 400, `from 参数非法：${err}`);
      conds.push('substr(createdAt, 1, 10) >= ?');
      args.push(from);
    }
    const to = typeof req.query.to === 'string' ? req.query.to.trim() : '';
    if (to) {
      const err = validBizDate(to);
      if (err) return sendError(req, res, 400, `to 参数非法：${err}`);
      conds.push('substr(createdAt, 1, 10) <= ?');
      args.push(to);
    }
    if (from && to && from > to) {
      return sendError(req, res, 400, 'from 不能晚于 to');
    }

    const kw = typeof req.query.kw === 'string' ? req.query.kw.trim() : '';
    if (kw) {
      const like = `%${escapeLike(kw)}%`;
      conds.push(
        `(IFNULL(username,'') LIKE ? ESCAPE '\\' OR IFNULL(action,'') LIKE ? ESCAPE '\\' OR IFNULL(entityId,'') LIKE ? ESCAPE '\\' OR IFNULL(detail,'') LIKE ? ESCAPE '\\')`,
      );
      args.push(like, like, like, like);
    }

    const whereSql = conds.join(' AND ');
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE ${whereSql}`).get(...args) as { c: number }).c;
    const list = db
      .prepare(
        `SELECT id, teamId, userId, username, action, entityType, entityId, requestId, ip, detail, createdAt
         FROM audit_log WHERE ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, rows, (page - 1) * rows);

    return res.json({ rows: list, total, page, rowsPerPage: rows });
  });
}
