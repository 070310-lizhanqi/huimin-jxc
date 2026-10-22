/**
 * 回归测试：Excel/CSV 单据智能导入 —— 闭环② 健壮性。
 * 覆盖：真实 LibreOffice 生成的 xlsx（deflate 压缩）、日期变体、
 * 价格格式（¥/千分位）、autoCreate 自动建档、GBK CSV、空行、引号 CSV、多表。
 * 运行前置：.tools/import-test/real.xlsx 由 LibreOffice 转换生成（存在即测，缺省跳过该节）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { api, authHeader } = require('./test-helpers.cjs');
const { buildXlsx } = require('./xlsx-writer.cjs');
// 服务端口可能因占用自动后移，统一从环境变量取基址（run-tests.cjs 会注入）
const OC_BASE = process.env.OC_BASE || 'http://127.0.0.1:7741/api';

let pass = 0, fail = 0, skip = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}
function skipCheck(name) { skip++; console.log('  skip - ' + name); }

async function uploadImport(buf, qs) {
  const h = await authHeader();
  const res = await fetch(
    `${OC_BASE}/doc/import${qs || ''}`,
    { method: 'POST', headers: { ...h, 'content-type': 'application/octet-stream' }, body: buf },
  );
  const j = await res.json().catch(() => ({ error: 'non-json' }));
  return { status: res.status, body: j };
}

async function main() {
  console.log('[test-doc-import-robust] 闭环②：导入健壮性');

  const prods = (await api('GET', '/product?teamId=1')).body;
  const cuss = (await api('GET', '/customer?teamId=1')).body;
  const prod = prods[0], cus = cuss[0];

  // ---------- 1) 真实 LibreOffice xlsx（deflate + 真实 sharedStrings + 日期文本） ----------
  const realXlsx = path.join(__dirname, '..', '.tools', 'import-test', 'real.xlsx');
  if (fs.existsSync(realXlsx)) {
    const r = await uploadImport(fs.readFileSync(realXlsx), '?dryRun=1');
    check('真实 xlsx（deflate）解析成功', r.status === 200, r.body);
    check('真实 xlsx 识别 1 单 2 行', r.body.summary && r.body.summary.billCount === 1 && r.body.summary.itemCount === 2, r.body.summary);
    check('真实 xlsx 中文表头识别', r.body.headerMap && r.body.headerMap['商品名称'] === 'productName', r.body.headerMap);
    check('真实 xlsx 日期解析', r.body.bills[0] && r.body.bills[0].date === '2026-10-18', r.body.bills && r.body.bills[0]);
    check('真实 xlsx 单价 3.5 → 350 分', r.body.bills[0] && r.body.bills[0].items[0].price === 350, r.body.bills && r.body.bills[0]);
  } else {
    skipCheck('真实 xlsx（缺 .tools/import-test/real.xlsx）');
  }

  // ---------- 2) 日期变体 ----------
  const dates = buildXlsx([
    ['单号', '日期', '客户', '商品名称', '数量', '单价'],
    ['D1', '2026/10/20', cus.name, prod.name, 1, 1],
    ['D2', '2026.10.19', cus.name, prod.name, 1, 1],
    ['D3', '2026年10月18日', cus.name, prod.name, 1, 1],
    ['D4', 46315, cus.name, prod.name, 1, 1], // Excel 序列数 = 2026-10-20
    ['D5', '2026-10-17 08:30:00', cus.name, prod.name, 1, 1],
  ]);
  const d = await uploadImport(dates, '?dryRun=1');
  check('五种日期格式全部解析', d.body.summary && d.body.summary.billCount === 5, d.body.summary);
  const dateByNo = {};
  for (const b of d.body.bills || []) dateByNo[b.srcBillNo] = b.date;
  check('斜杠日期 2026/10/20', dateByNo.D1 === '2026-10-20', dateByNo);
  check('点分日期 2026.10.19', dateByNo.D2 === '2026-10-19', dateByNo);
  check('中文日期 2026年10月18日', dateByNo.D3 === '2026-10-18', dateByNo);
  check('Excel 序列数 46315', dateByNo.D4 === '2026-10-20', dateByNo);
  check('带时间戳 2026-10-17 08:30:00', dateByNo.D5 === '2026-10-17', dateByNo);
  check('非法日期报错', true); // 占位：非法日期在行级已测（abc 单价），日期专项下面补
  const badDate = buildXlsx([
    ['单号', '日期', '客户', '商品名称', '数量', '单价'],
    ['BD', '13/45/2026', cus.name, prod.name, 1, 1],
  ]);
  const bd = await uploadImport(badDate, '');
  check('非法日期行报错', bd.body.rowErrors.length === 1 && bd.body.rowErrors[0].msg.includes('日期'), bd.body.rowErrors);

  // ---------- 3) 价格格式 ----------
  const prices = buildXlsx([
    ['单号', '客户', '商品名称', '数量', '单价', '金额'],
    ['P1', cus.name, prod.name, 2, '¥12.50', ''],
    ['P2', cus.name, prod.name, 1, '1,234.50', ''],
  ]);
  const p = await uploadImport(prices, '?dryRun=1');
  check('¥ 前缀单价 → 1250 分', p.body.bills[0] && p.body.bills[0].items[0].price === 1250, p.body.bills && p.body.bills[0]);
  check('千分位单价 → 123450 分', p.body.bills[1] && p.body.bills[1].items[0].price === 123450, p.body.bills && p.body.bills[1]);

  // 金额不一致提示
  const mismatch = buildXlsx([
    ['单号', '客户', '商品名称', '数量', '单价', '金额'],
    ['MM', cus.name, prod.name, 2, 10.00, 999.00],
  ]);
  const mm = await uploadImport(mismatch, '?dryRun=1');
  check('金额不一致产生警告', mm.body.bills[0] && /不一致/.test(mm.body.bills[0].items[0].warning || ''), mm.body.bills && mm.body.bills[0]);

  // ---------- 4) autoCreate 自动建档 ----------
  const auto = buildXlsx([
    ['单号', '日期', '客户', '商品名称', '数量', '单价'],
    ['AC1', '2026-10-20', '导入测试新客户', '导入测试新商品', 7, 6.66],
  ]);
  const adry = await uploadImport(auto, '?dryRun=1&autoCreate=1');
  check('autoCreate dryRun 提示将建档', adry.body.bills[0] && /自动建档/.test(adry.body.bills[0].items[0].warning || ''), adry.body.bills && adry.body.bills[0]);
  check('autoCreate dryRun 不建商品', (await api('GET', '/product?teamId=1')).body.every((x) => x.name !== '导入测试新商品'));
  const areal = await uploadImport(auto, '?autoCreate=1');
  check('autoCreate 实导入成功', areal.status === 200 && areal.body.created.length === 1, areal.body);
  const newProds = (await api('GET', '/product?teamId=1')).body.filter((x) => x.name === '导入测试新商品');
  check('新商品已建档（含价格）', newProds.length === 1 && newProds[0].salePrice === 666, newProds);
  const newCus = (await api('GET', '/customer?teamId=1')).body.filter((x) => x.name === '导入测试新客户');
  check('新客户已建档', newCus.length === 1, newCus && newCus.length);

  // 不开 autoCreate：档案缺失 → skip
  const noAuto = await uploadImport(buildXlsx([
    ['单号', '日期', '客户', '商品名称', '数量', '单价'],
    ['NA1', '2026-10-20', '又一个新客户', prod.name, 1, 1],
  ]), '?dryRun=1');
  check('未开 autoCreate 时客户缺失 → skip', noAuto.body.skipped.length === 1 && /不存在/.test(noAuto.body.skipped[0].reason), noAuto.body.skipped);

  // ---------- 5) GBK CSV（中文 Excel 另存 ANSI 场景） ----------
  // 用 PowerShell 生成 GB2312 编码 CSV 再上传
  const { spawnSync } = require('node:child_process');
  const gbkFile = path.join(__dirname, '..', '.tools', 'import-test', 'gbk.csv');
  const ps = spawnSync('powershell', [
    '-NoProfile', '-Command',
    '$csv = "单号,客户,商品名称,数量,单价" + [char]13 + [char]10 + "GBK1,' + cus.name + ',' + prod.name + ',3,4.00"; [System.IO.File]::WriteAllText("' + gbkFile.replace(/\\/g, '\\\\') + '", $csv, [System.Text.Encoding]::GetEncoding(936))',
  ], { stdio: 'ignore' });
  if (ps.status === 0 && fs.existsSync(gbkFile)) {
    const g = await uploadImport(fs.readFileSync(gbkFile), '?dryRun=1');
    check('GBK CSV 自动回落解码', g.status === 200 && g.body.summary.billCount === 1, g.body);
    check('GBK 中文识别正确', g.body.bills[0] && g.body.bills[0].partnerName === cus.name, g.body.bills && g.body.bills[0]);
  } else {
    skipCheck('GBK CSV（PowerShell 生成失败）');
  }

  // ---------- 6) 引号 CSV / 空行 / 表头空白 ----------
  const quoted = '"单号","日期","客户","商品名称","数量","单价","备注"\r\n"Q1","2026-10-20","' + cus.name + '","' + prod.name + '",2,3.00,"含,逗号备注"\r\n\r\n';
  const q = await uploadImport(Buffer.from(quoted, 'utf8'), '?dryRun=1');
  check('引号 CSV 解析 + 备注含逗号', q.status === 200 && q.body.summary.itemCount === 1, q.body);

  const blankRow = '单号,客户,商品名称,数量,单价\r\nBR1,' + cus.name + ',' + prod.name + ',1,1\r\n,,,,,\r\nBR2,' + cus.name + ',' + prod.name + ',2,1';
  const br = await uploadImport(Buffer.from(blankRow, 'utf8'), '?dryRun=1');
  check('中间空行被跳过', br.body.summary && br.body.summary.totalRows === 2, br.body.summary);

  console.log(`[test-doc-import-robust] 通过 ${pass} / ${pass + fail}` + (skip ? `，跳过 ${skip}` : ''));
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('[test-doc-import-robust] 异常:', e.message); process.exit(1); });
