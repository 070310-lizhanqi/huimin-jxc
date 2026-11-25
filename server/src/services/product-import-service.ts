/**
 * 商品批量导入业务逻辑（从 index.ts 抽离）
 * - 支持部分成功模式：单行字段/重名/价格/数量错误记入 errors 继续下一行
 * - 使用 withImmediateTx 立即写锁 + tryCheckpoint 保证事务原子性与 WAL 落盘
 */
import type { DatabaseSync } from 'node:sqlite';
import { FIELD_LIMITS } from '../crud';
import { withImmediateTx } from '../infra/tx';
import { PRICE_CENTS_MAX, QTY_MAX, roundQty } from '../shared/money';

export interface ProductImportResult {
  success: number;
  errors: Array<{ row: number; msg: string }>;
  total: number;
}

function parsePriceCents(v: unknown): number | null {
  const s = String(v ?? '').replace(/[¥￥,\s]/g, '');
  if (s === '') return 0;
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(parseFloat(s) * 100);
  if (!Number.isFinite(n) || n < 0 || n > PRICE_CENTS_MAX) return null;
  return n;
}

function checkImportStrLen(raw: unknown, field: string, label: string): { value: string | null } | { error: string } {
  const s = String(raw ?? '').trim();
  if (!s) return { value: null };
  const limit = FIELD_LIMITS[field];
  if (limit !== undefined && s.length > limit) {
    return { error: `${label}长度不能超过 ${limit} 个字符` };
  }
  return { value: s };
}

export function importProducts(
  db: DatabaseSync,
  teamId: number,
  rows: Array<Record<string, unknown>>,
): ProductImportResult {
  const errors: Array<{ row: number; msg: string }> = [];
  let success = 0;

  const prodNames = new Set<string>(
    (db.prepare(`SELECT name FROM product WHERE teamId = ?`).all(teamId) as Array<{ name: string }>).map((p) => p.name),
  );
  const catByName = new Map<string, number>(
    (db.prepare(`SELECT id, name FROM cat WHERE teamId = ?`).all(teamId) as Array<{ id: number; name: string }>).map(
      (c) => [c.name, c.id] as [string, number],
    ),
  );
  const getCat = db.prepare(`SELECT id FROM cat WHERE teamId = ? AND name = ?`);
  const insCat = db.prepare(`INSERT INTO cat (teamId, name) VALUES (?, ?)`);
  const ins = db.prepare(
    `INSERT INTO product (teamId, catId, name, barcode, unit, spec, salePrice, retailPrice, purchasePrice, wholePrice, lowQty, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  withImmediateTx(
    db,
    () => {
      for (const [idx, r] of rows.entries()) {
        const rowNo = idx + 1;
        const name = String(r.name ?? '').trim();
        if (!name) {
          errors.push({ row: rowNo, msg: '名称不能为空' });
          continue;
        }
        if (name.length > FIELD_LIMITS.name) {
          errors.push({ row: rowNo, msg: `名称长度不能超过 ${FIELD_LIMITS.name} 个字符` });
          continue;
        }
        if (prodNames.has(name)) {
          errors.push({ row: rowNo, msg: `商品「${name}」已存在` });
          continue;
        }

        const barcodeRes = checkImportStrLen(r.barcode, 'barcode', '条码');
        if ('error' in barcodeRes) {
          errors.push({ row: rowNo, msg: barcodeRes.error });
          continue;
        }
        const unitRes = checkImportStrLen(r.unit, 'unit', '单位');
        if ('error' in unitRes) {
          errors.push({ row: rowNo, msg: unitRes.error });
          continue;
        }
        const specRes = checkImportStrLen(r.spec, 'spec', '规格');
        if ('error' in specRes) {
          errors.push({ row: rowNo, msg: specRes.error });
          continue;
        }
        const remarkRes = checkImportStrLen(r.remark, 'remark', '备注');
        if ('error' in remarkRes) {
          errors.push({ row: rowNo, msg: remarkRes.error });
          continue;
        }

        let catId: number | null = null;
        const catName = String(r.catName ?? '').trim();
        if (catName) {
          if (catName.length > FIELD_LIMITS.name) {
            errors.push({ row: rowNo, msg: `分类名称长度不能超过 ${FIELD_LIMITS.name} 个字符` });
            continue;
          }
          const cached = catByName.get(catName);
          if (cached !== undefined) {
            catId = cached;
          } else {
            const hit = getCat.get(teamId, catName) as { id: number } | undefined;
            if (hit) {
              catId = hit.id;
            } else {
              catId = Number(insCat.run(teamId, catName).lastInsertRowid);
            }
            catByName.set(catName, catId);
          }
        }

        const prices: number[] = [];
        let bad = '';
        for (const k of ['purchasePrice', 'salePrice', 'retailPrice', 'wholePrice'] as const) {
          const p = parsePriceCents(r[k]);
          if (p === null) {
            bad = '价格格式不正确';
            break;
          }
          prices.push(p);
        }
        if (bad) {
          errors.push({ row: rowNo, msg: bad });
          continue;
        }

        let lowQty = 0;
        const lowRaw = String(r.lowQty ?? '').trim();
        if (lowRaw !== '') {
          const n = Number(lowRaw);
          if (!Number.isFinite(n) || n < 0 || n > QTY_MAX) {
            errors.push({ row: rowNo, msg: '安全库存格式不正确' });
            continue;
          }
          lowQty = roundQty(n);
        }

        try {
          ins.run(
            teamId,
            catId,
            name,
            barcodeRes.value,
            unitRes.value || '件',
            specRes.value,
            prices[1],
            prices[2],
            prices[0],
            prices[3],
            lowQty,
            remarkRes.value,
          );
        } catch (e) {
          if (String((e as Error)?.message ?? '').includes('UNIQUE constraint failed')) {
            prodNames.add(name);
            errors.push({ row: rowNo, msg: `商品「${name}」已存在` });
            continue;
          }
          throw e;
        }
        prodNames.add(name);
        success++;
      }
    },
    { checkpoint: true },
  );

  return { success, errors, total: rows.length };
}
