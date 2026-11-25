/**
 * 零依赖 xlsx / CSV 读取器（仅覆盖导入所需的表格读取场景）。
 *
 * 设计取舍：项目坚持零外部依赖（除 express），因此不引 SheetJS；
 * 这里实现一个「够用且严格」的子集：
 * - ZIP：EOCD + 中央目录定位，支持 stored(0) / deflate(8)；不支持 ZIP64（表格文件不会超 4GB）
 * - XML：workbook.xml / workbook.xml.rels / sharedStrings.xml / sheet*.xml
 *   用正则切片解析（xlsx 是机器生成的规范 XML，属性顺序无关处理按「整个标签内提取」）
 * - 单元格值：共享字符串 / 内联字符串 / 数字 / 布尔；公式取缓存值 <v>
 * - 日期：Excel 序列数（1900 体系）→ 由上层按「目标列是日期」决定是否转换
 *
 * CSV：支持引号转义、CRLF、BOM、逗号/分号/Tab 自动识别；
 *      编码 UTF-8 优先，解码失败自动回落 GB18030（Excel 中文环境导出 ANSI 常见）。
 */
import zlib from 'node:zlib';

export interface SheetData {
  name: string;
  /** 行×列的纯文本值（数字保持原字符串形式；空单元格为 ''） */
  rows: string[][];
}

/** 解码 XML 实体（含数字字符引用） */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 从一个标签字符串里提取某属性值（属性顺序无关） */
function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? decodeXmlEntities(m[1]) : null;
}

/** 去掉 CDATA 包裹（共享字符串可能用 cdata 存文本） */
function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

// ============================ ZIP ============================

/** zip 条目解压体积上限（80MB）：恶意 xlsx 可以用 2MB 压缩体声明数十 GB 解压内容（zip 炸弹），
 *  inflateRawSync 不限长会把内存吃满。正常单据表远小于此值。 */
const MAX_ENTRY_BYTES = 80 * 1024 * 1024;

/** 解压总量上限（B-安9）：与单条目上限取同一值 80MB。
 *  理由：上传限 12MB、单据导入最多 2000 行，正常 xlsx 解压后远小于 80MB；
 *  总量与单条目共用一个阈值，语义简单且足够宽松。总量按中央目录声明尺寸在解压前
 *  预检（声明可谎报，解压时再按实际累计尺寸复核一次）。 */
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;

/** 共享字符串条数上限（B-安9）：2000 行导入最多约 4 万个文本单元格，20 万留足余量；
 *  共享字符串表本身还受解压总量上限约束。 */
const MAX_SHARED_STRINGS = 200_000;

/** 中央目录条目元数据（只读目录，不解压） */
interface ZipEntryMeta {
  name: string;
  method: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
}

/** 只解析 ZIP 中央目录，返回条目元数据（不解压任何条目） */
function readCentralDirectory(buf: Buffer): ZipEntryMeta[] {
  // 1) 从尾部找 EOCD（固定 22 字节，前面可能有注释，最多 64KB）
  const eocdMin = 22;
  let eocd = -1;
  const scanStart = Math.max(0, buf.length - 65557);
  for (let i = buf.length - eocdMin; i >= scanStart; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx/ZIP 文件');
  const entryCount = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || entryCount === 0xffff) {
    throw new Error('暂不支持 ZIP64 格式的 xlsx 文件');
  }
  if (cdOffset + 46 > buf.length || cdOffset < 0) throw new Error('ZIP 中央目录损坏');
  // 2) 遍历中央目录（越界前终止：损坏文件可能声明了超量条目）
  const metas: ZipEntryMeta[] = [];
  for (let i = 0; i < entryCount; i++) {
    if (cdOffset + 46 > buf.length) throw new Error('ZIP 中央目录损坏');
    if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const method = buf.readUInt16LE(cdOffset + 10);
    const compSize = buf.readUInt32LE(cdOffset + 20);
    const uncompSize = buf.readUInt32LE(cdOffset + 24);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localOffset = buf.readUInt32LE(cdOffset + 42);
    const name = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen);
    cdOffset += 46 + nameLen + extraLen + commentLen;
    metas.push({ name, method, compSize, uncompSize, localOffset });
  }
  return metas;
}

/** 解压单个条目（按元数据定位本地头并取数据） */
function inflateEntry(buf: Buffer, meta: ZipEntryMeta): Buffer {
  const { name, method, compSize, localOffset } = meta;
  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP 本地头损坏：${name}`);
  const lNameLen = buf.readUInt16LE(localOffset + 26);
  const lExtraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + lNameLen + lExtraLen;
  if (dataStart + compSize > buf.length) throw new Error(`ZIP 条目越界：${name}`);
  const raw = buf.subarray(dataStart, dataStart + compSize);
  if (method === 0) {
    return Buffer.from(raw);
  } else if (method === 8) {
    // maxOutputLength：解压结果超过上限直接抛错，防 zip 炸弹吃满内存
    return zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
  } else {
    throw new Error(`不支持的 ZIP 压缩方式 ${method}：${name}`);
  }
}

/** 解析 ZIP：只解压 `needed` 判定为需要的条目，返回 文件名 → 内容 映射。
 *  B-安9：① 解压前按中央目录声明尺寸累计总量，超 80MB 即拒（无需解压即可判定）；
 *  ② 其余条目（图片/样式/绘图等）根本不解压；③ 解压时再按实际累计尺寸复核一次，
 *  防中央目录谎报小尺寸。 */
function unzip(buf: Buffer, needed: (name: string) => boolean): Map<string, Buffer> {
  const metas = readCentralDirectory(buf);
  let declaredTotal = 0;
  for (const m of metas) declaredTotal += m.uncompSize;
  if (declaredTotal > MAX_TOTAL_BYTES) {
    throw new Error(`xlsx 解压后体积超出上限 ${MAX_TOTAL_BYTES / 1024 / 1024}MB`);
  }
  const out = new Map<string, Buffer>();
  let actualTotal = 0;
  for (const meta of metas) {
    if (!needed(meta.name)) continue; // 不需要的条目直接跳过，不解压
    const data = inflateEntry(buf, meta);
    actualTotal += data.length;
    if (actualTotal > MAX_TOTAL_BYTES) {
      throw new Error(`xlsx 解压后体积超出上限 ${MAX_TOTAL_BYTES / 1024 / 1024}MB`);
    }
    out.set(meta.name, data);
  }
  return out;
}

// ============================ XML（sheet 解析） ============================

/** 单列引用（A1）→ 0 基列号 */
function colIndex(ref: string): number {
  const m = ref.match(/^([A-Z]+)/);
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Excel 真实最大列数（XFD，即 16384 列）。超出视为非法引用直接丢弃：
 *  恶意 xlsx 可声明 r="ZZZZZZZZ1" 这类天文列号，若照单全收，
 *  下面的 while 补空循环会一次性分配数十 GB 的占位数组（12MB 上传即可打挂进程）。 */
const MAX_XLSX_COLS = 16384;

/** 解析 sharedStrings.xml 为字符串表 */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const sis = xml.match(/<si(?:\s[^>]*)?>[\s\S]*?<\/si>|<si\/>/g) ?? [];
  // B-安9：共享字符串条数上限（解压总量上限只约束字节数，条数再约束一次，
  // 防几十 MB 全是 <si> 空壳时解析出的数组本身撑爆内存）
  if (sis.length > MAX_SHARED_STRINGS) {
    throw new Error(`共享字符串数量超出上限 ${MAX_SHARED_STRINGS} 条`);
  }
  for (const si of sis) {
    const ts = si.match(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>/g) ?? [];
    out.push(ts.map((x) => decodeXmlEntities(stripCdata(x.replace(/<t(?:\s[^>]*)?>/, '').replace(/<\/t>/, '')))).join(''));
  }
  return out;
}

// ============================ xlsx 主入口 ============================

export interface ReadSpreadsheetOptions {
  /** 数据行数上限（不含表头）：解析到第 maxRows+1 个非空数据行时立即抛错，
   *  不必等整个文件解析完。未传则不限制（保持旧行为）。 */
  maxRows?: number;
  /** 只解析第一个工作表：其余表只保留表名、rows 为 []（docimport 只用 sheets[0]，
   *  其余表的解压与解析成本纯浪费）。未传则解析全部表（保持旧行为）。 */
  firstSheetOnly?: boolean;
}

/**
 * 读取 xlsx 全部工作表。
 * 返回 { sheets: [{name, rows}] }（按 workbook 声明顺序）。
 * B-安9：分三步只解压真正需要的条目——先解 workbook.xml 定表清单，再解 rels 定 sheet 路径，
 * 最后只解被引用的 sheet +（确实用到共享字符串时才解）sharedStrings.xml；图片/样式等一律跳过。
 */
export function readXlsx(buf: Buffer, opts: ReadSpreadsheetOptions = {}): { sheets: SheetData[] } {
  const wbFiles = unzip(buf, (name) => name === 'xl/workbook.xml');
  const wbXml = wbFiles.get('xl/workbook.xml');
  if (!wbXml) throw new Error('xlsx 缺少 xl/workbook.xml（可能不是 Excel 工作簿）');

  // workbook.xml.rels：rId → worksheet 路径
  const relsFiles = unzip(buf, (name) => name === 'xl/_rels/workbook.xml.rels');
  const relsXml = relsFiles.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const relMap = new Map<string, string>();
  for (const rel of relsXml.match(/<Relationship\b[^>]*\/?>/g) ?? []) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (id && target && target.includes('worksheets/')) {
      // Target 有相对（worksheets/sheet1.xml）与绝对（/xl/worksheets/sheet1.xml）两种写法，
      // 统一规范成包内路径，避免绝对写法被拼成 xl/xl/worksheets/…
      const norm = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
      relMap.set(id, norm);
    }
  }

  // workbook.xml 的 sheet 列表（按声明顺序），先只定路径、不解压
  const sheetDefs: Array<{ name: string; path: string | undefined }> = [];
  let idx = 0;
  for (const sheetTag of wbXml.toString('utf8').match(/<sheet\b[^>]*\/?>/g) ?? []) {
    const name = attr(sheetTag, 'name') ?? `Sheet${idx + 1}`;
    const rid = attr(sheetTag, 'r:id') ?? attr(sheetTag, 'id');
    const path = rid ? relMap.get(rid) : undefined;
    sheetDefs.push({ name, path: path ?? `xl/worksheets/sheet${idx + 1}.xml` });
    idx++;
  }
  if (!sheetDefs.length) throw new Error('xlsx 中没有工作表');

  // 只解压真正要解析的 sheet（firstSheetOnly 时仅第一表）
  const toParse = opts.firstSheetOnly ? sheetDefs.slice(0, 1) : sheetDefs;
  const wantedPaths = new Set(toParse.map((d) => d.path));
  const sheetFiles = unzip(buf, (name) => wantedPaths.has(name));
  // 共享字符串表只在确有 sheet 用到 t="s" 时才解压
  const needsShared = [...sheetFiles.values()].some((b) => b.toString('utf8').includes('t="s"'));
  const sharedFiles = needsShared
    ? unzip(buf, (name) => name === 'xl/sharedStrings.xml')
    : new Map<string, Buffer>();
  const shared = sharedFiles.has('xl/sharedStrings.xml')
    ? parseSharedStrings(sharedFiles.get('xl/sharedStrings.xml')!.toString('utf8'))
    : [];

  const sheets: SheetData[] = [];
  for (const def of sheetDefs) {
    if (!toParse.includes(def)) {
      // 未解析的表只保留表名（调用方只用 sheets[0] 时其余表不产生成本）
      sheets.push({ name: def.name, rows: [] });
      continue;
    }
    const sheetFile = sheetFiles.get(def.path!);
    // t="s" 的单元格值为 sharedStrings 下标，统一回填为真实文本
    const rows = sheetFile ? backfillShared(sheetFile.toString('utf8'), shared, opts.maxRows) : [];
    sheets.push({ name: def.name, rows });
  }
  return { sheets };
}

/** 解析 sheet XML：单元格 → 行数组（t="s" 回填共享字符串，inlineStr/数字/布尔直取）。
 *  maxRows：非空数据行（除第 1 行表头外）超限时立即抛错，不必等整表解析完。 */
function backfillShared(xml: string, shared: string[], maxRows?: number): string[][] {
  const rows: string[][] = [];
  const rowTags = xml.match(/<row[^>]*\/>|<row[^>]*>[\s\S]*?<\/row>/g) ?? [];
  let dataRows = 0;
  for (const rowTag of rowTags) {
    if (rowTag.endsWith('/>')) continue;
    const inner = rowTag.slice(rowTag.indexOf('>') + 1, rowTag.lastIndexOf('</row>'));
    const cells: string[] = [];
    const cellTags = inner.match(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g) ?? [];
    for (const cellTag of cellTags) {
      const ref = attr(cellTag, 'r') ?? '';
      const t = attr(cellTag, 't');
      let value = '';
      if (!cellTag.endsWith('/>')) {
        if (t === 'inlineStr') {
          const ts = cellTag.match(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>/g) ?? [];
          value = ts.map((x) => decodeXmlEntities(stripCdata(x.replace(/<t(?:\s[^>]*)?>/, '').replace(/<\/t>/, '')))).join('');
        } else {
          const v = cellTag.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
          if (v) {
            if (t === 's') {
              const idx = parseInt(v[1], 10);
              value = Number.isInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx] : '';
            } else if (t === 'b') {
              value = v[1] === '1' ? 'TRUE' : 'FALSE';
            } else {
              value = decodeXmlEntities(v[1]);
            }
          }
        }
      }
      const ci = colIndex(ref);
      if (ci >= 0 && ci < MAX_XLSX_COLS) {
        while (cells.length < ci) cells.push('');
        cells[ci] = value;
      } else if (value !== '') {
        // 无列引用或超界引用但带值：退化为顺序追加，保证不丢数据
        cells.push(value);
      }
    }
    rows.push(cells);
    // 流式上限：第 1 行是表头，只数之后非空的数据行（与 docimport 的 dataRows 口径一致）
    if (maxRows !== undefined && rows.length > 1 && cells.some((c) => c !== '')) {
      dataRows++;
      if (dataRows > maxRows) throw new Error(`行数超出上限 ${maxRows} 行`);
    }
  }
  return rows;
}

// ============================ CSV ============================

/** 按分隔符解析 CSV 文本（支持引号包裹、双引号转义、引号内换行）。
 *  maxRows：非空数据行（除第 1 行表头外）超限时立即抛错，不必等全文解析完。 */
function parseCsvText(text: string, delim: string, maxRows?: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let dataRows = 0;
  const finishRow = (): void => {
    row.push(field);
    field = '';
    rows.push(row);
    // 流式上限：第 1 行是表头，只数之后非空的数据行
    if (maxRows !== undefined && rows.length > 1 && row.some((f) => f !== '')) {
      dataRows++;
      if (dataRows > maxRows) throw new Error(`行数超出上限 ${maxRows} 行`);
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      finishRow();
    } else field += ch;
  }
  if (field !== '' || row.length) finishRow();
  return rows;
}

/** 读取 CSV：BOM 剥离、分隔符自动识别、GBK 编码回落 */
export function readCsv(buf: Buffer, maxRows?: number): { rows: string[][] } {
  let text: string;
  // UTF-8 严格解码失败 → GB18030（Excel 中文环境「另存为 CSV」默认 ANSI/GBK）
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('gb18030').decode(buf);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  // 分隔符识别：首行（截到第一个换行）中 , ; \t 出现次数最多者
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts: Array<[string, number]> = [
    [',', (firstLine.match(/,/g) ?? []).length],
    [';', (firstLine.match(/;/g) ?? []).length],
    ['\t', (firstLine.match(/\t/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  const delim = counts[0][1] > 0 ? counts[0][0] : ',';
  return { rows: parseCsvText(text, delim, maxRows) };
}

/** 统一入口：按魔数识别 xlsx / CSV，返回全部工作表（CSV 视为单表） */
export function readSpreadsheet(buf: Buffer, opts: ReadSpreadsheetOptions = {}): { kind: 'xlsx' | 'csv'; sheets: SheetData[] } {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return { kind: 'xlsx', sheets: readXlsx(buf, opts).sheets };
  }
  // 二进制垃圾检测：控制字符占比过高则拒绝
  let ctrl = 0;
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  for (const b of sample) if (b < 9 || (b > 13 && b < 32)) ctrl++;
  if (sample.length > 0 && ctrl / sample.length > 0.1) {
    throw new Error('无法识别的文件格式（仅支持 .xlsx 与 .csv）');
  }
  return { kind: 'csv', sheets: [{ name: 'CSV', rows: readCsv(buf, opts.maxRows).rows }] };
}

/** Excel 序列数（1900 体系）→ YYYY-MM-DD；超出合理范围返回 null */
export function excelSerialToDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 61 || serial > 100000) return null;
  const ms = Math.floor((serial - 25569) * 86400000);
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
