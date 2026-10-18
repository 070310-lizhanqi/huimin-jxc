/**
 * 进销存统计 / 库存预估 / 客户供应商对账单
 *
 * 进销存统计（period 内四类单据的数量与金额）：
 *   采购入库、采购退货、销售出库、销售退货、其它入库、其它出库、调拨
 * 库存预估：按当前库存 × 加权平均成本 + 最近 N 天日均出库 → 可售天数
 * 对账单：往来单位在一段时间内的应收/应付发生额与结余（期初 + 期间发生 - 期间收付 = 期末）
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, Router } from 'express';

function rangeOf(req: Request): { from: string; to: string } {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    from: String(req.query.from ?? `${d.getFullYear()}-${p(d.getMonth() + 1)}-01`),
    to: String(req.query.to ?? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`),
  };
}

/** 单据类型归类：正负方向用于进销存统计
 *  - 入库：采购入库 / 其它入库 / 销售退货 / 期初库存 / 生产组装产出行
 *  - 出库：销售出库 / 其它出库 / 采购退货 / 生产组装耗用行
 */
const IN_TYPES = ['stockin', 'otherin', 'sret', 'stockinit'];
const OUT_TYPES = ['stockout', 'otherout', 'pin'];

export function mountJxcReports(router: Router, db: DatabaseSync): void {
  /**
   * 进销存统计：按商品或按单据类型汇总期间内的入/出数量与金额。
   * 返回 rows（按商品归组）与 byType（按单据类型归组）
   */
  router.get('/report/jxc-stat', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) {
      res.status(400).json({ error: 'teamId 不能为空' });
      return;
    }
    const { from, to } = rangeOf(req);

    // 按单据类型汇总
    const byType = db
      .prepare(
        `SELECT d.type, COUNT(*) AS count,
                COALESCE(SUM(d.totalQty), 0) AS qty,
                COALESCE(SUM(d.totalAmount), 0) AS amount
         FROM doc d
         WHERE d.teamId = ? AND d.status = 'audit'
           AND d.type IN ('stockin','pin','stockout','sret','otherin','otherout','transfer','adjust','stocktake','assembly','stockinit')
           AND d.date >= ? AND d.date <= ?
         GROUP BY d.type ORDER BY d.type`,
      )
      .all(teamId, from, to) as Array<{ type: string; count: number; qty: number; amount: number }>;

    // 按商品汇总（入 = stockin/otherin/sret/stockinit，出 = stockout/otherout/pin）
    // 结存数量取 stock 表当前实存（不分期间），避免「只看出库看不出库前库存」导致负数。
    const rows = db
      .prepare(
        `SELECT i.productId, p.name AS prodName, p.spec, p.unit,
                COALESCE(SUM(CASE WHEN d.type IN ('stockin','otherin','sret','stockinit') THEN i.qty ELSE 0 END), 0) AS inQty,
                COALESCE(SUM(CASE WHEN d.type IN ('stockin','otherin','sret','stockinit') THEN i.amount ELSE 0 END), 0) AS inAmount,
                COALESCE(SUM(CASE WHEN d.type IN ('stockout','otherout','pin') THEN i.qty ELSE 0 END), 0) AS outQty,
                COALESCE(SUM(CASE WHEN d.type IN ('stockout','otherout','pin') THEN i.amount ELSE 0 END), 0) AS outAmount,
                COALESCE((SELECT SUM(s.qty) FROM stock s WHERE s.teamId = d.teamId AND s.productId = i.productId), 0) AS stockQty
         FROM doc_item i
         JOIN doc d ON d.id = i.docId
         JOIN product p ON p.id = i.productId
         WHERE d.teamId = ? AND d.status = 'audit' AND d.date >= ? AND d.date <= ?
         GROUP BY i.productId
         HAVING inQty <> 0 OR outQty <> 0
         ORDER BY outAmount DESC, inAmount DESC`,
      )
      .all(teamId, from, to) as Array<{
      productId: number;
      prodName: string;
      spec: string | null;
      unit: string | null;
      inQty: number;
      inAmount: number;
      outQty: number;
      outAmount: number;
      stockQty: number;
    }>;

    const totals = rows.reduce(
      (s, r) => ({
        inQty: s.inQty + r.inQty,
        inAmount: s.inAmount + r.inAmount,
        outQty: s.outQty + r.outQty,
        outAmount: s.outAmount + r.outAmount,
      }),
      { inQty: 0, inAmount: 0, outQty: 0, outAmount: 0 },
    );

    res.json({ from, to, byType, rows, totals });
  });

  /**
   * 库存预估：当前库存 + 加权成本 + 最近 N 天日均出库 → 可售天数 / 建议补货量
   * days: 统计窗口，默认 30 天
   */
  router.get('/report/stock-forecast', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) {
      res.status(400).json({ error: 'teamId 不能为空' });
      return;
    }
    const windowDays = Math.min(365, Math.max(1, Number(req.query.days ?? 30)));
    const d = new Date();
    const end = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const startD = new Date(d.getTime() - windowDays * 86_400_000);
    const start = `${startD.getFullYear()}-${String(startD.getMonth() + 1).padStart(2, '0')}-${String(startD.getDate()).padStart(2, '0')}`;

    // 当前库存
    const stocks = db
      .prepare(
        `SELECT s.productId, COALESCE(SUM(s.qty), 0) AS qty
         FROM stock s WHERE s.teamId = ? GROUP BY s.productId`,
      )
      .all(teamId) as Array<{ productId: number; qty: number }>;
    const stockMap = new Map<number, number>(stocks.map((s) => [s.productId, s.qty]));

    // 窗口内出库数量
    const outs = db
      .prepare(
        `SELECT i.productId, COALESCE(SUM(i.qty), 0) AS qty
         FROM doc_item i JOIN doc d ON d.id = i.docId
         WHERE d.teamId = ? AND d.status = 'audit' AND d.type IN ('stockout','otherout')
           AND d.date >= ? AND d.date <= ?
         GROUP BY i.productId`,
      )
      .all(teamId, start, end) as Array<{ productId: number; qty: number }>;
    const outMap = new Map<number, number>(outs.map((o) => [o.productId, o.qty]));

    // 成本
    const costs = db
      .prepare(
        `SELECT l.productId, SUM(l.qty * l.unitCost) * 1.0 / SUM(l.qty) AS avgCost
         FROM stock_ledger l JOIN doc d ON d.id = l.refDocId
         WHERE l.teamId = ? AND l.direction = 'in' AND d.type = 'stockin' AND d.status = 'audit'
         GROUP BY l.productId`,
      )
      .all(teamId) as Array<{ productId: number; avgCost: number }>;
    const costMap = new Map<number, number>(costs.map((c) => [c.productId, c.avgCost]));

    const products = db
      .prepare('SELECT id, name, spec, unit, purchasePrice, lowQty FROM product WHERE teamId = ?')
      .all(teamId) as Array<{
      id: number;
      name: string;
      spec: string | null;
      unit: string | null;
      purchasePrice: number;
      lowQty: number;
    }>;

    const rows = products.map((p) => {
      const qty = stockMap.get(p.id) ?? 0;
      const outQty = outMap.get(p.id) ?? 0;
      const avgDailyOut = outQty / windowDays;
      const unitCost = Math.round(costMap.get(p.id) ?? p.purchasePrice);
      const amount = Math.round(qty * unitCost);
      // 可售天数：无出库记录时视为无限
      const saleableDays = avgDailyOut > 0 ? Math.floor(qty / avgDailyOut) : null;
      // 建议补货：可售天数 < 15 天时补到 30 天用量
      const targetQty = avgDailyOut * 30;
      const suggestQty = saleableDays !== null && saleableDays < 15 ? Math.max(0, Math.ceil(targetQty - qty)) : 0;
      return {
        productId: p.id,
        prodName: p.name,
        spec: p.spec,
        unit: p.unit,
        qty,
        outQty,
        avgDailyOut: Math.round(avgDailyOut * 100) / 100,
        unitCost,
        amount,
        saleableDays,
        suggestQty,
        lowQty: p.lowQty ?? 0,
      };
    });
    rows.sort((a, b) => {
      // 可售天数升序（null 视为无限，排最后），再按库存金额降序
      const da = a.saleableDays === null ? Number.MAX_SAFE_INTEGER : a.saleableDays;
      const db2 = b.saleableDays === null ? Number.MAX_SAFE_INTEGER : b.saleableDays;
      if (da !== db2) return da - db2;
      return b.amount - a.amount;
    });

    res.json({ from: start, to: end, windowDays, rows });
  });

  /**
   * 往来对账单：某往来单位在期间内的明细流水 + 期初/期末结余。
   * mode=ar 客户（应收），mode=ap 供应商（应付）。
   * 明细包含：单据（发生额）与收付款单（冲减额），按日期升序。
   */
  router.get('/report/statement', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    const partnerId = Number(req.query.partnerId);
    const mode = String(req.query.mode ?? 'ar') === 'ap' ? 'ap' : 'ar';
    if (!teamId) {
      res.status(400).json({ error: 'teamId 不能为空' });
      return;
    }
    if (!partnerId) {
      res.status(400).json({ error: 'partnerId 不能为空' });
      return;
    }
    const { from, to } = rangeOf(req);
    const partnerType = mode === 'ar' ? 'cus' : 'ven';
    const chargeTypes = mode === 'ar' ? "('stockout','sret')" : "('stockin','pin')";
    const settleType = mode === 'ar' ? 'receipt' : 'payment';
    const signOf = (type: string) => {
      if (mode === 'ar') return type === 'sret' ? -1 : 1;
      return type === 'pin' ? -1 : 1;
    };

    // 期初 = 期间之前的单据发生额（退货取负） - 期间之前的收付
    const beforeRows = db
      .prepare(
        `SELECT type, COALESCE(SUM(totalAmount), 0) AS amt FROM doc
         WHERE teamId = ? AND status = 'audit' AND type IN ${chargeTypes}
           AND partnerId = ? AND date < ?
         GROUP BY type`,
      )
      .all(teamId, partnerId, from) as Array<{ type: string; amt: number }>;
    const beforeDocs = beforeRows.reduce((s, r) => s + r.amt * signOf(r.type), 0);
    const beforeSettle = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS amt FROM settlement
         WHERE teamId = ? AND type = ? AND partnerId = ? AND date < ?`,
      )
      .get(teamId, settleType, partnerId, from) as { amt: number };
    const opening = beforeDocs - beforeSettle.amt;

    // 期间明细
    const chargeRows = db
      .prepare(
        `SELECT id, billNo, date, type, totalAmount, remark FROM doc
         WHERE teamId = ? AND status = 'audit' AND type IN ${chargeTypes}
           AND partnerId = ? AND date >= ? AND date <= ?
         ORDER BY date ASC, id ASC`,
      )
      .all(teamId, partnerId, from, to) as Array<{
      id: number;
      billNo: string;
      date: string;
      type: string;
      totalAmount: number;
      remark: string | null;
    }>;
    const settleRows = db
      .prepare(
        `SELECT id, date, amount, accountId, remark FROM settlement
         WHERE teamId = ? AND type = ? AND partnerId = ? AND date >= ? AND date <= ?
         ORDER BY date ASC, id ASC`,
      )
      .all(teamId, settleType, partnerId, from, to) as Array<{
      id: number;
      date: string;
      amount: number;
      accountId: number | null;
      remark: string | null;
    }>;

    interface Line {
      date: string;
      kind: 'doc' | 'settle';
      billNo: string;
      label: string;
      debit: number;
      credit: number;
      balance: number;
      remark: string | null;
    }
    const DOC_LABEL: Record<string, string> = {
      stockin: '采购入库',
      pin: '采购退货',
      stockout: '销售出库',
      sret: '销售退货',
    };
    const lines: Line[] = [];
    let balance = opening;
    const merged: Array<{ date: string; seq: number; line: Omit<Line, 'balance'> }> = [];
    for (const r of chargeRows) {
      merged.push({
        date: r.date,
        seq: r.id,
        line: {
          date: r.date,
          kind: 'doc',
          billNo: r.billNo,
          label: DOC_LABEL[r.type] ?? r.type,
          debit: r.totalAmount * signOf(r.type) > 0 ? r.totalAmount * signOf(r.type) : 0,
          credit: r.totalAmount * signOf(r.type) < 0 ? -r.totalAmount * signOf(r.type) : 0,
          remark: r.remark,
        },
      });
    }
    for (const r of settleRows) {
      merged.push({
        date: r.date,
        seq: 1_000_000 + r.id,
        line: {
          date: r.date,
          kind: 'settle',
          billNo: `#${r.id}`,
          label: settleType === 'receipt' ? '收款' : '付款',
          debit: 0,
          credit: r.amount,
          remark: r.remark,
        },
      });
    }
    merged.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
    for (const m of merged) {
      balance += m.line.debit - m.line.credit;
      lines.push({ ...m.line, balance });
    }

    const periodDebit = lines.reduce((s, l) => s + l.debit, 0);
    const periodCredit = lines.reduce((s, l) => s + l.credit, 0);

    // 往来单位名称
    const table = partnerType === 'cus' ? 'customer' : 'vendor';
    const partner = db
      .prepare(`SELECT id, name, mobile, address FROM ${table} WHERE id = ? AND teamId = ?`)
      .get(partnerId, teamId) as { id: number; name: string; mobile: string | null; address: string | null } | undefined;

    res.json({
      mode, from, to,
      partner: partner ?? { id: partnerId, name: `#${partnerId}`, mobile: null, address: null },
      opening,
      periodDebit,
      periodCredit,
      closing: opening + periodDebit - periodCredit,
      lines,
    });
  });
}
