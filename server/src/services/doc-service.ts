/**
 * 单据核心业务服务：单据元数据、参数/金额/结算校验、防重指纹、明细落库与审核/作废结算记账
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Request } from 'express';
import { escapeLike } from '../crud';
import { validBizDate } from '../db';
import {
  parseBizDateOptional,
  parseOptionalPositiveInt,
  parseOptionalString,
  parsePositiveInt,
} from '../infra/validate';
import { BILL_NO_PREFIXES } from '../settings';
import { lineAmount, MAX_TOTAL_AMOUNT_CENTS, PRICE_CENTS_MAX, QTY_MAX, roundQty, sumQty } from '../shared/money';
import { bumpPartnerBalance, StockError } from './stock-service';

export interface ItemInput {
  productId: number;
  qty: number;
  price: number;
  batchNo?: string;
  productionDate?: string;
  expiryDate?: string;
  reservoirId?: number;
  toWarehouseId?: number;
  toReservoirId?: number;
  remark?: string;
}

export interface DocInput {
  teamId: number;
  type:
    | 'stockin'
    | 'stockout'
    | 'transfer'
    | 'adjust'
    | 'stocktake'
    | 'quo'
    | 'porder'
    | 'sorder'
    | 'pin'
    | 'sret'
    | 'otherin'
    | 'otherout'
    | 'assembly'
    | 'outapply'
    | 'prodtask'
    | 'stockinit';
  date?: string;
  partnerType?: 'cus' | 'ven' | null;
  partnerId?: number | null;
  clerkId?: number | null;
  warehouseId: number;
  refOrderId?: number | null;
  remark?: string;
  receiverName?: string | null;
  receiverMobile?: string | null;
  receiverAddress?: string | null;
  discount?: number | null;
  paidAmount?: number | null;
  accountId?: number | null;
  deposit?: number | null;
  items: ItemInput[];
}

export const ORDER_TYPES = new Set(['porder', 'sorder', 'quo', 'outapply', 'prodtask']);
export const RET_TYPES = new Set(['sret', 'pin']);

export const MONEY_FLOW: Record<string, 'receipt' | 'payment'> = {
  stockout: 'receipt',
  stockin: 'payment',
  sret: 'payment',
  pin: 'receipt',
};

export const NO_SETTLE_TYPES = new Set([
  'transfer',
  'stocktake',
  'assembly',
  'adjust',
  'otherin',
  'otherout',
  'stockinit',
]);

export const DOC_META: Record<string, { label: string; kind: 'order' | 'stock' | 'partner' }> = {
  porder: { label: '采购订单', kind: 'order' },
  quo: { label: '报价单', kind: 'order' },
  stockinit: { label: '期初库存', kind: 'stock' },
  sorder: { label: '销售订单', kind: 'order' },
  stockin: { label: '采购入库', kind: 'stock' },
  stockout: { label: '销售出库', kind: 'stock' },
  pin: { label: '采购退货', kind: 'stock' },
  sret: { label: '销售退货', kind: 'stock' },
  transfer: { label: '调拨单', kind: 'stock' },
  adjust: { label: '库存调整', kind: 'stock' },
  stocktake: { label: '盘点单', kind: 'stock' },
  otherin: { label: '其它入库', kind: 'stock' },
  otherout: { label: '其它出库', kind: 'stock' },
  assembly: { label: '生产组装', kind: 'stock' },
  outapply: { label: '出库申请单', kind: 'order' },
  prodtask: { label: '生产任务', kind: 'order' },
};

export const DOC_STATUS_TEXT: Record<string, string> = {
  draft: '草稿',
  pending: '待审核',
  audit: '已审核',
  void: '已作废',
};

export function docListFilter(
  req: Request,
  teamId: number,
): { conds: string[]; args: SQLInputValue[]; statusArgIndex: number } {
  const conds: string[] = ['d.teamId = ?'];
  const args: SQLInputValue[] = [teamId];
  let statusArgIndex = -1;
  if (req.query.type) {
    conds.push('d.type = ?');
    args.push(String(req.query.type));
  }
  if (req.query.types) {
    const ts = String(req.query.types)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ts.length) {
      conds.push(`d.type IN (${ts.map(() => '?').join(',')})`);
      args.push(...ts);
    }
  }
  if (req.query.status) {
    statusArgIndex = args.length;
    conds.push('d.status = ?');
    args.push(String(req.query.status));
  }
  if (req.query.partnerId) {
    conds.push('d.partnerId = ?');
    args.push(Number(req.query.partnerId));
  }
  if (req.query.from) {
    conds.push('d.date >= ?');
    args.push(String(req.query.from));
  }
  if (req.query.to) {
    conds.push('d.date <= ?');
    args.push(String(req.query.to));
  }
  if (req.query.kw) {
    conds.push("(d.billNo LIKE ? ESCAPE '\\' OR IFNULL(d.remark, '') LIKE ? ESCAPE '\\')");
    const k = `%${escapeLike(String(req.query.kw))}%`;
    args.push(k, k);
  }
  return { conds, args, statusArgIndex };
}

export function checkSettle(totalAmount: number, paidAmount: number, deposit: number): string | null {
  if (paidAmount + deposit <= totalAmount) return null;
  if (totalAmount <= 0 && paidAmount === 0 && deposit === 0) return null;
  if (totalAmount <= 0) return `单据应收金额为 ${totalAmount / 100} 元，不能填写收款或订金`;
  return `本次收款 ${paidAmount / 100} 元 + 抵扣订金 ${deposit / 100} 元超过应收金额 ${totalAmount / 100} 元`;
}

export interface ComputedDocFinancials {
  totalQty: number;
  grossAmount: number;
  discount: number;
  totalAmount: number;
  paidAmount: number;
  deposit: number;
}

export function computeDocFinancials(
  input: DocInput,
): { ok: true; value: ComputedDocFinancials } | { ok: false; error: string } {
  const totalQty = sumQty(input.items.map((i) => i.qty));
  const grossAmount = input.items.reduce((s, i) => s + lineAmount(i.qty, Number(i.price ?? 0)), 0);
  const discount = Math.max(0, Math.round(Number(input.discount ?? 0)));
  if (discount > 0 && discount > grossAmount) {
    return { ok: false, error: `整单折扣 ${discount / 100} 元超过单据金额` };
  }
  const totalAmount = grossAmount - discount;
  const paidAmount = Math.max(0, Math.round(Number(input.paidAmount ?? 0)));
  const deposit = Math.max(0, Math.round(Number(input.deposit ?? 0)));

  if (NO_SETTLE_TYPES.has(input.type)) {
    if (paidAmount > 0 || deposit > 0) {
      return { ok: false, error: '该单据类型为纯库存单，不能填写收付款/订金' };
    }
  } else if (ORDER_TYPES.has(input.type)) {
    if (paidAmount > 0 || deposit > 0) {
      return {
        ok: false,
        error: '报价/订单/申请类单据不产生收付，请去掉收款/订金后保存（收付款在出库/入库单上填写）',
      };
    }
  } else {
    const settleErr = checkSettle(totalAmount, paidAmount, deposit);
    if (settleErr) return { ok: false, error: settleErr };
  }

  return {
    ok: true,
    value: { totalQty, grossAmount, discount, totalAmount, paidAmount, deposit },
  };
}

const recentCreates = new Map<string, { id: number; billNo: string; at: number }>();
const CREATE_DEDUP_MS = 5000;

function createFingerprint(input: DocInput, userId?: number): string {
  return JSON.stringify([
    input.teamId,
    userId ?? 0,
    input.type,
    input.date ?? null,
    input.partnerType ?? null,
    input.partnerId ?? null,
    input.clerkId ?? null,
    input.warehouseId ?? null,
    input.remark ?? null,
    input.receiverName ?? null,
    input.receiverMobile ?? null,
    input.receiverAddress ?? null,
    Number(input.discount ?? 0),
    Number(input.paidAmount ?? 0),
    input.accountId ?? null,
    Number(input.deposit ?? 0),
    input.items.map((i) => [
      i.productId,
      i.qty,
      i.price,
      i.batchNo ?? null,
      i.reservoirId ?? null,
      i.toWarehouseId ?? null,
      i.toReservoirId ?? null,
      i.productionDate ?? null,
      i.expiryDate ?? null,
      i.remark ?? null,
    ]),
  ]);
}

export function dedupCreate(db: DatabaseSync, input: DocInput, userId?: number): { id: number; billNo: string } | null {
  const key = createFingerprint(input, userId);
  const hit = recentCreates.get(key);
  if (hit && Date.now() - hit.at < CREATE_DEDUP_MS) {
    const row = db
      .prepare(`SELECT id, billNo, status FROM doc WHERE id = ? AND teamId = ?`)
      .get(hit.id, input.teamId) as { id: number; billNo: string; status: string } | undefined;
    if (row && row.status === 'draft') return { id: row.id, billNo: row.billNo };
    recentCreates.delete(key);
    return null;
  }
  return null;
}

export function rememberCreate(input: DocInput, id: number, billNo: string, userId?: number): void {
  const key = createFingerprint(input, userId);
  recentCreates.set(key, { id, billNo, at: Date.now() });
  if (recentCreates.size > 200) {
    const now = Date.now();
    for (const [k, v] of recentCreates) if (now - v.at > CREATE_DEDUP_MS) recentCreates.delete(k);
  }
}

export function validateDocInput(db: DatabaseSync, input: DocInput): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '请求参数格式非法';
  if (!input.teamId) return 'teamId 不能为空';
  if (typeof input.type !== 'string' || !Object.hasOwn(BILL_NO_PREFIXES, input.type)) {
    return `不支持的单据类型 ${String(input.type ?? '')}`;
  }
  if (!ORDER_TYPES.has(input.type)) {
    if (input.warehouseId === undefined || input.warehouseId === null || input.warehouseId === ('' as unknown)) {
      return '仓库不能为空';
    }
    const whParsed = parsePositiveInt(input.warehouseId, '仓库');
    if (!whParsed.ok) return whParsed.error;
  } else if (input.warehouseId !== undefined && input.warehouseId !== null && input.warehouseId !== ('' as unknown)) {
    const whOpt = parseOptionalPositiveInt(input.warehouseId, '仓库');
    if (!whOpt.ok) return whOpt.error;
  }
  if (!Array.isArray(input.items) || input.items.length === 0) return '明细不能为空';
  if (input.items.length > 1000) return `明细行数超出上限（最多 1000 行，当前 ${input.items.length} 行）`;
  for (const [i, it] of input.items.entries()) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) {
      return `第 ${i + 1} 行明细格式非法`;
    }
  }

  for (const [res, label] of [
    [parseOptionalString(input.remark, '备注', 500), 'remark'],
    [parseOptionalString(input.receiverName, '收件人', 100), 'receiverName'],
    [parseOptionalString(input.receiverMobile, '收件手机', 32), 'receiverMobile'],
    [parseOptionalString(input.receiverAddress, '收件地址', 200), 'receiverAddress'],
  ] as const) {
    if (!res.ok) return res.error;
    void label;
  }

  if (input.type === 'transfer') {
    for (const [i, it] of input.items.entries()) {
      if (!it.toWarehouseId) return `第 ${i + 1} 行调往仓库不能为空`;
      const toWhParsed = parsePositiveInt(it.toWarehouseId, `第 ${i + 1} 行调往仓库`);
      if (!toWhParsed.ok) return toWhParsed.error;
      if (toWhParsed.value === Number(input.warehouseId)) return `第 ${i + 1} 行调往仓库不能与调出仓库相同`;
    }
  }

  if (input.date !== undefined && input.date !== null && input.date !== '') {
    if (typeof input.date !== 'string') return '单据日期格式必须为 YYYY-MM-DD';
    const dateErr = validBizDate(input.date.trim());
    if (dateErr) return '单据日期' + dateErr;
  }

  const clerkParsed = parseOptionalPositiveInt(input.clerkId, '业务员');
  if (!clerkParsed.ok) return clerkParsed.error;
  const partnerParsed = parseOptionalPositiveInt(input.partnerId, '往来单位');
  if (!partnerParsed.ok) return partnerParsed.error;
  const accParsed = parseOptionalPositiveInt(input.accountId, '收款账户');
  if (!accParsed.ok) return accParsed.error;

  if (input.warehouseId) {
    const wh = db
      .prepare(`SELECT id FROM warehouse WHERE id = ? AND teamId = ?`)
      .get(Number(input.warehouseId), input.teamId) as { id: number } | undefined;
    if (!wh) return '仓库不存在';
  }
  if (clerkParsed.value !== null) {
    const clerk = db
      .prepare(`SELECT id FROM clerk WHERE id = ? AND teamId = ?`)
      .get(clerkParsed.value, input.teamId) as { id: number } | undefined;
    if (!clerk) return '业务员不存在';
  }
  if (partnerParsed.value !== null) {
    if (!['cus', 'ven'].includes(input.partnerType ?? '')) return '往来单位类型非法';
    const partnerTable = input.partnerType === 'cus' ? 'customer' : 'vendor';
    const partner = db
      .prepare(`SELECT id FROM ${partnerTable} WHERE id = ? AND teamId = ?`)
      .get(partnerParsed.value, input.teamId) as { id: number } | undefined;
    if (!partner) return '往来单位不存在';
  }
  if (accParsed.value !== null) {
    const acc = db.prepare(`SELECT id FROM account WHERE id = ? AND teamId = ?`).get(accParsed.value, input.teamId) as
      { id: number } | undefined;
    if (!acc) return '收款账户不存在';
  }

  if (input.type === 'stocktake') {
    const seen = new Map<string, number>();
    for (const [i, it] of input.items.entries()) {
      const batchNorm = typeof it.batchNo === 'string' && it.batchNo.trim() ? it.batchNo.trim() : null;
      const key = [it.productId, it.reservoirId ?? null, batchNorm].join('|');
      const prev = seen.get(key);
      if (prev !== undefined) return `第 ${prev + 1} 行与第 ${i + 1} 行是同一商品同一批次，请合并为一行盘点`;
      seen.set(key, i);
    }
  }

  {
    const productIds = [
      ...new Set(input.items.map((it) => Number(it.productId)).filter((n) => Number.isInteger(n) && n > 0)),
    ];
    const reservoirIds = [
      ...new Set(input.items.map((it) => Number(it.reservoirId)).filter((n) => Number.isInteger(n) && n > 0)),
    ];
    const toWhIds = [
      ...new Set(input.items.map((it) => Number(it.toWarehouseId)).filter((n) => Number.isInteger(n) && n > 0)),
    ];
    const toResIds = [
      ...new Set(input.items.map((it) => Number(it.toReservoirId)).filter((n) => Number.isInteger(n) && n > 0)),
    ];

    const existIn = (table: string, ids: number[]): Set<number> => {
      if (!ids.length) return new Set();
      const rows = db
        .prepare(`SELECT id FROM ${table} WHERE teamId = ? AND id IN (${ids.map(() => '?').join(',')})`)
        .all(input.teamId, ...ids) as Array<{ id: number }>;
      return new Set(rows.map((r) => r.id));
    };

    const prodSet = existIn('product', productIds);
    const resMap = new Map<number, number>();
    if (reservoirIds.length) {
      for (const r of db
        .prepare(
          `SELECT id, warehouseId FROM reservoir WHERE teamId = ? AND id IN (${reservoirIds.map(() => '?').join(',')})`,
        )
        .all(input.teamId, ...reservoirIds) as Array<{ id: number; warehouseId: number }>) {
        resMap.set(r.id, r.warehouseId);
      }
    }
    const toWhSet = existIn('warehouse', toWhIds);
    const toResMap = new Map<number, number>();
    if (toResIds.length) {
      for (const r of db
        .prepare(
          `SELECT id, warehouseId FROM reservoir WHERE teamId = ? AND id IN (${toResIds.map(() => '?').join(',')})`,
        )
        .all(input.teamId, ...toResIds) as Array<{ id: number; warehouseId: number }>) {
        toResMap.set(r.id, r.warehouseId);
      }
    }

    for (const [i, it] of input.items.entries()) {
      const prodParsed = parsePositiveInt(it.productId, `第 ${i + 1} 行商品`);
      if (!prodParsed.ok) return `第 ${i + 1} 行缺少商品`;
      if (!prodSet.has(prodParsed.value)) return `第 ${i + 1} 行商品不存在`;
      const resParsed = parseOptionalPositiveInt(it.reservoirId, `第 ${i + 1} 行库区`);
      if (!resParsed.ok) return resParsed.error;
      if (resParsed.value !== null) {
        if (resMap.get(resParsed.value) !== Number(input.warehouseId)) return `第 ${i + 1} 行库区不属于该仓库`;
      }
      const toWhParsed = parseOptionalPositiveInt(it.toWarehouseId, `第 ${i + 1} 行调往仓库`);
      if (!toWhParsed.ok) return toWhParsed.error;
      if (toWhParsed.value !== null && !toWhSet.has(toWhParsed.value)) return `第 ${i + 1} 行调往仓库不存在`;
      const toResParsed = parseOptionalPositiveInt(it.toReservoirId, `第 ${i + 1} 行调往库区`);
      if (!toResParsed.ok) return toResParsed.error;
      if (toResParsed.value !== null) {
        if (toWhParsed.value === null) return `第 ${i + 1} 行填写了调往库区，但缺少调往仓库`;
        if (toResMap.get(toResParsed.value) !== toWhParsed.value) {
          return `第 ${i + 1} 行调往库区不属于调往仓库`;
        }
      }
      const batchParsed = parseOptionalString(it.batchNo, `第 ${i + 1} 行批次`, 64);
      if (!batchParsed.ok) return batchParsed.error;
      const itemRemarkParsed = parseOptionalString(it.remark, `第 ${i + 1} 行备注`, 500);
      if (!itemRemarkParsed.ok) return itemRemarkParsed.error;
      const prodDateParsed = parseBizDateOptional(it.productionDate, `第 ${i + 1} 行生产日期`);
      if (!prodDateParsed.ok) return prodDateParsed.error;
      const expDateParsed = parseBizDateOptional(it.expiryDate, `第 ${i + 1} 行有效期至`);
      if (!expDateParsed.ok) return expDateParsed.error;
    }
  }

  for (const [i, it] of input.items.entries()) {
    if (it.price !== undefined && typeof it.price !== 'number') {
      return `第 ${i + 1} 行单价必须是数值`;
    }
    if (typeof it.qty !== 'number') {
      return `第 ${i + 1} 行数量必须是数值`;
    }
    if (!Number.isFinite(it.qty) || (it.price !== undefined && !Number.isFinite(it.price))) {
      return `第 ${i + 1} 行数量或单价必须是有限数值`;
    }
    const allowNegative = input.type === 'adjust' || input.type === 'assembly';
    const allowZero = input.type === 'stocktake';
    const roundedQty = roundQty(it.qty);
    if ((it.qty === 0 || roundedQty === 0) && !allowZero) return `第 ${i + 1} 行数量不能为 0`;
    if (!allowNegative && it.qty < 0) return `第 ${i + 1} 行数量非法`;
    if (Math.abs(it.qty) > QTY_MAX) return `第 ${i + 1} 行数量超出上限 ${QTY_MAX}`;
    if (it.price < 0) return `第 ${i + 1} 行单价不能为负`;
    if (it.price > PRICE_CENTS_MAX) return `第 ${i + 1} 行单价超出上限 ${PRICE_CENTS_MAX / 100} 元`;
  }

  const discountRaw = Number(input.discount ?? 0);
  if (!Number.isFinite(discountRaw)) return '整单折扣必须是有限数值';
  if (discountRaw < 0) return '整单折扣不能为负数';
  const paidRaw = Number(input.paidAmount ?? 0);
  if (!Number.isFinite(paidRaw)) return '本次收款必须是有限数值';
  if (paidRaw < 0) return '本次收款不能为负数';
  const depRaw = Number(input.deposit ?? 0);
  if (!Number.isFinite(depRaw)) return '抵扣订金必须是有限数值';
  if (depRaw < 0) return '抵扣订金不能为负数';

  if (input.refOrderId != null && input.refOrderId !== undefined && Number(input.refOrderId) !== 0) {
    const refParsed = parsePositiveInt(input.refOrderId, '来源订单');
    if (!refParsed.ok) return refParsed.error;
    const selfId = (input as { id?: number }).id;
    if (selfId != null && refParsed.value === Number(selfId)) return '来源订单不能是单据自身';
    const ref = db
      .prepare(`SELECT type, status FROM doc WHERE id = ? AND teamId = ?`)
      .get(refParsed.value, input.teamId) as { type: string; status: string } | undefined;
    if (!ref) return '来源订单不存在';
    if (!ORDER_TYPES.has(ref.type) || ref.type === 'quo') return '来源必须是订单类单据';
    if (ref.status !== 'audit') return '来源订单尚未审核，不能转单';
  }

  const grossAmount = input.items.reduce((s, i) => s + lineAmount(i.qty, Number(i.price ?? 0)), 0);
  const totalAmount = grossAmount - Math.max(0, Math.round(Number(input.discount ?? 0)));
  if (!Number.isFinite(totalAmount) || Math.abs(totalAmount) > MAX_TOTAL_AMOUNT_CENTS) {
    return '单据总金额超出上限（10 亿元），请核对后重试';
  }
  return null;
}

export function insertItems(db: DatabaseSync, docId: number, items: ItemInput[]): void {
  const stmt = db.prepare(
    `INSERT INTO doc_item (docId, productId, qty, price, amount, batchNo, productionDate, expiryDate, reservoirId, toWarehouseId, toReservoirId, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const it of items) {
    const price = Math.round(Number(it.price ?? 0));
    const qty = roundQty(Number(it.qty));
    const batchNo = typeof it.batchNo === 'string' && it.batchNo.trim() ? it.batchNo.trim() : null;
    const productionDate =
      typeof it.productionDate === 'string' && it.productionDate.trim() ? it.productionDate.trim() : null;
    const expiryDate = typeof it.expiryDate === 'string' && it.expiryDate.trim() ? it.expiryDate.trim() : null;
    const remark = typeof it.remark === 'string' && it.remark.trim() ? it.remark.trim() : null;
    stmt.run(
      docId,
      Number(it.productId),
      qty,
      price,
      lineAmount(qty, price),
      batchNo,
      productionDate,
      expiryDate,
      it.reservoirId ? Number(it.reservoirId) : null,
      it.toWarehouseId ? Number(it.toWarehouseId) : null,
      it.toReservoirId ? Number(it.toReservoirId) : null,
      remark,
    );
  }
}

export function settleOnAudit(
  db: DatabaseSync,
  teamId: number,
  doc: {
    id: number;
    type: string;
    partnerType: string | null;
    partnerId: number | null;
    paidAmount: number | null;
    deposit: number | null;
    accountId: number | null;
    date: string;
  },
): void {
  const paid = Math.max(0, Number(doc.paidAmount ?? 0));
  const dep = Math.max(0, Number(doc.deposit ?? 0));
  if (paid + dep <= 0) return;
  const moneyType = MONEY_FLOW[doc.type];
  if (!moneyType) return;
  if (!doc.partnerType || !doc.partnerId) throw new StockError('填写了收款/订金，但单据没有关联往来单位');
  const balanceSign = RET_TYPES.has(doc.type) ? 1 : -1;
  if (doc.accountId && paid > 0) {
    const acc = db.prepare(`SELECT id, balance FROM account WHERE id=? AND teamId=?`).get(doc.accountId, teamId) as
      { id: number; balance: number } | undefined;
    if (!acc) throw new StockError('收款账户不存在');
    if (moneyType === 'payment' && acc.balance < paid) {
      throw new StockError(
        `账户余额不足：可用 ${(acc.balance / 100).toFixed(2)} 元，本次付款 ${(paid / 100).toFixed(2)} 元`,
      );
    }
  }
  if (paid > 0) {
    db.prepare(
      `INSERT INTO settlement (teamId, type, partnerType, partnerId, accountId, amount, date, remark, refDocId, isAuto)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(
      teamId,
      moneyType,
      doc.partnerType,
      doc.partnerId,
      doc.accountId ?? null,
      paid,
      doc.date,
      '开单即收付',
      doc.id,
    );
  }
  bumpPartnerBalance(db, teamId, doc.partnerType, doc.partnerId, balanceSign * (paid + dep));
  if (doc.accountId && paid > 0) {
    const inc = moneyType === 'receipt' ? paid : -paid;
    db.prepare(`UPDATE account SET balance = balance + ? WHERE id=? AND teamId=?`).run(inc, doc.accountId, teamId);
  }
}

export function reverseSettleOnVoid(
  db: DatabaseSync,
  teamId: number,
  doc: {
    id: number;
    type: string;
    partnerType: string | null;
    partnerId: number | null;
    paidAmount: number | null;
    deposit: number | null;
    accountId: number | null;
  },
): void {
  const manuals = db
    .prepare(`SELECT id, type, amount, date FROM settlement WHERE teamId=? AND refDocId=? AND isAuto=0 ORDER BY id`)
    .all(teamId, doc.id) as Array<{ id: number; type: string; amount: number; date: string }>;
  if (manuals.length) {
    const list = manuals
      .map((m) => `#${m.id}${m.type === 'receipt' ? '收款' : '付款'}${(m.amount / 100).toFixed(2)}元（${m.date}）`)
      .join('、');
    throw new StockError(`单据存在后续手工收付款记录，无法作废，请先删除或修改以下手工结算记录：${list}`);
  }
  const paid = Math.max(0, Number(doc.paidAmount ?? 0));
  const dep = Math.max(0, Number(doc.deposit ?? 0));
  if (paid + dep <= 0) return;
  if (!doc.partnerType || !doc.partnerId) return;
  const moneyType = MONEY_FLOW[doc.type];
  if (!moneyType) return;
  const balanceSign = RET_TYPES.has(doc.type) ? 1 : -1;

  const autos = db
    .prepare(`SELECT id, accountId, amount, type FROM settlement WHERE teamId=? AND refDocId=? AND isAuto=1`)
    .all(teamId, doc.id) as Array<{ id: number; accountId: number | null; amount: number; type: string }>;

  const receiptBack = new Map<number, number>();
  for (const s of autos) {
    if (s.type === 'receipt' && s.accountId) {
      receiptBack.set(s.accountId, (receiptBack.get(s.accountId) ?? 0) + s.amount);
    }
  }
  for (const [accountId, need] of receiptBack) {
    const acc = db.prepare(`SELECT balance FROM account WHERE id=? AND teamId=?`).get(accountId, teamId) as
      { balance: number } | undefined;
    if (acc && acc.balance < need) {
      throw new StockError(
        `该笔收款已被支用，账户当前余额 ${(acc.balance / 100).toFixed(2)} 元，不足以冲回 ${(need / 100).toFixed(2)} 元。请先调整资金（调账补足余额）后再作废。`,
      );
    }
  }

  db.prepare(`DELETE FROM settlement WHERE teamId=? AND refDocId=? AND isAuto=1`).run(teamId, doc.id);
  bumpPartnerBalance(db, teamId, doc.partnerType, doc.partnerId, -balanceSign * (paid + dep));
  for (const s of autos) {
    if (!s.accountId) continue;
    const inc = s.type === 'receipt' ? -s.amount : s.amount;
    db.prepare(`UPDATE account SET balance = balance + ? WHERE id=? AND teamId=?`).run(inc, s.accountId, teamId);
  }
  if (!autos.length && doc.accountId && paid > 0) {
    if (moneyType === 'receipt') {
      const acc = db.prepare(`SELECT balance FROM account WHERE id=? AND teamId=?`).get(doc.accountId, teamId) as
        { balance: number } | undefined;
      if (acc && acc.balance < paid) {
        throw new StockError(
          `该笔收款已被支用，账户当前余额 ${(acc.balance / 100).toFixed(2)} 元，不足以冲回 ${(paid / 100).toFixed(2)} 元。请先调整资金（调账补足余额）后再作废。`,
        );
      }
    }
    const inc = moneyType === 'receipt' ? -paid : paid;
    db.prepare(`UPDATE account SET balance = balance + ? WHERE id=? AND teamId=?`).run(inc, doc.accountId, teamId);
  }
}
