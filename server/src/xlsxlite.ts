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

interface ZipEntry {
  name: string;
  data: Buffer;
}

/** 解析 ZIP：返回 文件名 → 内容 映射 */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
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
  // 2) 遍历中央目录
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const method = buf.readUInt16LE(cdOffset + 10);
    const compSize = buf.readUInt32LE(cdOffset + 20);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localOffset = buf.readUInt32LE(cdOffset + 42);
    const name = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen);
    cdOffset += 46 + nameLen + extraLen + commentLen;
    // 3) 读本地头，取数据
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`ZIP 本地头损坏：${name}`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) {
      out.set(name, Buffer.from(raw));
    } else if (method === 8) {
      out.set(name, zlib.inflateRawSync(raw));
    } else {
      throw new Error(`不支持的 ZIP 压缩方式 ${method}：${name}`);
    }
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

/** 解析 sharedStrings.xml 为字符串表 */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const sis = xml.match(/<si(?:\s[^>]*)?>[\s\S]*?<\/si>|<si\/>/g) ?? [];
  for (const si of sis) {
    const ts = si.match(/<t(?:\s[^>]*)?>[\s\S]*?<\/t>/g) ?? [];
    out.push(ts.map((x) => decodeXmlEntities(stripCdata(x.replace(/<t(?:\s[^>]*)?>/, '').replace(/<\/t>/, '')))).join(''));
  }
  return out;
}

// ============================ xlsx 主入口 ============================

/**
 * 读取 xlsx 全部工作表。
 * 返回 { sheets: [{name, rows}] }（按 workbook 声明顺序）。
 */
export function readXlsx(buf: Buffer): { sheets: SheetData[] } {
  const files = unzip(buf);
  const wbXml = files.get('xl/workbook.xml');
  if (!wbXml) throw new Error('xlsx 缺少 xl/workbook.xml（可能不是 Excel 工作簿）');
  const shared = files.has('xl/sharedStrings.xml')
    ? parseSharedStrings(files.get('xl/sharedStrings.xml')!.toString('utf8'))
    : [];

  // workbook.xml.rels：rId → worksheet 路径
  const relsXml = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const relMap = new Map<string, string>();
  for (const rel of relsXml.match(/<Relationship\b[^>]*\/?>/g) ?? []) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (id && target && target.includes('worksheets/')) {
      relMap.set(id, 'xl/' + target.replace(/^\//, ''));
    }
  }

  // workbook.xml 的 sheet 列表（按声明顺序）
  const sheets: SheetData[] = [];
  for (const sheetTag of wbXml.toString('utf8').match(/<sheet\b[^>]*\/?>/g) ?? []) {
    const name = attr(sheetTag, 'name') ?? `Sheet${sheets.length + 1}`;
    const rid = attr(sheetTag, 'r:id') ?? attr(sheetTag, 'id');
    const path = rid ? relMap.get(rid) : undefined;
    const sheetFile = path ? files.get(path) : files.get(`xl/worksheets/sheet${sheets.length + 1}.xml`);
    // t="s" 的单元格值为 sharedStrings 下标，统一回填为真实文本
    const rows = sheetFile ? backfillShared(sheetFile.toString('utf8'), shared) : [];
    sheets.push({ name, rows });
  }
  if (!sheets.length) throw new Error('xlsx 中没有工作表');
  return { sheets };
}

/** 解析 sheet XML：单元格 → 行数组（t="s" 回填共享字符串，inlineStr/数字/布尔直取） */
function backfillShared(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  const rowTags = xml.match(/<row[^>]*\/>|<row[^>]*>[\s\S]*?<\/row>/g) ?? [];
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
      if (ci >= 0) {
        while (cells.length < ci) cells.push('');
        cells[ci] = value;
      } else if (value !== '') {
        cells.push(value);
      }
    }
    rows.push(cells);
  }
  return rows;
}

// ============================ CSV ============================

/** 按分隔符解析 CSV 文本（支持引号包裹、双引号转义、引号内换行） */
function parseCsvText(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
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
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** 读取 CSV：BOM 剥离、分隔符自动识别、GBK 编码回落 */
export function readCsv(buf: Buffer): { rows: string[][] } {
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
  return { rows: parseCsvText(text, delim) };
}

/** 统一入口：按魔数识别 xlsx / CSV，返回全部工作表（CSV 视为单表） */
export function readSpreadsheet(buf: Buffer): { kind: 'xlsx' | 'csv'; sheets: SheetData[] } {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return { kind: 'xlsx', sheets: readXlsx(buf).sheets };
  }
  // 二进制垃圾检测：控制字符占比过高则拒绝
  let ctrl = 0;
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  for (const b of sample) if (b < 9 || (b > 13 && b < 32)) ctrl++;
  if (sample.length > 0 && ctrl / sample.length > 0.1) {
    throw new Error('无法识别的文件格式（仅支持 .xlsx 与 .csv）');
  }
  return { kind: 'csv', sheets: [{ name: 'CSV', rows: readCsv(buf).rows }] };
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
