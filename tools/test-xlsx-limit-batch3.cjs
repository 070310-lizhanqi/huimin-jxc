/**
 * 回归测试：B-安9 xlsx 解压总量上限（第三批第一波）。
 *
 * 覆盖：
 *  §1 zip 炸弹：10 个条目各膨胀 20MB（总量约 200MB，压缩后仅约 250KB），改后必须拒绝（400），改前会放行。
 *  §2 只解压必要条目：无关条目是损坏的 deflate 流，改后应被跳过、导入成功；改前 unzip 会直接抛错。
 *  §3 正常多表 xlsx：只用 sheets[0]，其余表不解析，但表名仍列出。
 *  §4 含图片/样式的真实 Excel 结构：多余条目被跳过而非报错，仍能正常导入。
 *  §5 GBK CSV 与大共享字符串表回归。
 *  §6 行数上限流式提前停：6 万行文件改后应在解析早期就拒绝（计时对比），不必等全解析完。
 *
 * 既做 HTTP 层断言（/doc/import），也直接调 dist/server/xlsxlite.js 做单元层断言。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const { api, authHeader } = require('./test-helpers.cjs');
const OC_BASE = process.env.OC_BASE || 'http://127.0.0.1:7741/api';
const { readSpreadsheet } = require('../dist/server/xlsxlite.js');

// ---------- 本轮清理：直连 SQLite 删掉本轮新建的商品/客户 ----------
// 服务运行时另开一个连接写库是安全的（busy_timeout 防 SQLITE_BUSY）。
// 本文件全部单据导入都用 ?dryRun=1（零副作用），实际只新建 1 商品 1 客户；
// doc/doc_item 只快照核对（有变就报错），不删。
const DATA_DIR = process.env.ORANGE_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'huimin-clone.db');
const CLEAN_TABLES = ['product', 'customer', 'doc', 'doc_item'];
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
      db.prepare('DELETE FROM customer WHERE teamId = 1 AND name LIKE ?').run(`${runTag}%`);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } throw e; }
    const after = countAll(db);
    const allBack = CLEAN_TABLES.every((t) => before[t] === after[t]);
    check('清理：跑后相关表行数回到跑前', allBack, { before, after });
  } catch (e) {
    check('清理：删除本轮数据', false, String((e && e.message) || e));
  } finally {
    try { if (db) db.close(); } catch { /* ignore */ }
  }
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : '')); }
}

/** 通用 ZIP 构造器：支持 stored(0) / deflate(8)，中央目录写真实 comp/uncomp 尺寸 */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const rawBuf = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const method = e.method === 8 ? 8 : 0;
    const compBuf = method === 8 ? zlib.deflateRawSync(rawBuf) : rawBuf;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compBuf.length, 18);
    local.writeUInt32LE(rawBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, compBuf);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(compBuf.length, 20);
    cd.writeUInt32LE(rawBuf.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += 30 + nameBuf.length + compBuf.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function colName(n) {
  let s = '';
  n += 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * 多表 xlsx 构造器。
 * sheets: [{ name, rows: string[][], useSharedStrings? }]
 * extraEntries: [{ name, data, method }] 追加的无关条目（如 styles/media）
 * sheetMethod: sheet XML 用 stored(0) 还是 deflate(8)
 */
function buildMultiSheetXlsx(sheets, extraEntries = [], sheetMethod = 0) {
  const shared = [];
  const sheetXmls = sheets.map((sh) => {
    const useSS = sh.useSharedStrings !== false;
    const rowXml = sh.rows.map((cells, ri) => {
      const cellXml = cells.map((v, ci) => {
        if (v == null || v === '') return '';
        const ref = `${colName(ci)}${ri + 1}`;
        const isNum = typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v));
        if (isNum) return `<c r="${ref}"><v>${v}</v></c>`;
        if (useSS) { shared.push(String(v)); return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`; }
        return `<c r="${ref}" t="inlineStr"><is><t>${xmlEsc(v)}</t></is></c>`;
      }).join('');
      return `<row r="${ri + 1}">${cellXml}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
  });
  const wbSheets = sheets.map((sh, i) =>
    `<sheet name="${xmlEsc(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const wbRels = sheets.map((sh, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rIdSS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`;
  const entries = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${wbSheets}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wbRels}</Relationships>` },
    ...sheetXmls.map((xml, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: xml, method: sheetMethod })),
  ];
  if (shared.length) {
    entries.push({ name: 'xl/sharedStrings.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t>${xmlEsc(s)}</t></si>`).join('')}</sst>` });
  }
  for (const ex of extraEntries) entries.push(ex);
  return buildZip(entries);
}

async function uploadImport(buf, qs) {
  const h = await authHeader();
  const res = await fetch(
    `${OC_BASE}/doc/import${qs || ''}`,
    { method: 'POST', headers: { ...h, 'content-type': 'application/octet-stream' }, body: buf },
  );
  const j = await res.json().catch(() => ({ error: 'non-json' }));
  return { status: res.status, body: j };
}

async function mainBody() {
  console.log('[test-xlsx-limit-batch3] B-安9：xlsx 解压总量上限 + 只解必要条目 + 行数流式上限');
  const t0 = Date.now();

  // 前置档案：自建商品/客户，避免依赖种子数据内容（名字带时间戳，重复跑也不撞唯一索引）
  const tag = `B3X${Date.now().toString(36)}`;
  runTag = tag;
  const prodName = `${tag}Prod`;
  const cusName = `${tag}Cus`;
  const prodRes = await api('POST', '/product', { teamId: 1, name: prodName, unit: '件', salePrice: 1000, purchasePrice: 500 });
  check('前置：自建商品', prodRes.status === 200 || prodRes.status === 201, prodRes.body);
  const cusRes = await api('POST', '/customer', { teamId: 1, name: cusName });
  check('前置：自建客户', cusRes.status === 200 || cusRes.status === 201, cusRes.body);

  const goodRows = [
    ['单号', '日期', '客户', '商品名称', '数量', '单价'],
    ['B3X001', '2026-10-20', cusName, prodName, 2, 10.00],
  ];
  const goodXlsx = buildMultiSheetXlsx([{ name: 'Sheet1', rows: goodRows }]);

  // ---------- §1 zip 炸弹：10 条目 × 20MB = 约 200MB 总量 ----------
  const bombEntries = [];
  for (let i = 0; i < 10; i++) {
    bombEntries.push({ name: `xl/media/blob${i}.bin`, data: Buffer.alloc(20 * 1024 * 1024, 0), method: 8 });
  }
  const bomb = buildMultiSheetXlsx([{ name: 'Sheet1', rows: goodRows }], bombEntries);
  console.log(`  [info] 炸弹文件压缩后 ${bomb.length} 字节，声明解压总量约 200MB`);
  let bombThrewUnit = false;
  let bombUnitErr = '';
  try {
    readSpreadsheet(bomb);
  } catch (e) { bombThrewUnit = true; bombUnitErr = e.message; }
  check('§1 单元层：总量 200MB 的 xlsx 被拒绝', bombThrewUnit && /上限|超出/.test(bombUnitErr), bombUnitErr);
  const bombHttp = await uploadImport(bomb, '?dryRun=1');
  check('§1 HTTP 层：总量 200MB 的 xlsx 导入返回 400', bombHttp.status === 400, bombHttp.body);

  // ---------- §2 只解必要条目：无关条目是损坏的 deflate 流 ----------
  // 手工造一个 method=8 但内容是随机垃圾的条目（declared uncomp 1MB，实为无效流）
  const corruptEntry = { name: 'xl/media/corrupt.bin', data: Buffer.from('not-a-deflate-stream-at-all-'.repeat(40), 'utf8'), method: 8 };
  // 注意：buildZip 会对 method 8 的 data 再做一次 deflateRawSync，得到的是合法流；
  // 要造“损坏流”需直接拼 ZIP：用已压缩的垃圾字节当作 comp 数据。
  function buildZipRawComp(entries) {
    // entries: [{name, compBuf, uncompSize, method}]
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
      const nameBuf = Buffer.from(e.name, 'utf8');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0, 6);
      local.writeUInt16LE(e.method, 8);
      local.writeUInt16LE(0, 10);
      local.writeUInt16LE(0, 12);
      local.writeUInt32LE(0, 14);
      local.writeUInt32LE(e.compBuf.length, 18);
      local.writeUInt32LE(e.uncompSize, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      chunks.push(local, nameBuf, e.compBuf);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0, 8);
      cd.writeUInt16LE(e.method, 10);
      cd.writeUInt16LE(0, 12);
      cd.writeUInt16LE(0, 14);
      cd.writeUInt32LE(0, 16);
      cd.writeUInt32LE(e.compBuf.length, 20);
      cd.writeUInt32LE(e.uncompSize, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt16LE(0, 30);
      cd.writeUInt16LE(0, 32);
      cd.writeUInt16LE(0, 34);
      cd.writeUInt16LE(0, 36);
      cd.writeUInt32LE(0, 38);
      cd.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([cd, nameBuf]));
      offset += 30 + nameBuf.length + e.compBuf.length;
    }
    const centralBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...chunks, centralBuf, eocd]);
  }
  // 把正常 goodXlsx 拆成条目再拼：简单做法——复用 buildMultiSheetXlsx 的条目表，
  // 另加一条 method=8、comp 为垃圾字节的无关条目。buildZip 会对 method 8 再压缩，
  // 因此这里直接用 buildZipRawComp 重建整个包：正常条目用 stored，垃圾条目原样放。
  const goodParts = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>` },
  ];
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>单号</t></is></c><c r="B1" t="inlineStr"><is><t>日期</t></is></c><c r="C1" t="inlineStr"><is><t>客户</t></is></c><c r="D1" t="inlineStr"><is><t>商品名称</t></is></c><c r="E1" t="inlineStr"><is><t>数量</t></is></c><c r="F1" t="inlineStr"><is><t>单价</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>B3X002</t></is></c><c r="B2" t="inlineStr"><is><t>2026-10-20</t></is></c><c r="C2" t="inlineStr"><is><t>${cusName}</t></is></c><c r="D2" t="inlineStr"><is><t>${prodName}</t></is></c><c r="E2"><v>2</v></c><c r="F2"><v>10</v></c></row></sheetData></worksheet>`;
  const corruptXlsx = buildZipRawComp([
    ...goodParts.map((p) => ({ name: p.name, compBuf: Buffer.from(p.data, 'utf8'), uncompSize: Buffer.byteLength(p.data), method: 0 })),
    { name: 'xl/worksheets/sheet1.xml', compBuf: Buffer.from(sheetXml, 'utf8'), uncompSize: Buffer.byteLength(sheetXml), method: 0 },
    // 损坏的无关条目：method 8，comp 数据是非法 deflate 流，声明解压 1MB
    { name: 'xl/media/corrupt.bin', compBuf: Buffer.from('garbage-not-deflate-'.repeat(50), 'utf8'), uncompSize: 1024 * 1024, method: 8 },
  ]);
  void corruptEntry;
  let corruptUnitOk = false;
  let corruptUnitErr = '';
  try {
    const parsed = readSpreadsheet(corruptXlsx);
    corruptUnitOk = parsed.sheets[0] && parsed.sheets[0].rows.length === 2;
  } catch (e) { corruptUnitErr = e.message; }
  check('§2 单元层：损坏的无关条目被跳过、正常表仍可读', corruptUnitOk, corruptUnitErr);
  const corruptHttp = await uploadImport(corruptXlsx, '?dryRun=1');
  check('§2 HTTP 层：含损坏无关条目的 xlsx 仍能导入', corruptHttp.status === 200 && corruptHttp.body.summary && corruptHttp.body.summary.billCount === 1, corruptHttp.body);

  // ---------- §3 正常多表 xlsx：只用 sheets[0] ----------
  const multi = buildMultiSheetXlsx([
    { name: '销售', rows: goodRows },
    { name: '采购', rows: [['日期', '供应商', '商品名称', '数量', '单价'], ['2026-10-18', '供应商A', prodName, 5, 3.00]] },
    { name: '空白表', rows: [['备注'], ['与第一表无关']] },
  ]);
  const multiParsed = readSpreadsheet(multi);
  check('§3 多表：表名全部列出', multiParsed.sheets.map((s) => s.name).join(',') === '销售,采购,空白表', multiParsed.sheets.map((s) => s.name));
  check('§3 多表：第一表行数正确', multiParsed.sheets[0].rows.length === 2, multiParsed.sheets[0].rows.length);
  const multiHttp = await uploadImport(multi, '?dryRun=1');
  check('§3 多表 HTTP：只按第一表识别出 1 单', multiHttp.status === 200 && multiHttp.body.summary && multiHttp.body.summary.billCount === 1, multiHttp.body && multiHttp.body.summary);

  // ---------- §4 含图片/样式的真实 Excel 结构 ----------
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const fakePng = Buffer.concat([pngHeader, Buffer.alloc(2 * 1024 * 1024, 0xAB)]); // 2MB“图片”，stored
  const realLike = buildMultiSheetXlsx([{ name: 'Sheet1', rows: goodRows }], [
    { name: 'xl/styles.xml', data: '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts><font><sz val="11"/></font></fonts></styleSheet>' },
    { name: 'xl/media/image1.png', data: fakePng, method: 0 },
    { name: 'docProps/core.xml', data: '<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"><dc:title>test</dc:title></cp:coreProperties>' },
    { name: 'xl/drawings/drawing1.xml', data: '<?xml version="1.0"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>' },
  ]);
  let realUnitOk = false;
  try {
    const p = readSpreadsheet(realLike);
    realUnitOk = p.sheets[0].rows.length === 2;
  } catch (e) { realUnitOk = false; }
  check('§4 单元层：含 2MB 图片/样式的真实结构仍可读', realUnitOk);
  const realHttp = await uploadImport(realLike, '?dryRun=1');
  check('§4 HTTP 层：含图片/样式的 xlsx 正常导入', realHttp.status === 200 && realHttp.body.summary && realHttp.body.summary.billCount === 1, realHttp.body && realHttp.body.summary);

  // ---------- §5 GBK CSV 与大共享字符串表 ----------
  // GBK 表头：商品名称,数量,单价,客户（GBK 编码），数据行用 ASCII 名
  const gbkHeader = Buffer.from('C9CCC6B7C3FBB3C6', 'hex'); // 商品名称
  const gbkQty = Buffer.from('CAFD C1BF'.replace(/ /g, ''), 'hex'); // 数量
  const gbkPrice = Buffer.from('B5A5BCDB', 'hex'); // 单价
  const gbkCus = Buffer.from('BFCDBBA7', 'hex'); // 客户（客=BFCD，户=BBA7）
  const gbkCsv = Buffer.concat([
    gbkHeader, Buffer.from(','), gbkQty, Buffer.from(','), gbkPrice, Buffer.from(','), gbkCus,
    Buffer.from('\r\n'),
    Buffer.from(`${prodName},5,10.00,${cusName}\r\n`, 'ascii'),
  ]);
  const gbkHttp = await uploadImport(gbkCsv, '?dryRun=1');
  check('§5 GBK CSV 仍能正常导入', gbkHttp.status === 200 && gbkHttp.body.summary && gbkHttp.body.summary.billCount === 1, gbkHttp.body && gbkHttp.body.summary);
  // 大共享字符串表：5000 条共享字符串，sheet 只引用其中几条
  const bigSSRows = [['单号', '日期', '客户', '商品名称', '数量', '单价']];
  const bigSS = buildMultiSheetXlsx([{ name: 'Sheet1', rows: [...bigSSRows, ['B3X003', '2026-10-20', cusName, prodName, 2, 10.00]] }]);
  // 追加 5000 条无用共享字符串：直接改写 sharedStrings.xml 条目
  const manyStrings = Array.from({ length: 5000 }, (_, i) => `<si><t>填充字符串${i}号-abcdefghijklmnopqrstuvwxyz</t></si>`).join('');
  const bigSSWithJunk = (() => {
    // 取出 bigSS 的条目并替换 sharedStrings：复用 buildMultiSheetXlsx 的结构，
    // 改为在 sheet 里放一个引用大量共享字符串的表头行以外的行——更简单：直接再建一个
    // 带 5000 行“注释列”的 sheet2？不，sharedStrings 由 buildMultiSheetXlsx 自动生成。
    // 这里用另一条路：构造一个 sheet，含 5000 个不同文本单元格（走 sharedStrings）。
    const fillerRows = [['商品名称']];
    for (let i = 0; i < 5000; i++) fillerRows.push([`填充商品名${i}`]);
    return buildMultiSheetXlsx([
      { name: 'Sheet1', rows: goodRows },
      { name: '填充表', rows: fillerRows },
    ]);
  })();
  void bigSS; void manyStrings;
  let bigSSOk = false;
  try {
    const p = readSpreadsheet(bigSSWithJunk);
    bigSSOk = p.sheets[0].rows.length === 2;
  } catch (e) { bigSSOk = false; }
  check('§5 单元层：5000+ 共享字符串表仍可读', bigSSOk);
  const bigSSHttp = await uploadImport(bigSSWithJunk, '?dryRun=1');
  check('§5 HTTP 层：大共享字符串表仍能导入', bigSSHttp.status === 200 && bigSSHttp.body.summary && bigSSHttp.body.summary.billCount === 1, bigSSHttp.body && bigSSHttp.body.summary);

  // ---------- §6 行数上限流式提前停：6 万行 ----------
  const ROWS = 60000;
  const hugeRows = [['单号', '日期', '客户', '商品名称', '数量', '单价']];
  for (let i = 0; i < ROWS; i++) hugeRows.push([`B3H${String(i).padStart(5, '0')}`, '2026-10-20', cusName, prodName, 1, 10.00]);
  const hugeXlsx = buildMultiSheetXlsx([{ name: 'Sheet1', rows: hugeRows }], [], 8);
  console.log(`  [info] 6 万行 xlsx 压缩后 ${hugeXlsx.length} 字节`);
  const u0 = Date.now();
  let hugeThrew = false;
  let hugeErr = '';
  try {
    readSpreadsheet(hugeXlsx);
  } catch (e) { hugeThrew = true; hugeErr = e.message; }
  const unitMs = Date.now() - u0;
  console.log(`  [info] 单元层 6 万行解析耗时 ${unitMs}ms（改前全量解析，改后应在 2001 行处提前停）`);
  check('§6 单元层：超 2000 行被拒绝', hugeThrew && /2000|行数|上限/.test(hugeErr), hugeErr);
  const h0 = Date.now();
  const hugeHttp = await uploadImport(hugeXlsx, '?dryRun=1');
  const httpMs = Date.now() - h0;
  console.log(`  [info] HTTP 层 6 万行导入耗时 ${httpMs}ms，状态 ${hugeHttp.status}`);
  check('§6 HTTP 层：超 2000 行返回 400', hugeHttp.status === 400, hugeHttp.body);
  check('§6 HTTP 层：6 万行拒绝耗时 < 5000ms（提前停）', httpMs < 5000, httpMs);

  // CSV 行数上限同样 400
  const csvLines = ['商品名称,数量,单价,客户'];
  for (let i = 0; i < 3000; i++) csvLines.push(`${prodName},1,10.00,${cusName}`);
  const csvHttp = await uploadImport(Buffer.from(csvLines.join('\r\n'), 'utf8'), '?dryRun=1');
  check('§6 CSV 超 2000 行返回 400', csvHttp.status === 400, csvHttp.body && csvHttp.body.error);

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
  if (completed) console.log(`[test-xlsx-limit-batch3] 通过 ${pass} / ${pass + fail}，总耗时 ${ms}ms`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('[test-xlsx-limit-batch3] 异常:', e); process.exit(1); });
