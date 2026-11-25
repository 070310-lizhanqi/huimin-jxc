/**
 * 单据（doc / doc_item）REST 路由层
 * - 使用 withImmediateTx 统一写锁事务 + 安全回滚
 * - /doc/create、/doc/audit、/doc/void 支持 Idempotency-Key 持久化幂等键
 * - 写操作记录审计日志 audit_log
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, Router } from 'express';
import { nextBillNo } from '../bill-no';
import { localDate } from '../db';
import { recordAuditTxFromRequest } from '../infra/audit-log';
import { AppError, ConflictError, sendError, ValidationError } from '../infra/errors';
import {
  extractIdempotencyKey,
  hashRequestPayload,
  lookupIdempotencyKey,
  saveIdempotencyKey,
} from '../infra/idempotency';
import { withImmediateTx } from '../infra/tx';
import { parseOptionalString, parsePositiveInt } from '../infra/validate';
import { recomputePriceMemory, rememberPrices } from '../price';
import {
  computeDocFinancials,
  dedupCreate,
  DOC_META,
  DOC_STATUS_TEXT,
  docListFilter,
  insertItems,
  ORDER_TYPES,
  rememberCreate,
  reverseSettleOnVoid,
  settleOnAudit,
  validateDocInput,
} from '../services/doc-service';
import type { DocInput } from '../services/doc-service';
import { COST_TYPES, postStock, precheckStock, snapshotStocktake, StockError } from '../services/stock-service';
import { centsToYuan, csvCell, MAX_EXPORT_ROWS } from '../shared/csv';
import { lineAmount, MAX_TOTAL_AMOUNT_CENTS, roundQty, sumQty } from '../shared/money';

export function mountDocs(router: Router, db: DatabaseSync): void {
  router.get('/doc/list', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return sendError(req, res, 400, 'teamId 不能为空');
    const filter = docListFilter(req, teamId);
    if (filter.error) return sendError(req, res, 400, filter.error);
    const { conds, args, statusArgIndex } = filter;
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const rows = Math.min(200, Math.max(1, Number(req.query.rows ?? 20) || 20));
    const total = db.prepare(`SELECT COUNT(*) AS c FROM doc d WHERE ${conds.join(' AND ')}`).get(...args) as {
      c: number;
    };
    const list = db
      .prepare(
        `SELECT d.*,
           (SELECT GROUP_CONCAT(x, '、') FROM (
              SELECT p.name || '×' || CAST(i.qty AS TEXT) AS x
              FROM doc_item i LEFT JOIN product p ON p.id = i.productId
              WHERE i.docId = d.id ORDER BY i.id LIMIT 3
            )) AS summary,
           (SELECT COUNT(*) FROM doc_item WHERE docId = d.id) AS itemCount,
           (SELECT GROUP_CONCAT(nm, '、') FROM (
              SELECT DISTINCT w2.name AS nm FROM doc_item i2
                JOIN warehouse w2 ON w2.id = i2.toWarehouseId
                WHERE i2.docId = d.id
            )) AS toWarehouseNames
         FROM doc d WHERE ${conds.join(' AND ')} ORDER BY d.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, rows, (page - 1) * rows);
    const statConds = conds.filter((c) => c !== 'd.status = ?');
    const statArgs = statConds.length === conds.length ? args : args.filter((_, i) => i !== statusArgIndex);
    const statusStats = db
      .prepare(`SELECT d.status AS s, COUNT(*) AS c FROM doc d WHERE ${statConds.join(' AND ')} GROUP BY d.status`)
      .all(...statArgs) as Array<{ s: string; c: number }>;
    const statusCount: Record<string, number> = { draft: 0, pending: 0, audit: 0, void: 0 };
    for (const r of statusStats) statusCount[r.s] = r.c;
    return res.json({ total: total.c, rows: list, page, pageSize: rows, statusCount });
  });

  router.get('/doc/export', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return sendError(req, res, 400, 'teamId 不能为空');
    const filter = docListFilter(req, teamId);
    if (filter.error) return sendError(req, res, 400, filter.error);
    const { conds, args } = filter;
    const where = conds.join(' AND ');
    const total = db.prepare(`SELECT COUNT(*) AS c FROM doc d WHERE ${where}`).get(...args) as { c: number };
    if (total.c > MAX_EXPORT_ROWS) {
      return sendError(req, res, 400, `导出数据 ${total.c} 条，超过上限 ${MAX_EXPORT_ROWS} 条，请缩小筛选范围后再导出`);
    }
    const rows = db
      .prepare(
        `SELECT d.billNo, d.date, d.totalQty, d.totalAmount, d.status, d.remark,
           CASE WHEN d.partnerType = 'cus' THEN (SELECT name FROM customer WHERE id = d.partnerId)
                WHEN d.partnerType = 'ven' THEN (SELECT name FROM vendor WHERE id = d.partnerId)
                ELSE '' END AS partnerName,
           (SELECT name FROM warehouse WHERE id = d.warehouseId) AS warehouseName
         FROM doc d WHERE ${where} ORDER BY d.id DESC LIMIT ?`,
      )
      .all(...args, MAX_EXPORT_ROWS) as Array<{
      billNo: string;
      date: string;
      totalQty: number;
      totalAmount: number;
      status: string;
      remark: string | null;
      partnerName: string | null;
      warehouseName: string | null;
    }>;
    const filename = `单据导出_${localDate().replace(/-/g, '')}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('X-Export-Total', String(total.c));
    res.write(
      '\ufeff' +
        ['单号', '日期', '往来单位', '仓库', '合计数量', '合计金额(元)', '状态', '备注'].map(csvCell).join(',') +
        '\r\n',
    );
    for (const r of rows) {
      res.write(
        [
          r.billNo,
          (r.date || '').slice(0, 10),
          r.partnerName || '',
          r.warehouseName || '',
          r.totalQty,
          centsToYuan(r.totalAmount),
          DOC_STATUS_TEXT[r.status] || r.status,
          r.remark || '',
        ]
          .map(csvCell)
          .join(',') + '\r\n',
      );
    }
    return res.end();
  });

  router.get('/doc/pending', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return sendError(req, res, 400, 'teamId 不能为空');
    const list = db
      .prepare(
        `SELECT d.*,
           (SELECT GROUP_CONCAT(x, '、') FROM (
              SELECT p.name || '×' || CAST(i.qty AS TEXT) AS x
              FROM doc_item i LEFT JOIN product p ON p.id = i.productId
              WHERE i.docId = d.id ORDER BY i.id LIMIT 3
            )) AS summary,
           (SELECT COUNT(*) FROM doc_item WHERE docId = d.id) AS itemCount
         FROM doc d
         WHERE d.teamId = ? AND d.status = 'pending'
         ORDER BY d.submitAt ASC, d.id ASC
         LIMIT 500`,
      )
      .all(teamId);
    return res.json({ rows: list, total: list.length });
  });

  router.get('/doc/bill-nos', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return sendError(req, res, 400, 'teamId 不能为空');
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 200);
    if (!ids.length) return res.json({});
    const rows = db
      .prepare(`SELECT id, billNo, type, date FROM doc WHERE teamId = ? AND id IN (${ids.map(() => '?').join(',')})`)
      .all(teamId, ...ids) as Array<{ id: number; billNo: string | null; type: string; date: string }>;
    const out: Record<string, { billNo: string | null; type: string; date: string }> = {};
    for (const r of rows) out[String(r.id)] = { billNo: r.billNo, type: r.type, date: r.date };
    return res.json(out);
  });

  router.get('/doc/items', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return sendError(req, res, 400, 'teamId 不能为空');
    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 200);
    if (!ids.length) return res.json({});
    const rows = db
      .prepare(
        `SELECT i.docId, i.productId, p.name AS prodName, p.spec AS prodSpec, p.unit AS prodUnit,
                i.qty, i.price, i.amount
         FROM doc_item i
         LEFT JOIN product p ON p.id = i.productId
         WHERE i.docId IN (${ids.map(() => '?').join(',')})
           AND i.docId IN (SELECT id FROM doc WHERE teamId = ?)
         ORDER BY i.docId, i.id`,
      )
      .all(...ids, teamId) as Array<Record<string, unknown>>;
    const out: Record<string, Array<Record<string, unknown>>> = {};
    for (const r of rows) {
      const k = String(r.docId);
      (out[k] ??= []).push({
        productId: r.productId,
        prodName: r.prodName,
        spec: r.prodSpec,
        unit: r.prodUnit,
        qty: r.qty,
        price: r.price,
        amount: r.amount,
      });
    }
    return res.json(out);
  });

  router.get('/doc/info', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return sendError(req, res, 400, 'teamId 不能为空');
    const idParsed = parsePositiveInt(req.query.id, 'id');
    if (!idParsed.ok) return sendError(req, res, 400, idParsed.error);
    const id = idParsed.value;
    const doc = db.prepare('SELECT * FROM doc WHERE id = ? AND teamId = ?').get(id, teamId) as
      { type: string } | undefined;
    if (!doc) return sendError(req, res, 404, '单据不存在');
    const items = db.prepare('SELECT * FROM doc_item WHERE docId = ? ORDER BY id').all(id);
    let fulfillment: Array<{ productId: number; ordered: number; converted: number; remain: number }> | null = null;
    if (ORDER_TYPES.has(doc.type)) {
      const converted = db
        .prepare(
          `SELECT i.productId, COALESCE(SUM(i.qty), 0) AS qty
           FROM doc_item i JOIN doc d ON d.id = i.docId
           WHERE d.refOrderId = ? AND d.teamId = ? AND d.status <> 'void'
           GROUP BY i.productId`,
        )
        .all(id, teamId) as Array<{ productId: number; qty: number }>;
      const convMap = new Map<number, number>(converted.map((r) => [r.productId, r.qty]));
      fulfillment = (items as Array<{ productId: number; qty: number }>).map((it) => {
        const avail = convMap.get(it.productId) ?? 0;
        const used = roundQty(Math.min(Math.max(0, it.qty), Math.max(0, avail)));
        convMap.set(it.productId, roundQty(avail - used));
        return { productId: it.productId, ordered: it.qty, converted: used, remain: roundQty(it.qty - used) };
      });
    }
    return res.json({ doc, items, fulfillment });
  });

  router.post('/doc/create', (req: Request, res: Response) => {
    const input = req.body as DocInput;
    const err = validateDocInput(db, input);
    if (err) return sendError(req, res, 400, err);

    const idem = extractIdempotencyKey(req);
    if ('error' in idem) return sendError(req, res, 400, idem.error);
    const reqHash = idem.present ? hashRequestPayload('POST:/doc/create', req.body) : '';
    if (idem.present) {
      const hitKey = lookupIdempotencyKey(db, input.teamId, 'doc.create', idem.key, reqHash);
      if ('conflict' in hitKey) {
        return sendError(req, res, 409, '幂等键冲突：相同 Idempotency-Key 不可用于不同请求参数', 'CONFLICT');
      }
      if (hitKey.hit) {
        res.setHeader('Idempotent-Replayed', 'true');
        return res.status(hitKey.statusCode).json(hitKey.body);
      }
    }

    if (!idem.present) {
      const dup = dedupCreate(db, input, req.auth?.userId);
      if (dup) return res.json(dup);
    }

    const fin = computeDocFinancials(input);
    if (!fin.ok) return sendError(req, res, 400, fin.error);
    const { totalQty, totalAmount, discount, paidAmount, deposit } = fin.value;
    const docDate = typeof input.date === 'string' && input.date.trim() ? input.date.trim() : localDate();
    const remarkVal = typeof input.remark === 'string' && input.remark !== '' ? input.remark : null;
    const receiverName =
      typeof input.receiverName === 'string' && input.receiverName !== '' ? input.receiverName : null;
    const receiverMobile =
      typeof input.receiverMobile === 'string' && input.receiverMobile !== '' ? input.receiverMobile : null;
    const receiverAddress =
      typeof input.receiverAddress === 'string' && input.receiverAddress !== '' ? input.receiverAddress : null;

    let docId = 0;
    let billNo = '';
    let replayed = false;
    try {
      withImmediateTx(db, () => {
        if (idem.present) {
          const hitInTx = lookupIdempotencyKey(db, input.teamId, 'doc.create', idem.key, reqHash);
          if ('conflict' in hitInTx) {
            throw new ConflictError('幂等键冲突：相同 Idempotency-Key 不可用于不同请求参数');
          }
          if (hitInTx.hit) {
            const payload = hitInTx.body as { id: number; billNo: string };
            docId = payload.id;
            billNo = payload.billNo;
            replayed = true;
            return;
          }
        }
        billNo = nextBillNo(db, input.teamId, input.type);
        const info = db
          .prepare(
            `INSERT INTO doc (teamId, billNo, type, date, partnerType, partnerId, clerkId, warehouseId, status, remark, totalAmount, totalQty, userId, refOrderId,
                               receiverName, receiverMobile, receiverAddress, discount, paidAmount, accountId, deposit)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.teamId,
            billNo,
            input.type,
            docDate,
            input.partnerType ?? null,
            input.partnerId ? Number(input.partnerId) : null,
            input.clerkId ? Number(input.clerkId) : null,
            input.warehouseId ? Number(input.warehouseId) : null,
            remarkVal,
            totalAmount,
            totalQty,
            req.auth?.userId ?? null,
            input.refOrderId ? Number(input.refOrderId) : null,
            receiverName,
            receiverMobile,
            receiverAddress,
            discount,
            paidAmount,
            input.accountId ? Number(input.accountId) : null,
            deposit,
          );
        docId = Number(info.lastInsertRowid);
        insertItems(db, docId, input.items);
        recordAuditTxFromRequest(db, req, {
          teamId: input.teamId,
          action: 'doc.create',
          entityType: 'doc',
          entityId: docId,
          detail: { billNo, type: input.type, totalAmount, itemCount: input.items.length },
        });
        if (idem.present) {
          saveIdempotencyKey(db, input.teamId, 'doc.create', idem.key, reqHash, 200, { id: docId, billNo });
        }
      });
    } catch (e) {
      if (e instanceof AppError) return sendError(req, res, e.statusCode, e.message, e.code);
      if (e instanceof StockError) return sendError(req, res, 400, e.message);
      return sendError(req, res, 400, '保存失败');
    }

    if (replayed) {
      res.setHeader('Idempotent-Replayed', 'true');
    } else if (!idem.present) {
      rememberCreate(input, docId, billNo, req.auth?.userId);
    }
    return res.json({ id: docId, billNo });
  });

  router.post('/doc/convert', (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const idParsed = parsePositiveInt(req.body.id, 'id');
    if (!idParsed.ok) return sendError(req, res, 400, idParsed.error);
    const id = idParsed.value;
    const doc = db.prepare(`SELECT * FROM doc WHERE id = ? AND teamId = ?`).get(id, teamId) as
      | {
          type: string;
          status: string;
          partnerType: string | null;
          partnerId: number | null;
          clerkId: number | null;
          warehouseId: number;
          remark: string | null;
          receiverName: string | null;
          receiverMobile: string | null;
          receiverAddress: string | null;
        }
      | undefined;
    if (!doc) return sendError(req, res, 404, '单据不存在');
    if (!ORDER_TYPES.has(doc.type)) return sendError(req, res, 400, '仅订单可转化');
    if (doc.status !== 'audit') return sendError(req, res, 400, '仅已审核订单可转化');

    const target = String(req.body.to ?? '');
    let toType: string;
    if (doc.type === 'porder') toType = 'stockin';
    else if (doc.type === 'sorder') toType = 'stockout';
    else if (doc.type === 'quo') toType = target === 'stockout' ? 'stockout' : 'sorder';
    else if (doc.type === 'outapply') toType = 'stockout';
    else if (doc.type === 'prodtask') toType = 'assembly';
    else return sendError(req, res, 400, '仅订单可转化');

    const targetWh =
      doc.warehouseId ??
      (
        db.prepare(`SELECT id FROM warehouse WHERE teamId = ? ORDER BY id LIMIT 1`).get(teamId) as
          { id: number } | undefined
      )?.id ??
      null;
    if (!targetWh) return sendError(req, res, 400, '请先建立一个仓库后再转单');

    const items = db.prepare(`SELECT * FROM doc_item WHERE docId = ?`).all(id) as Array<{
      productId: number;
      qty: number;
      price: number;
      batchNo: string | null;
      reservoirId: number | null;
      remark: string | null;
    }>;

    let newId = 0;
    let billNo = '';
    try {
      withImmediateTx(db, () => {
        const freshSrc = db.prepare(`SELECT status FROM doc WHERE id = ? AND teamId = ?`).get(id, teamId) as
          { status: string } | undefined;
        if (!freshSrc || freshSrc.status !== 'audit') {
          throw new ValidationError('来源订单状态已变化（可能已作废），请刷新后重试');
        }
        const fulfilledRows = db
          .prepare(
            `SELECT i.productId, COALESCE(SUM(i.qty), 0) AS qty
             FROM doc_item i JOIN doc d ON d.id = i.docId
             WHERE d.refOrderId = ? AND d.teamId = ? AND d.status <> 'void'
             GROUP BY i.productId`,
          )
          .all(id, teamId) as Array<{ productId: number; qty: number }>;
        const fulfilled = new Map<number, number>(fulfilledRows.map((r) => [r.productId, r.qty]));
        const remainItems = items
          .map((it) => {
            const avail = fulfilled.get(it.productId) ?? 0;
            const consume = roundQty(Math.min(Math.max(0, it.qty), Math.max(0, avail)));
            fulfilled.set(it.productId, roundQty(avail - consume));
            const remain = roundQty(it.qty - consume);
            return { ...it, qty: remain };
          })
          .filter((it) => it.qty > 0);
        if (!remainItems.length) {
          throw new ValidationError('该订单已全部转单，没有可转出的剩余数量');
        }
        billNo = nextBillNo(db, teamId, toType);
        const totalQty = sumQty(remainItems.map((i) => i.qty));
        const totalAmount = remainItems.reduce((s, i) => s + lineAmount(i.qty, i.price), 0);
        if (Math.abs(totalAmount) > MAX_TOTAL_AMOUNT_CENTS) {
          throw new ValidationError('单据总金额超出上限（10 亿元），请核对后重试');
        }
        const info = db
          .prepare(
            `INSERT INTO doc (teamId, billNo, type, date, partnerType, partnerId, clerkId, warehouseId, status, remark, totalAmount, totalQty, userId, refOrderId,
                             receiverName, receiverMobile, receiverAddress)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            teamId,
            billNo,
            toType,
            localDate(),
            doc.partnerType,
            doc.partnerId,
            doc.clerkId,
            targetWh,
            '由订单转单生成',
            totalAmount,
            totalQty,
            req.auth?.userId ?? null,
            id,
            doc.receiverName ?? null,
            doc.receiverMobile ?? null,
            doc.receiverAddress ?? null,
          );
        newId = Number(info.lastInsertRowid);
        const insStmt = db.prepare(
          `INSERT INTO doc_item (docId, productId, qty, price, amount, batchNo, reservoirId, remark)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const it of remainItems) {
          insStmt.run(
            newId,
            it.productId,
            it.qty,
            it.price,
            lineAmount(it.qty, it.price),
            it.batchNo,
            it.reservoirId,
            it.remark,
          );
        }
        recordAuditTxFromRequest(db, req, {
          teamId,
          action: 'doc.convert',
          entityType: 'doc',
          entityId: newId,
          detail: { fromDocId: id, toType, billNo },
        });
      });
    } catch (e) {
      if (e instanceof AppError) return sendError(req, res, e.statusCode, e.message, e.code);
      return sendError(req, res, 400, '转单失败');
    }
    return res.json({ id: newId, billNo, type: toType });
  });

  router.post('/doc/copy', (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const idParsed = parsePositiveInt(req.body.id, 'id');
    if (!idParsed.ok) return sendError(req, res, 400, idParsed.error);
    const id = idParsed.value;
    const doc = db.prepare(`SELECT * FROM doc WHERE id = ? AND teamId = ?`).get(id, teamId) as
      | {
          type: string;
          partnerType: string | null;
          partnerId: number | null;
          clerkId: number | null;
          warehouseId: number | null;
          remark: string | null;
          receiverName: string | null;
          receiverMobile: string | null;
          receiverAddress: string | null;
          discount: number | null;
          accountId: number | null;
        }
      | undefined;
    if (!doc) return sendError(req, res, 404, '单据不存在');
    let newId = 0;
    let billNo = '';
    try {
      withImmediateTx(db, () => {
        billNo = nextBillNo(db, teamId, doc.type);
        const totalQty = roundQty(
          (db.prepare(`SELECT COALESCE(SUM(qty), 0) AS q FROM doc_item WHERE docId = ?`).get(id) as { q: number }).q,
        );
        const grossAmount = (
          db.prepare(`SELECT COALESCE(SUM(amount), 0) AS a FROM doc_item WHERE docId = ?`).get(id) as { a: number }
        ).a;
        const discount = Math.max(0, Math.min(Math.round(Number(doc.discount ?? 0)), grossAmount));
        const totalAmount = grossAmount - discount;
        const info = db
          .prepare(
            `INSERT INTO doc (teamId, billNo, type, date, partnerType, partnerId, clerkId, warehouseId, status, remark, totalAmount, totalQty, userId, refOrderId,
                             receiverName, receiverMobile, receiverAddress, discount, accountId)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
          )
          .run(
            teamId,
            billNo,
            doc.type,
            localDate(),
            doc.partnerType,
            doc.partnerId,
            doc.clerkId,
            doc.warehouseId,
            doc.remark ? `${doc.remark}（复制）` : '（复制自原单）',
            totalAmount,
            totalQty,
            req.auth?.userId ?? null,
            doc.receiverName ?? null,
            doc.receiverMobile ?? null,
            doc.receiverAddress ?? null,
            discount,
            doc.accountId ?? null,
          );
        newId = Number(info.lastInsertRowid);
        db.prepare(
          `INSERT INTO doc_item (docId, productId, qty, price, amount, batchNo, productionDate, expiryDate, reservoirId, toWarehouseId, toReservoirId, remark)
           SELECT ?, productId, qty, price, amount, batchNo, productionDate, expiryDate, reservoirId, toWarehouseId, toReservoirId, remark
           FROM doc_item WHERE docId = ? ORDER BY id`,
        ).run(newId, id);
        recordAuditTxFromRequest(db, req, {
          teamId,
          action: 'doc.copy',
          entityType: 'doc',
          entityId: newId,
          detail: { sourceDocId: id, billNo },
        });
      });
    } catch (e) {
      if (e instanceof AppError) return sendError(req, res, e.statusCode, e.message, e.code);
      return sendError(req, res, 400, '复制失败');
    }
    return res.json({ id: newId, billNo });
  });

  router.put('/doc/edit', (req: Request, res: Response) => {
    const rawBody = req.body as Record<string, unknown> | null;
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      return sendError(req, res, 400, '请求参数格式非法');
    }
    const idParsed = parsePositiveInt(rawBody.id, 'id');
    if (!idParsed.ok) return sendError(req, res, 400, idParsed.error);
    const input = rawBody as unknown as DocInput & { id: number };
    const doc = db.prepare(`SELECT * FROM doc WHERE id = ? AND teamId = ?`).get(idParsed.value, input.teamId) as
      { status: string; billNo: string; type: string } | undefined;
    if (!doc) return sendError(req, res, 404, '单据不存在');
    if (doc.status !== 'draft') return sendError(req, res, 400, '仅草稿可编辑');
    if (input.type && input.type !== doc.type) {
      return sendError(req, res, 400, `单据类型不可修改（原类型 ${DOC_META[doc.type]?.label ?? doc.type}）`);
    }
    input.id = idParsed.value;
    input.type = doc.type as DocInput['type'];
    const err = validateDocInput(db, input);
    if (err) return sendError(req, res, 400, err);

    const fin = computeDocFinancials(input);
    if (!fin.ok) return sendError(req, res, 400, fin.error);
    const { totalQty, totalAmount, discount, paidAmount, deposit } = fin.value;
    const docDate = typeof input.date === 'string' && input.date.trim() ? input.date.trim() : localDate();
    const remarkVal = typeof input.remark === 'string' && input.remark !== '' ? input.remark : null;
    const receiverName =
      typeof input.receiverName === 'string' && input.receiverName !== '' ? input.receiverName : null;
    const receiverMobile =
      typeof input.receiverMobile === 'string' && input.receiverMobile !== '' ? input.receiverMobile : null;
    const receiverAddress =
      typeof input.receiverAddress === 'string' && input.receiverAddress !== '' ? input.receiverAddress : null;

    try {
      withImmediateTx(db, () => {
        const fresh = db.prepare(`SELECT status FROM doc WHERE id = ? AND teamId = ?`).get(input.id, input.teamId) as
          { status: string } | undefined;
        if (!fresh || fresh.status !== 'draft') throw new ValidationError('单据状态已变化，请刷新后重试');
        const upd = db
          .prepare(
            `UPDATE doc SET date=?, partnerType=?, partnerId=?, clerkId=?, warehouseId=?, remark=?, totalAmount=?, totalQty=?,
                            receiverName=?, receiverMobile=?, receiverAddress=?, discount=?, paidAmount=?, accountId=?, deposit=?
             WHERE id=? AND teamId=?`,
          )
          .run(
            docDate,
            input.partnerType ?? null,
            input.partnerId ? Number(input.partnerId) : null,
            input.clerkId ? Number(input.clerkId) : null,
            input.warehouseId ? Number(input.warehouseId) : null,
            remarkVal,
            totalAmount,
            totalQty,
            receiverName,
            receiverMobile,
            receiverAddress,
            discount,
            paidAmount,
            input.accountId ? Number(input.accountId) : null,
            deposit,
            input.id,
            input.teamId,
          );
        if (upd.changes === 0) throw new ValidationError('单据状态已变化，请刷新后重试');
        db.prepare('DELETE FROM doc_item WHERE docId = ?').run(input.id);
        insertItems(db, input.id, input.items);
        recordAuditTxFromRequest(db, req, {
          teamId: input.teamId,
          action: 'doc.edit',
          entityType: 'doc',
          entityId: input.id,
          detail: { billNo: doc.billNo, totalAmount, itemCount: input.items.length },
        });
      });
    } catch (e) {
      if (e instanceof AppError) return sendError(req, res, e.statusCode, e.message, e.code);
      if (e instanceof StockError) return sendError(req, res, 400, e.message);
      return sendError(req, res, 400, '保存失败');
    }
    return res.json({ ok: true });
  });

  router.post('/doc/submit', (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const idParsed = parsePositiveInt(req.body.id, 'id');
    if (!idParsed.ok) return sendError(req, res, 400, idParsed.error);
    const id = idParsed.value;
    const info = db
      .prepare(
        `UPDATE doc SET status='pending', submitAt=datetime('now','localtime'), rejectReason=NULL WHERE id=? AND teamId=? AND status='draft'`,
      )
      .run(id, teamId);
    if (info.changes === 0) {
      const doc = db.prepare(`SELECT status FROM doc WHERE id = ? AND teamId = ?`).get(id, teamId) as
        { status: string } | undefined;
      if (!doc) return sendError(req, res, 404, '单据不存在');
      return sendError(req, res, 400, '仅草稿可提交审核');
    }
    return res.json({ ok: true, status: 'pending' });
  });

  router.post('/doc/reject', (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const idParsed = parsePositiveInt(req.body.id, 'id');
    if (!idParsed.ok) return sendError(req, res, 400, idParsed.error);
    const id = idParsed.value;
    const reasonParsed = parseOptionalString(req.body.reason, '驳回原因', 200);
    if (!reasonParsed.ok) return sendError(req, res, 400, reasonParsed.error);
    const reason = reasonParsed.value;
    const info = db
      .prepare(`UPDATE doc SET status='draft', rejectReason=? WHERE id=? AND teamId=? AND status='pending'`)
      .run(reason, id, teamId);
    if (info.changes === 0) {
      const doc = db.prepare(`SELECT status FROM doc WHERE id = ? AND teamId = ?`).get(id, teamId) as
        { status: string } | undefined;
      if (!doc) return sendError(req, res, 404, '单据不存在');
      return sendError(req, res, 400, '仅待审核单据可驳回');
    }
    return res.json({ ok: true, status: 'draft' });
  });

  router.post('/doc/submit-batch', (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    if (!Array.isArray(req.body.ids) || req.body.ids.length === 0) return sendError(req, res, 400, 'ids 不能为空');
    if (req.body.ids.length > 500) return sendError(req, res, 400, '单次最多批量提交 500 张单据');
    const ids: number[] = [];
    for (const rawId of req.body.ids) {
      const p = parsePositiveInt(rawId, 'ids');
      if (!p.ok) return sendError(req, res, 400, 'ids 必须全部为正整数');
      ids.push(p.value);
    }
    let done = 0;
    const skipped: number[] = [];
    const sel = db.prepare(`SELECT status FROM doc WHERE id=? AND teamId=?`);
    const upd = db.prepare(
      `UPDATE doc SET status='pending', submitAt=datetime('now','localtime'), rejectReason=NULL WHERE id=? AND teamId=? AND status='draft'`,
    );
    try {
      withImmediateTx(db, () => {
        for (const id of ids) {
          const row = sel.get(id, teamId) as { status: string } | undefined;
          if (!row || row.status !== 'draft') {
            skipped.push(id);
            continue;
          }
          const r = upd.run(id, teamId);
          if (r.changes > 0) done += 1;
          else skipped.push(id);
        }
      });
    } catch (e) {
      if (e instanceof AppError) return sendError(req, res, e.statusCode, e.message, e.code);
      return sendError(req, res, 400, '提交失败');
    }
    return res.json({ ok: true, done, skipped });
  });

  router.post('/doc/audit', (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const idParsed = parsePositiveInt(req.body.id, 'id');
    if (!idParsed.ok) return sendError(req, res, 400, idParsed.error);
    const id = idParsed.value;
    const auditByParsed = parseOptionalString(req.body.auditBy, '审核人', 50);
    if (!auditByParsed.ok) return sendError(req, res, 400, auditByParsed.error);
    const auditBy = auditByParsed.value;

    const idem = extractIdempotencyKey(req);
    if ('error' in idem) return sendError(req, res, 400, idem.error);
    const reqHash = idem.present ? hashRequestPayload('POST:/doc/audit', req.body) : '';
    if (idem.present && teamId) {
      const hitKey = lookupIdempotencyKey(db, teamId, 'doc.audit', idem.key, reqHash);
      if ('conflict' in hitKey) {
        return sendError(req, res, 409, '幂等键冲突：相同 Idempotency-Key 不可用于不同请求参数', 'CONFLICT');
      }
      if (hitKey.hit) {
        res.setHeader('Idempotent-Replayed', 'true');
        return res.status(hitKey.statusCode).json(hitKey.body);
      }
    }

    const doc = db.prepare(`SELECT * FROM doc WHERE id = ? AND teamId = ?`).get(id, teamId) as
      { id: number; status: string } | undefined;
    if (!doc) return sendError(req, res, 404, '单据不存在');
    if (doc.status !== 'draft' && doc.status !== 'pending') {
      return sendError(req, res, 400, '仅草稿或待审核单据可审核');
    }

    let replayed = false;
    try {
      withImmediateTx(
        db,
        () => {
          if (idem.present) {
            const hitInTx = lookupIdempotencyKey(db, teamId, 'doc.audit', idem.key, reqHash);
            if ('conflict' in hitInTx) {
              throw new ConflictError('幂等键冲突：相同 Idempotency-Key 不可用于不同请求参数');
            }
            if (hitInTx.hit) {
              replayed = true;
              return;
            }
          }
          const freshDoc = db.prepare(`SELECT * FROM doc WHERE id = ? AND teamId = ?`).get(id, teamId) as
            | {
                id: number;
                billNo: string;
                status: string;
                type: string;
                partnerType: string | null;
                partnerId: number | null;
                totalAmount: number;
                paidAmount: number | null;
                deposit: number | null;
                accountId: number | null;
                date: string;
                refOrderId: number | null;
              }
            | undefined;
          if (!freshDoc || (freshDoc.status !== 'draft' && freshDoc.status !== 'pending')) {
            throw new ValidationError('单据状态已变化，请刷新后重试');
          }
          if (freshDoc.refOrderId) {
            const parent = db
              .prepare(`SELECT status FROM doc WHERE id = ? AND teamId = ?`)
              .get(freshDoc.refOrderId, teamId) as { status: string } | undefined;
            if (!parent || parent.status !== 'audit') {
              throw new StockError('来源订单已作废或不存在，请先删除本单或重新转单');
            }
          }
          if (COST_TYPES.has(freshDoc.type)) {
            if (freshDoc.type === 'stocktake') snapshotStocktake(db, id);
            const err = precheckStock(db, id);
            if (err) throw new StockError(err);
            postStock(db, id);
          }
          settleOnAudit(db, teamId, freshDoc);
          rememberPrices(db, { ...freshDoc, teamId }, id);
          db.prepare(
            `UPDATE doc SET status='audit', auditAt=datetime('now','localtime'), auditBy=?, auditUserId=? WHERE id=? AND teamId=?`,
          ).run(auditBy, req.auth?.userId ?? null, id, teamId);
          recordAuditTxFromRequest(db, req, {
            teamId,
            action: 'doc.audit',
            entityType: 'doc',
            entityId: id,
            detail: { billNo: freshDoc.billNo, type: freshDoc.type, totalAmount: freshDoc.totalAmount },
          });
          if (idem.present) {
            saveIdempotencyKey(db, teamId, 'doc.audit', idem.key, reqHash, 200, { ok: true });
          }
        },
        { checkpoint: true },
      );
    } catch (e) {
      if (e instanceof AppError) return sendError(req, res, e.statusCode, e.message, e.code);
      if (e instanceof StockError) return sendError(req, res, 400, e.message);
      return sendError(req, res, 400, '审核失败');
    }
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return res.json({ ok: true });
  });

  router.post('/doc/void', (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const idParsed = parsePositiveInt(req.body.id, 'id');
    if (!idParsed.ok) return sendError(req, res, 400, idParsed.error);
    const id = idParsed.value;
    const reasonParsed = parseOptionalString((req.body as { reason?: unknown }).reason, '作废原因', 200);
    if (!reasonParsed.ok) return sendError(req, res, 400, reasonParsed.error);
    const voidReason = reasonParsed.value;

    const idem = extractIdempotencyKey(req);
    if ('error' in idem) return sendError(req, res, 400, idem.error);
    const reqHash = idem.present ? hashRequestPayload('POST:/doc/void', req.body) : '';
    if (idem.present && teamId) {
      const hitKey = lookupIdempotencyKey(db, teamId, 'doc.void', idem.key, reqHash);
      if ('conflict' in hitKey) {
        return sendError(req, res, 409, '幂等键冲突：相同 Idempotency-Key 不可用于不同请求参数', 'CONFLICT');
      }
      if (hitKey.hit) {
        res.setHeader('Idempotent-Replayed', 'true');
        return res.status(hitKey.statusCode).json(hitKey.body);
      }
    }

    const doc = db.prepare(`SELECT id, status FROM doc WHERE id = ? AND teamId = ?`).get(id, teamId) as
      { id: number; status: string } | undefined;
    if (!doc) return sendError(req, res, 404, '单据不存在');
    if (doc.status !== 'audit') return sendError(req, res, 400, '仅已审核单据可作废');

    let replayed = false;
    try {
      withImmediateTx(
        db,
        () => {
          if (idem.present) {
            const hitInTx = lookupIdempotencyKey(db, teamId, 'doc.void', idem.key, reqHash);
            if ('conflict' in hitInTx) {
              throw new ConflictError('幂等键冲突：相同 Idempotency-Key 不可用于不同请求参数');
            }
            if (hitInTx.hit) {
              replayed = true;
              return;
            }
          }
          const freshDoc = db.prepare(`SELECT * FROM doc WHERE id = ? AND teamId = ?`).get(id, teamId) as
            | {
                id: number;
                billNo: string;
                status: string;
                type: string;
                partnerType: string | null;
                partnerId: number | null;
                paidAmount: number | null;
                deposit: number | null;
                accountId: number | null;
                date: string;
              }
            | undefined;
          if (!freshDoc || freshDoc.status !== 'audit') {
            throw new ValidationError('单据状态已变化，请刷新后重试');
          }
          if (COST_TYPES.has(freshDoc.type)) postStock(db, id, true);
          reverseSettleOnVoid(db, teamId, freshDoc);
          recomputePriceMemory(db, { ...freshDoc, teamId }, id);
          db.prepare(
            `UPDATE doc SET status='void', voidAt=datetime('now','localtime'), voidReason=?, voidUserId=? WHERE id=? AND teamId=?`,
          ).run(voidReason, req.auth?.userId ?? null, id, teamId);
          recordAuditTxFromRequest(db, req, {
            teamId,
            action: 'doc.void',
            entityType: 'doc',
            entityId: id,
            detail: { billNo: freshDoc.billNo, type: freshDoc.type, voidReason },
          });
          if (idem.present) {
            saveIdempotencyKey(db, teamId, 'doc.void', idem.key, reqHash, 200, { ok: true });
          }
        },
        { checkpoint: true },
      );
    } catch (e) {
      if (e instanceof AppError) return sendError(req, res, e.statusCode, e.message, e.code);
      const msg = e instanceof StockError ? e.message : '作废失败';
      return sendError(req, res, 400, msg);
    }
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return res.json({ ok: true });
  });

  router.delete('/doc/:id', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    const idParsed = parsePositiveInt(req.params.id, 'id');
    if (!idParsed.ok) return sendError(req, res, 400, idParsed.error);
    const id = idParsed.value;
    const doc = db.prepare(`SELECT status, billNo FROM doc WHERE id = ? AND teamId = ?`).get(id, teamId) as
      { status: string; billNo: string } | undefined;
    if (!doc) return sendError(req, res, 404, '单据不存在');
    if (doc.status !== 'draft') return sendError(req, res, 400, '仅草稿可删除');

    try {
      withImmediateTx(db, () => {
        const fresh = db.prepare(`SELECT status FROM doc WHERE id = ? AND teamId = ?`).get(id, teamId) as
          { status: string } | undefined;
        if (!fresh || fresh.status !== 'draft') throw new ValidationError('单据状态已变化，请刷新后重试');
        db.prepare('DELETE FROM doc_item WHERE docId = ?').run(id);
        db.prepare('DELETE FROM doc WHERE id = ? AND teamId = ?').run(id, teamId);
        recordAuditTxFromRequest(db, req, {
          teamId,
          action: 'doc.delete',
          entityType: 'doc',
          entityId: id,
          detail: { billNo: doc.billNo },
        });
      });
    } catch (e) {
      if (e instanceof AppError) return sendError(req, res, e.statusCode, e.message, e.code);
      return sendError(req, res, 400, '删除失败');
    }
    return res.json({ ok: true });
  });
}
