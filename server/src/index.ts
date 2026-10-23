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
import { mountDocImport } from './docimport';
import { mountBackup } from './backup';
import { dataDir } from './db';
import type { Router } from 'express';

// 令牌签名密钥安全校验：单机自用可用内置密钥；公网/隧道暴露必须显式设置密钥。
// 开启 ORANGE_REQUIRE_SECRET=1 且未设置 ORANGE_JWT_SECRET 时直接拒绝启动，防止误暴露。
if (!process.env.ORANGE_JWT_SECRET) {
  if (process.env.ORANGE_REQUIRE_SECRET === '1') {
    console.error('[启动失败] 已设置 ORANGE_REQUIRE_SECRET=1 但未设置 ORANGE_JWT_SECRET。');
    console.error('请先设置密钥再启动，PowerShell 示例：$env:ORANGE_JWT_SECRET="<32 位以上随机字符串>"');
    process.exit(1);
  }
  console.warn('[安全提示] 未设置 ORANGE_JWT_SECRET，将使用内置本地密钥（仅限本机自用；请勿将服务直接暴露到公网）。');
}

const PORT = Number(process.env.PORT ?? 7741);
const db = openDb();
migrate(db);

const app = express();
app.set('x-powered-by', false);
app.use(express.json({ limit: '2mb' }));

// CORS：仅允许同源与本地开发端口（白名单按实际端口动态生成，改 PORT 部署不失效）
const ALLOW_ORIGINS = new Set(
  [PORT, 19387].flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]),
);
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

// 基线安全响应头。说明：前端是无构建的 Vue 3 global build（模板运行时编译依赖 new Function），
// 严格 CSP 需放开 unsafe-eval 反而削弱其意义，故不引入 CSP；仅设置无副作用的基线安全头。
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// 零依赖 gzip 压缩：vendor 库（echarts ≈1MB）与 JSON API 响应体积约缩至 1/3，
// 显著加快首屏与列表加载。阈值以下不压（压缩开销不划算）。
import zlib from 'node:zlib';
const GZIP_MIN = 1024;
// 上限保护：单次响应缓冲超过 32MB 时直接放弃压缩，转发原始响应——
// 避免报表导出/备份下载这类大响应被整体缓冲进内存推高 RSS。
const GZIP_MAX_BUFFER = 32 * 1024 * 1024;
const COMPRESSIBLE = /^(text\/|application\/json|application\/javascript|application\/xml|image\/svg)/;
// 下载/导出路由显式跳过压缩：备份文件已是 SQLite 二进制，压缩无收益且放大内存
const GZIP_SKIP_PATH = /^\/api\/backup\/download/;
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  const accept = String(req.headers['accept-encoding'] ?? '');
  if (!/\bgzip\b/.test(accept) || req.headers['content-encoding']) {
    next();
    return;
  }
  // 下载路由跳过：直接走原始流式响应
  if (GZIP_SKIP_PATH.test(req.path)) {
    next();
    return;
  }
  // 包装 write/end：缓冲完整体再统一 gzip（静态文件与 JSON 均为一次性写出，内存可控）
  const chunks: Buffer[] = [];
  let size = 0;
  let usingGzip = false;
  let overflow = false; // 缓冲超上限后放弃压缩，直接转发原始字节
  const origWrite = res.write.bind(res) as (c: unknown) => boolean;
  const origEnd = res.end.bind(res) as (...a: unknown[]) => express.Response;
  const origSetHeader = res.setHeader.bind(res);
  res.setHeader = (name: string, value: unknown) => {
    // 内容长度按压缩后重算；压缩决定下发前先扣下原值
    if (usingGzip && /^content-length$/i.test(name)) return res;
    return origSetHeader(name, value as never);
  };
  res.write = (chunk: unknown): boolean => {
    if (chunk) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      // 超上限：放弃压缩，立即把已缓冲内容原样写出，转入直通模式
      if (!overflow && size + b.length > GZIP_MAX_BUFFER) {
        overflow = true;
        for (const c of chunks) origWrite(c);
        chunks.length = 0;
        origWrite(b);
        return true;
      }
      if (overflow) {
        origWrite(b);
        return true;
      }
      chunks.push(b);
      size += b.length;
    }
    return true;
  };
  res.end = (...a: unknown[]): express.Response => {
    const tail = a[0];
    if (tail) {
      const b = Buffer.isBuffer(tail) ? tail : Buffer.from(String(tail));
      if (overflow) {
        origWrite(b);
        return origEnd();
      }
      if (size + b.length > GZIP_MAX_BUFFER) {
        // 最后一个 chunk 把它顶超上限：原样转发全部
        for (const c of chunks) origWrite(c);
        chunks.length = 0;
        origWrite(b);
        return origEnd();
      }
      chunks.push(b);
      size += b.length;
    }
    if (overflow) return origEnd();
    const type = String(res.getHeader('content-type') ?? '').split(';')[0];
    // 决策：类型可压 + 体积达标 + 未手动指定 Content-Encoding
    if (size >= GZIP_MIN && COMPRESSIBLE.test(type) && !res.getHeader('content-encoding')) {
      usingGzip = true;
      const body = zlib.gzipSync(Buffer.concat(chunks), { level: 6 });
      chunks.length = 0;
      origSetHeader('content-encoding', 'gzip');
      origSetHeader('content-length', String(body.length));
      origSetHeader('vary', 'Accept-Encoding');
      origWrite(body);
      return origEnd();
    }
    for (const c of chunks) origWrite(c);
    return origEnd();
  };
  next();
});

// Host 头白名单：本机应用被隧道/反代暴露时，防 DNS rebinding（攻击者用自己域名解析到 127.0.0.1
// 借用户浏览器读本地 API）。白名单外的 Host 直接拒绝；隧道域名通过 ORANGE_ALLOW_HOSTS 追加。
const ALLOW_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
for (const h of String(process.env.ORANGE_ALLOW_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
  ALLOW_HOSTS.add(h);
}
const hostAllowed = (hostHeader: string): boolean => {
  const h = hostHeader.replace(/:\d+$/, '').toLowerCase();
  if (ALLOW_HOSTS.has(h)) return true;
  // 本机任意回环地址（如 127.0.0.5）也算可信
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
};
app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
  const host = String(req.headers.host ?? '');
  if (host && !hostAllowed(host)) {
    res.status(421).json({ error: '请求 Host 不在允许列表内（本机应用默认仅允许 127.0.0.1/localhost）' });
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
  deleteGuard: (d, id, teamId) => {
    // 子分类/商品引用检查限定本团队：跨团队 id 不构成删除障碍
    if (exists(`SELECT COUNT(*) AS c FROM cat WHERE parentId = ? AND teamId = ?`, id, teamId)) return '分类下还有子分类，不能删除';
    if (exists(`SELECT COUNT(*) AS c FROM product WHERE catId = ? AND teamId = ?`, id, teamId)) return '分类下还有商品，不能删除';
    return null;
  },
  // 新建/改分类时校验父分类归属本团队（防把分类挂到别的团队的分类树下），
  // 并沿 parentId 向上查环：把祖先挂到自己的子孙下会形成环，导致前端分类树无限递归。
  validate: (body) => {
    const parentId = Number(body.parentId);
    if (parentId) {
      const teamId = Number(body.teamId);
      const p = db.prepare(`SELECT id FROM cat WHERE id = ? AND teamId = ?`).get(parentId, teamId) as
        | { id: number }
        | undefined;
      if (!p) return '父分类不存在';
      const editId = Number(body.id);
      if (editId) {
        // 自引用与间接环检测：从父级沿链上溯，遇到自己即成环
        let cur = parentId;
        for (let hop = 0; hop < 100; hop++) {
          if (cur === editId) return '父分类不能是自己或自己的子分类';
          const row = db.prepare(`SELECT parentId FROM cat WHERE id = ? AND teamId = ?`).get(cur, teamId) as
            | { parentId: number | null }
            | undefined;
          if (!row || !row.parentId) break;
          cur = row.parentId;
        }
      }
    }
    return null;
  },
});
mountCrud(api, db, {
  table: 'product',
  fields: ['catId', 'name', 'barcode', 'unit', 'spec', 'salePrice', 'retailPrice', 'purchasePrice', 'wholePrice', 'lowQty', 'remark', 'archived'],
  // 关键词同时搜条码/规格：扫码枪录入与按规格找货都不用先选列
  kwFields: ['barcode', 'spec'],
  deleteGuard: (d, id, teamId) => {
    if (exists(`SELECT COUNT(*) AS c FROM doc_item i JOIN doc x ON x.id = i.docId WHERE i.productId = ? AND x.teamId = ?`, id, teamId)) return '商品已被单据引用，不能删除';
    if (exists(`SELECT COUNT(*) AS c FROM stock WHERE productId = ? AND teamId = ? AND qty != 0`, id, teamId)) return '商品还有库存，不能删除';
    return null;
  },
});
mountCrud(api, db, {
  table: 'warehouse',
  fields: ['name', 'remark'],
  deleteGuard: (d, id, teamId) => {
    if (exists(`SELECT COUNT(*) AS c FROM reservoir WHERE warehouseId = ? AND teamId = ?`, id, teamId)) return '仓库下还有库位，不能删除';
    if (exists(`SELECT COUNT(*) AS c FROM stock WHERE warehouseId = ? AND teamId = ? AND qty != 0`, id, teamId)) return '仓库还有库存，不能删除';
    // 单据引用（含调拨目标仓）：被引用的仓库删除会让历史单据仓库名悬空
    if (exists(`SELECT COUNT(*) AS c FROM doc WHERE teamId = ? AND status != 'void' AND (warehouseId = ? OR warehouseId IS NULL) AND EXISTS (SELECT 1 FROM doc_item WHERE docId = doc.id AND toWarehouseId = ?)`, teamId, id, id)) return '仓库已被调拨单引用，不能删除';
    if (exists(`SELECT COUNT(*) AS c FROM doc WHERE teamId = ? AND warehouseId = ? AND status != 'void'`, teamId, id)) return '仓库已被单据引用，不能删除';
    return null;
  },
});
mountCrud(api, db, {
  table: 'reservoir',
  fields: ['warehouseId', 'name'],
  deleteGuard: (d, id, teamId) => {
    if (exists(`SELECT COUNT(*) AS c FROM stock WHERE reservoirId = ? AND teamId = ? AND qty != 0`, id, teamId)) return '库位还有库存，不能删除';
    return null;
  },
});
const partnerGuard = (ptype: 'cus' | 'ven', label: string) => (_d: unknown, id: number, teamId: number): string | null => {
  if (exists(
    `SELECT COUNT(*) AS c FROM doc WHERE partnerType = ? AND partnerId = ? AND teamId = ? AND status != 'void'`,
    ptype,
    id,
    teamId,
  )) return `${label}已被单据引用，不能删除`;
  if (exists(
    `SELECT COUNT(*) AS c FROM settlement WHERE partnerType = ? AND partnerId = ? AND teamId = ?`,
    ptype,
    id,
    teamId,
  )) return `${label}已有收付款记录，不能删除`;
  return null;
};
mountCrud(api, db, { table: 'customer', fields: ['name', 'mobile', 'address', 'remark', 'priceLevel'], deleteGuard: partnerGuard('cus', '客户') });
mountCrud(api, db, { table: 'vendor', fields: ['name', 'mobile', 'address', 'remark'], deleteGuard: partnerGuard('ven', '供应商') });
mountCrud(api, db, {
  table: 'clerk',
  fields: ['name', 'mobile'],
  deleteGuard: (d, id, teamId) =>
    exists(`SELECT COUNT(*) AS c FROM doc WHERE clerkId = ? AND teamId = ?`, id, teamId) ? '业务员已被单据引用，不能删除' : null,
});
mountCrud(api, db, {
  table: 'account',
  fields: ['name', 'type', 'balance'],
  // 期初余额仅创建时可设；余额只能由收付款/单据结算变动，防止任意登录用户直接篡改资金
  createOnlyFields: ['balance'],
  deleteGuard: (d, id, teamId) =>
    exists(`SELECT COUNT(*) AS c FROM settlement WHERE accountId = ? AND teamId = ?`, id, teamId) ? '账户已被收付款引用，不能删除' : null,
});
// 商品单位档案
mountCrud(api, db, {
  table: 'unit',
  fields: ['name', 'remark'],
  deleteGuard: (d, id, teamId) => {
    const row = d.prepare(`SELECT name, teamId FROM unit WHERE id = ? AND teamId = ?`).get(id, teamId) as
      { name: string; teamId: number } | undefined;
    if (!row) return null;
    return exists(`SELECT COUNT(*) AS c FROM product WHERE teamId = ? AND unit = ?`, row.teamId, row.name)
      ? '该单位已被商品使用，不能删除' : null;
  },
});

// 单据与库存
mountDocs(api, db);
// 单据 Excel/CSV 智能导入（raw body 上传）
mountDocImport(api, db);
mountStockQueries(api, db);
mountSettlements(api, db);
mountReports(api, db);
mountAging(api, db);
mountDashboard(api, db);
mountJxcReports(api, db);
mountPriceMemory(api, db);
mountSettings(api, db);
// 数据备份与恢复（仅管理员）
mountBackup(api, db);

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
  // BEGIN 放 try 外：BEGIN 失败时 ROLLBACK 二次抛错会掩盖原始错误
  // BEGIN IMMEDIATE：批量导入立刻取写锁，避免与其它写事务交叉时 SQLITE_BUSY
  db.exec('BEGIN IMMEDIATE');
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

// API 未匹配路由统一返回 JSON 404（否则落到静态兜底会返回 index.html）
app.use('/api', (_req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// 静态前端（web 目录）；vendor 前端库内容恒定，缓存 7 天减少重复下载
import path from 'node:path';
import fs from 'node:fs';
const WEB_ROOT = path.join(__dirname, '..', '..', 'web');
app.use(
  '/vendor',
  express.static(path.join(WEB_ROOT, 'vendor'), { maxAge: '7d', immutable: true }),
);
// 应用脚本 index.html 必须每次校验（no-cache，允许协商缓存命中 304）：
// 否则升级程序后浏览器可能复用旧 index.html + 旧 js，用户看到的是未修复的前端。
app.use(
  express.static(WEB_ROOT, {
    setHeaders: (res, filePath) => {
      if (/\.(?:html|js|css)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }),
);
// 非页面路径兜底回 index.html（hash 路由其实不需要，仅保险）。
// vendor 静态库文件缺失时按真实 404 返回，而不是兜底回 index.html：
// 浏览器请求 JS 收到 HTML 会报语法错误且难排查；404 能直接暴露缺文件。
app.get(/^\/(?!api|vendor\/).*/, (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, '..', '..', 'web', 'index.html'));
});
// vendor 兜底 404（express.static 未命中时走到这里）
app.use('/vendor', (_req: express.Request, res: express.Response) => {
  res.status(404).json({ error: 'vendor 文件不存在' });
});

// 全局错误处理：任何路由抛出的异常统一返回 JSON，避免 Express 默认 HTML 错误页
// 破坏前端 {error} 约定（同步 throw 由 Express 自动转入此中间件）
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // headersSent 防止响应已开始后再写头导致崩溃
  if (res.headersSent) {
    _next(err);
    return;
  }
  console.error('[api-error]', err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

// ---------- 启动监听：本机回环 + 端口自适应 + 单实例文件锁 ----------
import http from 'node:http';

/** 单实例锁：锁文件存在且 pid 活着 → 已有实例在跑，退出（启动器会去唤起已有实例） */
function acquireLock(): boolean {
  const lockFile = path.join(dataDir(), 'server.lock');
  // 旧锁存活检测：锁文件存在但 pid 已死 → 视为残留锁，允许覆盖后重建。
  try {
    const old = Number(fs.readFileSync(lockFile, 'utf8').trim());
    if (old > 0 && old !== process.pid) {
      try {
        process.kill(old, 0);
        return false; // 旧进程仍存活
      } catch { /* 旧进程已死，锁文件是残留，继续走原子重建 */ }
    }
  } catch { /* 无锁文件，首次启动 */ }
  // 原子创建（O_CREAT|O_EXCL）：两个实例同时启动时只有一个能建立锁文件，
  // 另一个进 EEXIST 分支复核对方 pid，消除原来「读-检-写」之间的竞态窗口。
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      try {
        fs.writeSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      break; // 抢锁成功
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') throw e; // 其他错误（目录不可写等）按原行为上抛
      // 锁文件已被并发实例抢先创建：复核其中 pid 是否存活
      let other = 0;
      try { other = Number(fs.readFileSync(lockFile, 'utf8').trim()); } catch { /* ignore */ }
      if (!(other > 0) || other === process.pid) {
        // 内容为空/异常（抢先者刚建文件还没写入，或残留损坏）：删掉重试一次
        try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
        continue;
      }
      try {
        process.kill(other, 0);
        return false; // 抢先者存活：本实例退出
      } catch {
        // 抢先者已死：清残留后重试原子创建
        try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
      }
    }
  }
  // 退出时清锁（kill -9 等异常退出会留残留文件，由上面的存活检测兜底）
  process.on('exit', () => {
    try {
      if (Number(fs.readFileSync(lockFile, 'utf8').trim()) === process.pid) fs.rmSync(lockFile, { force: true });
    } catch { /* ignore */ }
  });
  return true;
}

/** 把实际端口写进数据目录，供启动器/快捷方式读取后打开浏览器。
 *  原子写：先写临时文件再 rename——launcher 每 2s 轮询读，
 *  直接 writeFileSync 会让 launcher 读到截断内容返回 null 误判服务未起。 */
function writePortFile(port: number): void {
  try {
    const target = path.join(dataDir(), 'port.txt');
    const tmp = `${target}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, String(port));
    fs.renameSync(tmp, target);
  } catch { /* 数据目录不可写时忽略：仅影响自动开浏览器 */ }
}

/**
 * 依次尝试首选端口起的连续若干个端口；成功后写 port.txt 并返回 server。
 * ORANGE_BIND=0.0.0.0 时按原行为监听全部网卡（服务管理器隧道场景需要显式开启）。
 */
function listenOn(firstPort: number, tries: number): Promise<{ server: http.Server; port: number }> {
  const host = process.env.ORANGE_BIND === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  return new Promise((resolve, reject) => {
    const attempt = (port: number, left: number) => {
      const server = app.listen(port, host, () => {
        resolve({ server, port });
      });
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && left > 1) attempt(port + 1, left - 1);
        else reject(err);
      });
    };
    attempt(firstPort, tries);
  });
}

(async () => {
  if (!acquireLock()) {
    console.log('[单实例] 已有一个惠民云进销存实例在运行（锁文件指向存活进程），本次启动退出。');
    process.exit(0);
  }
  const firstPort = PORT;
  const { server, port } = await listenOn(firstPort, 20);
  writePortFile(port);
  const actualPort = port;
  console.log(`huimin-clone server listening on http://127.0.0.1:${actualPort}`);
  if (actualPort !== firstPort) {
    console.log(`[端口] 首选端口 ${firstPort} 被占用，已自动改用 ${actualPort}（port.txt 已更新）。`);
  }
  // 自写 pid 文件：不论服务器由谁启动（管理器 / 命令行 / 后台任务），
  // 服务管理器都能据此识别进程并停止它，不必依赖 netstat/tasklist
  try {
    const runtimeDir = path.join(__dirname, '..', '..', '.tools');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'server.pid'), String(process.pid));
  } catch { /* 无权限或目录不可写时忽略，不影响服务本身 */ }
  // keep a reference so the server handle is not GC'd / lint-dead
  void server;
})();