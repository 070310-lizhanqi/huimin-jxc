/**
 * 服务入口：Express + node:sqlite
 * 端口 7741，REST 风格 /api/<资源>
 */
import express from 'express';
import { openDb, migrate } from './db';
import { mountCrud } from './crud';
import { mountDocs } from './docs';
import { mountStockQueries } from './stock';
import { mountSettlements } from './settlement';
import { mountReports } from './report';
import { mountAging } from './aging';
import { mountDashboard } from './dashboard';
import { mountJxcReports } from './jxc-report';
import { mountPriceMemory } from './price';
import { mountSettings } from './settings';
import { mountAuth, requireAuth } from './auth';
import type { Router } from 'express';

const PORT = Number(process.env.PORT ?? 7741);
const db = openDb();
migrate(db);

const app = express();
app.use(express.json({ limit: '2mb' }));

// CORS：仅允许同源与本地开发端口（不再放开 *）
const ALLOW_ORIGINS = new Set([
  'http://127.0.0.1:7741', 'http://localhost:7741',
  'http://127.0.0.1:19387', 'http://localhost:19387',
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOW_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

const api: Router = express.Router();

// 认证路由（注册/登录/状态查询为公开；其余在 mountAuth 内部自带 requireAuth）
mountAuth(api, db);

// 自此之后注册的全部业务路由都要求登录。
// requireAuth 会把 req.query/req.body 里的 teamId 覆盖为令牌中的团队，
// 因此下游路由无需改造即实现团队数据隔离，客户端无法越权读写其他团队。
api.use(requireAuth);

// 基础档案 CRUD（含删除引用保护）
const exists = (sql: string, ...args: Array<string | number>): boolean =>
  Boolean((db.prepare(sql).get(...args) as { c: number } | undefined)?.c);
mountCrud(api, db, {
  table: 'cat',
  fields: ['parentId', 'name'],
  deleteGuard: (d, id) =>
    exists(`SELECT COUNT(*) AS c FROM cat WHERE parentId = ?`, id)
      ? '分类下还有子分类，不能删除'
      : exists(`SELECT COUNT(*) AS c FROM product WHERE catId = ?`, id)
        ? '分类下还有商品，不能删除'
        : null,
});
mountCrud(api, db, {
  table: 'product',
  fields: ['catId', 'name', 'barcode', 'unit', 'spec', 'salePrice', 'retailPrice', 'purchasePrice', 'wholePrice', 'lowQty', 'remark', 'archived'],
  deleteGuard: (_d, id) =>
    exists(`SELECT COUNT(*) AS c FROM doc_item WHERE productId = ?`, id)
      ? '商品已被单据引用，不能删除'
      : exists(`SELECT COUNT(*) AS c FROM stock WHERE productId = ? AND qty != 0`, id)
        ? '商品还有库存，不能删除'
        : null,
});
mountCrud(api, db, {
  table: 'warehouse',
  fields: ['name', 'remark'],
  deleteGuard: (_d, id) =>
    exists(`SELECT COUNT(*) AS c FROM reservoir WHERE warehouseId = ?`, id)
      ? '仓库下还有库位，不能删除'
      : exists(`SELECT COUNT(*) AS c FROM stock WHERE warehouseId = ? AND qty != 0`, id)
        ? '仓库还有库存，不能删除'
        : null,
});
mountCrud(api, db, {
  table: 'reservoir',
  fields: ['warehouseId', 'name'],
  deleteGuard: (_d, id) =>
    exists(`SELECT COUNT(*) AS c FROM stock WHERE reservoirId = ? AND qty != 0`, id)
      ? '库位还有库存，不能删除'
      : null,
});
const partnerGuard = (ptype: 'cus' | 'ven', label: string) => (_d: unknown, id: number): string | null =>
  exists(
    `SELECT COUNT(*) AS c FROM doc WHERE partnerType = ? AND partnerId = ? AND status != 'void'`,
    ptype,
    id,
  )
    ? `${label}已被单据引用，不能删除`
    : exists(`SELECT COUNT(*) AS c FROM settlement WHERE partnerType = ? AND partnerId = ?`, ptype, id)
      ? `${label}已有收付款记录，不能删除`
      : null;
mountCrud(api, db, { table: 'customer', fields: ['name', 'mobile', 'address', 'remark', 'priceLevel'], deleteGuard: partnerGuard('cus', '客户') });
mountCrud(api, db, { table: 'vendor', fields: ['name', 'mobile', 'address', 'remark'], deleteGuard: partnerGuard('ven', '供应商') });
mountCrud(api, db, {
  table: 'clerk',
  fields: ['name', 'mobile'],
  deleteGuard: (_d, id) =>
    exists(`SELECT COUNT(*) AS c FROM doc WHERE clerkId = ?`, id) ? '业务员已被单据引用，不能删除' : null,
});
mountCrud(api, db, {
  table: 'account',
  fields: ['name', 'type', 'balance'],
  deleteGuard: (_d, id) =>
    exists(`SELECT COUNT(*) AS c FROM settlement WHERE accountId = ?`, id) ? '账户已被收付款引用，不能删除' : null,
});
// 商品单位档案
mountCrud(api, db, {
  table: 'unit',
  fields: ['name', 'remark'],
  deleteGuard: (d, id) => {
    const row = d.prepare(`SELECT name, teamId FROM unit WHERE id = ?`).get(id) as
      { name: string; teamId: number } | undefined;
    if (!row) return null;
    return exists(`SELECT COUNT(*) AS c FROM product WHERE teamId = ? AND unit = ?`, row.teamId, row.name)
      ? '该单位已被商品使用，不能删除' : null;
  },
});

// 单据与库存
mountDocs(api, db);
mountStockQueries(api, db);
mountSettlements(api, db);
mountReports(api, db);
mountAging(api, db);
mountDashboard(api, db);
mountJxcReports(api, db);
mountPriceMemory(api, db);
mountSettings(api, db);

// 商品批量导入：部分成功模式（错误行跳过并返回行号错误清单）
api.post('/product/import', (req, res) => {
  const teamId = Number(req.body.teamId);
  if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
  const rows = req.body.rows as Array<Record<string, unknown>>;
  if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: '导入数据不能为空' });
  if (rows.length > 1000) return res.status(400).json({ error: '单次最多导入 1000 行' });
  // 价格解析：去 ¥/￥/逗号/空白，×100 取整为分；空值视为 0；非法返回 null
  const parsePrice = (v: unknown): number | null => {
    const s = String(v ?? '').replace(/[¥￥,\s]/g, '');
    if (s === '') return 0;
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    const n = Math.round(parseFloat(s) * 100);
    if (!Number.isFinite(n) || n < 0 || n > 9_999_999) return null;
    return n;
  };
  const errors: Array<{ row: number; msg: string }> = [];
  let success = 0;
  const getCat = db.prepare(`SELECT id FROM cat WHERE teamId = ? AND name = ?`);
  const insCat = db.prepare(`INSERT INTO cat (teamId, name) VALUES (?, ?)`);
  const getProd = db.prepare(`SELECT id FROM product WHERE teamId = ? AND name = ?`);
  const ins = db.prepare(
    `INSERT INTO product (teamId, catId, name, barcode, unit, spec, salePrice, retailPrice, purchasePrice, wholePrice, lowQty, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  try {
    for (const [idx, r] of rows.entries()) {
      const rowNo = idx + 1;
      const name = String(r.name ?? '').trim();
      if (!name) {
        errors.push({ row: rowNo, msg: '名称不能为空' });
        continue;
      }
      if (getProd.get(teamId, name)) {
        errors.push({ row: rowNo, msg: `商品「${name}」已存在` });
        continue;
      }
      // 分类名：不存在则自动创建
      let catId: number | null = null;
      const catName = String(r.catName ?? '').trim();
      if (catName) {
        const hit = getCat.get(teamId, catName) as { id: number } | undefined;
        catId = hit ? hit.id : Number(insCat.run(teamId, catName).lastInsertRowid);
      }
      const prices: number[] = [];
      let bad = '';
      for (const k of ['purchasePrice', 'salePrice', 'retailPrice', 'wholePrice'] as const) {
        const p = parsePrice(r[k]);
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
        if (!Number.isFinite(n) || n < 0) {
          errors.push({ row: rowNo, msg: '安全库存格式不正确' });
          continue;
        }
        lowQty = n;
      }
      ins.run(
        teamId,
        catId,
        name,
        String(r.barcode ?? '').trim() || null,
        String(r.unit ?? '').trim() || '件',
        String(r.spec ?? '').trim() || null,
        prices[1],
        prices[2],
        prices[0],
        prices[3],
        lowQty,
        String(r.remark ?? '').trim() || null,
      );
      success++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: `导入失败：${(e as Error).message}` });
  }
  return res.json({ success, errors, total: rows.length });
});

// 当前登录用户所属团队（团队隔离：不再返回全库团队列表）
api.get('/team/list', (req, res) => {
  const u = req.auth;
  if (!u) return res.status(401).json({ error: '未登录' });
  const team = db.prepare(`SELECT id, name, startPeriod FROM team WHERE id = ?`).get(u.teamId);
  return res.json(team ? [team] : []);
});

app.use('/api', api);

// 静态前端（web 目录）
import path from 'node:path';
app.use(express.static(path.join(__dirname, '..', '..', 'web')));
// 非页面路径兜底回 index.html（hash 路由其实不需要，仅保险）
app.get(/^\/(?!api).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'web', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`orange-clone server listening on http://127.0.0.1:${PORT}`);
});