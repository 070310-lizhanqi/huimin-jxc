/**
 * 回归测试：B-安12 gzip 异步化 + 静态缓存（第三批第一波）。
 *
 * 注意：undici 的 fetch 会自动解压 gzip 并抹掉 content-encoding 响应头，
 * 因此本文件用 node:http 原始请求观测压缩行为，自行 gunzip 校验。
 *
 * 覆盖：
 *  §1 重复请求 /vendor/echarts.min.js（20 次）：全部 200 且 gzip 编码，解压后与明文一致；
 *     打印总耗时与首请求/后续中位耗时（缓存收益）。
 *  §2 大响应：500 行商品列表 JSON，gzip 编码、内容正确；打印 gzip 与明文耗时。
 *  §3 大 gzip 进行中时小请求 /auth/status 的延迟：20 个 vendor 大请求并发时连续测 5 次，
 *     改前 gzipSync 会阻塞事件循环拖住小请求，改后应不再被拖住。打印每次延迟。
 *  §4 流式响应：备份下载（res.download）跳过压缩、无 content-encoding、内容为 SQLite 文件。
 *  §5 已手动指定 Content-Encoding 的响应：无路由会手动指定——以两点覆盖：
 *     (a) 代码层：dist 里 gzip 决策仍保留 !getHeader('content-encoding') 守卫；
 *     (b) 行为层：响应绝不双重编码（content-encoding 恰为 'gzip'，一次解压即得明文）。
 *     另测请求自带 Content-Encoding 时中间件直接放行（响应不压缩）。
 *  §6 阈值与不压缩路径：小响应（<1024B）不压；无 Accept-Encoding 时不压。
 */
'use strict';
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { api, authHeader } = require('./test-helpers.cjs');
const OC_BASE = process.env.OC_BASE || 'http://127.0.0.1:7741/api';
const ROOT = OC_BASE.replace(/\/api\/?$/, '');
const ROOT_URL = new URL(ROOT);

// ---------- 本轮清理：直连 SQLite 删掉本轮新建的商品 ----------
// 服务运行时另开一个连接写库是安全的（busy_timeout 防 SQLITE_BUSY）。
// 只按本轮唯一 tag 前缀删，不碰种子数据；备份文件（§4）只落盘不写行数，不管。
// 本轮只新建商品，故只快照/核对 product 表。
const DATA_DIR = process.env.ORANGE_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'huimin-clone.db');
const CLEAN_TABLES = ['product'];
let runTag = '';
function openTestDb() {
  if (!fs.existsSync(DB_PATH)) throw new Error('数据库文件不存在：' + DB_PATH + '（是否漏设 ORANGE_DATA_DIR？）');
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}
function countAll(db) {
  const out = {};
  for (const t of CLEAN_TABLES) {
    try { out[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c; }
    catch { out[t] = -1; }
  }
  return out;
}
function cleanupAndVerify(before) {
  let db = null;
  try {
    db = openTestDb();
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM product WHERE teamId = 1 AND name LIKE ?').run(`${runTag}%`);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
    const after = countAll(db);
    const allBack = CLEAN_TABLES.every((t) => before[t] === after[t]);
    check('清理：跑后商品行数回到跑前', allBack, { before, after });
  } catch (e) {
    check('清理：删除本轮商品', false, String((e && e.message) || e));
  } finally {
    try { if (db) db.close(); } catch { /* ignore */ }
  }
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : '')); }
}

/** 原始 HTTP GET，不自动解压，返回 { status, headers, body: Buffer } */
function rawGet(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: ROOT_URL.hostname,
      port: Number(ROOT_URL.port),
      path: pathname,
      method: 'GET',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function mainBody() {
  console.log('[test-gzip-batch3] B-安12：gzip 异步化 + /vendor/* 压缩缓存');
  const t0 = Date.now();
  const tag = `B3G${Date.now().toString(36)}`;
  runTag = tag;

  // ---------- §1 重复请求 vendor 20 次 ----------
  const plain = await rawGet('/vendor/echarts.min.js', {});
  check('§1 明文请求 200', plain.status === 200 && plain.body.length > 100000, { status: plain.status, len: plain.body.length });
  check('§1 明文请求不带 content-encoding', !plain.headers['content-encoding'], plain.headers['content-encoding']);
  const times = [];
  let allGzip = true;
  let allMatch = true;
  for (let i = 0; i < 20; i++) {
    const s = Date.now();
    const r = await rawGet('/vendor/echarts.min.js', { 'Accept-Encoding': 'gzip' });
    times.push(Date.now() - s);
    if (r.status !== 200 || r.headers['content-encoding'] !== 'gzip') allGzip = false;
    else {
      try {
        const dec = zlib.gunzipSync(r.body);
        if (!dec.equals(plain.body)) allMatch = false;
      } catch { allMatch = false; }
    }
  }
  const total20 = times.reduce((a, b) => a + b, 0);
  console.log(`  [info] 20 次 gzip 请求 /vendor/echarts.min.js 总耗时 ${total20}ms，首请求 ${times[0]}ms，后续中位 ${median(times.slice(1))}ms`);
  check('§1 20 次请求全部 200 且 gzip 编码', allGzip);
  check('§1 20 次解压后与明文逐字节一致', allMatch);
  check('§1 20 次总耗时 < 5000ms', total20 < 5000, total20);

  // ---------- §2 大响应：500 行商品列表 ----------
  const h = await authHeader();
  const rows = [];
  for (let i = 0; i < 500; i++) {
    rows.push({ name: `${tag}P${String(i).padStart(4, '0')}`, catName: '', unit: '件', purchasePrice: '5.00', salePrice: '10.00', retailPrice: '12.00', wholePrice: '9.00', lowQty: '0' });
  }
  const imp = await fetch(`${OC_BASE}/product/import`, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId: 1, rows }),
  }).then((r) => r.json());
  check('§2 前置：500 行商品导入成功', imp.success === 500, { success: imp.success, errors: (imp.errors || []).slice(0, 2) });
  const listPath = `/api/product?teamId=1&rows=500`;
  const gz0 = Date.now();
  const gzList2 = await rawGet(listPath, { 'Accept-Encoding': 'gzip', ...h });
  const gzMs2 = Date.now() - gz0;
  let listJson = null;
  let listOk = false;
  if (gzList2.status === 200 && gzList2.headers['content-encoding'] === 'gzip') {
    try {
      listJson = JSON.parse(zlib.gunzipSync(gzList2.body).toString('utf8'));
      listOk = Array.isArray(listJson) && listJson.length === 500;
    } catch { listOk = false; }
  }
  console.log(`  [info] 500 行商品列表 gzip 响应 ${gzList2.body.length} 字节，耗时约 ${gzMs2}ms`);
  check('§2 大列表 gzip 编码且 500 行内容正确', listOk, { status: gzList2.status, enc: gzList2.headers['content-encoding'], len: gzList2.body.length });
  const pl0 = Date.now();
  const plainList = await rawGet(listPath, { ...h });
  const plMs = Date.now() - pl0;
  console.log(`  [info] 500 行商品列表明文 ${plainList.body.length} 字节，耗时 ${plMs}ms；gzip 压缩比 ${(plainList.body.length / Math.max(1, gzList2.body.length)).toFixed(2)}x`);
  check('§2 大列表明文不带 content-encoding', plainList.status === 200 && !plainList.headers['content-encoding'], plainList.headers['content-encoding']);
  check('§2 gzip 体显著小于明文', gzList2.body.length < plainList.body.length * 0.6, { gz: gzList2.body.length, plain: plainList.body.length });

  // ---------- §3 大 gzip 进行中时小请求延迟 ----------
  const burst = [];
  for (let i = 0; i < 20; i++) burst.push(rawGet('/vendor/echarts.min.js', { 'Accept-Encoding': 'gzip' }));
  // 并发 burst 已发出，立即连续测 5 次 /auth/status
  const statusLat = [];
  for (let i = 0; i < 5; i++) {
    const s = Date.now();
    const r = await rawGet('/api/auth/status', {});
    statusLat.push(Date.now() - s);
    if (r.status !== 200) break;
  }
  const burstRes = await Promise.all(burst);
  console.log(`  [info] 20 个大 gzip 并发进行中，/auth/status 5 次延迟 ${statusLat.join('ms, ')}ms（中位 ${median(statusLat)}ms，最大 ${Math.max(...statusLat)}ms）`);
  check('§3 并发大 gzip 期间小请求全部 200', burstRes.every((r) => r.status === 200), burstRes.map((r) => r.status));
  check('§3 小请求延迟中位 < 1000ms（不再被 gzip 拖住）', median(statusLat) < 1000, statusLat);
  check('§3 小请求延迟最大 < 2000ms', Math.max(...statusLat) < 2000, statusLat);

  // ---------- §4 流式响应：备份下载跳过压缩 ----------
  const created = await api('POST', '/backup/create', { teamId: 1 });
  check('§4 前置：备份创建成功', created.status === 200 && created.body.file, created.body);
  const dl = await rawGet(`/api/backup/download?file=${created.body.file}`, { 'Accept-Encoding': 'gzip', ...h });
  check('§4 备份下载 200', dl.status === 200, { status: dl.status });
  check('§4 备份下载跳过压缩（无 content-encoding）', !dl.headers['content-encoding'], dl.headers['content-encoding']);
  check('§4 备份下载内容为 SQLite 文件', dl.body.slice(0, 15).toString('utf8') === 'SQLite format 3', dl.body.slice(0, 15).toString('utf8'));

  // ---------- §5 已手动指定 Content-Encoding 的响应 ----------
  const distIndex = fs.readFileSync(path.join(__dirname, '..', 'dist', 'server', 'index.js'), 'utf8');
  check('§5 代码层：gzip 决策保留 !getHeader(\'content-encoding\') 守卫', distIndex.includes("getHeader('content-encoding')"), 'guard missing');
  const once = await rawGet('/vendor/echarts.min.js', { 'Accept-Encoding': 'gzip' });
  check('§5 行为层：content-encoding 恰为单值 gzip（无双重编码）', once.headers['content-encoding'] === 'gzip', once.headers['content-encoding']);
  let singleDecOk = false;
  try { singleDecOk = zlib.gunzipSync(once.body).equals(plain.body); } catch { singleDecOk = false; }
  check('§5 行为层：一次解压即得明文', singleDecOk);
  // 请求自带 Content-Encoding 时中间件直接放行（响应不压缩）
  const withReqEnc = await rawGet('/vendor/echarts.min.js', { 'Accept-Encoding': 'gzip', 'Content-Encoding': 'gzip' });
  check('§5 请求带 Content-Encoding 时响应不压缩', withReqEnc.status === 200 && !withReqEnc.headers['content-encoding'], { status: withReqEnc.status, enc: withReqEnc.headers['content-encoding'] });

  // ---------- §6 阈值与不压缩路径 ----------
  const small = await rawGet('/api/auth/status', { 'Accept-Encoding': 'gzip' });
  check('§6 小响应（<1024B）不压缩', small.status === 200 && !small.headers['content-encoding'], { status: small.status, enc: small.headers['content-encoding'] });
  const noAe = await rawGet('/vendor/vue.global.prod.js', {});
  check('§6 无 Accept-Encoding 时不压缩', noAe.status === 200 && !noAe.headers['content-encoding'], noAe.headers['content-encoding']);

  return Date.now() - t0;
}

async function main() {
  // 跑前快照相关表行数；无论本体通过/失败/抛错，finally 里都先清掉本轮数据再退出
  // （本体末尾不再直接 process.exit(1)，否则 finally 的清理跑不到）。
  let before = null;
  try {
    const db = openTestDb();
    before = countAll(db);
    db.close();
  } catch (e) { console.log('[cleanup] 跑前行数快照失败：' + e.message); check('清理：跑前行数快照', false, e.message); }
  let ms = 0;
  let completed = false;
  try {
    ms = await mainBody();
    completed = true;
  } finally {
    if (before) cleanupAndVerify(before);
  }
  // 汇总放在清理断言之后打印，数字才含清理断言
  if (completed) console.log(`[test-gzip-batch3] 通过 ${pass} / ${pass + fail}，总耗时 ${ms}ms`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('[test-gzip-batch3] 异常:', e); process.exit(1); });
