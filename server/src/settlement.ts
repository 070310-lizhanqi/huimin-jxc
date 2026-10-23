/**
 * 收付款（settlement）与往来余额。
 * type: receipt=收款（客户付我们） / payment=付款（我们付供应商）
 * 余额口径：customer 余额 = 我们应收（正数为客户欠我们）；vendor 余额 = 我们应付（正数为我们欠供应商）。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, Router } from 'express';
import { localDate, validBizDate } from './db';

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
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
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
    const type = String(req.body.type ?? '');
    const partnerType = String(req.body.partnerType ?? '');
    const partnerId = Number(req.body.partnerId);
    const amount = Math.round(Number(req.body.amount ?? 0));
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    if (!['receipt', 'payment'].includes(type)) return res.status(400).json({ error: 'type 非法' });
    if (!['cus', 'ven'].includes(partnerType)) return res.status(400).json({ error: 'partnerType 非法' });
    // 配对校验：收款对象只能是客户、付款对象只能是供应商。
    // 交叉组合（如 payment+cus）会凭空冲减客户应收/供应商应付，报表端无法归因
    if (type === 'receipt' && partnerType !== 'cus')
      return res.status(400).json({ error: '收款（receipt）的往来单位必须是客户' });
    if (type === 'payment' && partnerType !== 'ven')
      return res.status(400).json({ error: '付款（payment）的往来单位必须是供应商' });
    if (!partnerId) return res.status(400).json({ error: '往来单位不能为空' });
    if (!(amount > 0)) return res.status(400).json({ error: '金额必须大于 0' });
    // 金额上限与单据侧 MAX_PRICE_CENTS 同量级：防误录 15 位数直接改写往来/账户
    if (amount > 1e11) return res.status(400).json({ error: '金额超出上限（10 亿元），请核对后重试' });
    // 日期校验：脏日期会污染账龄分桶与对账单期初，且事后无法用普通查询筛出
    const dateErr = validBizDate(req.body.date);
    if (dateErr) return res.status(400).json({ error: '收付款日期' + dateErr });
    const accountId = req.body.accountId ? Number(req.body.accountId) : null;

    // 引用完整性：往来单位必须存在于本团队
    const partnerTable = partnerType === 'cus' ? 'customer' : 'vendor';
    const partner = db
      .prepare(`SELECT id FROM ${partnerTable} WHERE id = ? AND teamId = ?`)
      .get(partnerId, teamId) as { id: number } | undefined;
    if (!partner) return res.status(400).json({ error: '往来单位不存在' });

    let createdId = 0;
    // 双击防重：3 秒窗口内同 (团队,类型,往来,金额,账户,日期,备注,refDocId,userId) 的重复请求返回首次结果。
    // 创建型请求不能像单据那样幂等回查草稿——结算入账立即生效，重复请求会造成重复冲账。
    // 备注/关联单据/操作人必须进 key：现场同一客户连收两笔同额现金（或两人同秒各录一笔）
    // 是真实业务，只按金额去重会把第二笔真金白银静默吞掉
    const dedupKey = JSON.stringify([
      teamId, type, partnerType, partnerId, amount, accountId, String(req.body.date ?? ''),
      String(req.body.remark ?? ''), req.body.refDocId ? Number(req.body.refDocId) : 0, req.auth?.userId ?? 0,
    ]);
    const hit = recentSettles.get(dedupKey);
    if (hit && Date.now() - hit.at < SETTLE_DEDUP_MS) {
      const still = db.prepare(`SELECT id FROM settlement WHERE id = ? AND teamId = ?`).get(hit.id, teamId);
      if (still) return res.json({ ok: true, id: hit.id, dedup: true });
      recentSettles.delete(dedupKey);
    }

    try {
      dbtransaction(db, () => {
        // 锁内校验账户与余额：锁外校验存在 TOCTOU 窗口（校验后、入账前余额可能被并发改动）
        if (accountId) {
          const account = db
            .prepare(`SELECT id, balance FROM account WHERE id = ? AND teamId = ?`)
            .get(accountId, teamId) as { id: number; balance: number } | undefined;
          if (!account) throw new Error('资金账户不存在');
          // 付款不能超过账户可用余额（收款不校验）
          if (type === 'payment' && amount > account.balance) {
            throw new Error(
              `账户余额不足：可用 ${(account.balance / 100).toFixed(2)} 元，本次付款 ${(amount / 100).toFixed(2)} 元`,
            );
          }
        }
        const info = db.prepare(
          `INSERT INTO settlement (teamId, type, partnerType, partnerId, accountId, amount, date, refDocId, remark, isAuto)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
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
        createdId = Number(info.lastInsertRowid);
        // 应收冲减 / 应付冲减：收款使 cus 余额减少，付款使 ven 余额减少。
        // upsert 原子写入，避免并发首笔时 SELECT-then-INSERT 撞主键
        db.prepare(
          `INSERT INTO partner_balance (teamId, partnerType, partnerId, balance) VALUES (?, ?, ?, ?)
           ON CONFLICT(teamId, partnerType, partnerId) DO UPDATE SET balance = balance + excluded.balance`,
        ).run(teamId, partnerType, partnerId, -amount);
        // 账户余额变动
        if (accountId) {
          const inc = type === 'receipt' ? amount : -amount;
          db.prepare(`UPDATE account SET balance = balance + ? WHERE id = ? AND teamId = ?`).run(inc, accountId, teamId);
        }
      });
    } catch (e) {
      return res.status(400).json({ error: e instanceof Error ? e.message : '保存失败' });
    }
    rememberSettle(dedupKey, createdId);
    return res.json({ ok: true, id: createdId });
  });

  /** 收付款单修改：先反向冲回旧记录影响，再按新值入账 */
  router.put('/settlement/:id', (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const id = Number(req.params.id);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const old = db
      .prepare(`SELECT * FROM settlement WHERE id = ? AND teamId = ?`)
      .get(id, teamId) as
      | { id: number; type: string; partnerType: string; partnerId: number; accountId: number | null; amount: number; date: string; remark: string | null; isAuto: number }
      | undefined;
    if (!old) return res.status(404).json({ error: '收付款记录不存在' });
    // 单据审核自动生成的收付款由「作废单据」统一冲回，禁止在此直接改/删，避免两处记账不一致
    // （isAuto 为服务端写入的专用标识，客户端无法伪造——按 remark 判断可被手工建单冒充）
    if (old.isAuto) {
      return res.status(400).json({ error: '该收付款由单据审核自动生成，请通过作废单据调整' });
    }

    const amount = req.body.amount != null ? Math.round(Number(req.body.amount)) : old.amount;
    if (!(amount > 0)) return res.status(400).json({ error: '金额必须大于 0' });
    const accountId = req.body.accountId !== undefined
      ? (req.body.accountId ? Number(req.body.accountId) : null)
      : old.accountId;
    const date = String(req.body.date ?? old.date);
    // 修改时同样校验日期：改错日期同样会污染账龄与对账单期初
    const dateErr = validBizDate(date);
    if (dateErr) return res.status(400).json({ error: '收付款日期' + dateErr });
    const remark = req.body.remark !== undefined ? (req.body.remark as string) : old.remark;

    try {
      dbtransaction(db, () => {
        // 锁内校验一：收款冲回的钱可能已被支用。同账户时随后补回新金额，只需保证冲回差额够扣；
        // 换账户时旧账户需全额扣回
        if (old.accountId && old.type === 'receipt') {
          const oldAcc = db
            .prepare(`SELECT balance FROM account WHERE id = ? AND teamId = ?`)
            .get(old.accountId, teamId) as { balance: number } | undefined;
          if (oldAcc) {
            const backNeed = old.accountId === accountId ? Math.max(0, old.amount - amount) : old.amount;
            if (oldAcc.balance < backNeed) {
              throw new Error(
                `该笔收款已被支用，旧账户当前余额 ${(oldAcc.balance / 100).toFixed(2)} 元，不足以冲回 ${(backNeed / 100).toFixed(2)} 元。请先调整资金或换用其他账户。`,
              );
            }
          }
        }
        // 锁内校验二：付款可用余额 = 当前余额 + 旧付款占用的额度（同账户时）
        if (accountId) {
          const account = db
            .prepare(`SELECT id, balance FROM account WHERE id = ? AND teamId = ?`)
            .get(accountId, teamId) as { id: number; balance: number } | undefined;
          if (!account) throw new Error('资金账户不存在');
          if (old.type === 'payment') {
            const avail = old.accountId === accountId ? account.balance + old.amount : account.balance;
            if (amount > avail) {
              throw new Error(
                `账户余额不足：可用 ${(avail / 100).toFixed(2)} 元，本次付款 ${(amount / 100).toFixed(2)} 元`,
              );
            }
          }
        }
        // 1) 往来余额净变动 = 冲回旧额 - 新额，原子 upsert
        db.prepare(
          `INSERT INTO partner_balance (teamId, partnerType, partnerId, balance) VALUES (?, ?, ?, ?)
           ON CONFLICT(teamId, partnerType, partnerId) DO UPDATE SET balance = balance + excluded.balance`,
        ).run(teamId, old.partnerType, old.partnerId, old.amount - amount);
        // 2) 旧账户反向冲回
        if (old.accountId) {
          const back = old.type === 'receipt' ? -old.amount : old.amount;
          db.prepare(`UPDATE account SET balance = balance + ? WHERE id = ? AND teamId = ?`).run(back, old.accountId, teamId);
        }
        // 3) 应用新值
        db.prepare(
          `UPDATE settlement SET accountId = ?, amount = ?, date = ?, remark = ? WHERE id = ? AND teamId = ?`,
        ).run(accountId, amount, date, remark, id, teamId);
        if (accountId) {
          const inc = old.type === 'receipt' ? amount : -amount;
          db.prepare(`UPDATE account SET balance = balance + ? WHERE id = ? AND teamId = ?`).run(inc, accountId, teamId);
        }
      });
    } catch (e) {
      return res.status(400).json({ error: e instanceof Error ? e.message : '保存失败' });
    }
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
      | { id: number; type: string; partnerType: string; partnerId: number; accountId: number | null; amount: number; remark: string | null; isAuto: number }
      | undefined;
    if (!old) return res.status(404).json({ error: '收付款记录不存在' });
    // 单据审核自动生成的收付款由「作废单据」统一冲回，禁止在此直接改/删
    // （isAuto 为服务端写入的专用标识，客户端无法伪造）
    if (old.isAuto) {
      return res.status(400).json({ error: '该收付款由单据审核自动生成，请通过作废单据调整' });
    }

    try {
      dbtransaction(db, () => {
        // 锁内复核：删除收款会从账户扣回这笔钱，余额不够扣说明钱已被花掉，不允许删
        if (old.accountId && old.type === 'receipt') {
          const acc = db
            .prepare(`SELECT balance FROM account WHERE id = ? AND teamId = ?`)
            .get(old.accountId, teamId) as { balance: number } | undefined;
          if (acc && acc.balance < old.amount) {
            throw new Error(
              `该笔收款已被支用，账户当前余额 ${(acc.balance / 100).toFixed(2)} 元，不足以冲回 ${(old.amount / 100).toFixed(2)} 元。请先调整资金或改为修改金额。`,
            );
          }
        }
        db.prepare(
          `INSERT INTO partner_balance (teamId, partnerType, partnerId, balance) VALUES (?, ?, ?, ?)
           ON CONFLICT(teamId, partnerType, partnerId) DO UPDATE SET balance = balance + excluded.balance`,
        ).run(teamId, old.partnerType, old.partnerId, old.amount);
        if (old.accountId) {
          const back = old.type === 'receipt' ? -old.amount : old.amount;
          db.prepare(`UPDATE account SET balance = balance + ? WHERE id = ? AND teamId = ?`).run(back, old.accountId, teamId);
        }
        db.prepare(`DELETE FROM settlement WHERE id = ? AND teamId = ?`).run(id, teamId);
      });
    } catch (e) {
      return res.status(400).json({ error: e instanceof Error ? e.message : '删除失败' });
    }
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
  // BEGIN 放 try 外：BEGIN 失败时 ROLLBACK 二次抛错会掩盖原始错误
  // BEGIN IMMEDIATE：写事务立刻取写锁，避免 deferred BEGIN 下并发事务升级写锁时 SQLITE_BUSY
  db.exec('BEGIN IMMEDIATE');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}