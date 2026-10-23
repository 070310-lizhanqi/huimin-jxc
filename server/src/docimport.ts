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
import { localDate, validBizDate } from './db';
import { loadNoMode, loadPrefix } from './settings';
import type { SheetData } from './xlsxlite';

/** 与 docs.ts 的上限保持一致 */
const MAX_QTY = 9_999_999;
const MAX_PRICE_CENTS = 9_999_999;
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
  return s
    .replace(/\s+/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .trim();
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
      if (syn.exact.includes(h)) { hit = field; break; }
    }
    if (!hit) {
      for (const [field, syn] of fields) {
        if (syn.contains && syn.contains.some((s) => h.includes(s))) { hit = field; break; }
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

/** 类型识别关键词 → 单据类型（长词优先避免「采购入库」被「入库」抢先） */
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
function detectTypeByText(text: string): string | null {
  const t = text.replace(/\s+/g, '');
  for (const [kw, type] of TYPE_KEYWORDS) {
    if (t.includes(kw)) return type;
  }
  if (t.includes('入库')) return 'stockin';
  if (t.includes('出库')) return 'stockout';
  return null;
}

/** 数量解析：去千分位/单位残留，容错「1,234.5」「3件」 */
function parseQty(raw: string): number | null {
  const s = String(raw ?? '').replace(/[,\s，]/g, '').replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return n;
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
  // 纯数字：Excel 日期序列（1900 体系）
  if (/^\d+(\.\d+)?$/.test(s)) {
    return excelSerialToDate(parseFloat(s));
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
  // 原始字节体（xlsx/CSV）：json 解析器会跳过非 JSON Content-Type，这里用 raw 接住
  router.post(
    '/doc/import',
    express.raw({ type: () => true, limit: '12mb' }),
    (req: Request, res: Response) => {
      const teamId = Number(req.query.teamId);
      const dryRun = String(req.query.dryRun ?? '') === '1';
      const autoCreate = String(req.query.autoCreate ?? '') === '1';
      const body = req.body as unknown;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return res.status(400).json({ error: '请上传文件内容（xlsx 或 CSV）' });
      }

      // ---------- 1) 解析文件 ----------
      let kind: 'xlsx' | 'csv';
      let sheets: SheetData[];
      try {
        const parsed = readSpreadsheet(body);
        kind = parsed.kind;
        sheets = parsed.sheets;
      } catch (e) {
        return res.status(400).json({ error: (e as Error).message });
      }
      const sheet = sheets[0]; // 默认第一个工作表
      const rows = sheet.rows;
      if (rows.length < 2) {
        return res.status(400).json({ error: '表格没有数据行（至少需要表头 + 1 行数据）' });
      }
      const dataRows = rows.slice(1).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
      if (dataRows.length === 0) {
        return res.status(400).json({ error: '表格没有数据行（只有表头）' });
      }
      if (dataRows.length > MAX_ROWS) {
        return res.status(400).json({ error: `单次最多导入 ${MAX_ROWS} 行，当前 ${dataRows.length} 行` });
      }

      // ---------- 2) 列识别 ----------
      const { fieldOf, headerMap } = mapHeaders(rows[0].map((c) => String(c ?? '')));
      const needQty = fieldOf.includes('qty');
      const needProduct = fieldOf.includes('productName');
      if (!needProduct || !needQty) {
        return res.status(400).json({
          error: `未识别到必需列：${!needProduct ? '「商品」' : ''}${!needQty ? '「数量」' : ''}。请确认表头命名（支持：商品/品名/货品、数量、单价、日期、客户/供应商等）`,
          headerMap,
        });
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
        // 必填校验（错误行跳过，不中断整体）
        const fail2 = (msg: string): void => { rowErrors.push({ row: rowNo, msg }); };
        if (!pr.productName) { fail2('商品名称为空'); return; }
        const qty = parseQty(get('qty'));
        if (qty == null || qty === 0) { fail2(`数量无效：「${get('qty') || '空'}」`); return; }
        if (Math.abs(qty) > MAX_QTY) { fail2(`数量超出上限 ${MAX_QTY}`); return; }
        if (qty < 0) { fail2('导入不支持负数数量（请使用库存调整单）'); return; }
        pr.qty = qty;
        const priceRaw = get('price');
        const priceCents = priceRaw === '' ? 0 : parseCents(priceRaw);
        if (priceCents == null) { fail2(`单价无效：「${priceRaw}」`); return; }
        if (priceCents > MAX_PRICE_CENTS) { fail2(`单价超出上限 ${MAX_PRICE_CENTS / 100} 元`); return; }
        pr.price = priceCents;
        const amountRaw = get('amount');
        pr.amount = amountRaw === '' ? null : parseCents(amountRaw);
        const dateRaw = get('date');
        if (dateRaw !== '') {
          const d = parseDate(dateRaw);
          if (!d) { fail2(`日期无效：「${dateRaw}」`); return; }
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
        const key = hasBillNoCol && pr.srcBillNo
          ? `${pr.type}|${pr.srcBillNo}`
          : `${pr.type}|${pr.date ?? ''}|${pr.partnerCus || pr.partnerVen}`;
        if (!groups.has(key)) { groups.set(key, []); order.push(key); }
        groups.get(key)!.push(pr);
      }

      // ---------- 5) 档案匹配 ----------
      const prods = db.prepare(`SELECT id, name, barcode FROM product WHERE teamId = ?`).all(teamId) as Array<
        { id: number; name: string; barcode: string | null }
      >;
      const prodByName = new Map(prods.map((p) => [p.name, p]));
      const prodByBarcode = new Map(prods.filter((p) => p.barcode).map((p) => [p.barcode as string, p]));
      const getPartner = (ptype: 'cus' | 'ven', name: string) =>
        db
          .prepare(`SELECT id FROM ${ptype === 'cus' ? 'customer' : 'vendor'} WHERE teamId = ? AND name = ?`)
          .get(teamId, name) as { id: number } | undefined;
      const warehouses = db.prepare(`SELECT id, name FROM warehouse WHERE teamId = ? ORDER BY id`).all(teamId) as Array<
        { id: number; name: string }
      >;
      const clerks = db.prepare(`SELECT id, name FROM clerk WHERE teamId = ?`).all(teamId) as Array<{ id: number; name: string }>;

      const bills: BillOut[] = [];
      const skipped: SkippedBill[] = [];
      const created: CreatedDoc[] = [];
      // 自动建档的孤儿追踪：落库失败 ROLLBACK 后，事务外已插入的 customer/vendor/product 需要一并清理
      const pendingPartnerCreates: Array<{ table: string; id: number | null }> = [];
      const pendingProductCreates: number[] = [];

      for (const key of order) {
        const rowsIn = groups.get(key)!;
        const first = rowsIn[0];
        const warnings: string[] = [];
        const srcLabel = first.srcBillNo ?? `${first.type}@${first.date ?? ''}`;

        // 类型对应的往来单位
        const isCus = first.type === 'stockout' || first.type === 'sret' || first.type === 'sorder';
        const partnerName = isCus ? first.partnerCus : first.partnerVen;
        if (isCus && first.partnerVen && !first.partnerCus) warnings.push('数据带供应商列但单据为销售方向，已忽略供应商');
        if (!isCus && first.partnerCus && !first.partnerVen) warnings.push('数据带客户列但单据为采购方向，已忽略客户');

        // 幂等：同 srcBillNo + type 已存在 → 跳过整组
        if (first.srcBillNo) {
          const exists = db
            .prepare(`SELECT id FROM doc WHERE teamId = ? AND type = ? AND srcBillNo = ? LIMIT 1`)
            .get(teamId, first.type, first.srcBillNo);
          if (exists) {
            skipped.push({ srcBillNo: srcLabel, type: first.type, reason: '该外部单号已导入过' });
            continue;
          }
        }

        // 往来单位匹配
        let partnerId: number | null = null;
        if (partnerName) {
          const hit = getPartner(isCus ? 'cus' : 'ven', partnerName);
          if (hit) partnerId = hit.id;
          else if (autoCreate && !dryRun) {
            if (isCus) {
              partnerId = Number(
                db
                  .prepare(`INSERT INTO customer (teamId, name, remark) VALUES (?, ?, 'Excel导入自动建档')`)
                  .run(teamId, partnerName).lastInsertRowid,
              );
            } else {
              partnerId = Number(
                db
                  .prepare(`INSERT INTO vendor (teamId, name, remark) VALUES (?, ?, 'Excel导入自动建档')`)
                  .run(teamId, partnerName).lastInsertRowid,
              );
            }
            warnings.push(`往来单位「${partnerName}」不存在，已自动建档`);
          } else if (autoCreate && dryRun) {
            warnings.push(`往来单位「${partnerName}」不存在，导入时将自动建档`);
          } else {
            skipped.push({
              srcBillNo: srcLabel,
              type: first.type,
              reason: `往来单位「${partnerName}」不存在（可勾选自动建档）`,
            });
            continue;
          }
        } else {
          skipped.push({
            srcBillNo: srcLabel,
            type: first.type,
            reason: isCus ? '缺少客户' : '缺少供应商',
          });
          continue;
        }
        // 供应商/客户建档若发生在落库事务之前、后续落库失败，会残留孤儿档案——
        // 收集本单自动建档的 id，落库失败 ROLLBACK 后一并清理。
        pendingPartnerCreates.push({ table: isCus ? 'customer' : 'vendor', id: partnerId });

        // 仓库：列值匹配 > 第一个仓库
        let warehouseId: number | null = null;
        let warehouseName = '';
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

        // 明细行
        const items: BillItemOut[] = [];
        let bad = false;
        for (const pr of rowsIn) {
          let prod = prodByName.get(pr.productName);
          if (!prod && pr.barcode) prod = prodByBarcode.get(pr.barcode);
          let productId: number | null = prod ? prod.id : null;
          let itemWarning: string | undefined;
          if (!prod) {
            if (autoCreate && !dryRun) {
              productId = Number(
                db
                  .prepare(
                    `INSERT INTO product (teamId, name, barcode, unit, salePrice, purchasePrice, remark)
                     VALUES (?, ?, ?, ?, ?, ?, 'Excel导入自动建档')`,
                  )
                  .run(
                    teamId,
                    pr.productName,
                    pr.barcode || null,
                    pr.unit || '件',
                    isCus ? pr.price ?? 0 : 0,
                    isCus ? 0 : pr.price ?? 0,
                  ).lastInsertRowid,
              );
              prodByName.set(pr.productName, {
                id: productId,
                name: pr.productName,
                barcode: pr.barcode || null,
              });
              // 商品建档同样可能成孤儿，收集之（失败时清理）
              pendingProductCreates.push(productId);
              itemWarning = `商品「${pr.productName}」不存在，已自动建档`;
            } else if (autoCreate && dryRun) {
              itemWarning = `商品「${pr.productName}」不存在，导入时将自动建档`;
            } else {
              rowErrors.push({ row: pr.rowNo, msg: `商品「${pr.productName}」不存在（可勾选自动建档）` });
              bad = true;
              continue;
            }
          }
          // 金额交叉核对：|qty×price − amount| > 2 分则提示（不影响导入）。
          // 用整数运算：qty 是 4 位小数浮点，直接 qty*price 在大额分时浮点误差会超 2 分阈值误报。
          // 与 docs.ts 的 lineAmount 口径一致：qty 先转"万分"整数再乘。
          if (pr.amount != null && pr.price != null) {
            const qtyScaled = Math.round(Math.round((pr.qty! + Number.EPSILON) * 10000) );
            const lineAmt = Math.round((qtyScaled * pr.price) / 10000);
            if (Math.abs(lineAmt - pr.amount) > 2) {
              itemWarning = (itemWarning ? itemWarning + '；' : '') +
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
        if (bad || !items.length) continue;

        // 业务员：名称匹配不到仅提示
        let clerkId: number | null = null;
        if (first.clerkName) {
          const hit = clerks.find((c) => c.name === first.clerkName);
          if (hit) clerkId = hit.id;
          else warnings.push(`业务员「${first.clerkName}」不存在，已忽略`);
        }

        bills.push({
          type: first.type!,
          date: first.date ?? localDate(),
          srcBillNo: first.srcBillNo,
          partnerName,
          partnerId,
          warehouseName,
          warehouseId,
          items,
          warnings: [...warnings, ...(hasBillNoCol ? [] : ['无单号列，按 日期+往来单位 聚合'])],
        });
        // 供创建阶段使用（bills 数组元素在 dryRun 下也复用）
        (bills[bills.length - 1] as BillOut & { clerkId?: number | null }).clerkId = clerkId;
        (bills[bills.length - 1] as BillOut & { remarks?: string }).remarks = first.remark;
      }

      // ---------- 6) 落库（非 dryRun） ----------
      if (!dryRun) {
        const insDoc = db.prepare(
          `INSERT INTO doc (teamId, billNo, type, date, partnerType, partnerId, clerkId, warehouseId, status, remark, totalAmount, totalQty, userId, srcBillNo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, NULL, ?)`,
        );
        const insItem = db.prepare(
          `INSERT INTO doc_item (docId, productId, qty, price, amount, remark) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        // BEGIN 放 try 外：BEGIN 失败时 ROLLBACK 二次抛错会掩盖原始错误
        // BEGIN IMMEDIATE：批量导入立刻取写锁，避免与其它写事务交叉时 SQLITE_BUSY
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const b of bills) {
            const ext = b as BillOut & { clerkId?: number | null; remarks?: string };
            const totalQty = Math.round(b.items.reduce((s, i) => s + i.qty, 0) * 10000) / 10000;
            const totalAmount = b.items.reduce((s, i) => s + Math.round(i.qty * i.price), 0);
            const billNo = nextBillNoForImport(db, teamId, b.type);
            const remarkParts = ['Excel导入'];
            if (ext.remarks) remarkParts.push(ext.remarks);
            const info = insDoc.run(
              teamId,
              billNo,
              b.type,
              b.date,
              b.type === 'stockout' || b.type === 'sret' || b.type === 'sorder' ? 'cus' : 'ven',
              b.partnerId,
              ext.clerkId ?? null,
              b.warehouseId,
              remarkParts.join('：'),
              totalAmount,
              totalQty,
              b.srcBillNo,
            );
            const docId = Number(info.lastInsertRowid);
            for (const it of b.items) {
              insItem.run(docId, it.productId, it.qty, it.price, Math.round(it.qty * it.price), null);
            }
            created.push({ id: docId, billNo, type: b.type, srcBillNo: b.srcBillNo, itemCount: b.items.length });
          }
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          // 落库失败：事务外的自动建档已成孤儿，按「无单据引用」清理（doc 未生成，id 安全）
          for (const p of pendingPartnerCreates) {
            if (p.id == null) continue;
            try {
              db.prepare(`DELETE FROM ${p.table} WHERE id = ? AND remark = 'Excel导入自动建档'`).run(p.id);
            } catch { /* 清理失败不掩盖原始错误 */ }
          }
          for (const pid of pendingProductCreates) {
            try {
              db.prepare(`DELETE FROM product WHERE id = ? AND remark = 'Excel导入自动建档'`).run(pid);
            } catch { /* 同上 */ }
          }
          return res.status(500).json({ error: `导入失败：${(e as Error).message}` });
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
    },
  );
}

/** 生成系统单号（与 docs.ts nextBillNo 同规则；此处独立实现避免循环依赖） */
function nextBillNoForImport(db: DatabaseSync, teamId: number, type: string): string {
  const PREFIX: Record<string, string> = {
    stockin: 'RK', stockout: 'CK', transfer: 'DB', adjust: 'TZ', stocktake: 'PD',
    porder: 'CG', sorder: 'XS', pin: 'CT', sret: 'XT', otherin: 'QR', otherout: 'QC',
    assembly: 'ZZ', stockinit: 'QCQ', quo: 'BJ', outapply: 'SQ', prodtask: 'SC',
  };
  // 与 docs.ts nextBillNo 一致：优先读 team 级单号配置（前缀 + 重置方式）
  const custom = loadPrefix(db, teamId);
  const prefix = custom[type] ?? PREFIX[type] ?? 'NO';
  const mode = loadNoMode(db, teamId);
  const full = localDate().replace(/-/g, '');
  const datePart = mode === 'none' ? '' : mode === 'month' ? full.slice(0, 6) : full;
  const key = `${teamId}:${prefix}:${datePart}`;
  // 单语句 upsert + RETURNING：与 docs.ts nextBillNo 一致，
  // 避免两个并发 import 在「upsert + SELECT」两语句之间拿到错乱 seq。
  const row = db.prepare(
    `INSERT INTO bill_seq (k, seq) VALUES (?, 1)
     ON CONFLICT(k) DO UPDATE SET seq = seq + 1
     RETURNING seq`,
  ).get(key) as { seq: number };
  return `${prefix}${datePart}${String(row.seq).padStart(4, '0')}`;
}
