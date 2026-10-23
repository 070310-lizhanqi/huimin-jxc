/**
 * 账龄统计：客户欠款 / 供应商欠款 / 库存账龄
 *
 * 口径说明
 * - 应收（客户欠款）：已审核的销售向单据（stockout 正、sret 负），单据未收金额 = 合计金额 - 已收金额。
 *   已收金额按「该客户在该团队的全部收款单」分摊：先冲最早的单据（FIFO），这是最常用的账龄算法。
 * - 应付（供应商欠款）：采购向单据（stockin 正、pin 负），分摊逻辑与应收对称，用付款单冲抵。
 * - 账龄 = 今天 - 单据日期 的天数，按 30/60/90/180/360/720 天分桶。
 * - 库存账龄：按批次入库日期（stock_ledger 首次 in 的时间）计算，只统计 qty > 0 的库存。
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

/**
 * 按 FIFO 把「已结算金额」分摊到未结单据上，返回每张单的未结金额。
 * @param docs 按日期升序的应收/应付单据（amount 为分，可正可负：负数表示退货/退款冲减）
 * @param settled 已结算总额（分）
 * 超收处理：当 settled 超过全部正数单据合计时，剩余 left 不再丢弃，
 * 而是作为负数挂到最新一张单据上——否则客户超收时应收被系统性低估，与 partner_balance 对不上账。
 */
function allocate(docs: OpenDoc[], settled: number): Array<{ doc: OpenDoc; open: number }> {
  let left = settled;
  const out: Array<{ doc: OpenDoc; open: number }> = [];
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
  // 超收溢额：挂到最新（日期最大，即数组末尾）一张单据作为负数未结
  if (left > 0 && out.length > 0) {
    const last = out[out.length - 1];
    out[out.length - 1] = { doc: last.doc, open: last.open - left };
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

    // 1) 取全部已审核往来单据（正负按方向）。
    //    注意：不能加日期下限过滤——早于 720 天的单据金额仍须计入 over720 桶，
    //    否则老客户的历史欠款会从应收总额里消失，与 partner_balance 对不上。
    //    日期过滤已靠索引 idx_doc_team_status_type_date 加速，无需砍掉历史数据。
    const docs = db
      .prepare(
        `SELECT id, partnerId, date, type, totalAmount FROM doc
         WHERE teamId = ? AND status = 'audit' AND type IN ${chargeTypes}
           AND partnerId IS NOT NULL
         ORDER BY date ASC, id ASC`,
      )
      .all(teamId) as Array<{
      id: number;
      partnerId: number;
      date: string;
      type: string;
      totalAmount: number;
    }>;

    // 2) 取各往来单位的已结算总额（partnerType 必须一致：customer/vendor 自增 id 可能撞号，
    //    不加过滤会把供应商的付款算到同号客户的应收上）
    const settles = db
      .prepare(
        `SELECT partnerId, SUM(amount) AS amt FROM settlement
         WHERE teamId = ? AND type = ? AND partnerType = ? GROUP BY partnerId`,
      )
      .all(teamId, settleType, partnerType) as Array<{ partnerId: number; amt: number }>;
    const settleMap = new Map<number, number>(settles.map((s) => [s.partnerId, s.amt]));

    // 3) 按往来单位分组 → FIFO 分摊 → 按账龄分桶
    //    订金（deposit）在审核时已冲减往来但不生成 settlement，这里把它并进已结额，
    //    否则账龄会把订金抵掉的部分仍计为未结，虚高欠款。
    const byPartner = new Map<number, OpenDoc[]>();
    const depByPartner = new Map<number, number>();
    for (const d of docs) {
      const list = byPartner.get(d.partnerId) ?? [];
      list.push({ id: d.id, partnerId: d.partnerId, date: d.date, amount: d.totalAmount * signOf(d.type) });
      byPartner.set(d.partnerId, list);
    }
    const depRows = db
      .prepare(
        `SELECT partnerId, COALESCE(SUM(CASE WHEN type = 'sret' THEN -deposit WHEN type = 'pin' THEN -deposit ELSE deposit END), 0) AS amt
         FROM doc
         WHERE teamId = ? AND status = 'audit' AND type IN ${chargeTypes}
           AND partnerId IS NOT NULL AND deposit > 0
         GROUP BY partnerId`,
      )
      .all(teamId) as Array<{ partnerId: number; amt: number }>;
    for (const r of depRows) depByPartner.set(r.partnerId, r.amt);

    const names = new Map<number, string>();
    if (byPartner.size > 0) {
      const table = partnerType === 'cus' ? 'customer' : 'vendor';
      const rows = db
        .prepare(`SELECT id, name FROM ${table} WHERE teamId = ?`)
        .all(teamId) as Array<{ id: number; name: string }>;
      for (const r of rows) names.set(r.id, r.name);
    }

    const now = today();
    const rows: AgingBucketRow[] = [];
    const totals: Record<string, number> = {
      d30: 0, d60: 0, d90: 0, d180: 0, d360: 0, d720: 0, over720: 0, total: 0,
    };

    for (const [partnerId, list] of byPartner) {
      const alloc = allocate(list, (settleMap.get(partnerId) ?? 0) + (depByPartner.get(partnerId) ?? 0));
      const row: AgingBucketRow = {
        partnerId,
        partnerName: names.get(partnerId) ?? `#${partnerId}`,
        partnerType,
        d30: 0, d60: 0, d90: 0, d180: 0, d360: 0, d720: 0, over720: 0,
        total: 0,
        oldestDate: null,
      };
      for (const { doc, open } of alloc) {
        if (open === 0) continue;
        const key = bucketOf(daysBetween(doc.date, now));
        row[key] += open;
        row.total += open;
        // oldestDate 统计所有非零未结（含负数退货单）：纯退货客户的最早账龄不再为 null
        if (open !== 0 && (row.oldestDate === null || doc.date < row.oldestDate)) {
          row.oldestDate = doc.date;
        }
      }
      if (row.total !== 0) {
        for (const k of BUCKET_KEYS) totals[k] += row[k];
        totals.total += row.total;
        rows.push(row);
      }
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
    const limit = Math.min(20, Math.max(1, Number(req.query.limit ?? 5)));
    if (!teamId) {
      res.status(400).json({ error: 'teamId 不能为空' });
      return;
    }
    const { rows } = computeAging(teamId, mode);
    res.json({ mode, rows: rows.slice(0, limit) });
  });

  /**
   * 库存账龄：按库存行的「最早入库日期」分桶。
   * 只统计 qty > 0 的库存；金额按该商品的加权平均入库成本估算。
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

    // 加权平均成本（只算截至今天的采购入库流水，与报表口径一致；
    // 不加日期上限会把"未来补录的历史入库"也计入，成本被往回带的采购价污染）
    const costs = db
      .prepare(
        `SELECT l.productId, SUM(l.qty * l.unitCost) * 1.0 / SUM(l.qty) AS avgCost
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
