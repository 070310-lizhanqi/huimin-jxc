/**
 * 收付款（settlement）与往来余额。
 * type: receipt=收款（客户付我们） / payment=付款（我们付供应商）
 * 余额口径：customer 余额 = 我们应收（正数为客户欠我们）；vendor 余额 = 我们应付（正数为我们欠供应商）。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, Router } from 'express';
import { localDate, validBizDate } from './db';
import { recordAuditTxFromRequest } from './infra/audit-log';
import { AppError, ConflictError, NotFoundError, sendError, ValidationError } from './infra/errors';
import { extractIdempotencyKey, hashRequestPayload, lookupIdempotencyKey, saveIdempotencyKey } from './infra/idempotency';
import { withImmediateTx } from './infra/tx';
import { parseOptionalPositiveInt, parseOptionalString, parsePositiveInt } from './infra/validate';
import { MAX_TOTAL_AMOUNT_CENTS } from './shared/money';

type Value = string | number | null;

/** 收付款创建双击防重：key=(团队,类型,往来,金额,账户,日期)，3 秒窗口内幂等返回首单 */
const SETTLE_DEDUP_MS = 3000;
const recentSettles = new Map<string, { id: number; at: number }>();
function rememberSettle(key: string, id: number): void {
  recentSettles.set(key, { id, at: Date.now() });
  if (recentSettles.size > 200) {
    const now = Date.now();
    for (const [k, v] of recentSettles) if (now - v.at > SETTLE_DEDUP_MS) recentSettles.delete(k);
  }
}

export function mountSettlements(router: Router, db: DatabaseSync): void {
  router.get('/settlement/list', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return sendError(req, res, 400, 'teamId 不能为空');
    const conds: string[] = ['teamId = ?'];
    const args: Value[] = [teamId];
    if (req.query.type) {
      conds.push('type = ?');
      args.push(String(req.query.type));
    }
    if (req.query.partnerId) {
      conds.push('partnerId = ?');
      args.push(Number(req.query.partnerId));
    }
    if (req.query.refDocId) {
      conds.push('refDocId = ?');
      args.push(Number(req.query.refDocId));
    }
    if (req.query.from) {
      conds.push('date >= ?');
      args.push(String(req.query.from));
    }
    if (req.query.to) {
      conds.push('date <= ?');
      args.push(String(req.query.to));
    }
    // rows 参数历史上一直被调用方传（test-settle 等）但从未生效：这里真正实现并设 500 上限
    const rawRows = Number(req.query.rows ?? 200);
    const rows = Math.min(500, Math.max(1, Number.isFinite(rawRows) && rawRows > 0 ? Math.floor(rawRows) : 200));
    // LIMIT 占位符（不拼字符串）：与 docs/crud 风格一致，防止后续维护者照搬 ${} 模式引入注入
    const list = db
      .prepare(`SELECT * FROM settlement WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT ?`)
      .all(...args, rows);
    return res.json(list);
  });

  router.post('/settlement/create', (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const type = typeof req.body.type === 'string' ? req.body.type : '';
    const partnerType = typeof req.body.partnerType === 'string' ? req.body.partnerType : '';
    const partnerParsed = parsePositiveInt(req.body.partnerId, '往来单位');
    const amount = Math.round(Number(req.body.amount ?? 0));
    if (!teamId) return sendError(req, res, 400, 'teamId 不能为空');
    if (!['receipt', 'payment'].includes(type)) return sendError(req, res, 400, 'type 非法');
    if (!['cus', 'ven'].includes(partnerType)) return sendError(req, res, 400, 'partnerType 非法');
    // 配对校验：收款对象只能是客户、付款对象只能是供应商。
    // 交叉组合（如 payment+cus）会凭空冲减客户应收/供应商应付，报表端无法归因
    if (type === 'receipt' && partnerType !== 'cus')
      return sendError(req, res, 400, '收款（receipt）的往来单位必须是客户');
    if (type === 'payment' && partnerType !== 'ven')
      return sendError(req, res, 400, '付款（payment）的往来单位必须是供应商');
    if (!partnerParsed.ok) return sendError(req, res, 400, '往来单位不能为空');
    const partnerId = partnerParsed.value;
    if (!(amount > 0)) return sendError(req, res, 400, '金额必须大于 0');
    if (amount > MAX_TOTAL_AMOUNT_CENTS) return sendError(req, res, 400, '金额超出上限（10 亿元），请核对后重试');
    if (req.body.date !== undefined && req.body.date !== null && typeof req.body.date !== 'string') {
      return sendError(req, res, 400, '收付款日期格式必须为 YYYY-MM-DD');
    }
    const rawDate = typeof req.body.date === 'string' ? req.body.date.trim() : '';
    if (rawDate !== '') {
      const dateErr = validBizDate(rawDate);
      if (dateErr) return sendError(req, res, 400, '收付款日期' + dateErr);
    }
    const settleDate = rawDate || localDate();
    const remarkParsed = parseOptionalString(req.body.remark, '备注', 500);
    if (!remarkParsed.ok) return sendError(req, res, 400, remarkParsed.error);
    const remark = remarkParsed.value;
    const accParsed = parseOptionalPositiveInt(req.body.accountId, 'accountId');
    if (!accParsed.ok) return sendError(req, res, 400, accParsed.error);
    const accountId = accParsed.value;
    const refParsed = parseOptionalPositiveInt(req.body.refDocId, '关联单据');
    if (!refParsed.ok) return sendError(req, res, 400, refParsed.error);
    const refDocId = refParsed.value;

    const idem = extractIdempotencyKey(req);
    if ('error' in idem) return sendError(req, res, 400, idem.error);
    const reqHash = idem.present ? hashRequestPayload('POST:/settlement/create', req.body) : '';
    if (idem.present) {
      const hitKey = lookupIdempotencyKey(db, teamId, 'settlement.create', idem.key, reqHash);
      if ('conflict' in hitKey) {
        return sendError(req, res, 409, '幂等键冲突：相同 Idempotency-Key 不可用于不同请求参数', 'CONFLICT');
      }
      if (hitKey.hit) {
        res.setHeader('Idempotent-Replayed', 'true');
        return res.status(hitKey.statusCode).json(hitKey.body);
      }
    }

    // 引用完整性：往来单位必须存在于本团队
    const partnerTable = partnerType === 'cus' ? 'customer' : 'vendor';
    const partner = db
      .prepare(`SELECT id FROM ${partnerTable} WHERE id = ? AND teamId = ?`)
      .get(partnerId, teamId) as { id: number } | undefined;
    if (!partner) return sendError(req, res, 400, '往来单位不存在');

    if (refDocId !== null) {
      const refDoc = db.prepare(`SELECT id FROM doc WHERE id = ? AND teamId = ?`).get(refDocId, teamId);
      if (!refDoc) return sendError(req, res, 400, '关联单据不存在');
    }

    let createdId = 0;
    let replayed = false;
    const dedupKey = JSON.stringify([
      teamId, type, partnerType, partnerId, amount, accountId, rawDate,
      remark ?? '', refDocId ?? 0, req.auth?.userId ?? 0,
    ]);
    if (!idem.present) {
      const hit = recentSettles.get(dedupKey);
      if (hit && Date.now() - hit.at < SETTLE_DEDUP_MS) {
        const still = db.prepare(`SELECT id FROM settlement WHERE id = ? AND teamId = ?`).get(hit.id, teamId);
        if (still) return res.json({ ok: true, id: hit.id, dedup: true });
        recentSettles.delete(dedupKey);
      }
    }

    try {
      withImmediateTx(
        db,
        () => {
          if (idem.present) {
            const hitInTx = lookupIdempotencyKey(db, teamId, 'settlement.create', idem.key, reqHash);
            if ('conflict' in hitInTx) {
              throw new ConflictError('幂等键冲突：相同 Idempotency-Key 不可用于不同请求参数');
            }
            if (hitInTx.hit) {
              createdId = Number((hitInTx.body as { id?: number }).id ?? 0);
              replayed = true;
              return;
            }
          }
          // 锁内校验账户与余额
          if (accountId) {
            const account = db
              .prepare(`SELECT id, balance FROM account WHERE id = ? AND teamId = ?`)
              .get(accountId, teamId) as { id: number; balance: number } | undefined;
            if (!account) throw new ValidationError('资金账户不存在');
            if (type === 'payment' && amount > account.balance) {
              throw new ValidationError(
                `账户余额不足：可用 ${(account.balance / 100).toFixed(2)} 元，本次付款 ${(amount / 100).toFixed(2)} 元`,
              );
            }
          }
          const info = db
            .prepare(
              `INSERT INTO settlement (teamId, type, partnerType, partnerId, accountId, amount, date, refDocId, remark, isAuto)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            )
            .run(
              teamId,
              type,
              partnerType,
              partnerId,
              accountId,
              amount,
              settleDate,
              refDocId,
              remark,
            );
          createdId = Number(info.lastInsertRowid);
          db.prepare(
            `INSERT INTO partner_balance (teamId, partnerType, partnerId, balance) VALUES (?, ?, ?, ?)
             ON CONFLICT(teamId, partnerType, partnerId) DO UPDATE SET balance = balance + excluded.balance`,
          ).run(teamId, partnerType, partnerId, -amount);
          if (accountId) {
            const inc = type === 'receipt' ? amount : -amount;
            db.prepare(`UPDATE account SET balance = balance + ? WHERE id = ? AND teamId = ?`).run(inc, accountId, teamId);
          }
          recordAuditTxFromRequest(db, req, {
            teamId,
            action: 'settlement.create',
            entityType: 'settlement',
            entityId: createdId,
            detail: { type, partnerType, partnerId, amount, accountId, refDocId },
          });
          if (idem.present) {
            saveIdempotencyKey(db, teamId, 'settlement.create', idem.key, reqHash, 200, { ok: true, id: createdId });
          }
        },
        { checkpoint: true },
      );
    } catch (e) {
      if (e instanceof AppError) return sendError(req, res, e.statusCode, e.message, e.code);
      return sendError(req, res, 400, '保存失败');
    }
    if (replayed) {
      res.setHeader('Idempotent-Replayed', 'true');
    } else if (!idem.present) {
      rememberSettle(dedupKey, createdId);
    }
    return res.json({ ok: true, id: createdId });
  });

  /** 收付款单修改：先反向冲回旧记录影响，再按新值入账 */
  router.put('/settlement/:id', (req: Request, res: Response) => {
    const teamIdParsed = parsePositiveInt(req.body.teamId, 'teamId');
    if (!teamIdParsed.ok) return sendError(req, res, 400, 'teamId 不能为空');
    const teamId = teamIdParsed.value;
    const idParsed = parsePositiveInt(req.params.id, 'id');
    if (!idParsed.ok) return sendError(req, res, 400, idParsed.error);
    const id = idParsed.value;

    let reqAmount: number | undefined;
    if (req.body.amount !== undefined && req.body.amount !== null) {
      reqAmount = Math.round(Number(req.body.amount));
      if (!(reqAmount > 0)) return sendError(req, res, 400, '金额必须大于 0');
      if (reqAmount > MAX_TOTAL_AMOUNT_CENTS) return sendError(req, res, 400, '金额超出上限（10 亿元），请核对后重试');
    }
    let reqAccountId: number | null | undefined = undefined;
    if (req.body.accountId !== undefined) {
      const accParsed = parseOptionalPositiveInt(req.body.accountId, 'accountId');
      if (!accParsed.ok) return sendError(req, res, 400, accParsed.error);
      reqAccountId = accParsed.value;
    }
    let reqDate: string | undefined;
    if (req.body.date !== undefined && req.body.date !== null) {
      if (typeof req.body.date !== 'string') return sendError(req, res, 400, '收付款日期格式必须为 YYYY-MM-DD');
      const dStr = req.body.date.trim();
      if (!dStr) return sendError(req, res, 400, '收付款日期不能为空');
      const dateErr = validBizDate(dStr);
      if (dateErr) return sendError(req, res, 400, '收付款日期' + dateErr);
      reqDate = dStr;
    }
    let reqRemark: string | null | undefined = undefined;
    if (req.body.remark !== undefined) {
      const remarkParsed = parseOptionalString(req.body.remark, '备注', 500);
      if (!remarkParsed.ok) return sendError(req, res, 400, remarkParsed.error);
      reqRemark = remarkParsed.value;
    }

    try {
      withImmediateTx(
        db,
        () => {
          const old = db
            .prepare(`SELECT * FROM settlement WHERE id = ? AND teamId = ?`)
            .get(id, teamId) as
            | { id: number; type: string; partnerType: string; partnerId: number; accountId: number | null; amount: number; date: string; remark: string | null; isAuto: number }
            | undefined;
          if (!old) throw new NotFoundError('收付款记录不存在');
          if (old.isAuto) {
            throw new ValidationError('该收付款由单据审核自动生成，请通过作废单据调整');
          }
          const amount = reqAmount !== undefined ? reqAmount : old.amount;
          const accountId = reqAccountId !== undefined ? reqAccountId : old.accountId;
          const date = reqDate !== undefined ? reqDate : old.date;
          const remark = reqRemark !== undefined ? reqRemark : old.remark;

          if (old.accountId && old.type === 'receipt') {
            const oldAcc = db
              .prepare(`SELECT balance FROM account WHERE id = ? AND teamId = ?`)
              .get(old.accountId, teamId) as { balance: number } | undefined;
            if (oldAcc) {
              const backNeed = old.accountId === accountId ? Math.max(0, old.amount - amount) : old.amount;
              if (oldAcc.balance < backNeed) {
                throw new ValidationError(
                  `该笔收款已被支用，旧账户当前余额 ${(oldAcc.balance / 100).toFixed(2)} 元，不足以冲回 ${(backNeed / 100).toFixed(2)} 元。请先调整资金或换用其他账户。`,
                );
              }
            }
          }
          if (accountId !== null) {
            const account = db
              .prepare(`SELECT id, balance FROM account WHERE id = ? AND teamId = ?`)
              .get(accountId, teamId) as { id: number; balance: number } | undefined;
            if (!account) throw new ValidationError('资金账户不存在');
            if (old.type === 'payment') {
              const avail = old.accountId === accountId ? account.balance + old.amount : account.balance;
              if (amount > avail) {
                throw new ValidationError(
                  `账户余额不足：可用 ${(avail / 100).toFixed(2)} 元，本次付款 ${(amount / 100).toFixed(2)} 元`,
                );
              }
            }
          }
          db.prepare(
            `INSERT INTO partner_balance (teamId, partnerType, partnerId, balance) VALUES (?, ?, ?, ?)
             ON CONFLICT(teamId, partnerType, partnerId) DO UPDATE SET balance = balance + excluded.balance`,
          ).run(teamId, old.partnerType, old.partnerId, old.amount - amount);
          if (old.accountId) {
            const back = old.type === 'receipt' ? -old.amount : old.amount;
            db.prepare(`UPDATE account SET balance = balance + ? WHERE id = ? AND teamId = ?`).run(back, old.accountId, teamId);
          }
          const upd = db
            .prepare(
              `UPDATE settlement SET accountId = ?, amount = ?, date = ?, remark = ? WHERE id = ? AND teamId = ?`,
            )
            .run(accountId, amount, date, remark, id, teamId);
          if (upd.changes === 0) throw new NotFoundError('收付款记录不存在');
          if (accountId !== null) {
            const inc = old.type === 'receipt' ? amount : -amount;
            db.prepare(`UPDATE account SET balance = balance + ? WHERE id = ? AND teamId = ?`).run(inc, accountId, teamId);
          }
          recordAuditTxFromRequest(db, req, {
            teamId,
            action: 'settlement.update',
            entityType: 'settlement',
            entityId: id,
            detail: { oldAmount: old.amount, newAmount: amount, oldAccountId: old.accountId, newAccountId: accountId },
          });
        },
        { checkpoint: true },
      );
    } catch (e) {
      if (e instanceof AppError) return sendError(req, res, e.statusCode, e.message, e.code);
      return sendError(req, res, 400, '保存失败');
    }
    return res.json({ ok: true });
  });

  /** 删除收付款单：冲回往来余额与账户影响 */
  router.delete('/settlement/:id', (req: Request, res: Response) => {
    const teamIdParsed = parsePositiveInt(req.query.teamId, 'teamId');
    if (!teamIdParsed.ok) return sendError(req, res, 400, 'teamId 不能为空');
    const teamId = teamIdParsed.value;
    const idParsed = parsePositiveInt(req.params.id, 'id');
    if (!idParsed.ok) return sendError(req, res, 400, idParsed.error);
    const id = idParsed.value;

    try {
      withImmediateTx(
        db,
        () => {
          const old = db
            .prepare(`SELECT * FROM settlement WHERE id = ? AND teamId = ?`)
            .get(id, teamId) as
            | { id: number; type: string; partnerType: string; partnerId: number; accountId: number | null; amount: number; remark: string | null; isAuto: number }
            | undefined;
          if (!old) throw new NotFoundError('收付款记录不存在');
          if (old.isAuto) {
            throw new ValidationError('该收付款由单据审核自动生成，请通过作废单据调整');
          }
          if (old.accountId && old.type === 'receipt') {
            const acc = db
              .prepare(`SELECT balance FROM account WHERE id = ? AND teamId = ?`)
              .get(old.accountId, teamId) as { balance: number } | undefined;
            if (acc && acc.balance < old.amount) {
              throw new ValidationError(
                `该笔收款已被支用，账户当前余额 ${(acc.balance / 100).toFixed(2)} 元，不足以冲回 ${(old.amount / 100).toFixed(2)} 元。请先调整资金或改为修改金额。`,
              );
            }
          }
          const del = db.prepare(`DELETE FROM settlement WHERE id = ? AND teamId = ?`).run(id, teamId);
          if (del.changes === 0) throw new NotFoundError('收付款记录不存在');
          db.prepare(
            `INSERT INTO partner_balance (teamId, partnerType, partnerId, balance) VALUES (?, ?, ?, ?)
             ON CONFLICT(teamId, partnerType, partnerId) DO UPDATE SET balance = balance + excluded.balance`,
          ).run(teamId, old.partnerType, old.partnerId, old.amount);
          if (old.accountId) {
            const back = old.type === 'receipt' ? -old.amount : old.amount;
            db.prepare(`UPDATE account SET balance = balance + ? WHERE id = ? AND teamId = ?`).run(back, old.accountId, teamId);
          }
          recordAuditTxFromRequest(db, req, {
            teamId,
            action: 'settlement.delete',
            entityType: 'settlement',
            entityId: id,
            detail: { type: old.type, amount: old.amount, partnerType: old.partnerType, partnerId: old.partnerId },
          });
        },
        { checkpoint: true },
      );
    } catch (e) {
      if (e instanceof AppError) return sendError(req, res, e.statusCode, e.message, e.code);
      return sendError(req, res, 400, '删除失败');
    }
    return res.json({ ok: true });
  });

  router.get('/partner/balance', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return sendError(req, res, 400, 'teamId 不能为空');
    const list = db
      .prepare(`SELECT * FROM partner_balance WHERE teamId = ?`)
      .all(teamId);
    return res.json(list);
  });
}