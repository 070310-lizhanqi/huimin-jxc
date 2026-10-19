/**
 * 单据（doc/doc_item）与库存事务。
 * 单据类型：stockin 入库 / stockout 出库 / transfer 调拨 / adjust 调整 / stocktake 盘点
 * 生命周期：draft -> (audit) 审核过账 -> (void) 作废冲回
 */
import type { DatabaseSync } from 'node:sqlite';
import { rememberPrices } from './price';
import { loadNoMode, loadPrefix } from './settings';
import type { Request, Response, Router } from 'express';

type Value = string | number | null;

// 数量精度归一：金额以“分”为整数存储；数量以 4 位小数（万分之一）为准。
// round 至固定小数位，消除 IEEE754 浮点累加误差（如 0.1 + 0.2 = 0.30000000000000004）。
const QTY_DECIMALS = 4;
const roundQty = (n: number): number => {
  const f = 10 ** QTY_DECIMALS;
  return Math.round((n + Number.EPSILON) * f) / f;
};

interface ItemInput {
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

interface DocInput {
  teamId: number;
  type:
    | 'stockin'
    | 'stockout'
    | 'transfer'
    | 'adjust'
    | 'stocktake'
    | 'porder'
    | 'sorder'
    | 'pin'
    | 'sret'
    | 'otherin'
    | 'otherout'
    | 'assembly'
    | 'outapply'
    | 'prodtask';
  date?: string;
  partnerType?: 'cus' | 'ven' | null;
  partnerId?: number | null;
  clerkId?: number | null;
  warehouseId: number;
  refOrderId?: number | null;
  remark?: string;
  /** 收件人信息（销售出库单常用） */
  receiverName?: string | null;
  receiverMobile?: string | null;
  receiverAddress?: string | null;
  /** 整单折扣（分）：从明细合计中直接扣减 */
  discount?: number | null;
  /** 本次收款（分）：保存时同步生成一张收款单 */
  paidAmount?: number | null;
  /** 收款/付款账户 */
  accountId?: number | null;
  /** 抵扣订金（分）：计入已收金额，但不进资金账户 */
  deposit?: number | null;
  items: ItemInput[];
}

const BILL_PREFIX: Record<string, string> = {
  stockin: 'RK',
  stockout: 'CK',
  transfer: 'DB',
  adjust: 'TZ',
  stocktake: 'PD',
  porder: 'CG',
  sorder: 'XS',
  pin: 'CT', // 采购退货（出库）
  sret: 'XT', // 销售退货（入库）
  otherin: 'QR', // 其它入库
  otherout: 'QC', // 其它出库
  assembly: 'ZZ', // 生产组装
  quo: 'BJ', // 报价单
  stockinit: 'QCQ', // 期初库存
  outapply: 'SQ', // 出库申请单
  prodtask: 'SC', // 生产任务
};

/** 订单类：不写库存，可转化为出入库单 */
const ORDER_TYPES = new Set(['porder', 'sorder', 'quo', 'outapply', 'prodtask']);

/**
 * 会写库存流水的单据类型。
 * 注意 stocktake（盘点）也在此列：盘点单以「实盘数量」表达，审核时按差额生成盈亏。
 */
const COST_TYPES = new Set([
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
const DEDUCT_TYPES = new Set(['stockout', 'transfer', 'adjust', 'pin', 'stocktake', 'otherout']);

/** 退货类单据：销售退货（退款给客户）/ 采购退货（收回供应商货款） */
const RET_TYPES = new Set(['sret', 'pin']);
/** 各单据类型「开单即收付」的资金流向：receipt=钱进我方账户 / payment=钱出我方账户 */
const MONEY_FLOW: Record<string, 'receipt' | 'payment'> = {
  stockout: 'receipt', // 销售出库：收货款
  stockin: 'payment', // 采购入库：付货款
  sret: 'payment', // 销售退货：退款给客户
  pin: 'receipt', // 采购退货：收回供应商退款
};

/** 纯库存单据：只动库存，不涉及往来单位与收付款，跳过结算金额校验 */
const NO_SETTLE_TYPES = new Set(['transfer', 'stocktake', 'assembly', 'adjust', 'otherin', 'otherout']);
/** 类型元信息：中文名 + 过账方向 + 单据性质 */
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

class StockError extends Error {}

/** 单项金额上限（分）：qty ≤ 9,999,999 且 price ≤ 9,999,999 分（≈10 万元），单行 ≤ ~10^13 分。
 *  超过将导致 JS Number 精度丢失 / SQLite INTEGER 溢出，validate 阶段直接拒绝。 */
const MAX_QTY = 9_999_999;
const MAX_PRICE_CENTS = 9_999_999;

/** 创建单据的短时幂等：防止双击保存/网络重试导致重复建单。
 *  key = teamId:type:内容指纹，5 秒窗口内重复请求返回同一张单。 */
const recentCreates = new Map<string, { id: number; billNo: string; at: number }>();
const CREATE_DEDUP_MS = 5000;
/** 结算字段校验：收款 + 订金不得超过应收金额（金额单位：分）
 *  合计金额为负或 0 的单据（生产组装纯耗用行、调整单等）不参与检查 */
function checkSettle(totalAmount: number, paidAmount: number, deposit: number): string | null {
  if (paidAmount + deposit <= totalAmount) return null;
  if (totalAmount <= 0 && paidAmount === 0 && deposit === 0) return null;
  if (totalAmount <= 0) return `单据应收金额为 ${totalAmount / 100} 元，不能填写收款或订金`;
  return `本次收款 ${paidAmount / 100} 元 + 抵扣订金 ${deposit / 100} 元超过应收金额 ${totalAmount / 100} 元`;
}

/** 创建幂等指纹：必须包含全部影响落库结果的字段（结算字段漏进来会误判重复） */
function createFingerprint(input: DocInput): string {
  return JSON.stringify([
    input.teamId, input.type, input.date ?? null, input.partnerType ?? null, input.partnerId ?? null,
    input.clerkId ?? null, input.warehouseId ?? null, input.remark ?? null,
    input.receiverName ?? null, input.receiverMobile ?? null, input.receiverAddress ?? null,
    Number(input.discount ?? 0), Number(input.paidAmount ?? 0), input.accountId ?? null, Number(input.deposit ?? 0),
    input.items.map((i) => [i.productId, i.qty, i.price, i.batchNo ?? null, i.toWarehouseId ?? null, i.remark ?? null]),
  ]);
}
function dedupCreate(db: DatabaseSync, input: DocInput): { id: number; billNo: string } | null {
  const key = createFingerprint(input);
  const hit = recentCreates.get(key);
  if (hit && Date.now() - hit.at < CREATE_DEDUP_MS) {
    // 单据可能已被用户删除；只有仍存在的草稿才可幂等返回，否则正常重建
    const row = db
      .prepare(`SELECT id, billNo, status FROM doc WHERE id = ? AND teamId = ?`)
      .get(hit.id, input.teamId) as { id: number; billNo: string; status: string } | undefined;
    if (row && row.status === 'draft') return { id: row.id, billNo: row.billNo };
    recentCreates.delete(key);
    return null;
  }
  return null;
}
function rememberCreate(input: DocInput, id: number, billNo: string): void {
  const key = createFingerprint(input);
  recentCreates.set(key, { id, billNo, at: Date.now() });
  // 控制内存：超过 200 条时清理过期项
  if (recentCreates.size > 200) {
    const now = Date.now();
    for (const [k, v] of recentCreates) if (now - v.at > CREATE_DEDUP_MS) recentCreates.delete(k);
  }
}

export function mountDocs(router: Router, db: DatabaseSync): void {
  // 单据列表（支持 type/types/status/partnerId/日期区间/关键词 过滤与分页）
  router.get('/doc/list', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const conds: string[] = ['d.teamId = ?'];
    const args: Value[] = [teamId];
    if (req.query.type) {
      conds.push('d.type = ?');
      args.push(String(req.query.type));
    }
    // 多类型：一个页签含多个单据类型时用（如 采购订单+采购入库）
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
      // 单号 / 备注 模糊匹配（备注可能为 NULL，用 IFNULL 兜底）
      conds.push("(d.billNo LIKE ? OR IFNULL(d.remark, '') LIKE ?)");
      const k = `%${String(req.query.kw)}%`;
      args.push(k, k);
    }
    const page = Math.max(1, Number(req.query.page ?? 1));
    const rows = Number(req.query.rows ?? 20);
    const total = db
      .prepare(`SELECT COUNT(*) AS c FROM doc d WHERE ${conds.join(' AND ')}`)
      .get(...args) as { c: number };
    const list = db
      .prepare(
        `SELECT d.*,
           (SELECT GROUP_CONCAT(x, '、') FROM (
              SELECT p.name || '×' || CAST(i.qty AS TEXT) AS x
              FROM doc_item i LEFT JOIN product p ON p.id = i.productId
              WHERE i.docId = d.id ORDER BY i.id LIMIT 3
            )) AS summary,
           (SELECT COUNT(*) FROM doc_item WHERE docId = d.id) AS itemCount,
           -- 调拨单的目标仓（可能多仓，去重后拼接）
           (SELECT GROUP_CONCAT(nm, '、') FROM (
              SELECT DISTINCT w2.name AS nm FROM doc_item i2
                JOIN warehouse w2 ON w2.id = i2.toWarehouseId
                WHERE i2.docId = d.id
            )) AS toWarehouseNames
         FROM doc d WHERE ${conds.join(' AND ')} ORDER BY d.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, rows, (page - 1) * rows);
    return res.json({ total: total.c, rows: list, page, pageSize: rows });
  });

  // 待审核工作台：列出所有待审核单据（按提交时间升序，先提交先处理）
  router.get('/doc/pending', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const rows = db
      .prepare(
        `SELECT d.*,
           (SELECT GROUP_CONCAT(x, '、') FROM (
              SELECT p.name || '×' || CAST(i.qty AS TEXT) AS x
              FROM doc_item i LEFT JOIN product p ON p.id = i.productId
              WHERE i.docId = d.id ORDER BY i.id LIMIT 3
            )) AS summary,
           (SELECT COUNT(*) FROM doc_item WHERE docId = d.id) AS itemCount
         FROM doc d WHERE d.teamId = ? AND d.status = 'pending'
         ORDER BY IFNULL(d.submitAt, d.date) ASC, d.id ASC LIMIT 200`,
      )
      .all(teamId);
    // 按类型统计，前端做页签徽标
    const byType = db
      .prepare(`SELECT type, COUNT(*) AS c, SUM(totalAmount) AS amt FROM doc WHERE teamId = ? AND status = 'pending' GROUP BY type`)
      .all(teamId);
    return res.json({ rows, total: rows.length, byType });
  });

  // 单据详情
  router.get('/doc/info', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    const id = Number(req.query.id);
    const doc = db.prepare('SELECT * FROM doc WHERE id = ? AND teamId = ?').get(id, teamId) as
      | { type: string }
      | undefined;
    if (!doc) return res.status(404).json({ error: '单据不存在' });
    const items = db.prepare('SELECT * FROM doc_item WHERE docId = ? ORDER BY id').all(id);
    // 订单类单据附带履约进度：每个商品已转出 / 剩余数量（供前端展示与部分转单）
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
        const c = convMap.get(it.productId) ?? 0;
        return { productId: it.productId, ordered: it.qty, converted: c, remain: roundQty(it.qty - c) };
      });
    }
    return res.json({ doc, items, fulfillment });
  });

  // 创建单据（草稿）
  router.post('/doc/create', (req: Request, res: Response) => {
    const input = req.body as DocInput;
    const err = validate(db, input);
    if (err) return res.status(400).json({ error: err });
    // 幂等：双击保存/重试在窗口内返回同一张单
    const dup = dedupCreate(db, input);
    if (dup) return res.json(dup);
    const billNo = nextBillNo(db, input.teamId, input.type);
    const totalQty = roundQty(input.items.reduce((s, i) => s + i.qty, 0));
    // 明细价格可缺省：调拨/盘点等纯库存单据不填价格，按 0 计
    const grossAmount = input.items.reduce((s, i) => s + Math.round(i.qty * Number(i.price ?? 0)), 0);
    const discount = Math.max(0, Math.round(Number(input.discount ?? 0)));
    // 整单折扣只能从正金额里扣：生产组装/调整等类型的合计可能为负或 0，此时折扣必须为 0
    if (discount > 0 && discount > grossAmount)
      return res.status(400).json({ error: `整单折扣 ${discount / 100} 元超过单据金额` });
    const totalAmount = grossAmount - discount;
    const paidAmount = Math.max(0, Math.round(Number(input.paidAmount ?? 0)));
    const deposit = Math.max(0, Math.round(Number(input.deposit ?? 0)));
    // 纯库存单据（调拨/盘点/组装/调整）不涉及往来款项，跳过结算校验
    if (!NO_SETTLE_TYPES.has(input.type)) {
      const settleErr = checkSettle(totalAmount, paidAmount, deposit);
      if (settleErr) return res.status(400).json({ error: settleErr });
    }
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
        input.date ?? new Date().toISOString().slice(0, 10),
        input.partnerType ?? null,
        input.partnerId ?? null,
        input.clerkId ?? null,
        input.warehouseId ?? null,
        input.remark ?? null,
        totalAmount,
        totalQty,
        null,
        input.refOrderId ?? null,
        input.receiverName ?? null,
        input.receiverMobile ?? null,
        input.receiverAddress ?? null,
        discount,
        paidAmount,
        input.accountId ?? null,
        deposit,
      );
    const docId = Number(info.lastInsertRowid);
    insertItems(db, docId, input.items);
    rememberCreate(input, docId, billNo);
    return res.json({ id: docId, billNo });
  });

  // 订单转化：从订单生成出入库草稿（携带原单引用），返回新单据 id
  router.post('/doc/convert', (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const id = Number(req.body.id);
    const doc = db.prepare(`SELECT * FROM doc WHERE id = ? AND teamId = ?`).get(id, teamId) as
      | {
          type: string;
          status: string;
          partnerType: string | null;
          partnerId: number | null;
          clerkId: number | null;
          warehouseId: number;
          remark: string | null;
        }
      | undefined;
    if (!doc) return res.status(404).json({ error: '单据不存在' });
    if (!ORDER_TYPES.has(doc.type)) return res.status(400).json({ error: '仅订单可转化' });
    if (doc.status !== 'audit') return res.status(400).json({ error: '仅已审核订单可转化' });
    // 报价单可转成销售订单或销售出库（由前端 to 参数决定，缺省转销售订单）
    const target = String(req.body.to ?? '');
    let toType: string;
    if (doc.type === 'porder') toType = 'stockin';
    else if (doc.type === 'sorder') toType = 'stockout';
    else if (doc.type === 'quo') toType = target === 'stockout' ? 'stockout' : 'sorder';
    else if (doc.type === 'outapply') toType = 'stockout';
    else if (doc.type === 'prodtask') toType = 'assembly';
    else return res.status(400).json({ error: '仅订单可转化' });
    // 订单不记仓库，但出入库必须落仓：无仓库时回填团队默认（第一个）仓库
    const targetWh =
      doc.warehouseId ??
      (db.prepare(`SELECT id FROM warehouse WHERE teamId = ? ORDER BY id LIMIT 1`).get(teamId) as
        | { id: number }
        | undefined)?.id ??
      null;
    if (!targetWh) return res.status(400).json({ error: '请先在档案设置中创建仓库' });
    const items = db.prepare(`SELECT * FROM doc_item WHERE docId = ?`).all(id) as Array<{
      productId: number;
      qty: number;
      price: number;
      batchNo: string | null;
      reservoirId: number | null;
      remark: string | null;
    }>;
    // 履约数量跟踪：统计该订单已转出的子单（含草稿/待审/已审，作废不计）按商品汇总的数量，
    // 只允许转出「剩余未履约数量」，全部转完则拦截，杜绝同一订单重复超额转单。
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
        const remain = roundQty(it.qty - (fulfilled.get(it.productId) ?? 0));
        return { ...it, qty: remain };
      })
      .filter((it) => it.qty > 0);
    if (!remainItems.length) {
      return res.status(400).json({ error: '该订单已全部转单，没有可转出的剩余数量' });
    }
    const billNo = nextBillNo(db, teamId, toType);
    const totalQty = roundQty(remainItems.reduce((s, i) => s + i.qty, 0));
    const totalAmount = remainItems.reduce((s, i) => s + Math.round(i.qty * i.price), 0);
    const info = db
      .prepare(
        `INSERT INTO doc (teamId, billNo, type, date, partnerType, partnerId, clerkId, warehouseId, status, remark, totalAmount, totalQty, userId, refOrderId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
      )
      .run(
        teamId,
        billNo,
        toType,
        new Date().toISOString().slice(0, 10),
        doc.partnerType,
        doc.partnerId,
        doc.clerkId,
        targetWh,
        `由订单转单生成`,
        totalAmount,
        totalQty,
        null,
        id,
      );
    const newId = Number(info.lastInsertRowid);
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
        Math.round(it.qty * it.price),
        it.batchNo,
        it.reservoirId,
        it.remark,
      );
    }
    // 回传本次实际转出明细与剩余，便于前端提示「部分转单」
    return res.json({
      id: newId,
      billNo,
      type: toType,
      partial: remainItems.length < items.length,
      items: remainItems.map((i) => ({ productId: i.productId, qty: i.qty })),
    });
  });

  // 单据复制：任意状态单据 → 生成同类型草稿（日期=今天，新单号）
  // 明细仅复制商品/数量/单价/金额/行备注，不复制批次与库位（批次可能已耗尽，由用户重选）
  router.post('/doc/copy', (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const id = Number(req.body.id);
    const doc = db
      .prepare(`SELECT * FROM doc WHERE id = ? AND teamId = ?`)
      .get(id, teamId) as
      | {
          type: string;
          partnerType: string | null;
          partnerId: number | null;
          clerkId: number | null;
          warehouseId: number | null;
          remark: string | null;
        }
      | undefined;
    if (!doc) return res.status(404).json({ error: '单据不存在' });
    const billNo = nextBillNo(db, teamId, doc.type);
    const totalQty = (
      db.prepare(`SELECT COALESCE(SUM(qty), 0) AS q FROM doc_item WHERE docId = ?`).get(id) as {
        q: number;
      }
    ).q;
    const totalAmount = (
      db.prepare(`SELECT COALESCE(SUM(amount), 0) AS a FROM doc_item WHERE docId = ?`).get(id) as {
        a: number;
      }
    ).a;
    const info = db
      .prepare(
        `INSERT INTO doc (teamId, billNo, type, date, partnerType, partnerId, clerkId, warehouseId, status, remark, totalAmount, totalQty, userId, refOrderId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, NULL)`,
      )
      .run(
        teamId,
        billNo,
        doc.type,
        new Date().toISOString().slice(0, 10),
        doc.partnerType,
        doc.partnerId,
        doc.clerkId,
        doc.warehouseId,
        doc.remark ? `${doc.remark}（复制）` : '（复制自原单）',
        totalAmount,
        totalQty,
        null,
      );
    const newId = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO doc_item (docId, productId, qty, price, amount, remark)
       SELECT ?, productId, qty, price, amount, remark FROM doc_item WHERE docId = ?`,
    ).run(newId, id);
    return res.json({ id: newId, billNo });
  });

  // 修改草稿
  router.put('/doc/edit', (req: Request, res: Response) => {
    const input = req.body as DocInput & { id: number };
    const doc = db
      .prepare(`SELECT * FROM doc WHERE id = ? AND teamId = ?`)
      .get(input.id, input.teamId) as { status: string; billNo: string } | undefined;
    if (!doc) return res.status(404).json({ error: '单据不存在' });
    if (doc.status !== 'draft') return res.status(400).json({ error: '仅草稿可编辑' });
    const err = validate(db, input);
    if (err) return res.status(400).json({ error: err });
    const totalQty = roundQty(input.items.reduce((s, i) => s + i.qty, 0));
    // 明细价格可缺省：调拨/盘点等纯库存单据不填价格，按 0 计
    const grossAmount = input.items.reduce((s, i) => s + Math.round(i.qty * Number(i.price ?? 0)), 0);
    const discount = Math.max(0, Math.round(Number(input.discount ?? 0)));
    // 整单折扣只能从正金额里扣：生产组装/调整等类型的合计可能为负或 0，此时折扣必须为 0
    if (discount > 0 && discount > grossAmount)
      return res.status(400).json({ error: `整单折扣 ${discount / 100} 元超过单据金额` });
    const totalAmount = grossAmount - discount;
    const paidAmount = Math.max(0, Math.round(Number(input.paidAmount ?? 0)));
    const deposit = Math.max(0, Math.round(Number(input.deposit ?? 0)));
    // 纯库存单据（调拨/盘点/组装/调整）不涉及往来款项，跳过结算校验
    if (!NO_SETTLE_TYPES.has(input.type)) {
      const settleErr = checkSettle(totalAmount, paidAmount, deposit);
      if (settleErr) return res.status(400).json({ error: settleErr });
    }
    db.prepare(
      `UPDATE doc SET date=?, partnerType=?, partnerId=?, clerkId=?, warehouseId=?, remark=?, totalAmount=?, totalQty=?,
                      receiverName=?, receiverMobile=?, receiverAddress=?, discount=?, paidAmount=?, accountId=?, deposit=?
       WHERE id=?`,
    ).run(
      input.date ?? new Date().toISOString().slice(0, 10),
      input.partnerType ?? null,
      input.partnerId ?? null,
      input.clerkId ?? null,
      input.warehouseId ?? null,
      input.remark ?? null,
      totalAmount,
      totalQty,
      input.receiverName ?? null,
      input.receiverMobile ?? null,
      input.receiverAddress ?? null,
      discount,
      paidAmount,
      input.accountId ?? null,
      deposit,
      input.id,
    );
    db.prepare('DELETE FROM doc_item WHERE docId = ?').run(input.id);
    insertItems(db, input.id, input.items);
    return res.json({ ok: true });
  });

  // 提交审核：草稿 -> 待审核（审批流第一步，不动库存）
  router.post('/doc/submit', (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const id = Number(req.body.id);
    const doc = db.prepare(`SELECT * FROM doc WHERE id = ? AND teamId = ?`).get(id, teamId) as
      | { status: string }
      | undefined;
    if (!doc) return res.status(404).json({ error: '单据不存在' });
    if (doc.status !== 'draft') return res.status(400).json({ error: '仅草稿可提交审核' });
    db.prepare(`UPDATE doc SET status='pending', submitAt=datetime('now','localtime'), rejectReason=NULL WHERE id=?`).run(id);
    return res.json({ ok: true, status: 'pending' });
  });

  // 驳回：待审核 -> 草稿（记录驳回原因，可修改后重新提交）
  router.post('/doc/reject', (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const id = Number(req.body.id);
    const reason = String(req.body.reason ?? '').trim();
    const doc = db.prepare(`SELECT * FROM doc WHERE id = ? AND teamId = ?`).get(id, teamId) as
      | { status: string }
      | undefined;
    if (!doc) return res.status(404).json({ error: '单据不存在' });
    if (doc.status !== 'pending') return res.status(400).json({ error: '仅待审核单据可驳回' });
    db.prepare(`UPDATE doc SET status='draft', rejectReason=? WHERE id=?`).run(reason || null, id);
    return res.json({ ok: true, status: 'draft' });
  });

  // 批量提交审核：把多张草稿一次性提交
  router.post('/doc/submit-batch', (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids 不能为空' });
    let done = 0;
    const skipped: number[] = [];
    try {
      db.exec('BEGIN');
      for (const id of ids) {
        const row = db.prepare(`SELECT status FROM doc WHERE id = ? AND teamId = ?`).get(id, teamId) as
          | { status: string }
          | undefined;
        if (!row || row.status !== 'draft') { skipped.push(id); continue; }
        db.prepare(`UPDATE doc SET status='pending', submitAt=datetime('now','localtime'), rejectReason=NULL WHERE id=?`).run(id);
        done += 1;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      return res.status(400).json({ error: e instanceof Error ? e.message : '提交失败' });
    }
    return res.json({ ok: true, done, skipped });
  });

  // 审核（过账）：写库存流水与实时库存（事务 + 库存校验）
  router.post('/doc/audit', (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const id = Number(req.body.id);
    const auditBy = String(req.body.auditBy ?? '').trim();
    const doc = db
      .prepare(`SELECT * FROM doc WHERE id = ? AND teamId = ?`)
      .get(id, teamId) as
      | {
          id: number;
          status: string;
          type: string;
          partnerType: string | null;
          partnerId: number | null;
          totalAmount: number;
          paidAmount: number | null;
          deposit: number | null;
          accountId: number | null;
          date: string;
        }
      | undefined;
    if (!doc) return res.status(404).json({ error: '单据不存在' });
    // 审批流：草稿可直接审核（小团队快速过账），待审核单据由审批人审核
    if (doc.status !== 'draft' && doc.status !== 'pending') {
      return res.status(400).json({ error: '仅草稿或待审核单据可审核' });
    }
    try {
      // BEGIN IMMEDIATE：立即取得写锁，避免两个审核事务在「预检-过账」之间交叉导致超卖
      db.exec('BEGIN IMMEDIATE');
      if (COST_TYPES.has(doc.type)) {
        // 盘点单：先把「实盘 - 账面」固化成 postQty，后续过账与作废都基于这个差额
        if (doc.type === 'stocktake') snapshotStocktake(db, id);
        const err = precheckStock(db, id);
        if (err) throw new StockError(err);
        postStock(db, id);
      }
      // 开单时填写的「本次收款 / 抵扣订金」在审核时入账：
      //   现金部分走资金账户 + 生成收支记录；订金部分只冲往来余额，不动账户
      settleOnAudit(db, teamId, doc);
      // 客户价格记忆：销售类单据审核后记住每个商品的成交价
      rememberPrices(db, { ...doc, teamId }, id);
      db.prepare(
        `UPDATE doc SET status='audit', auditAt=datetime('now','localtime'), auditBy=? WHERE id=?`,
      ).run(auditBy || null, id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      const msg = e instanceof StockError ? e.message : e instanceof Error ? e.message : '审核失败';
      return res.status(400).json({ error: msg });
    }
    return res.json({ ok: true });
  });

  // 作废：反冲库存与结算
  router.post('/doc/void', (req: Request, res: Response) => {
    const teamId = Number(req.body.teamId);
    const id = Number(req.body.id);
    const doc = db
      .prepare(`SELECT * FROM doc WHERE id = ? AND teamId = ?`)
      .get(id, teamId) as
      | {
          id: number;
          status: string;
          type: string;
          partnerType: string | null;
          partnerId: number | null;
          paidAmount: number | null;
          deposit: number | null;
          accountId: number | null;
        }
      | undefined;
    if (!doc) return res.status(404).json({ error: '单据不存在' });
    if (doc.status !== 'audit') return res.status(400).json({ error: '仅已审核单据可作废' });
    try {
      db.exec('BEGIN IMMEDIATE');
      if (COST_TYPES.has(doc.type)) postStock(db, id, true);
      // 冲回审核时 settleOnAudit 生成的结算记录与账户/往来余额变动，
      // 否则作废带收款的单据后：收款记录仍在、账户余额虚高、往来余额翻转为预收。
      reverseSettleOnVoid(db, teamId, doc);
      db.prepare(`UPDATE doc SET status='void' WHERE id=?`).run(id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      const msg = e instanceof StockError ? e.message : '作废失败';
      return res.status(400).json({ error: msg });
    }
    return res.json({ ok: true });
  });

  // 删除草稿
  router.delete('/doc/:id', (req: Request, res: Response) => {
    const teamId = Number(req.query.teamId);
    const id = Number(req.params.id);
    const doc = db
      .prepare(`SELECT status FROM doc WHERE id = ? AND teamId = ?`)
      .get(id, teamId) as { status: string } | undefined;
    if (!doc) return res.status(404).json({ error: '单据不存在' });
    if (doc.status !== 'draft') return res.status(400).json({ error: '仅草稿可删除' });
    db.prepare('DELETE FROM doc_item WHERE docId = ?').run(id);
    db.prepare('DELETE FROM doc WHERE id = ?').run(id);
    return res.json({ ok: true });
  });
}

function validate(db: DatabaseSync, input: DocInput): string | null {
  if (!input.teamId) return 'teamId 不能为空';
  if (!BILL_PREFIX[input.type]) return `不支持的单据类型 ${input.type}`;
  if (!ORDER_TYPES.has(input.type) && !input.warehouseId) return '仓库不能为空';
  if (input.type === 'transfer') {
    for (const [i, it] of input.items.entries()) {
      if (it.toWarehouseId && it.toWarehouseId === input.warehouseId)
        return `第 ${i + 1} 行调往仓库不能与调出仓库相同`;
    }
  }
  if (!Array.isArray(input.items) || input.items.length === 0) return '明细不能为空';
  for (const [i, it] of input.items.entries()) {
    if (!it.productId) return `第 ${i + 1} 行缺少商品`;
    const prod = db
      .prepare(`SELECT id FROM product WHERE id = ? AND teamId = ?`)
      .get(it.productId, input.teamId) as { id: number } | undefined;
    if (!prod) return `第 ${i + 1} 行商品不存在`;
    // 允许负数的类型：调整单（盘亏）、生产组装（负数行 = 耗用原料）
    // 允许 0 的类型：盘点单（实盘数量可以为 0）
    const allowNegative = input.type === 'adjust' || input.type === 'assembly';
    const allowZero = input.type === 'stocktake';
    if (it.qty === 0 && !allowZero) return `第 ${i + 1} 行数量不能为 0`;
    if (!allowNegative && it.qty < 0) return `第 ${i + 1} 行数量非法`;
    if (it.qty > MAX_QTY) return `第 ${i + 1} 行数量超出上限 ${MAX_QTY}`;
    if (it.price < 0) return `第 ${i + 1} 行单价不能为负`;
    if (it.price > MAX_PRICE_CENTS) return `第 ${i + 1} 行单价超出上限 ${MAX_PRICE_CENTS / 100} 元`;
  }
  return null;
}

function insertItems(db: DatabaseSync, docId: number, items: ItemInput[]): void {
  const stmt = db.prepare(
    `INSERT INTO doc_item (docId, productId, qty, price, amount, batchNo, productionDate, expiryDate, reservoirId, toWarehouseId, toReservoirId, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const it of items) {
    // 价格可缺省（调拨/盘点等纯库存单据不填价格）
    const price = Math.round(Number(it.price ?? 0));
    stmt.run(
      docId,
      it.productId,
      it.qty,
      price,
      Math.round(it.qty * price),
      it.batchNo ?? null,
      it.productionDate ?? null,
      it.expiryDate ?? null,
      it.reservoirId ?? null,
      it.toWarehouseId ?? null,
      it.toReservoirId ?? null,
      it.remark ?? null,
    );
  }
}

function nextBillNo(db: DatabaseSync, teamId: number, type: string): string {
  // 前缀与重置方式支持 team 级配置（功能设置 → 单据编号）
  const prefix = loadPrefix(db, teamId)[type] ?? BILL_PREFIX[type] ?? 'NO';
  const mode = loadNoMode(db, teamId);
  const full = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const datePart = mode === 'none' ? '' : mode === 'month' ? full.slice(0, 6) : full;
  // 独立序号表：删除草稿后序号不复用，保证 billNo 永不重复
  const key = `${teamId}:${prefix}:${datePart}`;
  db.prepare(
    `INSERT INTO bill_seq (k, seq) VALUES (?, 1)
     ON CONFLICT(k) DO UPDATE SET seq = seq + 1`,
  ).run(key);
  const row = db.prepare(`SELECT seq FROM bill_seq WHERE k = ?`).get(key) as { seq: number };
  return `${prefix}${datePart}${String(row.seq).padStart(4, '0')}`;
}

/** 过账：对一条已审核单据生成库存流水并更新实时库存（reverse=true 反冲） */
function postStock(db: DatabaseSync, docId: number, reverse = false): void {
  const doc = db.prepare(`SELECT * FROM doc WHERE id = ?`).get(docId) as {
    teamId: number;
    type: string;
    warehouseId: number;
    partnerType: string | null;
    partnerId: number | null;
    totalAmount: number;
  };
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
  ) => moveStock(db, doc, docId, productId, warehouseId, reservoirId, batchNo, direction, qty, unitCost, reverse);

  for (const it of items) {
    const unitCost = it.price;
    if (doc.type === 'stockin' || doc.type === 'sret' || doc.type === 'otherin' || doc.type === 'stockinit') {
      // 入库方向：采购入库 / 销售退货 / 其它入库
      move(it.productId, doc.warehouseId, it.reservoirId, it.batchNo, 'in', it.qty, unitCost);
    } else if (doc.type === 'stockout' || doc.type === 'pin' || doc.type === 'otherout') {
      // 出库方向：销售出库 / 采购退货 / 其它出库
      // 指定批次则定向扣，未指定按 FIFO 拆批扣减
      deduct(db, doc, docId, it.productId, doc.warehouseId, it.reservoirId, it.batchNo, it.qty, unitCost, reverse);
    } else if (doc.type === 'stocktake') {
      // 盘点：postQty 在审核前已固化为「实盘 - 账面」的差额
      // 正差盘盈入库、负差盘亏出库；差为 0 时不动
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
          reverse,
        );
      }
    } else if (doc.type === 'assembly') {
      // 生产组装：母件（qty 为正的行）入库，子件（qty 为负的行）出库
      // 明细用正负号区分方向：正数=产出成品入库，负数=耗用原料出库
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
          reverse,
        );
      }
    } else if (doc.type === 'transfer') {
      // 调拨：从源仓 FIFO 扣，原批次号保留进目标仓
      const batches = fifoBatches(db, doc.teamId, it.productId, doc.warehouseId, it.reservoirId, it.batchNo, it.qty);
      for (const b of batches) {
        move(it.productId, doc.warehouseId, b.reservoirId, b.batchNo, 'out', b.qty, unitCost);
        move(it.productId, it.toWarehouseId ?? doc.warehouseId, it.toReservoirId, b.batchNo, 'in', b.qty, unitCost);
      }
    } else if (doc.type === 'adjust') {
      // 调整单 qty 可为负：正数盘盈入库，负数盘亏出库
      if (it.qty >= 0) {
        move(it.productId, doc.warehouseId, it.reservoirId, it.batchNo, 'in', it.qty, unitCost);
      } else {
        deduct(db, doc, docId, it.productId, doc.warehouseId, it.reservoirId, it.batchNo, Math.abs(it.qty), unitCost, reverse);
      }
    }
  }

  // 往来余额：赊销/赊购过账（作废反向冲回）
  // 约定：cus 余额正 = 客户欠我们（应收）；ven 余额正 = 我们欠供应商（应付）
  const PARTNER_DELTA: Record<string, number> = { stockin: 1, sret: -1, stockout: 1, pin: -1 };
  const pd = PARTNER_DELTA[doc.type];
  if (pd && doc.partnerId && doc.partnerType) {
    const delta = pd * doc.totalAmount * (reverse ? -1 : 1);
    bumpPartnerBalance(db, doc.teamId, doc.partnerType, doc.partnerId, delta);
  }
}

/**
 * 盘点单过账前固化盈亏：把「实盘数 - 账面数」写入 doc_item.postQty。
 * 必须固化而不是每次重算 —— 否则作废时账面数已等于实盘数，差额恒为 0，无法冲回。
 */
function snapshotStocktake(db: DatabaseSync, docId: number): void {
  const items = db.prepare(`SELECT id, productId, qty FROM doc_item WHERE docId = ?`).all(docId) as Array<{
    id: number;
    productId: number;
    qty: number;
  }>;
  const info = db.prepare(`SELECT teamId, warehouseId FROM doc WHERE id = ?`).get(docId) as
    | { teamId: number; warehouseId: number }
    | undefined;
  if (!info) return;
  const upd = db.prepare(`UPDATE doc_item SET postQty = ? WHERE id = ?`);
  for (const it of items) {
    const book = bookQty(db, info.teamId, it.productId, info.warehouseId);
    upd.run(it.qty - book, it.id);
  }
}

/** 账面库存数量（指定仓库汇总，不分批次/库位） */
function bookQty(db: DatabaseSync, teamId: number, productId: number, warehouseId: number): number {
  const row = db
    .prepare(`SELECT COALESCE(SUM(qty), 0) AS q FROM stock WHERE teamId = ? AND productId = ? AND warehouseId = ?`)
    .get(teamId, productId, warehouseId) as { q: number } | undefined;
  return Number(row?.q ?? 0);
}

/** 查询可用库存行（FIFO 顺序：先进先出，按 stock.id 升序近似入库顺序）
 *  batchNo 指定时定向匹配；未指定（null）时扫全部批次按 FIFO 扣 */
function fifoBatches(
  db: DatabaseSync,
  teamId: number,
  productId: number,
  warehouseId: number,
  reservoirId: number | null,
  batchNo: string | null,
  qty: number,
): Array<{ batchNo: string | null; reservoirId: number | null; qty: number }> {
  const params: unknown[] = [teamId, productId, warehouseId];
  let where = `teamId=? AND productId=? AND warehouseId=? AND qty > 0`;
  if (reservoirId != null) {
    where += ` AND reservoirId = ?`;
    params.push(reservoirId);
  }
  if (batchNo != null) {
    where += ` AND batchNo = ?`;
    params.push(batchNo);
  }
  const rows = db
    .prepare(`SELECT id, batchNo, reservoirId, qty FROM stock WHERE ${where} ORDER BY id ASC`)
    .all(...(params as Value[])) as Array<{
    id: number;
    batchNo: string | null;
    reservoirId: number | null;
    qty: number;
  }>;
  const avail = roundQty(rows.reduce((s, r) => s + r.qty, 0));
  if (avail < qty) {
    throw new StockError(`商品 ${productId} 库存不足：可用 ${avail}，需要 ${qty}`);
  }
  const out: Array<{ batchNo: string | null; reservoirId: number | null; qty: number }> = [];
  let remain = qty;
  for (const r of rows) {
    if (remain <= 0) break;
    const take = Math.min(r.qty, remain);
    out.push({ batchNo: r.batchNo, reservoirId: r.reservoirId, qty: take });
    remain = roundQty(remain - take);
  }
  return out;
}

/** 出库方向扣减：batchNo 为空时 FIFO 拆批 */
function deduct(
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
): void {
  const batches = fifoBatches(db, doc.teamId, productId, warehouseId, reservoirId, batchNo, qty);
  for (const b of batches) {
    moveStock(db, doc, docId, productId, warehouseId, b.reservoirId, b.batchNo, 'out', b.qty, unitCost, reverse);
  }
}

/** 审核前预检：所有出库方向的明细库存是否足够 */
function precheckStock(db: DatabaseSync, docId: number): string | null {
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
  for (const it of items) {
    let need = it.qty;
    if (doc.type === 'adjust' && it.qty < 0) {
      // 调整单负数 = 盘亏，按绝对值出库
      need = Math.abs(it.qty);
    } else if (doc.type === 'assembly') {
      // 生产组装：只有负数行（耗用原料）才消耗库存
      need = it.qty < 0 ? Math.abs(it.qty) : 0;
    } else if (doc.type === 'stocktake') {
      // 盘点：实盘数是绝对数量，只有低于账面（盘亏）才消耗库存
      // 审核流程里 snapshotStocktake 已先固化 postQty，这里优先用它
      need = it.postQty != null ? -it.postQty : bookQty(db, doc.teamId, it.productId, doc.warehouseId) - it.qty;
    }
    if (need <= 0) continue;
    const params: unknown[] = [doc.teamId, it.productId, doc.warehouseId];
    let where = `teamId=? AND productId=? AND warehouseId=? AND qty > 0`;
    if (it.reservoirId != null) {
      where += ` AND reservoirId = ?`;
      params.push(it.reservoirId);
    }
    if (it.batchNo != null) {
      where += ` AND batchNo = ?`;
      params.push(it.batchNo);
    }
    const rows = db
      .prepare(`SELECT qty FROM stock WHERE ${where}`)
      .all(...(params as Value[])) as Array<{ qty: number }>;
    const avail = roundQty(rows.reduce((s, r) => s + r.qty, 0));
    if (avail < need) {
      const prod = db.prepare(`SELECT name FROM product WHERE id=?`).get(it.productId) as
        | { name: string }
        | undefined;
      return `${prod?.name ?? it.productId} 库存不足：可用 ${avail}，需要 ${need}`;
    }
  }
  return null;
}

/** 审核入账：把开单时填的「本次收款 / 抵扣订金」转为结算记录与余额变动。
 *  约定与 settlement.ts 一致：cus 余额正 = 客户欠我们；ven 余额正 = 我们欠供应商。
 *  - 现金部分（paidAmount）走资金账户，并写一条 settlement 记录；
 *  - 订金部分（deposit）只冲减往来余额，不进资金账户（钱早就收过了）。 */
function settleOnAudit(
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
  if (!doc.partnerType || !doc.partnerId) throw new StockError('填写了收款/订金，但单据没有关联往来单位');
  // 资金流向：
  //   销售出库=收货款（receipt）；采购入库=付货款（payment）；
  //   销售退货=退款给客户（payment）；采购退货=收回供应商货款（receipt）。
  const moneyType = MONEY_FLOW[doc.type] ?? 'payment';
  // 往来余额方向：普通进销单据收/付都减少「对方欠我方/我方欠对方」；
  // 退货单据的退款/回款是冲减「我方欠对方/对方欠我方」，方向相反。
  const balanceSign = RET_TYPES.has(doc.type) ? 1 : -1;
  if (doc.accountId && paid > 0) {
    const acc = db.prepare(`SELECT id FROM account WHERE id=? AND teamId=?`).get(doc.accountId, teamId) as
      | { id: number }
      | undefined;
    if (!acc) throw new StockError('收款账户不存在');
  }
  if (paid > 0) {
    db.prepare(
      `INSERT INTO settlement (teamId, type, partnerType, partnerId, accountId, amount, date, remark, refDocId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  // 往来余额冲减（普通单据收付款减少往来；退货退款/回款反向）
  bumpPartnerBalance(db, teamId, doc.partnerType, doc.partnerId, balanceSign * (paid + dep));
  // 资金账户变动：收款加、付款减
  if (doc.accountId && paid > 0) {
    const inc = moneyType === 'receipt' ? paid : -paid;
    db.prepare(`UPDATE account SET balance = balance + ? WHERE id=? AND teamId=?`).run(inc, doc.accountId, teamId);
  }
}

/** 作废时反冲 settleOnAudit 的三处影响：
 *  1. 删除审核时自动生成的「开单即收付」结算记录（refDocId 指向本单）；
 *  2. 往来余额按 paid + deposit 反向加回；
 *  3. 资金账户按 paid 反向扣回。
 *  注：若用户事后手工删除/修改过该自动结算记录，则删除影响 0 行，但余额冲回仍按原额执行。 */
function reverseSettleOnVoid(
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
  const paid = Math.max(0, Number(doc.paidAmount ?? 0));
  const dep = Math.max(0, Number(doc.deposit ?? 0));
  if (paid + dep <= 0) return;
  if (!doc.partnerType || !doc.partnerId) return;
  const moneyType = MONEY_FLOW[doc.type] ?? 'payment';
  const balanceSign = RET_TYPES.has(doc.type) ? 1 : -1;
  db.prepare(`DELETE FROM settlement WHERE teamId=? AND refDocId=? AND remark='开单即收付'`).run(
    teamId,
    doc.id,
  );
  // 反向加回审核时的往来冲减
  bumpPartnerBalance(db, teamId, doc.partnerType, doc.partnerId, -balanceSign * (paid + dep));
  if (doc.accountId && paid > 0) {
    const inc = moneyType === 'receipt' ? -paid : paid;
    db.prepare(`UPDATE account SET balance = balance + ? WHERE id=? AND teamId=?`).run(inc, doc.accountId, teamId);
  }
}

/** 往来余额增减（不存在则插入） */
function bumpPartnerBalance(
  db: DatabaseSync,
  teamId: number,
  partnerType: string,
  partnerId: number,
  delta: number,
): void {
  const cur = db
    .prepare(`SELECT balance FROM partner_balance WHERE teamId=? AND partnerType=? AND partnerId=?`)
    .get(teamId, partnerType, partnerId) as { balance: number } | undefined;
  if (cur) {
    db.prepare(
      `UPDATE partner_balance SET balance = balance + ? WHERE teamId=? AND partnerType=? AND partnerId=?`,
    ).run(delta, teamId, partnerType, partnerId);
  } else {
    db.prepare(
      `INSERT INTO partner_balance (teamId, partnerType, partnerId, balance) VALUES (?, ?, ?, ?)`,
    ).run(teamId, partnerType, partnerId, delta);
  }
}

/** move 的独立函数形态（deduct/transfer 共用） */
function moveStock(
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
  // 实际记账方向：作废冲回时取反
  const dirEff: 'in' | 'out' = reverse ? (direction === 'in' ? 'out' : 'in') : direction;
  // 实时库存增量：入库 +qty、出库 -qty；冲回再取反
  const delta = roundQty((dirEff === 'in' ? 1 : -1) * qty);
  db.prepare(
    `INSERT INTO stock_ledger (teamId, productId, warehouseId, reservoirId, batchNo, direction, qty, unitCost, refDocId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(doc.teamId, productId, warehouseId, reservoirId, batchNo ?? null, dirEff, qty, unitCost, docId);
  // 更新实时库存
  const existing = db
    .prepare(
      `SELECT id, qty FROM stock WHERE teamId=? AND productId=? AND warehouseId=? AND (reservoirId IS ?) AND (batchNo IS ?)`,
    )
    .get(doc.teamId, productId, warehouseId, reservoirId, batchNo) as
    | { id: number; qty: number }
    | undefined;
  if (existing) {
    if (dirEff === 'out') {
      // 原子扣减：WHERE qty >= 扣减量，并发审核时第二个事务直接 0 行命中 → 拒绝过账，杜绝负库存
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