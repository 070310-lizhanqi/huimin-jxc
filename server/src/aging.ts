/**
 * 账龄统计：客户欠款 / 供应商欠款 / 库存账龄
 *
 * 口径说明
 * - 应收（客户欠款）：已审核的销售向单据（stockout 正、sret 负），单据未收金额 = 合计金额 - 已收金额。
 *   已收金额按「该客户在该团队的全部收款单」分摊：先冲最早的单据（FIFO），这是最常用的账龄算法。
 * - 应付（供应商欠款）：采购向单据（stockin 正、pin 负），分摊逻辑与应收对称，用付款单冲抵。
 * - 账龄 = 今天 - 单据日期 的天数，按 30/60/90/180/360/720 天分桶。
 * - 库存账龄：按批次入库日期（stock_ledger 首次 in 的时间）计算，只统计 qty > 0 的库存。
 * - 无单据的预收/预付（partner_balance 有余额、无单据）单独列示，不进账龄桶；
 *   超收余额挂到超收发生日（结算日期）对应的桶；单据与结算均只计 date <= 今天，
 *   refDocId 指向作废单的手工结算不计入；订金按单归属（该单订金只冲该单）。
 *
 * 金额单位一律为「分」，与库内一致；前端负责除 100 展示。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, Router } from 'express';

/** 账龄分桶边界（天）。最后一段为「超过 720 天」。 */
const BUCKETS = [30, 60, 90, 180, 360, 720] as const;
const BUCKET_KEYS = ['d30', 'd60', 'd90', 'd180', 'd360', 'd720', 'over720'] as const;

interface AgingBucketRow {
  partnerId: number;
  partnerName: string | null;
  partnerType: string;
  /** 各分桶金额（分） */
  d30: number;
  d60: number;
  d90: number;
  d180: number;
  d360: number;
  d720: number;
  over720: number;
  /** 合计未结金额（分） */
  total: number;
  /** 最早未结单据日期（用于排行显示） */
  oldestDate: string | null;
  /** 无单据的预收/预付行：以 partner_balance 为驱动单独列示，不进账龄桶 */
  advance?: boolean;
}

function daysBetween(from: string, to: string): number {
  const a = new Date(`${from.slice(0, 10)}T00:00:00`).getTime();
  const b = new Date(`${to.slice(0, 10)}T00:00:00`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}

function bucketOf(days: number): (typeof BUCKET_KEYS)[number] {
  for (let i = 0; i < BUCKETS.length; i += 1) {
    if (days <= BUCKETS[i]) return BUCKET_KEYS[i];
  }
  return 'over720';
}

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

interface OpenDoc {
  id: number;
  partnerId: number;
  date: string;
  amount: number;
}

interface SettleEvent {
  date: string;
  amount: number;
}

/**
 * 按 FIFO 把「已结算金额」分摊到未结单据上，返回每张单的未结金额。
 * @param docs 按日期升序的应收/应付单据（amount 为分，可正可负：负数表示退货/退款冲减；
 *   amount 已按单扣掉该单订金，即 sign*(totalAmount - deposit)，订金不再汇总后 FIFO 冲最早单）
 * @param settled 已结算总额（分）
 * @param settleEvents 该往来单位按日期汇总的结算事件（已做 date <= 今天截断与作废单排除），
 *   用于确定超收发生日
 * 超收处理：当 settled 超过全部正数单据合计时，剩余 left 不再丢弃，也不再挂到最新一张单据上，
 * 而是作为一条独立的负数未结挂到「超收发生日」（累计结算首次越过正数单据合计的那笔结算日期）
 * 对应的桶；净退款（left < 0）同理挂到累计结算首次跌破 0 的结算日期对应的桶。
 * 否则客户超收时应收被系统性低估、或昨天的超收伪装成老欠款，与 partner_balance 对不上账。
 */
function allocate(
  docs: OpenDoc[],
  settled: number,
  settleEvents: SettleEvent[],
): Array<{ doc: OpenDoc; open: number; synthetic?: boolean }> {
  let left = settled;
  const out: Array<{ doc: OpenDoc; open: number; synthetic?: boolean }> = [];
  for (const doc of docs) {
    let open = doc.amount;
    if (left > 0 && open > 0) {
      const use = Math.min(left, open);
      left -= use;
      open -= use;
    }
    // 负数单据（退货）不参与分摊，直接作为负向未结
    out.push({ doc, open });
  }
  // 溢额挂到超收发生日（结算日期）对应的桶，不再挂最新单的桶
  if (left !== 0 && out.length > 0) {
    const positiveTotal = docs.reduce((s, d) => s + Math.max(0, d.amount), 0);
    let overDate: string | null = null;
    let cum = 0;
    for (const e of settleEvents) {
      cum += e.amount;
      if (left > 0 ? cum > positiveTotal : cum < 0) {
        overDate = e.date;
        break;
      }
    }
    // 无结算事件时回落到最新单日期（旧口径，仅防御：settled 非零时事件必存在）
    const date = overDate ?? out[out.length - 1].doc.date;
    out.push({
      doc: { id: 0, partnerId: out[out.length - 1].doc.partnerId, date, amount: 0 },
      open: -left,
      synthetic: true,
    });
  }
  return out;
}

export function mountAging(router: Router, db: DatabaseSync): void {
  /**
   * 账龄核心算法。mode=ar 客户欠款（应收），mode=ap 供应商欠款（应付）。
   * 返回 { asOf, totals, rows }，rows 按未结金额降序。
   */
  const computeAging = (
    teamId: number,
    mode: 'ar' | 'ap',
  ): { asOf: string; totals: Record<string, number>; rows: AgingBucketRow[] } => {
    const partnerType = mode === 'ar' ? 'cus' : 'ven';
    const chargeTypes = mode === 'ar' ? "('stockout', 'sret')" : "('stockin', 'pin')";
    const signOf = (type: string) =>
      mode === 'ar' ? (type === 'sret' ? -1 : 1) : type === 'pin' ? -1 : 1;
    const settleType = mode === 'ar' ? 'receipt' : 'payment';
    const reverseType = mode === 'ar' ? 'payment' : 'receipt';
    const now = today();

    // 1) 取全部已审核往来单据（正负按方向）。
    //    注意：不能加日期下限过滤——早于 720 天的单据金额仍须计入 over720 桶，
    //    否则老客户的历史欠款会从应收总额里消失，与 partner_balance 对不上。
    //    日期过滤已靠索引 idx_doc_team_status_type_date 加速，无需砍掉历史数据。
    //    但必须加 date <= 今天 上限：未来业务日期的单据（daysBetween 用 Math.max(0,…)
    //    会算 0 天进 d30）不能计入“今天”的账龄。
    //    deposit 一并取出：订金按单归属，未结 = sign*(totalAmount - deposit)，
    //    该单的订金只冲该单（退货单订金同理），不再汇总后 FIFO 冲最早单。
    const docs = db
      .prepare(
        `SELECT id, partnerId, date, type, totalAmount, COALESCE(deposit, 0) AS deposit FROM doc
         WHERE teamId = ? AND status = 'audit' AND type IN ${chargeTypes}
           AND partnerId IS NOT NULL AND date <= ?
         ORDER BY date ASC, id ASC`,
      )
      .all(teamId, now) as Array<{
      id: number;
      partnerId: number;
      date: string;
      type: string;
      totalAmount: number;
      deposit: number;
    }>;

    // 2) 取各往来单位的已结算总额（partnerType 必须一致：customer/vendor 自增 id 可能撞号，
    //    不加过滤会把供应商的付款算到同号客户的应收上）。
    //    净额口径：正向收款冲减应收，反向类型（AR 的 payment=现退客户 / AP 的 receipt=供应商退款）
    //    是退货当场退款、审核时 bump 往来为正——不扣回去的话有退货退款的客户账龄合计与 partner_balance 对不上。
    //    注意占位符顺序：CASE 的 ? 在 SELECT 列表里排第一
    //    截断与排除：只计 date <= 今天的结算；refDocId 指向作废单的手工结算不计入
    //    （B-数1 的孤儿手工结算；作废时自动结算已被删除，手工结算须先删改才能作废，
    //    但已存在的孤儿记录——如作废后补登的——不得再污染账龄）。
    const settleWhere = `teamId = ? AND type IN (?, ?) AND partnerType = ? AND date <= ?
      AND (refDocId IS NULL OR NOT EXISTS (SELECT 1 FROM doc vd WHERE vd.id = settlement.refDocId AND vd.status = 'void'))`;
    const settles = db
      .prepare(
        `SELECT partnerId, SUM(CASE WHEN type = ? THEN amount ELSE -amount END) AS amt FROM settlement
         WHERE ${settleWhere} GROUP BY partnerId`,
      )
      .all(settleType, teamId, settleType, reverseType, partnerType, now) as Array<{ partnerId: number; amt: number }>;
    const settleMap = new Map<number, number>(settles.map((s) => [s.partnerId, s.amt]));

    // 各往来单位按日期汇总的结算事件（与 settles 同口径），用于确定超收发生日
    const settleEventRows = db
      .prepare(
        `SELECT partnerId, date, SUM(CASE WHEN type = ? THEN amount ELSE -amount END) AS amt FROM settlement
         WHERE ${settleWhere} GROUP BY partnerId, date ORDER BY date ASC`,
      )
      .all(settleType, teamId, settleType, reverseType, partnerType, now) as Array<{ partnerId: number; date: string; amt: number }>;
    const settleEventMap = new Map<number, SettleEvent[]>();
    for (const r of settleEventRows) {
      const list = settleEventMap.get(r.partnerId) ?? [];
      list.push({ date: r.date, amount: r.amt });
      settleEventMap.set(r.partnerId, list);
    }

    // 3) 按往来单位分组 → FIFO 分摊 → 按账龄分桶
    const byPartner = new Map<number, OpenDoc[]>();
    for (const d of docs) {
      const list = byPartner.get(d.partnerId) ?? [];
      // 订金按单归属：sign*(total - deposit)；合计口径与旧汇总口径一致，只改桶归属
      list.push({ id: d.id, partnerId: d.partnerId, date: d.date, amount: signOf(d.type) * (d.totalAmount - d.deposit) });
      byPartner.set(d.partnerId, list);
    }

    // 无单据的预收/预付：以 partner_balance 为驱动（B-数5①），有余额、无单据的往来单位单独列示
    const advanceBalances = db
      .prepare(
        `SELECT partnerId, balance FROM partner_balance
         WHERE teamId = ? AND partnerType = ? AND balance <> 0`,
      )
      .all(teamId, partnerType) as Array<{ partnerId: number; balance: number }>;
    // “无单据”按账龄口径 = 无已审核往来单据（不限日期）：有未来单据的客户不算无单据，
    // 否则未来单的金额会借预收行重新计入今日账龄合计，③ 的截断就白做了
    const hasAuditDoc = new Set<number>(
      (
        db
          .prepare(
            `SELECT DISTINCT partnerId FROM doc
             WHERE teamId = ? AND status = 'audit' AND type IN ${chargeTypes} AND partnerId IS NOT NULL`,
          )
          .all(teamId) as Array<{ partnerId: number }>
      ).map((r) => r.partnerId),
    );

    const names = new Map<number, string>();
    if (byPartner.size > 0 || advanceBalances.length > 0) {
      const table = partnerType === 'cus' ? 'customer' : 'vendor';
      const rows = db
        .prepare(`SELECT id, name FROM ${table} WHERE teamId = ?`)
        .all(teamId) as Array<{ id: number; name: string }>;
      for (const r of rows) names.set(r.id, r.name);
    }

    const rows: AgingBucketRow[] = [];
    const totals: Record<string, number> = {
      d30: 0, d60: 0, d90: 0, d180: 0, d360: 0, d720: 0, over720: 0, total: 0,
    };

    for (const [partnerId, list] of byPartner) {
      const alloc = allocate(list, settleMap.get(partnerId) ?? 0, settleEventMap.get(partnerId) ?? []);
      const row: AgingBucketRow = {
        partnerId,
        partnerName: names.get(partnerId) ?? `#${partnerId}`,
        partnerType,
        d30: 0, d60: 0, d90: 0, d180: 0, d360: 0, d720: 0, over720: 0,
        total: 0,
        oldestDate: null,
      };
      for (const { doc, open, synthetic } of alloc) {
        if (open === 0) continue;
        const key = bucketOf(daysBetween(doc.date, now));
        row[key] += open;
        row.total += open;
        // oldestDate 统计所有非零未结（含负数退货单）：纯退货客户的最早账龄不再为 null；
        // 超收合成行不参与（它的日期是结算日，不是单据日）
        if (!synthetic && open !== 0 && (row.oldestDate === null || doc.date < row.oldestDate)) {
          row.oldestDate = doc.date;
        }
      }
      if (row.total !== 0) {
        for (const k of BUCKET_KEYS) totals[k] += row[k];
        totals.total += row.total;
        rows.push(row);
      }
    }
    // 预收/预付行：无单据，单独列示，不进账龄桶；total 取 partner_balance 余额，
    // 只进 totals.total，不进各桶合计
    for (const ab of advanceBalances) {
      if (byPartner.has(ab.partnerId) || hasAuditDoc.has(ab.partnerId)) continue;
      const row: AgingBucketRow = {
        partnerId: ab.partnerId,
        partnerName: names.get(ab.partnerId) ?? `#${ab.partnerId}`,
        partnerType,
        d30: 0, d60: 0, d90: 0, d180: 0, d360: 0, d720: 0, over720: 0,
        total: ab.balance,
        oldestDate: null,
        advance: true,
      };
      totals.total += ab.balance;
      rows.push(row);
    }
    rows.sort((a, b) => b.total - a.total);
    return { asOf: now, totals, rows };
  };

  router.get('/report/aging', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    const mode = String(req.query.mode ?? 'ar') === 'ap' ? 'ap' : 'ar';
    if (!teamId) {
      res.status(400).json({ error: 'teamId 不能为空' });
      return;
    }
    const { asOf, totals, rows } = computeAging(teamId, mode);
    res.json({ mode, asOf, bucketDays: BUCKETS, totals, rows });
  });

  /** 欠款排行：取账龄明细前 N 条（前端工作台用） */
  router.get('/report/aging/top', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    const mode = String(req.query.mode ?? 'ar') === 'ap' ? 'ap' : 'ar';
    // limit 守护：Number('abc')=NaN 时 slice(0, NaN) 静默返回空排行
    const rawLimit = Number(req.query.limit ?? 5);
    const limit = Number.isFinite(rawLimit) ? Math.min(20, Math.max(1, Math.floor(rawLimit))) : 5;
    if (!teamId) {
      res.status(400).json({ error: 'teamId 不能为空' });
      return;
    }
    const { rows } = computeAging(teamId, mode);
    res.json({ mode, rows: rows.slice(0, limit) });
  });

  /**
   * 库存账龄：按库存行的「最早入库日期」分桶。
   * 只统计 qty > 0 的库存；金额按该商品的历史采购均价（估算）估算。
   */
  router.get('/report/stock-aging', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) {
      res.status(400).json({ error: 'teamId 不能为空' });
      return;
    }
    const now = today();
    // 每个 (productId, warehouseId, reservoirId, batchNo) 的首次入库日期
    // 用 doc.date（业务日期）而非 stock_ledger.createdAt（记录创建时刻）：
    // 补录历史入库单时 createdAt 是"今天"，会让批次账龄被严重低估。
    const firstIn = db
      .prepare(
        `SELECT l.productId, l.warehouseId, l.reservoirId, COALESCE(l.batchNo, '') AS batchNo,
                MIN(substr(COALESCE(d.date, l.createdAt), 1, 10)) AS firstDate
         FROM stock_ledger l
         LEFT JOIN doc d ON d.id = l.refDocId
         WHERE l.teamId = ? AND l.direction = 'in'
           AND (d.id IS NULL OR d.status <> 'void')
         GROUP BY l.productId, l.warehouseId, l.reservoirId, COALESCE(l.batchNo, '')`,
      )
      .all(teamId) as Array<{
      productId: number;
      warehouseId: number;
      reservoirId: number | null;
      batchNo: string;
      firstDate: string;
    }>;
    const firstMap = new Map<string, string>();
    for (const r of firstIn) {
      firstMap.set(`${r.productId}|${r.warehouseId}|${r.reservoirId ?? ''}|${r.batchNo}`, r.firstDate);
    }

    // 历史采购均价（估算），只算截至今天的采购入库流水，与报表口径一致；
    // 不加日期上限会把"未来补录的历史入库"也计入，成本被往回带的采购价污染；
    // 零价入库（unitCost<=0）不计入分母，全零价商品 avgCost 为 NULL、调用方回落到 purchasePrice
    const costs = db
      .prepare(
        `SELECT l.productId,
                SUM(CASE WHEN l.unitCost > 0 THEN l.qty * l.unitCost ELSE 0 END) * 1.0
                  / NULLIF(SUM(CASE WHEN l.unitCost > 0 THEN l.qty ELSE 0 END), 0) AS avgCost
         FROM stock_ledger l JOIN doc d ON d.id = l.refDocId
         WHERE l.teamId = ? AND l.direction = 'in' AND d.type = 'stockin' AND d.status = 'audit'
           AND d.date <= ?
         GROUP BY l.productId`,
      )
      .all(teamId, now) as Array<{ productId: number; avgCost: number }>;
    const costMap = new Map<number, number>(costs.map((c) => [c.productId, c.avgCost]));

    const stocks = db
      .prepare(
        `SELECT s.productId, s.warehouseId, s.reservoirId, COALESCE(s.batchNo, '') AS batchNo,
                s.qty, p.name AS prodName, p.purchasePrice, w.name AS warehouseName
         FROM stock s
         JOIN product p ON p.id = s.productId
         LEFT JOIN warehouse w ON w.id = s.warehouseId
         WHERE s.teamId = ? AND s.qty > 0`,
      )
      .all(teamId) as Array<{
      productId: number;
      warehouseId: number;
      reservoirId: number | null;
      batchNo: string;
      qty: number;
      prodName: string;
      purchasePrice: number;
      warehouseName: string | null;
    }>;

    const totals: Record<string, number> = {
      d30: 0, d60: 0, d90: 0, d180: 0, d360: 0, d720: 0, over720: 0, total: 0, qty: 0,
    };
    const items: Array<{
      productId: number;
      prodName: string;
      warehouseName: string | null;
      batchNo: string;
      qty: number;
      firstDate: string | null;
      days: number;
      amount: number;
      bucket: string;
    }> = [];

    for (const s of stocks) {
      const key = `${s.productId}|${s.warehouseId}|${s.reservoirId ?? ''}|${s.batchNo}`;
      const firstDate = firstMap.get(key) ?? null;
      const days = firstDate ? daysBetween(firstDate, now) : 0;
      const bucket = bucketOf(days);
      const unitCost = costMap.get(s.productId) ?? s.purchasePrice;
      const amount = Math.round(s.qty * unitCost);
      totals[bucket] += amount;
      totals.total += amount;
      totals.qty += s.qty;
      items.push({
        productId: s.productId,
        prodName: s.prodName,
        warehouseName: s.warehouseName,
        batchNo: s.batchNo,
        qty: s.qty,
        firstDate,
        days,
        amount,
        bucket,
      });
    }
    items.sort((a, b) => b.days - a.days);
    res.json({ asOf: now, bucketDays: BUCKETS, totals, items });
  });
}
