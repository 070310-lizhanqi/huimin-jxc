/**
 * 通用 CRUD 工厂：为档案表生成 list/create/update/delete 路由。
 * 约定：所有表带 teamId 隔离；id 自增。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, Router } from 'express';
import { recordAuditFromRequest } from './infra/audit-log';
import { AppError, NotFoundError, sendError, ValidationError } from './infra/errors';
import { withImmediateTx } from './infra/tx';
import { parsePositiveInt } from './infra/validate';
import { PRICE_CENTS_MAX, QTY_MAX, roundQty } from './shared/money';

type Value = string | number | null;

/** 列表分页保护：单页行数上限（防止恶意大分页拖垮内存） */
export const CRUD_MAX_ROWS = 500;

export { PRICE_CENTS_MAX, QTY_MAX };

/**
 * B-安13：档案字段上限（与导入侧共用同一份常量，见 docimport.ts / product-import-service.ts）。
 */
export const FIELD_LIMITS: Record<string, number> = {
  name: 100,
  barcode: 64,
  spec: 200,
  remark: 500,
  address: 200,
  mobile: 32,
  unit: 50,
  priceLevel: 20,
  type: 20,
};
/** 以“分”为单位存整数的字段：小数一律 Math.round 取整，拒绝 REAL 落库 */
export const INT_CENTS_FIELDS = new Set(['salePrice', 'retailPrice', 'purchasePrice', 'wholePrice', 'balance']);
/** 以 4 位小数存的数量字段 */
export const QTY_FIELDS = new Set(['lowQty']);
/** 外键整数 ID 字段 */
const INT_ID_FIELDS = new Set(['parentId', 'catId', 'warehouseId']);

/** 校验 + 规整单个可写字段：返回 { value } 或 { error }（长度/整数分/数量上限） */
export function checkField(field: string, v: unknown): { value: Value } | { error: string } {
  if (typeof v === 'string') {
    if (v === '') return { value: null }; // 空串按旧 normalize 口径置 NULL（显式传 null/'' 才清空）
    const limit = FIELD_LIMITS[field];
    if (limit !== undefined && v.length > limit) {
      return { error: `「${field}」长度不能超过 ${limit} 个字符` };
    }
    if (INT_ID_FIELDS.has(field)) {
      const s = v.trim();
      if (s === '') return { value: null };
      if (!/^\d+$/.test(s)) return { error: `「${field}」必须是正整数` };
      const n = Number(s);
      if (!Number.isSafeInteger(n) || n <= 0) return { error: `「${field}」必须是正整数` };
      return { value: n };
    }
    if (INT_CENTS_FIELDS.has(field)) {
      const s = v.trim();
      if (s === '') return { value: null };
      if (!/^-?\d+(\.\d+)?$/.test(s)) return { error: `「${field}」必须是数字（单位：分）` };
      const n = Math.round(Number(s));
      if (!Number.isFinite(n)) return { error: `「${field}」必须是数字（单位：分）` };
      if (field !== 'balance' && n < 0) return { error: `「${field}」不能为负数` };
      if (field !== 'balance' && Math.abs(n) > PRICE_CENTS_MAX)
        return { error: `「${field}」超出上限 ${PRICE_CENTS_MAX} 分` };
      return { value: n };
    }
    if (QTY_FIELDS.has(field)) {
      const s = v.trim();
      if (s === '') return { value: null };
      if (!/^-?\d+(\.\d+)?$/.test(s)) return { error: `「${field}」必须是数字` };
      const n = roundQty(Number(s));
      if (!Number.isFinite(n)) return { error: `「${field}」必须是数字` };
      if (n < 0) return { error: `「${field}」不能为负数` };
      if (Math.abs(n) > QTY_MAX) return { error: `「${field}」超出上限 ${QTY_MAX}` };
      return { value: n };
    }
    return { value: v };
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { value: null };
    if (INT_ID_FIELDS.has(field)) {
      if (!Number.isSafeInteger(v) || v <= 0) return { error: `「${field}」必须是正整数` };
      return { value: v };
    }
    if (INT_CENTS_FIELDS.has(field)) {
      const n = Math.round(v);
      if (field !== 'balance' && n < 0) return { error: `「${field}」不能为负数` };
      if (field !== 'balance' && Math.abs(n) > PRICE_CENTS_MAX)
        return { error: `「${field}」超出上限 ${PRICE_CENTS_MAX} 分` };
      return { value: n };
    }
    if (QTY_FIELDS.has(field)) {
      const n = roundQty(v);
      if (n < 0) return { error: `「${field}」不能为负数` };
      if (Math.abs(n) > QTY_MAX) return { error: `「${field}」超出上限 ${QTY_MAX}` };
      return { value: n };
    }
    return { value: v };
  }
  return { value: normalize(v) };
}

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
    if (!Number.isInteger(teamId) || teamId <= 0)
      return sendError(req, res, 400, 'teamId 不能为空', 'VALIDATION_ERROR');
    const kw = String(req.query.kw ?? '').trim();
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    /**
     * B-前2 分页：只有显式传 page 才返回分页对象 { rows, total, page, rowsPerPage }。
     * 只传 rows 时沿用旧行为（返回数组、LIMIT rows）：test-backup-db-batch2 / test-gzip-batch3
     * 用 rows=500 取全量数组，改形状会直接 break 它们；旧客户端不带 page 也不受影响。
     * 分页时 rows 缺省 50、钳制 1~CRUD_MAX_ROWS。
     */
    const paged = req.query.page !== undefined;
    const rawRows = Number(req.query.rows ?? 0);
    const rows = paged
      ? Math.min(CRUD_MAX_ROWS, Math.max(1, Number.isFinite(rawRows) && rawRows > 0 ? Math.floor(rawRows) : 50))
      : Math.min(CRUD_MAX_ROWS, Math.max(0, Number.isFinite(rawRows) ? Math.floor(rawRows) : 0));
    let where = `teamId = ?`;
    const whereArgs: Value[] = [teamId];
    if (kw) {
      // 名称 + 附加字段（条码/规格）模糊匹配；通配符按字面处理
      const like = `%${escapeLike(kw)}%`;
      const fields = ['name', ...(cfg.kwFields ?? [])];
      where += ` AND (${fields.map((f) => `IFNULL(${f}, '') LIKE ? ESCAPE '\\'`).join(' OR ')})`;
      for (let i = 0; i < fields.length; i++) whereArgs.push(like);
    }
    const sql = `SELECT * FROM ${cfg.table} WHERE ${where} ORDER BY ${cfg.orderBy ?? 'id'}`;
    if (paged) {
      const total = (
        db.prepare(`SELECT COUNT(*) AS c FROM ${cfg.table} WHERE ${where}`).get(...whereArgs) as { c: number }
      ).c;
      const list = db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...whereArgs, rows, (page - 1) * rows);
      return res.json({ rows: list, total, page, rowsPerPage: rows });
    }
    const args: Value[] = [...whereArgs];
    let listSql = sql;
    if (rows > 0) {
      listSql += ` LIMIT ? OFFSET ?`;
      args.push(rows, (page - 1) * rows);
    } else {
      // 全量兜底上限：极端情况下（误把档案当导入用）也不会一次性吐几十万行。
      // 用占位符而非字符串插值：与上方分页写法一致，防止维护者照搬 ${} 模式引入注入。
      listSql += ` LIMIT ?`;
      args.push(CRUD_MAX_ROWS);
    }
    return res.json(db.prepare(listSql).all(...args));
  });

  router.post(`/${cfg.table}`, (req: Request, res: Response) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return sendError(req, res, 400, '请求体必须是对象', 'VALIDATION_ERROR');
    }
    const body = req.body as Record<string, unknown>;
    const teamIdParsed = parsePositiveInt(body.teamId, 'teamId');
    if (!teamIdParsed.ok) return sendError(req, res, 400, 'teamId 不能为空', 'VALIDATION_ERROR');
    const teamId = teamIdParsed.value;
    if (cfg.fields.includes('name')) {
      const rawName = body.name;
      if (typeof rawName !== 'string' || !rawName.trim()) {
        return sendError(req, res, 400, '名称不能为空', 'VALIDATION_ERROR');
      }
    }
    const values: Value[] = [];
    for (const f of cfg.fields) {
      const checked = checkField(f, body[f]);
      if ('error' in checked) return sendError(req, res, 400, checked.error, 'VALIDATION_ERROR');
      values.push(checked.value);
    }
    try {
      const row = withImmediateTx(db, () => {
        if (cfg.validate) {
          const err = cfg.validate(body);
          if (err) throw new ValidationError(err);
        }
        let info: { lastInsertRowid: number | bigint };
        try {
          info = db.prepare(`INSERT INTO ${cfg.table} (teamId, ${cols}) VALUES (?, ${holders})`).run(teamId, ...values);
        } catch {
          throw new ValidationError('保存失败：名称可能已存在');
        }
        const newId = Number(info.lastInsertRowid);
        return db.prepare(`SELECT * FROM ${cfg.table} WHERE id = ?`).get(newId) as Record<string, unknown>;
      });
      const newId = Number(row.id);
      recordAuditFromRequest(db, req, {
        teamId,
        action: `archive.${cfg.table}.create`,
        entityType: cfg.table,
        entityId: newId,
        detail: { name: body.name ?? null },
      });
      return res.json(row);
    } catch (e) {
      if (e instanceof AppError) return sendError(req, res, e.statusCode, e.message, e.code);
      return sendError(req, res, 400, '保存失败：名称可能已存在', 'VALIDATION_ERROR');
    }
  });

  router.put(`/${cfg.table}/:id`, (req: Request, res: Response) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return sendError(req, res, 400, '请求体必须是对象', 'VALIDATION_ERROR');
    }
    const body = req.body as Record<string, unknown>;
    const teamIdParsed = parsePositiveInt(body.teamId, 'teamId');
    if (!teamIdParsed.ok) return sendError(req, res, 400, 'teamId 不能为空', 'VALIDATION_ERROR');
    const teamId = teamIdParsed.value;
    const idParsed = parsePositiveInt(req.params.id, 'id');
    if (!idParsed.ok) return sendError(req, res, 400, idParsed.error, 'VALIDATION_ERROR');
    const id = idParsed.value;
    if (cfg.fields.includes('name') && body.name !== undefined) {
      const rawName = body.name;
      if (typeof rawName !== 'string' || !rawName.trim()) {
        return sendError(req, res, 400, '名称不能为空', 'VALIDATION_ERROR');
      }
    }
    // PATCH 式更新：请求体未携带的字段（undefined）保持旧值，显式传 null/'' 才清空。
    const present = updateFields.filter((f) => body[f] !== undefined);
    if (!present.length) return sendError(req, res, 400, '没有可更新的字段', 'VALIDATION_ERROR');
    const values: Value[] = [];
    for (const f of present) {
      const checked = checkField(f, body[f]);
      if ('error' in checked) return sendError(req, res, 400, checked.error, 'VALIDATION_ERROR');
      values.push(checked.value);
    }
    try {
      const row = withImmediateTx(db, () => {
        if (cfg.validate) {
          // PUT 语义补充路由 id：validate 需要区分「新建」与「编辑自身」
          const err = cfg.validate({ ...body, id });
          if (err) throw new ValidationError(err);
        }
        let info: { changes: number | bigint };
        try {
          info = db
            .prepare(`UPDATE ${cfg.table} SET ${present.map((f) => `${f} = ?`).join(', ')} WHERE id = ? AND teamId = ?`)
            .run(...values, id, teamId);
        } catch {
          throw new ValidationError('保存失败：名称可能已存在');
        }
        if (info.changes === 0) throw new NotFoundError('记录不存在');
        return db.prepare(`SELECT * FROM ${cfg.table} WHERE id = ? AND teamId = ?`).get(id, teamId);
      });
      recordAuditFromRequest(db, req, {
        teamId,
        action: `archive.${cfg.table}.update`,
        entityType: cfg.table,
        entityId: id,
        detail: { fields: present },
      });
      return res.json(row);
    } catch (e) {
      if (e instanceof AppError) return sendError(req, res, e.statusCode, e.message, e.code);
      return sendError(req, res, 400, '保存失败：名称可能已存在');
    }
  });

  router.delete(`/${cfg.table}/:id`, (req: Request, res: Response) => {
    const teamIdParsed = parsePositiveInt(req.query.teamId, 'teamId');
    if (!teamIdParsed.ok) return sendError(req, res, 400, 'teamId 不能为空');
    const teamId = teamIdParsed.value;
    const idParsed = parsePositiveInt(req.params.id, 'id');
    if (!idParsed.ok) return sendError(req, res, 400, idParsed.error);
    const id = idParsed.value;
    try {
      withImmediateTx(db, () => {
        if (cfg.deleteGuard) {
          // guard 带 teamId：引用检查只看本团队的记录，跨团队 id 不构成删除障碍也不泄露他队数据
          const err = cfg.deleteGuard(db, id, teamId);
          if (err) throw new ValidationError(err);
        }
        // 删除带归属校验返回影响行数：目标不存在/跨团队时返回 404（此前静默返回 ok 语义失真）
        const info = db.prepare(`DELETE FROM ${cfg.table} WHERE id = ? AND teamId = ?`).run(id, teamId);
        if (info.changes === 0) throw new NotFoundError('记录不存在');
      });
      recordAuditFromRequest(db, req, {
        teamId,
        action: `archive.${cfg.table}.delete`,
        entityType: cfg.table,
        entityId: id,
      });
      return res.json({ ok: true });
    } catch (e) {
      if (e instanceof AppError) return sendError(req, res, e.statusCode, e.message, e.code);
      return sendError(req, res, 400, '删除失败');
    }
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
