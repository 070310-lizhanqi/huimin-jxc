/**
 * 测试辅助：生成最小可用 xlsx 文件（STORED ZIP，无压缩）。
 * 仅需满足本项目 xlsxlite 读取器的解析路径：
 * [Content_Types].xml / xl/workbook.xml / xl/_rels/workbook.xml.rels /
 * xl/worksheets/sheet1.xml / xl/sharedStrings.xml
 */
'use strict';

/** 构造一个最小 ZIP（STORED，无压缩，CRC 写 0——读取器不校验 CRC） */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const dataBuf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    // 本地头：30 字节 + 文件名 + 数据
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(0, 14); // crc32（读取器不校验）
    local.writeUInt32LE(dataBuf.length, 18); // comp size = uncomp size
    local.writeUInt32LE(dataBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    chunks.push(local, nameBuf, dataBuf);
    // 中央目录项：46 字节 + 文件名
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(0, 16); // crc
    cd.writeUInt32LE(dataBuf.length, 20);
    cd.writeUInt32LE(dataBuf.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42); // 本地头偏移
    central.push(Buffer.concat([cd, nameBuf]));
    offset += 30 + nameBuf.length + dataBuf.length;
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

/** 列号 → Excel 列字母（0 → A） */
function colName(n) {
  let s = '';
  n += 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * 生成 xlsx Buffer。
 * @param {string[][]} rows 二维数据（rows[0] = 表头）
 * @param {object} opts { useSharedStrings: 文本单元格走 sharedStrings；sheetName }
 */
function buildXlsx(rows, opts = {}) {
  const useSS = opts.useSharedStrings !== false;
  const shared = [];
  const escCell = (v) => {
    if (v == null || v === '') return '';
    const isNum = typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v));
    if (isNum) return `<c r="R" ><v>${v}</v></c>`;
    let ref = 0;
    if (useSS) { shared.push(String(v)); ref = shared.length - 1; }
    // R 占位符在循环里替换为真实单元格引用
    return useSS
      ? `__SS__<c r="R" t="s"><v>${ref}</v></c>`
      : `<c r="R" t="inlineStr"><is><t>${xmlEsc(v)}</t></is></c>`;
  };
  const rowXml = rows
    .map((cells, ri) => {
      const cellXml = cells
        .map((v, ci) => escCell(v).replace(/r="R"/g, `r="${colName(ci)}${ri + 1}"`))
        .join('');
      return `<row r="${ri + 1}">${cellXml}</row>`;
    })
    .join('');
  const entries = [
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(opts.sheetName || 'Sheet1')}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`,
    },
  ];
  if (useSS && shared.length) {
    entries.push({
      name: 'xl/sharedStrings.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t>${xmlEsc(s)}</t></si>`).join('')}</sst>`,
    });
  }
  return buildZip(entries);
}

module.exports = { buildXlsx };
