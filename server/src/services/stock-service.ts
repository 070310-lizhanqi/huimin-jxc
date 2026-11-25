/**
 * 库存核心领域服务：FIFO 扣减、批次成本追踪、盘点快照、并发防超卖扣减、作废按流水精确冲回
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { QTY_DECIMALS, roundQty, sumQty } from '../shared/money';

export class StockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StockError';
  }
}

/** 会写库存流水的单据类型 */
export const COST_TYPES = new Set([
  'stockin',
  'stockout',
  'transfer',
  'adjust',
  'pin',
  'sret',
  'stocktake',
  'otherin',
  'otherout',
  'assembly',
  'stockinit',
]);

/** 出库方向会消耗库存的单据类型 */
export const DEDUCT_TYPES = new Set(['stockout', 'transfer', 'adjust', 'pin', 'stocktake', 'otherout']);

/** 往来余额增减：原子 upsert，避免并发首次插入主键冲突 */
export function bumpPartnerBalance(
  db: DatabaseSync,
  teamId: number,
  partnerType: string,
  partnerId: number,
  delta: number,
): void {
  db.prepare(
    `INSERT INTO partner_balance (teamId, partnerType, partnerId, balance) VALUES (?, ?, ?, ?)
     ON CONFLICT(teamId, partnerType, partnerId) DO UPDATE SET balance = balance + excluded.balance`,
  ).run(teamId, partnerType, partnerId, delta);
}

/** 账面库存数量：按 (商品, 仓库, 库位, 批次) 精确取数（null 安全比较） */
export function bookQty(
  db: DatabaseSync,
  teamId: number,
  productId: number,
  warehouseId: number,
  reservoirId: number | null = null,
  batchNo: string | null = null,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(qty), 0) AS q FROM stock
       WHERE teamId = ? AND productId = ? AND warehouseId = ? AND (reservoirId IS ?) AND (batchNo IS ?)`,
    )
    .get(teamId, productId, warehouseId, reservoirId, batchNo) as { q: number } | undefined;
  return Number(row?.q ?? 0);
}

/** 盘点单过账前固化盈亏：把「实盘数 - 账面数」写入 doc_item.postQty */
export function snapshotStocktake(db: DatabaseSync, docId: number): void {
  const items = db
    .prepare(`SELECT id, productId, qty, reservoirId, batchNo FROM doc_item WHERE docId = ?`)
    .all(docId) as Array<{
    id: number;
    productId: number;
    qty: number;
    reservoirId: number | null;
    batchNo: string | null;
  }>;
  const info = db.prepare(`SELECT teamId, warehouseId FROM doc WHERE id = ?`).get(docId) as
    { teamId: number; warehouseId: number } | undefined;
  if (!info) return;
  const upd = db.prepare(`UPDATE doc_item SET postQty = ? WHERE id = ?`);
  for (const it of items) {
    const book = bookQty(db, info.teamId, it.productId, info.warehouseId, it.reservoirId, it.batchNo);
    upd.run(roundQty(it.qty - book), it.id);
  }
}

/**
 * 某批次的成本可信入库成本（B-数9）：排除售价入库的 sret / assembly 产出行
 */
export function batchInboundCost(
  db: DatabaseSync,
  teamId: number,
  productId: number,
  warehouseId: number,
  reservoirId: number | null,
  batchNo: string | null,
): number | null {
  const row = db
    .prepare(
      `SELECT l.unitCost FROM stock_ledger l JOIN doc d ON d.id = l.refDocId
       WHERE l.teamId = ? AND l.productId = ? AND l.warehouseId = ? AND (l.reservoirId IS ?) AND (l.batchNo IS ?)
         AND l.direction = 'in' AND d.type IN ('stockin','transfer','otherin','stockinit','adjust')
       ORDER BY l.id DESC LIMIT 1`,
    )
    .get(teamId, productId, warehouseId, reservoirId, batchNo) as { unitCost: number } | undefined;
  return row ? Number(row.unitCost) : null;
}

/** 查询可用库存行（FIFO 顺序：按 stock.id 升序；exactCell=true 时 null 也精确匹配为空值格子） */
export function fifoBatches(
  db: DatabaseSync,
  teamId: number,
  productId: number,
  warehouseId: number,
  reservoirId: number | null,
  batchNo: string | null,
  qty: number,
  exactCell = false,
): Array<{ batchNo: string | null; reservoirId: number | null; qty: number; unitCost: number | null }> {
  const params: SQLInputValue[] = [teamId, productId, warehouseId];
  let where = `teamId=? AND productId=? AND warehouseId=? AND qty > 0`;
  if (exactCell) {
    where += ` AND (reservoirId IS ?) AND (batchNo IS ?)`;
    params.push(reservoirId, batchNo);
  } else {
    if (reservoirId != null) {
      where += ` AND reservoirId = ?`;
      params.push(reservoirId);
    }
    if (batchNo != null) {
      where += ` AND batchNo = ?`;
      params.push(batchNo);
    }
  }
  const rows = db
    .prepare(`SELECT id, batchNo, reservoirId, qty FROM stock WHERE ${where} ORDER BY id ASC`)
    .all(...params) as Array<{
    id: number;
    batchNo: string | null;
    reservoirId: number | null;
    qty: number;
  }>;
  const avail = sumQty(rows.map((r) => r.qty));
  if (avail < qty) {
    throw new StockError(`商品 ${productId} 库存不足：可用 ${avail}，需要 ${qty}`);
  }
  const out: Array<{ batchNo: string | null; reservoirId: number | null; qty: number; unitCost: number | null }> = [];
  let remain = qty;
  for (const r of rows) {
    if (remain <= 0) break;
    const take = Math.min(r.qty, remain);
    out.push({
      batchNo: r.batchNo,
      reservoirId: r.reservoirId,
      qty: take,
      unitCost: batchInboundCost(db, teamId, productId, warehouseId, r.reservoirId, r.batchNo),
    });
    remain = roundQty(remain - take);
  }
  return out;
}

export function moveStock(
  db: DatabaseSync,
  doc: { teamId: number; type: string; warehouseId: number },
  docId: number,
  productId: number,
  warehouseId: number,
  reservoirId: number | null,
  batchNo: string | null,
  direction: 'in' | 'out',
  qty: number,
  unitCost: number,
  reverse: boolean,
): void {
  const dirEff: 'in' | 'out' = reverse ? (direction === 'in' ? 'out' : 'in') : direction;
  const delta = roundQty((dirEff === 'in' ? 1 : -1) * qty);
  db.prepare(
    `INSERT INTO stock_ledger (teamId, productId, warehouseId, reservoirId, batchNo, direction, qty, unitCost, refDocId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(doc.teamId, productId, warehouseId, reservoirId, batchNo ?? null, dirEff, qty, unitCost, docId);

  const existing = db
    .prepare(
      `SELECT id, qty FROM stock WHERE teamId=? AND productId=? AND warehouseId=? AND (reservoirId IS ?) AND (batchNo IS ?)`,
    )
    .get(doc.teamId, productId, warehouseId, reservoirId, batchNo) as { id: number; qty: number } | undefined;

  if (existing) {
    if (dirEff === 'out') {
      const r = db
        .prepare(`UPDATE stock SET qty = ROUND(qty - ?, ${QTY_DECIMALS}) WHERE id = ? AND qty >= ?`)
        .run(qty, existing.id, qty);
      if (r.changes === 0) {
        throw new StockError(
          `商品 ${productId} 库存不足：可用 ${existing.qty}，需要扣减 ${qty}（并发审核冲突，请刷新后重试）`,
        );
      }
    } else {
      db.prepare(`UPDATE stock SET qty = ROUND(qty + ?, ${QTY_DECIMALS}) WHERE id = ?`).run(delta, existing.id);
    }
  } else {
    if (dirEff === 'out') {
      throw new StockError(`商品 ${productId} 库存不足：可用 0，需要扣减 ${qty}`);
    }
    db.prepare(
      `INSERT INTO stock (teamId, productId, warehouseId, reservoirId, batchNo, qty) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(doc.teamId, productId, warehouseId, reservoirId, batchNo ?? null, delta);
  }
}

export function deduct(
  db: DatabaseSync,
  doc: { teamId: number; type: string; warehouseId: number },
  docId: number,
  productId: number,
  warehouseId: number,
  reservoirId: number | null,
  batchNo: string | null,
  qty: number,
  unitCost: number,
  reverse: boolean,
  exactCell = false,
): void {
  const batches = fifoBatches(db, doc.teamId, productId, warehouseId, reservoirId, batchNo, qty, exactCell);
  for (const b of batches) {
    moveStock(
      db,
      doc,
      docId,
      productId,
      warehouseId,
      b.reservoirId,
      b.batchNo,
      'out',
      b.qty,
      b.unitCost ?? unitCost,
      reverse,
    );
  }
}

/** 审核前预检：按 (商品, 库位, 批次) 聚合总需求后比对可用量 */
export function precheckStock(db: DatabaseSync, docId: number): string | null {
  const doc = db.prepare(`SELECT * FROM doc WHERE id = ?`).get(docId) as {
    teamId: number;
    type: string;
    warehouseId: number;
  };
  const items = db.prepare(`SELECT * FROM doc_item WHERE docId = ?`).all(docId) as Array<{
    productId: number;
    qty: number;
    batchNo: string | null;
    reservoirId: number | null;
    postQty: number | null;
  }>;
  if (!DEDUCT_TYPES.has(doc.type)) return null;

  const prodIds = [...new Set(items.map((it) => it.productId))];
  const prodNames = new Map<number, string>();
  if (prodIds.length) {
    for (const r of db
      .prepare(`SELECT id, name FROM product WHERE id IN (${prodIds.map(() => '?').join(',')})`)
      .all(...prodIds) as Array<{ id: number; name: string }>) {
      prodNames.set(r.id, r.name);
    }
  }

  const needMap = new Map<
    string,
    { productId: number; reservoirId: number | null; batchNo: string | null; need: number }
  >();
  for (const it of items) {
    let need = it.qty;
    if (doc.type === 'adjust' && it.qty < 0) {
      need = Math.abs(it.qty);
    } else if (doc.type === 'assembly') {
      need = it.qty < 0 ? Math.abs(it.qty) : 0;
    } else if (doc.type === 'stocktake') {
      need =
        it.postQty != null
          ? -it.postQty
          : bookQty(db, doc.teamId, it.productId, doc.warehouseId, it.reservoirId, it.batchNo) - it.qty;
    }
    if (need <= 0) continue;
    const key = `${it.productId}|${it.reservoirId ?? ''}|${it.batchNo ?? ''}`;
    const cur = needMap.get(key);
    if (cur) cur.need = roundQty(cur.need + need);
    else needMap.set(key, { productId: it.productId, reservoirId: it.reservoirId, batchNo: it.batchNo, need });
  }

  const exactCell = doc.type === 'stocktake';
  for (const { productId, reservoirId, batchNo, need } of needMap.values()) {
    const params: SQLInputValue[] = [doc.teamId, productId, doc.warehouseId];
    let where = `teamId=? AND productId=? AND warehouseId=? AND qty > 0`;
    if (exactCell) {
      where += ` AND (reservoirId IS ?) AND (batchNo IS ?)`;
      params.push(reservoirId, batchNo);
    } else {
      if (reservoirId != null) {
        where += ` AND reservoirId = ?`;
        params.push(reservoirId);
      }
      if (batchNo != null) {
        where += ` AND batchNo = ?`;
        params.push(batchNo);
      }
    }
    const rows = db.prepare(`SELECT qty FROM stock WHERE ${where}`).all(...params) as Array<{ qty: number }>;
    const avail = sumQty(rows.map((r) => r.qty));
    if (avail < need) {
      return `${prodNames.get(productId) ?? `#${productId}`} 库存不足：可用 ${avail}，需要 ${need}`;
    }
  }
  return null;
}

export function postStockForward(
  db: DatabaseSync,
  doc: { teamId: number; type: string; warehouseId: number },
  docId: number,
): void {
  const items = db.prepare(`SELECT * FROM doc_item WHERE docId = ?`).all(docId) as Array<{
    productId: number;
    qty: number;
    price: number;
    batchNo: string | null;
    reservoirId: number | null;
    toWarehouseId: number | null;
    toReservoirId: number | null;
    postQty: number | null;
  }>;
  const move = (
    productId: number,
    warehouseId: number,
    reservoirId: number | null,
    batchNo: string | null,
    direction: 'in' | 'out',
    qty: number,
    unitCost: number,
  ) => moveStock(db, doc, docId, productId, warehouseId, reservoirId, batchNo, direction, qty, unitCost, false);

  for (const it of items) {
    const unitCost = it.price;
    if (doc.type === 'stockin' || doc.type === 'sret' || doc.type === 'otherin' || doc.type === 'stockinit') {
      move(it.productId, doc.warehouseId, it.reservoirId, it.batchNo, 'in', it.qty, unitCost);
    } else if (doc.type === 'stockout' || doc.type === 'pin' || doc.type === 'otherout') {
      deduct(db, doc, docId, it.productId, doc.warehouseId, it.reservoirId, it.batchNo, it.qty, unitCost, false);
    } else if (doc.type === 'stocktake') {
      const diff = Number(it.postQty ?? 0);
      if (diff > 0) {
        move(it.productId, doc.warehouseId, it.reservoirId, it.batchNo, 'in', diff, unitCost);
      } else if (diff < 0) {
        deduct(
          db,
          doc,
          docId,
          it.productId,
          doc.warehouseId,
          it.reservoirId,
          it.batchNo,
          Math.abs(diff),
          unitCost,
          false,
          true,
        );
      }
    } else if (doc.type === 'assembly') {
      if (it.qty > 0) {
        move(it.productId, doc.warehouseId, it.reservoirId, it.batchNo, 'in', it.qty, unitCost);
      } else {
        deduct(
          db,
          doc,
          docId,
          it.productId,
          doc.warehouseId,
          it.reservoirId,
          it.batchNo,
          Math.abs(it.qty),
          unitCost,
          false,
        );
      }
    } else if (doc.type === 'transfer') {
      const batches = fifoBatches(db, doc.teamId, it.productId, doc.warehouseId, it.reservoirId, it.batchNo, it.qty);
      for (const b of batches) {
        const cost = b.unitCost ?? unitCost;
        move(it.productId, doc.warehouseId, b.reservoirId, b.batchNo, 'out', b.qty, cost);
        move(it.productId, it.toWarehouseId ?? doc.warehouseId, it.toReservoirId, b.batchNo, 'in', b.qty, cost);
      }
    } else if (doc.type === 'adjust') {
      if (it.qty >= 0) {
        move(it.productId, doc.warehouseId, it.reservoirId, it.batchNo, 'in', it.qty, unitCost);
      } else {
        deduct(
          db,
          doc,
          docId,
          it.productId,
          doc.warehouseId,
          it.reservoirId,
          it.batchNo,
          Math.abs(it.qty),
          unitCost,
          false,
        );
      }
    }
  }
}

export function reverseStockByLedger(
  db: DatabaseSync,
  doc: { teamId: number; type: string; warehouseId: number },
  docId: number,
): void {
  const orig = db
    .prepare(
      `SELECT productId, warehouseId, reservoirId, batchNo, direction, qty, unitCost
       FROM stock_ledger WHERE teamId = ? AND refDocId = ? ORDER BY id`,
    )
    .all(doc.teamId, docId) as Array<{
    productId: number;
    warehouseId: number;
    reservoirId: number | null;
    batchNo: string | null;
    direction: string;
    qty: number;
    unitCost: number;
  }>;
  if (!orig.length) {
    // 账实相符（diff === 0）的盘点单审核时不写流水，作废时可直接放行
    if (doc.type === 'stocktake') {
      const hasDiff = db
        .prepare(`SELECT 1 AS ok FROM doc_item WHERE docId = ? AND COALESCE(postQty, 0) <> 0 LIMIT 1`)
        .get(docId) as { ok: number } | undefined;
      if (!hasDiff) return;
    }
    throw new StockError('找不到本单的原始库存流水，无法作废冲回');
  }
  for (const r of orig) {
    const dirEff: 'in' | 'out' = r.direction === 'in' ? 'out' : 'in';
    db.prepare(
      `INSERT INTO stock_ledger (teamId, productId, warehouseId, reservoirId, batchNo, direction, qty, unitCost, refDocId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(doc.teamId, r.productId, r.warehouseId, r.reservoirId, r.batchNo, dirEff, r.qty, r.unitCost, docId);
    const existing = db
      .prepare(
        `SELECT id, qty FROM stock WHERE teamId=? AND productId=? AND warehouseId=? AND (reservoirId IS ?) AND (batchNo IS ?)`,
      )
      .get(doc.teamId, r.productId, r.warehouseId, r.reservoirId, r.batchNo) as { id: number; qty: number } | undefined;
    if (dirEff === 'out') {
      if (!existing || existing.qty + 1e-9 < r.qty) {
        throw new StockError(
          `商品 ${r.productId} 原批次只剩 ${existing?.qty ?? 0}，不足以冲回入库 ${r.qty}（该商品已被后续出库消耗，请先作废相关出库单）`,
        );
      }
      db.prepare(`UPDATE stock SET qty = ROUND(qty - ?, ${QTY_DECIMALS}) WHERE id = ?`).run(r.qty, existing.id);
    } else if (existing) {
      db.prepare(`UPDATE stock SET qty = ROUND(qty + ?, ${QTY_DECIMALS}) WHERE id = ?`).run(r.qty, existing.id);
    } else {
      db.prepare(
        `INSERT INTO stock (teamId, productId, warehouseId, reservoirId, batchNo, qty) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(doc.teamId, r.productId, r.warehouseId, r.reservoirId, r.batchNo, r.qty);
    }
  }
}

export function postStock(db: DatabaseSync, docId: number, reverse = false): void {
  const doc = db.prepare(`SELECT * FROM doc WHERE id = ?`).get(docId) as {
    teamId: number;
    type: string;
    warehouseId: number;
    partnerType: string | null;
    partnerId: number | null;
    totalAmount: number;
  };
  if (reverse) {
    reverseStockByLedger(db, doc, docId);
  } else {
    postStockForward(db, doc, docId);
  }

  const PARTNER_DELTA: Record<string, { type: 'cus' | 'ven'; sign: number }> = {
    stockin: { type: 'ven', sign: 1 },
    pin: { type: 'ven', sign: -1 },
    stockout: { type: 'cus', sign: 1 },
    sret: { type: 'cus', sign: -1 },
  };
  const pd = PARTNER_DELTA[doc.type];
  if (pd && doc.partnerId && doc.partnerType) {
    if (doc.partnerType !== pd.type) {
      throw new StockError('往来单位类型与单据类型不匹配');
    }
    const delta = pd.sign * doc.totalAmount * (reverse ? -1 : 1);
    bumpPartnerBalance(db, doc.teamId, doc.partnerType, doc.partnerId, delta);
  }
}
