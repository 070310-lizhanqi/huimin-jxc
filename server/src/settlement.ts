/**
 * 收付款（settlement）与往来余额。
 * type: receipt=收款（客户付我们） / payment=付款（我们付供应商）
 * 余额口径：customer 余额 = 我们应收（正数为客户欠我们）；vendor 余额 = 我们应付（正数为我们欠供应商）。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, Router } from 'express';
import { localDate } from './db';

type Value = string | number | null;

export function mountSettlements(router: Router, db: DatabaseSync): void {
  router.get('/settlement/list', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const conds: string[] = ['teamId = ?'];
    const args: Value[] = [teamId];
    if (req.query.type) {
      conds.push('type = ?');
      args.push(String(req.query.type));
    }
    const list = db
      .prepare(`SELECT * FROM settlement WHERE ${conds.join(' AND ')} ORDER BY id DESC LIMIT 200`)
      .all(...args);
    return res.json(list);
  });

  router.post('/settlement/create', (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const type = String(req.body.type ?? '');
    const partnerType = String(req.body.partnerType ?? '');
    const partnerId = Number(req.body.partnerId);
    const amount = Math.round(Number(req.body.amount ?? 0));
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    if (!['receipt', 'payment'].includes(type)) return res.status(400).json({ error: 'type 非法' });
    if (!['cus', 'ven'].includes(partnerType)) return res.status(400).json({ error: 'partnerType 非法' });
    if (!partnerId) return res.status(400).json({ error: '往来单位不能为空' });
    if (!(amount > 0)) return res.status(400).json({ error: '金额必须大于 0' });
    const accountId = req.body.accountId ? Number(req.body.accountId) : null;

    // 引用完整性：往来单位与资金账户必须存在于本团队
    const partnerTable = partnerType === 'cus' ? 'customer' : 'vendor';
    const partner = db
      .prepare(`SELECT id FROM ${partnerTable} WHERE id = ? AND teamId = ?`)
      .get(partnerId, teamId) as { id: number } | undefined;
    if (!partner) return res.status(400).json({ error: '往来单位不存在' });
    if (accountId) {
      const account = db
        .prepare(`SELECT id, balance FROM account WHERE id = ? AND teamId = ?`)
        .get(accountId, teamId) as { id: number; balance: number } | undefined;
      if (!account) return res.status(400).json({ error: '资金账户不存在' });
      // 付款不能超过账户可用余额（收款不校验）
      if (type === 'payment' && amount > account.balance) {
        return res.status(400).json({
          error: `账户余额不足：可用 ${(account.balance / 100).toFixed(2)} 元，本次付款 ${(amount / 100).toFixed(2)} 元`,
        });
      }
    }

    dbtransaction(db, () => {
      db.prepare(
        `INSERT INTO settlement (teamId, type, partnerType, partnerId, accountId, amount, date, refDocId, remark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        teamId,
        type,
        partnerType,
        partnerId,
        accountId,
        amount,
        String(req.body.date ?? localDate()),
        req.body.refDocId ? Number(req.body.refDocId) : null,
        (req.body.remark as string) ?? null,
      );
      // 应收冲减 / 应付冲减：收款使 cus 余额减少，付款使 ven 余额减少
      const delta = -amount;
      const cur = db
        .prepare(`SELECT balance FROM partner_balance WHERE teamId=? AND partnerType=? AND partnerId=?`)
        .get(teamId, partnerType, partnerId) as { balance: number } | undefined;
      if (cur) {
        db.prepare(`UPDATE partner_balance SET balance = balance + ? WHERE teamId=? AND partnerType=? AND partnerId=?`).run(
          delta,
          teamId,
          partnerType,
          partnerId,
        );
      } else {
        db.prepare(`INSERT INTO partner_balance (teamId, partnerType, partnerId, balance) VALUES (?, ?, ?, ?)`).run(
          teamId,
          partnerType,
          partnerId,
          delta,
        );
      }
      // 账户余额变动
      if (accountId) {
        const inc = type === 'receipt' ? amount : -amount;
        db.prepare(`UPDATE account SET balance = balance + ? WHERE id = ? AND teamId = ?`).run(
          inc,
          accountId,
          teamId,
        );
      }
    });
    return res.json({ ok: true });
  });

  /** 收付款单修改：先反向冲回旧记录影响，再按新值入账 */
  router.put('/settlement/:id', (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const id = Number(req.params.id);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const old = db
      .prepare(`SELECT * FROM settlement WHERE id = ? AND teamId = ?`)
      .get(id, teamId) as
      | { id: number; type: string; partnerType: string; partnerId: number; accountId: number | null; amount: number; date: string; remark: string | null }
      | undefined;
    if (!old) return res.status(404).json({ error: '收付款记录不存在' });

    const amount = req.body.amount != null ? Math.round(Number(req.body.amount)) : old.amount;
    if (!(amount > 0)) return res.status(400).json({ error: '金额必须大于 0' });
    const accountId = req.body.accountId !== undefined
      ? (req.body.accountId ? Number(req.body.accountId) : null)
      : old.accountId;
    const date = String(req.body.date ?? old.date);
    const remark = req.body.remark !== undefined ? (req.body.remark as string) : old.remark;

    if (accountId) {
      const account = db
        .prepare(`SELECT id, balance FROM account WHERE id = ? AND teamId = ?`)
        .get(accountId, teamId) as { id: number; balance: number } | undefined;
      if (!account) return res.status(400).json({ error: '资金账户不存在' });
      // 改单时的可用余额 = 当前余额 + 旧记录占用的额度（同账户时）
      if (old.type === 'payment') {
        const avail = old.accountId === accountId ? account.balance + old.amount : account.balance;
        if (amount > avail) {
          return res.status(400).json({
            error: `账户余额不足：可用 ${(avail / 100).toFixed(2)} 元，本次付款 ${(amount / 100).toFixed(2)} 元`,
          });
        }
      }
    }

    dbtransaction(db, () => {
      // 1) 冲回旧记录：往来余额 +amount（原先是 -amount），账户反向
      db.prepare(`UPDATE partner_balance SET balance = balance + ? WHERE teamId=? AND partnerType=? AND partnerId=?`).run(
        old.amount, teamId, old.partnerType, old.partnerId,
      );
      if (old.accountId) {
        const back = old.type === 'receipt' ? -old.amount : old.amount;
        db.prepare(`UPDATE account SET balance = balance + ? WHERE id = ? AND teamId = ?`).run(back, old.accountId, teamId);
      }
      // 2) 应用新值
      db.prepare(
        `UPDATE settlement SET accountId = ?, amount = ?, date = ?, remark = ? WHERE id = ? AND teamId = ?`,
      ).run(accountId, amount, date, remark, id, teamId);
      db.prepare(`UPDATE partner_balance SET balance = balance + ? WHERE teamId=? AND partnerType=? AND partnerId=?`).run(
        -amount, teamId, old.partnerType, old.partnerId,
      );
      if (accountId) {
        const inc = old.type === 'receipt' ? amount : -amount;
        db.prepare(`UPDATE account SET balance = balance + ? WHERE id = ? AND teamId = ?`).run(inc, accountId, teamId);
      }
    });
    return res.json({ ok: true });
  });

  /** 删除收付款单：冲回往来余额与账户影响 */
  router.delete('/settlement/:id', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    const id = Number(req.params.id);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const old = db
      .prepare(`SELECT * FROM settlement WHERE id = ? AND teamId = ?`)
      .get(id, teamId) as
      | { id: number; type: string; partnerType: string; partnerId: number; accountId: number | null; amount: number }
      | undefined;
    if (!old) return res.status(404).json({ error: '收付款记录不存在' });

    // 删除收款会从账户扣回这笔钱，账户余额不够扣说明钱已被花掉，不允许删
    if (old.accountId && old.type === 'receipt') {
      const acc = db
        .prepare(`SELECT balance FROM account WHERE id = ? AND teamId = ?`)
        .get(old.accountId, teamId) as { balance: number } | undefined;
      if (acc && acc.balance < old.amount) {
        return res.status(400).json({
          error: `该笔收款已被支用，账户当前余额 ${(acc.balance / 100).toFixed(2)} 元，不足以冲回 ${(old.amount / 100).toFixed(2)} 元。请先调整资金或改为修改金额。`,
        });
      }
    }

    dbtransaction(db, () => {
      db.prepare(`UPDATE partner_balance SET balance = balance + ? WHERE teamId=? AND partnerType=? AND partnerId=?`).run(
        old.amount, teamId, old.partnerType, old.partnerId,
      );
      if (old.accountId) {
        const back = old.type === 'receipt' ? -old.amount : old.amount;
        db.prepare(`UPDATE account SET balance = balance + ? WHERE id = ? AND teamId = ?`).run(back, old.accountId, teamId);
      }
      db.prepare(`DELETE FROM settlement WHERE id = ? AND teamId = ?`).run(id, teamId);
    });
    return res.json({ ok: true });
  });

  router.get('/partner/balance', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const list = db
      .prepare(`SELECT * FROM partner_balance WHERE teamId = ?`)
      .all(teamId);
    return res.json(list);
  });
}

function dbtransaction(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}