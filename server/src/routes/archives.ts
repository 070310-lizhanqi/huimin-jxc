/**
 * 基础档案 CRUD（含删除引用保护、外键团队归属校验、枚举校验）与商品批量导入路由
 */
import type { Request, Response, Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { mountCrud } from '../crud';
import { createWindowLimiter } from '../db';
import { recordAuditFromRequest } from '../infra/audit-log';
import { BusyError, sendError } from '../infra/errors';
import { logger } from '../infra/logger';
import { parseEnum, parseOptionalPositiveInt, parsePositiveInt } from '../infra/validate';
import { requireAdmin } from '../middleware/rbac';
import { importProducts } from '../services/product-import-service';

const ACCOUNT_TYPES = ['cash', 'bank', 'wechat', 'alipay', 'other'] as const;
const PRICE_LEVELS = ['salePrice', 'retailPrice', 'wholePrice', 'purchasePrice'] as const;

export function mountArchiveRoutes(api: Router, db: DatabaseSync): void {
  const exists = (sql: string, ...args: Array<string | number>): boolean =>
    Boolean((db.prepare(sql).get(...args) as { c: number } | undefined)?.c);

  mountCrud(api, db, {
    table: 'cat',
    fields: ['parentId', 'name'],
    deleteGuard: (_d, id, teamId) => {
      if (exists(`SELECT COUNT(*) AS c FROM cat WHERE parentId = ? AND teamId = ?`, id, teamId))
        return '分类下还有子分类，不能删除';
      if (exists(`SELECT COUNT(*) AS c FROM product WHERE catId = ? AND teamId = ?`, id, teamId))
        return '分类下还有商品，不能删除';
      return null;
    },
    validate: (body) => {
      const parentParsed = parseOptionalPositiveInt(body.parentId, '父分类');
      if (!parentParsed.ok) return parentParsed.error;
      const parentId = parentParsed.value;
      if (parentId !== null) {
        const teamId = Number(body.teamId);
        const p = db.prepare(`SELECT id FROM cat WHERE id = ? AND teamId = ?`).get(parentId, teamId) as
          { id: number } | undefined;
        if (!p) return '父分类不存在';
        const editId = Number(body.id);
        if (editId) {
          const parentStmt = db.prepare(`SELECT parentId FROM cat WHERE id = ? AND teamId = ?`);
          let cur = parentId;
          for (let hop = 0; hop < 100; hop++) {
            if (cur === editId) return '父分类不能是自己或自己的子分类';
            const row = parentStmt.get(cur, teamId) as { parentId: number | null } | undefined;
            if (!row || !row.parentId) break;
            cur = row.parentId;
          }
        }
      }
      return null;
    },
  });

  mountCrud(api, db, {
    table: 'product',
    fields: [
      'catId',
      'name',
      'barcode',
      'unit',
      'spec',
      'salePrice',
      'retailPrice',
      'purchasePrice',
      'wholePrice',
      'lowQty',
      'remark',
      'archived',
    ],
    kwFields: ['barcode', 'spec'],
    validate: (body) => {
      if (body.catId !== undefined && body.catId !== null && body.catId !== '') {
        const parsed = parseOptionalPositiveInt(body.catId, 'catId');
        if (!parsed.ok) return parsed.error;
        if (parsed.value !== null) {
          const teamId = Number(body.teamId);
          if (!exists(`SELECT COUNT(*) AS c FROM cat WHERE id = ? AND teamId = ?`, parsed.value, teamId)) {
            return '商品分类不存在';
          }
        }
      }
      return null;
    },
    deleteGuard: (_d, id, teamId) => {
      if (
        exists(
          `SELECT COUNT(*) AS c FROM doc_item i JOIN doc x ON x.id = i.docId WHERE i.productId = ? AND x.teamId = ?`,
          id,
          teamId,
        )
      )
        return '商品已被单据引用，不能删除';
      if (exists(`SELECT COUNT(*) AS c FROM stock WHERE productId = ? AND teamId = ? AND qty != 0`, id, teamId))
        return '商品还有库存，不能删除';
      return null;
    },
  });

  mountCrud(api, db, {
    table: 'warehouse',
    fields: ['name', 'remark'],
    deleteGuard: (_d, id, teamId) => {
      if (exists(`SELECT COUNT(*) AS c FROM reservoir WHERE warehouseId = ? AND teamId = ?`, id, teamId))
        return '仓库下还有库位，不能删除';
      if (exists(`SELECT COUNT(*) AS c FROM stock WHERE warehouseId = ? AND teamId = ? AND qty != 0`, id, teamId))
        return '仓库还有库存，不能删除';
      if (
        exists(
          `SELECT COUNT(*) AS c FROM doc WHERE teamId = ? AND status != 'void' AND (warehouseId = ? OR warehouseId IS NULL) AND EXISTS (SELECT 1 FROM doc_item WHERE docId = doc.id AND toWarehouseId = ?)`,
          teamId,
          id,
          id,
        )
      )
        return '仓库已被调拨单引用，不能删除';
      if (exists(`SELECT COUNT(*) AS c FROM doc WHERE teamId = ? AND warehouseId = ? AND status != 'void'`, teamId, id))
        return '仓库已被单据引用，不能删除';
      return null;
    },
  });

  mountCrud(api, db, {
    table: 'reservoir',
    fields: ['warehouseId', 'name'],
    validate: (body) => {
      const teamId = Number(body.teamId);
      const isEdit = Number(body.id) > 0;
      if (!isEdit && (body.warehouseId === undefined || body.warehouseId === null || body.warehouseId === '')) {
        return '所属仓库不能为空';
      }
      if (body.warehouseId !== undefined) {
        const parsed = parsePositiveInt(body.warehouseId, 'warehouseId');
        if (!parsed.ok) return '所属仓库参数非法';
        if (!exists(`SELECT COUNT(*) AS c FROM warehouse WHERE id = ? AND teamId = ?`, parsed.value, teamId)) {
          return '所属仓库不存在';
        }
      }
      return null;
    },
    deleteGuard: (_d, id, teamId) => {
      if (exists(`SELECT COUNT(*) AS c FROM stock WHERE reservoirId = ? AND teamId = ? AND qty != 0`, id, teamId))
        return '库位还有库存，不能删除';
      return null;
    },
  });

  mountCrud(api, db, {
    table: 'customer',
    fields: ['name', 'mobile', 'address', 'remark', 'priceLevel'],
    validate: (body) => {
      if (body.priceLevel !== undefined && body.priceLevel !== null && body.priceLevel !== '') {
        const parsed = parseEnum(body.priceLevel, PRICE_LEVELS, '价格等级');
        if (!parsed.ok) return parsed.error;
      }
      return null;
    },
    deleteGuard: (_d, id, teamId) => {
      if (
        exists(`SELECT COUNT(*) AS c FROM doc WHERE teamId = ? AND partnerType = 'cus' AND partnerId = ?`, teamId, id)
      )
        return '客户已有单据记录，不能删除';
      if (
        exists(
          `SELECT COUNT(*) AS c FROM settlement WHERE teamId = ? AND partnerType = 'cus' AND partnerId = ?`,
          teamId,
          id,
        )
      )
        return '客户已有收付款记录，不能删除';
      return null;
    },
  });

  mountCrud(api, db, {
    table: 'vendor',
    fields: ['name', 'mobile', 'address', 'remark'],
    deleteGuard: (_d, id, teamId) => {
      if (
        exists(`SELECT COUNT(*) AS c FROM doc WHERE teamId = ? AND partnerType = 'ven' AND partnerId = ?`, teamId, id)
      )
        return '供应商已有单据记录，不能删除';
      if (
        exists(
          `SELECT COUNT(*) AS c FROM settlement WHERE teamId = ? AND partnerType = 'ven' AND partnerId = ?`,
          teamId,
          id,
        )
      )
        return '供应商已有收付款记录，不能删除';
      return null;
    },
  });

  mountCrud(api, db, {
    table: 'clerk',
    fields: ['name', 'mobile'],
    deleteGuard: (_d, id, teamId) => {
      if (exists(`SELECT COUNT(*) AS c FROM doc WHERE teamId = ? AND clerkId = ?`, teamId, id))
        return '业务员已被单据引用，不能删除';
      return null;
    },
  });

  mountCrud(api, db, {
    table: 'account',
    fields: ['name', 'type', 'balance'],
    createOnlyFields: ['balance'],
    validate: (body) => {
      if (body.type !== undefined && body.type !== null && body.type !== '') {
        const parsed = parseEnum(body.type, ACCOUNT_TYPES, '账户类型');
        if (!parsed.ok) return parsed.error;
      }
      return null;
    },
    deleteGuard: (_d, id, teamId) => {
      if (exists(`SELECT COUNT(*) AS c FROM settlement WHERE teamId = ? AND accountId = ?`, teamId, id))
        return '账户已有收付款流水，不能删除';
      return null;
    },
  });

  mountCrud(api, db, {
    table: 'unit',
    fields: ['name', 'remark'],
    deleteGuard: (d, id, teamId) => {
      const row = d.prepare(`SELECT name, teamId FROM unit WHERE id = ? AND teamId = ?`).get(id, teamId) as
        { name: string; teamId: number } | undefined;
      if (!row) return null;
      return exists(`SELECT COUNT(*) AS c FROM product WHERE teamId = ? AND unit = ?`, row.teamId, row.name)
        ? '该单位已被商品使用，不能删除'
        : null;
    },
  });

  const productImportLimit = createWindowLimiter(100, 60_000);
  api.post('/product/import', requireAdmin('仅管理员可批量导入商品'), (req: Request, res: Response) => {
    const teamIdParsed = parsePositiveInt(req.body.teamId, 'teamId');
    if (!teamIdParsed.ok) return sendError(req, res, 400, 'teamId 不能为空');
    const teamId = teamIdParsed.value;
    if (!productImportLimit(`team:${teamId}`)) {
      return sendError(req, res, 429, '导入过于频繁，请稍后再试', 'RATE_LIMITED');
    }
    const rows = req.body.rows as Array<Record<string, unknown>>;
    if (!Array.isArray(rows) || rows.length === 0) return sendError(req, res, 400, '导入数据不能为空');
    if (rows.length > 1000) return sendError(req, res, 400, '单次最多导入 1000 行');

    try {
      const result = importProducts(db, teamId, rows);
      recordAuditFromRequest(db, req, {
        teamId,
        action: 'product.import',
        entityType: 'product',
        detail: { success: result.success, errors: result.errors.length, total: result.total },
      });
      return res.json(result);
    } catch (e) {
      if (e instanceof BusyError) {
        return sendError(req, res, 503, e.message, 'SERVICE_UNAVAILABLE');
      }
      logger.error('Product batch import failed', { teamId, err: e });
      return sendError(req, res, 500, '导入失败，请稍后重试', 'INTERNAL_ERROR');
    }
  });
}
