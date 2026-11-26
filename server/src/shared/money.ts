/**
 * 金额与数量高精度计算口径（全服务端统一）
 * - 金额一律以「分（INTEGER）」存储与运算，避免 IEEE754 浮点精度漂移
 * - 数量以 4 位小数（万分之一，QTY_SCALE = 10_000）规整与整数化求和
 */

export const QTY_DECIMALS = 4;
export const QTY_SCALE = 10 ** QTY_DECIMALS;

/** 档案价格上限（分）：9,999,999 分 ≈ 10 万元 */
export const PRICE_CENTS_MAX = 9_999_999;
/** 数量上限（与档案/单据通用口径一致） */
export const QTY_MAX = 9_999_999;
/** 单据/结算单笔总金额上限（分）：10 亿元 */
export const MAX_TOTAL_AMOUNT_CENTS = 1e11;

export function roundQty(n: number): number {
  if (n === 0) return 0;
  const sign = n < 0 ? -1 : 1;
  const res = (sign * Math.round((Math.abs(n) + Number.EPSILON) * QTY_SCALE)) / QTY_SCALE;
  return res === 0 ? 0 : res;
}

/** 整数化缩放求和，避免循环内 0.1 + 0.2 类浮点尾差累积 */
export function sumQty(values: Iterable<number>): number {
  let scaled = 0;
  for (const v of values) {
    if (v === 0) continue;
    const sign = v < 0 ? -1 : 1;
    scaled += sign * Math.round((Math.abs(v) + Number.EPSILON) * QTY_SCALE);
  }
  const res = scaled / QTY_SCALE;
  return res === 0 ? 0 : res;
}

/**
 * 对称舍入（round half away from zero）：-1.5 → -2，与 +1.5 → 2 对称。
 * JS Math.round 向 +∞ 舍入会导致负数行（组装耗用/退货折算）少 1 分。
 */
export function roundHalfAwayFromZero(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

/** 数量 × 单价金额（分）：先将数量整数化为万分之一再与整数分相乘，消除浮点尾差 */
export function lineAmount(qty: number, priceCents: number): number {
  const qtyScaled = Math.round(roundQty(qty) * QTY_SCALE);
  return roundHalfAwayFromZero((qtyScaled * priceCents) / QTY_SCALE);
}

/** (docId, productId) 级明细聚合行，用于整单折扣分摊 */
export interface DiscountableLine {
  docId: number;
  productId: number;
  type: string;
  discount: number | null;
  qty: number;
  amount: number;
}

/**
 * 按行金额占比把整单折扣分摊到各 (docId, productId) 行，尾差归金额最大行，保证单内 Σ分摊 = 整单折扣。
 */
export function allocateDocDiscounts(lines: DiscountableLine[]): Map<string, number> {
  const byDoc = new Map<number, DiscountableLine[]>();
  for (const l of lines) {
    const arr = byDoc.get(l.docId) ?? [];
    arr.push(l);
    byDoc.set(l.docId, arr);
  }
  const net = new Map<string, number>();
  for (const arr of byDoc.values()) {
    const discount = Math.max(0, Math.round(Number(arr[0].discount ?? 0)));
    const gross = arr.reduce((s, l) => s + l.amount, 0);
    if (discount <= 0 || gross <= 0) {
      for (const l of arr) net.set(`${l.docId}:${l.productId}`, l.amount);
      continue;
    }
    let allocated = 0;
    let maxLine = arr[0];
    for (const l of arr) {
      const share = roundHalfAwayFromZero((discount * l.amount) / gross);
      net.set(`${l.docId}:${l.productId}`, l.amount - share);
      allocated += share;
      if (l.amount > maxLine.amount) maxLine = l;
    }
    const tail = discount - allocated;
    if (tail !== 0) {
      const k = `${maxLine.docId}:${maxLine.productId}`;
      net.set(k, (net.get(k) ?? maxLine.amount) - tail);
    }
  }
  return net;
}

/** 历史采购均价估算标量子查询（全报表/库存查询共用同一口径） */
export function histAvgCostSql(tableAlias = 's', productCol = 'productId'): string {
  return `(SELECT SUM(CASE WHEN l.unitCost > 0 THEN l.qty * l.unitCost ELSE 0 END) * 1.0
     / NULLIF(SUM(CASE WHEN l.unitCost > 0 THEN l.qty ELSE 0 END), 0)
   FROM stock_ledger l JOIN doc d ON d.id = l.refDocId
   WHERE l.teamId = ${tableAlias}.teamId AND l.productId = ${tableAlias}.${productCol} AND l.direction = 'in'
     AND d.type = 'stockin' AND d.status = 'audit' AND d.date <= date('now', 'localtime'))`;
}

export const HIST_AVG_COST_SQL = histAvgCostSql('s', 'productId');
