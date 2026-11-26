/**
 * 单据 Excel/CSV 智能导入（v0.2.1）。
 *
 * 设计：
 * - POST /doc/import，body 为原始文件字节（application/octet-stream），
 *   query：dryRun=1 仅预览；autoCreate=1 未识别的商品/往来单位自动建档。
 * - 自动识别三层：
 *   1) 文件格式：xlsx 魔数 / CSV 文本（含 GBK 回落）
 *   2) 列名：同义词词典匹配（商品/数量/单价/金额/日期/单号/客户/供应商/仓库/备注/业务员…）
 *   3) 单据类型：显式「类型」列优先，否则按 客户列→销售出库、供应商列→采购入库 推断
 * - 行分组：有「单号」列按单号分组（多行一单）；否则按 日期+往来单位 分组。
 * - 安全：导入只生成草稿（status=draft），审核过账仍走正常流程；
 *   dryRun 零副作用；带单号的重复导入按 srcBillNo 幂等跳过。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Request, Response, Router } from 'express';
import express from 'express';
import { readSpreadsheet, excelSerialToDate } from './xlsxlite';
import { localDate, validBizDate, createWindowLimiter } from './db';
import { nextBillNo, loadBillNoConfig } from './bill-no';
import { FIELD_LIMITS, PRICE_CENTS_MAX, QTY_MAX } from './crud';
import { recordAuditTxFromRequest } from './infra/audit-log';
import { AppError, BusyError, sendError, ValidationError } from './infra/errors';
import { logger } from './infra/logger';
import { withImmediateTx } from './infra/tx';
import { parsePositiveInt } from './infra/validate';
import { lineAmount, MAX_TOTAL_AMOUNT_CENTS, roundQty, sumQty } from './shared/money';
import type { SheetData } from './xlsxlite';

/** 与 docs.ts 的上限保持一致（与 crud.ts 共用同一份常量） */
const MAX_QTY = QTY_MAX;
const MAX_PRICE_CENTS = PRICE_CENTS_MAX;
/** 单次导入行数上限（与商品导入一致的量级，防止误传大文件拖垮服务） */
const MAX_ROWS = 2000;

interface RowError {
  row: number;
  msg: string;
}
interface BillItemOut {
  row: number;
  productName: string;
  productId: number | null;
  qty: number;
  price: number;
  amount: number | null;
  warning?: string;
}
interface BillOut {
  type: string;
  date: string;
  srcBillNo: string | null;
  partnerName: string;
  partnerId: number | null;
  warehouseName: string;
  warehouseId: number | null;
  items: BillItemOut[];
  warnings: string[];
}
interface CreatedDoc {
  id: number;
  billNo: string;
  type: string;
  srcBillNo: string | null;
  itemCount: number;
}
interface SkippedBill {
  srcBillNo: string;
  type: string | null;
  reason: string;
}

/** 列同义词词典：key = 识别字段；数组 = 可匹配表头（匹配前归一化：去空白、全角→半角括号） */
const FIELD_SYNONYMS: Record<string, { exact: string[]; contains?: string[] }> = {
  type: { exact: ['单据类型', '类型', '业务类型', '单类型', '单别'] },
  billNo: {
    exact: ['单号', '单据编号', '单据号', '编号', '订单号', '销售单号', '采购单号', '原始单号', '来源单号', '外部单号'],
  },
  date: {
    exact: ['日期', '单据日期', '开单日期', '业务日期', '出货日期', '发货日期', '入库日期', '出库日期', '时间'],
    contains: ['日期'],
  },
  productName: {
    exact: ['商品名称', '商品', '品名', '货品名称', '货品', '产品名称', '产品', '物料名称', '物料', '商品名', '名称'],
    contains: ['商品', '品名', '货品', '产品', '物料'],
  },
  barcode: { exact: ['条码', '条形码', '商品编码', '编码'] },
  spec: { exact: ['规格', '型号', '规格型号'] },
  unit: { exact: ['单位', '商品单位', '计量单位'] },
  qty: {
    exact: ['数量', '销售数量', '采购数量', '入库数量', '出库数量', '件数', 'qty', 'quantity'],
    contains: ['数量'],
  },
  price: {
    exact: ['单价', '价格', '销售单价', '采购单价', '入库单价', '出库单价', 'price', '单价(元)', '单价（元）'],
    contains: ['单价'],
  },
  amount: { exact: ['金额', '小计', '行金额', '总金额', '合计', '价税合计', 'amount'], contains: ['金额', '合计'] },
  customer: { exact: ['客户', '客户名称', '购货单位', '购货方', '买方', '买家', '收货单位', 'customer'] },
  vendor: { exact: ['供应商', '供应商名称', '供货单位', '供货方', '卖方', '卖家', '发货单位', 'vendor'] },
  warehouse: { exact: ['仓库', '仓库名称', '入库仓库', '出库仓库'], contains: ['仓库'] },
  remark: { exact: ['备注', '说明', '摘要', 'remark'] },
  clerk: { exact: ['业务员', '经手人', '销售员', '采购员', '制单人'] },
};

/** 归一化表头：去所有空白字符、统一括号，便于宽松匹配 */
function normHeader(s: string): string {
  return s.replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')').trim();
}

/** 表头 → 字段映射：先精确匹配（长同义词优先），再包含匹配 */
function mapHeaders(header: string[]): { fieldOf: Array<string | null>; headerMap: Record<string, string> } {
  const fieldOf: Array<string | null> = new Array(header.length).fill(null);
  const headerMap: Record<string, string> = {};
  // 字段按同义词最长优先排序，避免「客户名称」被「名称」抢走
  const fields = Object.entries(FIELD_SYNONYMS).sort(
    (a, b) => Math.max(...b[1].exact.map((x) => x.length)) - Math.max(...a[1].exact.map((x) => x.length)),
  );
  for (let c = 0; c < header.length; c++) {
    const h = normHeader(header[c] ?? '');
    if (!h) continue;
    let hit: string | null = null;
    for (const [field, syn] of fields) {
      if (syn.exact.includes(h)) {
        hit = field;
        break;
      }
    }
    if (!hit) {
      for (const [field, syn] of fields) {
        if (syn.contains && syn.contains.some((s) => h.includes(s))) {
          hit = field;
          break;
        }
      }
    }
    if (hit) {
      // 同一字段出现多列：第一列生效，后面列忽略（避免重复计数）
      if (!fieldOf.includes(hit)) {
        fieldOf[c] = hit;
        headerMap[header[c].trim()] = hit;
      }
    }
  }
  return { fieldOf, headerMap };
}

/** 类型识别关键词 → 单据类型。匹配时按关键词长度降序：
 *  「销售退货单」必须先命中「销售退货」(4字)而不是「退货单」(3字)，
 *  否则会被识别成采购退货（pin），库存方向与往来配对整单识别反 */
const TYPE_KEYWORDS: Array<[string, string]> = [
  ['采购入库', 'stockin'],
  ['入库单', 'stockin'],
  ['采购进货', 'stockin'],
  ['销售出库', 'stockout'],
  ['出库单', 'stockout'],
  ['销售单', 'stockout'],
  ['采购退货', 'pin'],
  ['退货单', 'pin'],
  ['销售退货', 'sret'],
  ['采购订单', 'porder'],
  ['销售订单', 'sorder'],
];
TYPE_KEYWORDS.sort((a, b) => b[0].length - a[0].length);
function detectTypeByText(text: string): string | null {
  const t = text.replace(/\s+/g, '');
  for (const [kw, type] of TYPE_KEYWORDS) {
    if (t.includes(kw)) return type;
  }
  if (t.includes('入库')) return 'stockin';
  if (t.includes('出库')) return 'stockout';
  return null;
}

/** 数量解析：去千分位/单位残留，容错「1,234.5」「3件」；归一到 4 位小数与 docs.ts roundQty 同口径。
 *  B-安16①：剥字符前先拒绝含 e/E 的串——`1e5` 若先剥掉 `e` 会变成 `15`，数量错 6000 多倍。 */
function parseQty(raw: string): number | null {
  const s0 = String(raw ?? '');
  if (/[eE]/.test(s0)) return null;
  const s = s0.replace(/[,\s，]/g, '').replace(/[^0-9.-]/g, '');
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

/** 金额解析：去货币符号/千分位 → 分（整数） */
function parseCents(raw: string): number | null {
  const s = String(raw ?? '').replace(/[¥￥$，,\s元]/g, '');
  if (s === '') return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(parseFloat(s) * 100);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/** 日期解析：常见文本格式 + Excel 序列数 */
function parseDate(raw: string): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  // 纯数字：Excel 日期序列（1900 体系）。序列分支同样要过 validBizDate：
  // excelSerialToDate 只挡 1900-03 前与 2173 后，1901~1999 与 2101+ 的序列
  // 会换成越界年份直接落库，绕过其它分支都在执行的年份区间校验
  if (/^\d+(\.\d+)?$/.test(s)) {
    const out = excelSerialToDate(parseFloat(s));
    return out !== null && !validBizDate(out) ? out : null;
  }
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (m) {
    const out = `${m[1]}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
    // 真实日历校验：格式对但日子不存在（如 2026-02-30）在导入阶段就要拦，
    // 否则脏日期落库后污染账龄/报表且无法用普通查询筛出
    return validBizDate(out) ? null : out;
  }
  // ISO 时间戳（xlsx 偶见）
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ]/);
  if (m) {
    const out = `${m[1]}-${m[2]}-${m[3]}`;
    return validBizDate(out) ? null : out;
  }
  return null;
}

interface ParsedRow {
  rowNo: number;
  type: string | null;
  srcBillNo: string | null;
  date: string | null;
  productName: string;
  barcode: string;
  qty: number | null;
  price: number | null;
  amount: number | null;
  partnerCus: string;
  partnerVen: string;
  warehouseName: string;
  remark: string;
  clerkName: string;
  unit: string;
}

export function mountDocImport(router: Router, db: DatabaseSync): void {
  /** B-安4③：单据导入按团队限速（每分钟 100 次），12MB 解析是高成本操作。阈值调参（2026-11-21，总协调人）：
   *  全量回归一分钟内合法导入约 20 余次，10 次/分钟误伤既有测试（doc-import/round1/round2）；100 次留有余量，
   *  仍可拦住失控循环。 */
  const docImportLimit = createWindowLimiter(100, 60_000);
  // 原始字节体（xlsx/CSV）：json 解析器会跳过非 JSON Content-Type，这里用 raw 接住
  router.post('/doc/import', express.raw({ type: () => true, limit: '12mb' }), (req: Request, res: Response) => {
    const teamRes = parsePositiveInt(req.query.teamId, 'teamId');
    const dryRun = String(req.query.dryRun ?? '') === '1';
    const autoCreate = String(req.query.autoCreate ?? '') === '1';
    const body = req.body as unknown;
    if (!teamRes.ok) {
      return sendError(
        req,
        res,
        400,
        req.query.teamId === undefined || req.query.teamId === '' || req.query.teamId === '0'
          ? 'teamId 不能为空'
          : teamRes.error,
        'VALIDATION_ERROR',
      );
    }
    const teamId = teamRes.value;
    if (autoCreate && req.auth?.role !== 'admin') {
      return sendError(req, res, 403, '仅管理员可使用自动建档导入', 'FORBIDDEN');
    }
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return sendError(req, res, 400, '请上传文件内容（xlsx 或 CSV）', 'VALIDATION_ERROR');
    }
    if (!docImportLimit(`team:${teamId}`)) {
      return sendError(req, res, 429, '导入过于频繁，请稍后再试', 'RATE_LIMITED');
    }

    // ---------- 1) 解析文件 ----------
    let kind: 'xlsx' | 'csv';
    let sheets: SheetData[];
    try {
      // B-安9：只解析第一表（docimport 只用 sheets[0]），数据行超 2000 时解析层提前停
      const parsed = readSpreadsheet(body, { maxRows: MAX_ROWS, firstSheetOnly: true });
      kind = parsed.kind;
      sheets = parsed.sheets;
    } catch (e) {
      // 行数超限是解析层提前抛出的可预期错误，返回与解析后检查同一口径的友好文案
      if (e instanceof Error && e.message.startsWith('行数超出上限')) {
        return sendError(req, res, 400, `单次最多导入 ${MAX_ROWS} 行`, 'VALIDATION_ERROR');
      }
      // A-安4：解析失败不回吐原始文案（可能含解析器内部细节），只返回通用文案，详情写服务端日志
      logger.warn('Document import spreadsheet parse failed', { err: e });
      return sendError(req, res, 400, '文件解析失败，请检查文件格式后重试', 'VALIDATION_ERROR');
    }
    const sheet = sheets[0]; // 默认第一个工作表
    const rows = sheet.rows;
    if (rows.length < 2) {
      return sendError(req, res, 400, '表格没有数据行（至少需要表头 + 1 行数据）', 'VALIDATION_ERROR');
    }
    const dataRows = rows.slice(1).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
    if (dataRows.length === 0) {
      return sendError(req, res, 400, '表格没有数据行（只有表头）', 'VALIDATION_ERROR');
    }
    if (dataRows.length > MAX_ROWS) {
      return sendError(req, res, 400, `单次最多导入 ${MAX_ROWS} 行，当前 ${dataRows.length} 行`, 'VALIDATION_ERROR');
    }

    // ---------- 2) 列识别 ----------
    const { fieldOf, headerMap } = mapHeaders(rows[0].map((c) => String(c ?? '')));
    const needQty = fieldOf.includes('qty');
    const needProduct = fieldOf.includes('productName');
    if (!needProduct || !needQty) {
      return sendError(
        req,
        res,
        400,
        `未识别到必需列：${!needProduct ? '「商品」' : ''}${!needQty ? '「数量」' : ''}。请确认表头命名（支持：商品/品名/货品、数量、单价、日期、客户/供应商等）`,
        'VALIDATION_ERROR',
        { headerMap },
      );
    }

    const col = (field: string): number => fieldOf.indexOf(field);

    // ---------- 3) 逐行解析 ----------
    const rowErrors: RowError[] = [];
    const parsed: ParsedRow[] = [];
    rows.slice(1).forEach((r, idx) => {
      const cells = r.map((c) => String(c ?? '').trim());
      if (!cells.some(Boolean)) return; // 空行跳过
      const rowNo = idx + 2; // 表头是第 1 行，数据从第 2 行计（空行也占行号）
      const get = (field: string): string => {
        const ci = col(field);
        return ci >= 0 ? (cells[ci] ?? '') : '';
      };
      const pr: ParsedRow = {
        rowNo,
        type: get('type') ? detectTypeByText(get('type')) : null,
        srcBillNo: get('billNo') || null,
        date: null,
        productName: get('productName'),
        barcode: get('barcode'),
        qty: null,
        price: null,
        amount: null,
        partnerCus: get('customer'),
        partnerVen: get('vendor'),
        warehouseName: get('warehouse'),
        remark: get('remark'),
        clerkName: get('clerk'),
        unit: get('unit'),
      };
      // 必填与长度校验（错误行跳过，不中断整体）
      const fail2 = (msg: string): void => {
        rowErrors.push({ row: rowNo, msg });
      };
      if (!pr.productName) {
        fail2('商品名称为空');
        return;
      }
      if (pr.productName.length > FIELD_LIMITS.name) {
        fail2(`商品名称不能超过 ${FIELD_LIMITS.name} 个字符`);
        return;
      }
      if (pr.barcode.length > FIELD_LIMITS.barcode) {
        fail2(`条码不能超过 ${FIELD_LIMITS.barcode} 个字符`);
        return;
      }
      if (pr.unit.length > FIELD_LIMITS.unit) {
        fail2(`单位不能超过 ${FIELD_LIMITS.unit} 个字符`);
        return;
      }
      if (pr.partnerCus.length > FIELD_LIMITS.name || pr.partnerVen.length > FIELD_LIMITS.name) {
        fail2(`往来单位名称不能超过 ${FIELD_LIMITS.name} 个字符`);
        return;
      }
      if (pr.remark.length > FIELD_LIMITS.remark) {
        fail2(`备注不能超过 ${FIELD_LIMITS.remark} 个字符`);
        return;
      }
      const qty = parseQty(get('qty'));
      if (qty == null || qty === 0) {
        fail2(`数量无效：「${get('qty') || '空'}」`);
        return;
      }
      if (Math.abs(qty) > MAX_QTY) {
        fail2(`数量超出上限 ${MAX_QTY}`);
        return;
      }
      if (qty < 0) {
        fail2('导入不支持负数数量（请使用库存调整单）');
        return;
      }
      pr.qty = qty;
      const priceRaw = get('price');
      const priceCents = priceRaw === '' ? 0 : parseCents(priceRaw);
      if (priceCents == null) {
        fail2(`单价无效：「${priceRaw}」`);
        return;
      }
      if (priceCents > MAX_PRICE_CENTS) {
        fail2(`单价超出上限 ${MAX_PRICE_CENTS / 100} 元`);
        return;
      }
      pr.price = priceCents;
      const amountRaw = get('amount');
      pr.amount = amountRaw === '' ? null : parseCents(amountRaw);
      const dateRaw = get('date');
      if (dateRaw !== '') {
        const d = parseDate(dateRaw);
        if (!d) {
          fail2(`日期无效：「${dateRaw}」`);
          return;
        }
        pr.date = d;
      }
      // 类型：显式列 > 往来单位推断
      if (!pr.type) {
        if (pr.partnerCus && pr.partnerVen) {
          fail2('同时出现客户与供应商列，无法判断单据方向（请增加「类型」列）');
          return;
        }
        if (pr.partnerCus) pr.type = 'stockout';
        else if (pr.partnerVen) pr.type = 'stockin';
      }
      parsed.push(pr);
    });

    // ---------- 4) 分组聚合 ----------
    // 有单号列 → 按单号分组；否则按 类型+日期+往来单位 分组（同日同人合并一单）
    const hasBillNoCol = col('billNo') >= 0;
    const groups = new Map<string, ParsedRow[]>();
    const order: string[] = [];
    for (const pr of parsed) {
      if (!pr.type) {
        rowErrors.push({ row: pr.rowNo, msg: '无法识别单据类型（无类型列，且无客户/供应商列）' });
        continue;
      }
      const key =
        hasBillNoCol && pr.srcBillNo
          ? JSON.stringify([pr.type, pr.srcBillNo])
          : JSON.stringify([pr.type, pr.date ?? '', pr.partnerCus || pr.partnerVen]);
      if (!groups.has(key)) {
        groups.set(key, []);
        order.push(key);
      }
      groups.get(key)!.push(pr);
    }

    // ---------- 5) 档案匹配与原子落库 ----------
    // B-安10①：预编译可复用 SQL 语句（非 dryRun 时全部在 withImmediateTx 写锁内执行，保证与建档完全原子）
    const getCusStmt = db.prepare(`SELECT id FROM customer WHERE teamId = ? AND name = ?`);
    const getVenStmt = db.prepare(`SELECT id FROM vendor WHERE teamId = ? AND name = ?`);
    const getPartner = (ptype: 'cus' | 'ven', name: string) =>
      (ptype === 'cus' ? getCusStmt : getVenStmt).get(teamId, name) as { id: number } | undefined;
    const existsDocStmt = db.prepare(`SELECT id FROM doc WHERE teamId = ? AND type = ? AND srcBillNo = ? LIMIT 1`);
    const insCusStmt = db.prepare(`INSERT INTO customer (teamId, name, remark) VALUES (?, ?, 'Excel导入自动建档')`);
    const insVenStmt = db.prepare(`INSERT INTO vendor (teamId, name, remark) VALUES (?, ?, 'Excel导入自动建档')`);
    const insProdStmt = db.prepare(
      `INSERT INTO product (teamId, name, barcode, unit, salePrice, purchasePrice, remark)
         VALUES (?, ?, ?, ?, ?, ?, 'Excel导入自动建档')`,
    );
    const insDoc = db.prepare(
      `INSERT INTO doc (teamId, billNo, type, date, partnerType, partnerId, clerkId, warehouseId, status, remark, totalAmount, totalQty, userId, srcBillNo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, NULL, ?)`,
    );
    const insItem = db.prepare(
      `INSERT INTO doc_item (docId, productId, qty, price, amount, remark) VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const bills: BillOut[] = [];
    const skipped: SkippedBill[] = [];
    const created: CreatedDoc[] = [];

    const runImportPass = (persist: boolean): void => {
      const prods = db.prepare(`SELECT id, name, barcode FROM product WHERE teamId = ?`).all(teamId) as Array<{
        id: number;
        name: string;
        barcode: string | null;
      }>;
      const prodByName = new Map(prods.map((p) => [p.name, p]));
      const prodByBarcode = new Map(prods.filter((p) => p.barcode).map((p) => [p.barcode as string, p]));
      const warehouses = db
        .prepare(`SELECT id, name FROM warehouse WHERE teamId = ? ORDER BY id`)
        .all(teamId) as Array<{ id: number; name: string }>;
      const clerks = db.prepare(`SELECT id, name FROM clerk WHERE teamId = ?`).all(teamId) as Array<{
        id: number;
        name: string;
      }>;
      // B-安10②：单号配置（prefix/noMode）在导入开始时一次读出，按单据复用
      const billNoCfg = persist ? loadBillNoConfig(db, teamId) : null;
      const createdCusIds = new Set<number>();
      const createdVenIds = new Set<number>();
      const seenSrcBills = new Set<string>();

      for (const key of order) {
        const rowsIn = groups.get(key)!;
        const first = rowsIn[0];
        const warnings: string[] = [];
        const srcLabel = first.srcBillNo ?? `${first.type}@${first.date ?? ''}`;

        // 类型对应的往来单位
        const isCus = first.type === 'stockout' || first.type === 'sret' || first.type === 'sorder';
        const partnerName = isCus ? first.partnerCus : first.partnerVen;
        if (isCus && first.partnerVen && !first.partnerCus)
          warnings.push('数据带供应商列但单据为销售方向，已忽略供应商');
        if (!isCus && first.partnerCus && !first.partnerVen) warnings.push('数据带客户列但单据为采购方向，已忽略客户');

        // 幂等：同 srcBillNo + type 已存在 → 跳过整组（在写锁内检查，防并发重复导入）
        if (first.srcBillNo) {
          const srcKey = `${first.type}\0${first.srcBillNo}`;
          if (seenSrcBills.has(srcKey) || existsDocStmt.get(teamId, first.type, first.srcBillNo)) {
            skipped.push({ srcBillNo: srcLabel, type: first.type, reason: '该外部单号已导入过' });
            continue;
          }
        }

        // 仓库：列值匹配 > 第一个仓库（跳过单不触发自动建档）
        let warehouseId: number;
        let warehouseName: string;
        if (first.warehouseName) {
          const hit = warehouses.find((w) => w.name === first.warehouseName);
          if (!hit) {
            skipped.push({
              srcBillNo: srcLabel,
              type: first.type,
              reason: `仓库「${first.warehouseName}」不存在`,
            });
            continue;
          }
          warehouseId = hit.id;
          warehouseName = hit.name;
        } else if (warehouses.length) {
          warehouseId = warehouses[0].id;
          warehouseName = warehouses[0].name;
          warnings.push(`未指定仓库，默认使用「${warehouseName}」`);
        } else {
          skipped.push({
            srcBillNo: srcLabel,
            type: first.type,
            reason: '团队没有仓库档案',
          });
          continue;
        }

        // 往来单位预校验（先确认本单不会因往来单位/商品缺失而被跳过，再执行写库建档）
        if (!partnerName) {
          skipped.push({
            srcBillNo: srcLabel,
            type: first.type,
            reason: isCus ? '缺少客户' : '缺少供应商',
          });
          continue;
        }
        const partnerHit = getPartner(isCus ? 'cus' : 'ven', partnerName);
        if (!partnerHit && !autoCreate) {
          skipped.push({
            srcBillNo: srcLabel,
            type: first.type,
            reason: `往来单位「${partnerName}」不存在（可勾选自动建档）`,
          });
          continue;
        }

        // 商品与单据总金额预校验（先收集缺失商品报错；有缺失则整单跳过，不建任何自动档案）
        let bad = false;
        for (const pr of rowsIn) {
          let prod = prodByName.get(pr.productName);
          if (!prod && pr.barcode) prod = prodByBarcode.get(pr.barcode);
          if (!prod && !autoCreate) {
            rowErrors.push({ row: pr.rowNo, msg: `商品「${pr.productName}」不存在（可勾选自动建档）` });
            bad = true;
          }
        }
        if (bad || !rowsIn.length) continue;

        const billTotalAmount = rowsIn.reduce((s, pr) => s + lineAmount(pr.qty!, pr.price ?? 0), 0);
        if (!Number.isFinite(billTotalAmount) || Math.abs(billTotalAmount) > MAX_TOTAL_AMOUNT_CENTS) {
          throw new ValidationError('单据总金额超出上限（10 亿元），请核对后重试');
        }

        // 往来单位落库（事务内）
        let partnerId: number | null = partnerHit ? partnerHit.id : null;
        if (!partnerHit) {
          if (autoCreate && persist) {
            if (isCus) {
              partnerId = Number(insCusStmt.run(teamId, partnerName).lastInsertRowid);
              createdCusIds.add(partnerId);
            } else {
              partnerId = Number(insVenStmt.run(teamId, partnerName).lastInsertRowid);
              createdVenIds.add(partnerId);
            }
            warnings.push(`往来单位「${partnerName}」不存在，已自动建档`);
          } else if (autoCreate && !persist) {
            warnings.push(`往来单位「${partnerName}」不存在，导入时将自动建档`);
          }
        }

        // 明细行解析与商品自动建档（事务内）
        const items: BillItemOut[] = [];
        for (const pr of rowsIn) {
          let prod = prodByName.get(pr.productName);
          if (!prod && pr.barcode) prod = prodByBarcode.get(pr.barcode);
          let productId: number | null = prod ? prod.id : null;
          let itemWarning: string | undefined;
          if (!prod) {
            if (autoCreate && persist) {
              productId = Number(
                insProdStmt.run(
                  teamId,
                  pr.productName,
                  pr.barcode || null,
                  pr.unit || '件',
                  isCus ? (pr.price ?? 0) : 0,
                  isCus ? 0 : (pr.price ?? 0),
                ).lastInsertRowid,
              );
              const createdProd = {
                id: productId,
                name: pr.productName,
                barcode: pr.barcode || null,
              };
              prodByName.set(pr.productName, createdProd);
              if (pr.barcode) {
                prodByBarcode.set(pr.barcode, createdProd);
              }
              itemWarning = `商品「${pr.productName}」不存在，已自动建档`;
            } else if (autoCreate && !persist) {
              itemWarning = `商品「${pr.productName}」不存在，导入时将自动建档`;
            }
          }
          if (pr.amount != null && pr.price != null) {
            const lineAmt = lineAmount(roundQty(pr.qty!), pr.price);
            if (Math.abs(lineAmt - pr.amount) > 2) {
              itemWarning =
                (itemWarning ? itemWarning + '；' : '') +
                `金额 ${pr.amount / 100} 与 数量×单价 ${lineAmt / 100} 不一致，已按数量×单价入账`;
            }
          }
          items.push({
            row: pr.rowNo,
            productName: pr.productName,
            productId,
            qty: pr.qty!,
            price: pr.price ?? 0,
            amount: pr.amount,
            warning: itemWarning,
          });
        }

        // 业务员：名称匹配不到仅提示
        let clerkId: number | null = null;
        if (first.clerkName) {
          const hit = clerks.find((c) => c.name === first.clerkName);
          if (hit) clerkId = hit.id;
          else warnings.push(`业务员「${first.clerkName}」不存在，已忽略`);
        }

        const billDate = first.date ?? localDate();
        const billOut: BillOut & { clerkId?: number | null; remarks?: string } = {
          type: first.type!,
          date: billDate,
          srcBillNo: first.srcBillNo,
          partnerName,
          partnerId,
          warehouseName,
          warehouseId,
          items,
          warnings: [...warnings, ...(hasBillNoCol ? [] : ['无单号列，按 日期+往来单位 聚合'])],
          clerkId,
          remarks: first.remark,
        };
        bills.push(billOut);

        if (persist) {
          const totalQty = sumQty(items.map((i) => i.qty));
          const totalAmount = items.reduce((s, i) => s + lineAmount(i.qty, i.price), 0);
          const billNo = nextBillNo(db, teamId, billOut.type, billNoCfg!);
          const remarkParts = ['Excel导入'];
          if (first.remark) remarkParts.push(first.remark);
          const info = insDoc.run(
            teamId,
            billNo,
            billOut.type,
            billDate,
            isCus ? 'cus' : 'ven',
            partnerId,
            clerkId,
            warehouseId,
            remarkParts.join('：'),
            totalAmount,
            totalQty,
            billOut.srcBillNo,
          );
          const docId = Number(info.lastInsertRowid);
          for (const it of items) {
            insItem.run(docId, it.productId, it.qty, it.price, lineAmount(it.qty, it.price), null);
          }
          if (billOut.srcBillNo) seenSrcBills.add(`${billOut.type}\0${billOut.srcBillNo}`);
          created.push({
            id: docId,
            billNo,
            type: billOut.type,
            srcBillNo: billOut.srcBillNo,
            itemCount: items.length,
          });
        }
      }

      if (persist && created.length > 0) {
        recordAuditTxFromRequest(db, req, {
          teamId,
          action: 'doc.import',
          entityType: 'doc',
          detail: {
            imported: created.length,
            skipped: skipped.length,
            rowErrors: rowErrors.length,
            autoCreatedCustomers: createdCusIds.size,
            autoCreatedVendors: createdVenIds.size,
          },
        });
      }
    };

    if (dryRun) {
      try {
        runImportPass(false);
      } catch (e) {
        if (e instanceof AppError) return sendError(req, res, e.statusCode, e.message, e.code);
        logger.error('Document import dryRun failed', { teamId, err: e });
        return sendError(req, res, 500, '导入预览失败，请稍后重试', 'INTERNAL_ERROR');
      }
    } else {
      try {
        withImmediateTx(
          db,
          () => {
            runImportPass(true);
          },
          { checkpoint: true },
        );
      } catch (e) {
        if (e instanceof BusyError) {
          logger.warn('Document import BEGIN IMMEDIATE failed (busy)', { teamId, err: e });
          return sendError(req, res, 503, '数据库繁忙，请稍后重试', 'SERVICE_UNAVAILABLE');
        }
        if (e instanceof AppError) return sendError(req, res, e.statusCode, e.message, e.code);
        logger.error('Document import persistence failed', { teamId, err: e });
        return sendError(req, res, 500, '导入失败，请稍后重试', 'INTERNAL_ERROR');
      }
    }

    // 响应里去掉内部字段
    const billsOut = bills.map((b) => {
      const { clerkId: _c, remarks: _r, ...rest } = b as BillOut & { clerkId?: number | null; remarks?: string };
      return rest;
    });
    return res.json({
      ok: true,
      file: { kind, sheet: sheet.name, sheets: sheets.map((s) => s.name), rows: dataRows.length },
      headerMap,
      bills: billsOut,
      rowErrors,
      skipped,
      created,
      summary: {
        totalRows: dataRows.length,
        billCount: billsOut.length,
        itemCount: billsOut.reduce((s, b) => s + b.items.length, 0),
        errorCount: rowErrors.length,
        skipCount: skipped.length,
        imported: created.length,
      },
    });
  });
}
