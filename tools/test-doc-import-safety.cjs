/**
 * 回归测试：Excel/CSV 单据智能导入 —— 闭环③ 安全与体验。
 * 覆盖：行号精确（含空行错位修复）、行数上限、未登录 401、
 * 上传空体 400、导入后作废冲回、导入单在列表可见。
 */
const { api, authHeader } = require('./test-helpers.cjs');
const { buildXlsx } = require('./xlsx-writer.cjs');
// 服务端口可能因占用自动后移，统一从环境变量取基址（run-tests.cjs 会注入）
const OC_BASE = process.env.OC_BASE || 'http://127.0.0.1:7741/api';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok - ' + name); }
  else { fail++; console.log('  FAIL - ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}

async function uploadImport(buf, qs, withAuth = true) {
  const headers = { 'content-type': 'application/octet-stream' };
  if (withAuth) Object.assign(headers, await authHeader());
  const res = await fetch(
    `${OC_BASE}/doc/import${qs || ''}`,
    { method: 'POST', headers, body: buf },
  );
  const j = await res.json().catch(() => ({ error: 'non-json' }));
  return { status: res.status, body: j };
}

async function main() {
  console.log('[test-doc-import-safety] 闭环③：安全与体验');

  const prods = (await api('GET', '/product?teamId=1')).body;
  const cus = (await api('GET', '/customer?teamId=1')).body[0];
  const prod = prods[0];

  // ---------- 1) 行号精确：空行后的错误行号不能偏移 ----------
  const rows = [
    ['单号', '客户', '商品名称', '数量', '单价'],
    ['S1', cus.name, prod.name, 1, 1],        // 第 2 行：正常
    ['', '', '', '', ''],                      // 第 3 行：空行
    ['', '', '', '', ''],                      // 第 4 行：空行
    ['S2', cus.name, '不存在的商品', 1, 1],    // 第 5 行：错误——行号必须是 5
  ];
  const rn = await uploadImport(buildXlsx(rows), '?dryRun=1');
  check('空行后错误行号不偏移（应为第 5 行）', rn.body.rowErrors.length === 1 && rn.body.rowErrors[0].row === 5, rn.body.rowErrors);

  // ---------- 2) 行数上限 ----------
  const big = [['单号', '客户', '商品名称', '数量', '单价']];
  for (let i = 0; i < 2001; i++) big.push(['B' + i, cus.name, prod.name, 1, 1]);
  const bl = await uploadImport(buildXlsx(big), '?dryRun=1');
  check('超 2000 行被拒绝', bl.status === 400 && /最多导入 2000 行/.test(bl.body.error || ''), bl.body);

  // ---------- 3) 未登录 401 ----------
  const unauth = await uploadImport(Buffer.from('单号,客户,商品名称,数量,单价', 'utf8'), '?dryRun=1', false);
  check('未登录 401', unauth.status === 401, unauth.body);

  // ---------- 4) 空体 400 ----------
  const empty = await uploadImport(Buffer.alloc(0), '');
  check('空上传体 400', empty.status === 400, empty.body);

  // ---------- 5) 只有表头 400 ----------
  const headerOnly = await uploadImport(buildXlsx([['单号', '客户', '商品名称', '数量', '单价']]), '');
  check('只有表头 400', headerOnly.status === 400 && /没有数据行/.test(headerOnly.body.error || ''), headerOnly.body);

  // ---------- 6) 导入 → 审核 → 作废 全链路 ----------
  const docCount0 = (await api('GET', '/doc/list?teamId=1&rows=1')).body.total;
  const stock0 = (await api('GET', `/stock/list?teamId=1&productId=${prod.id}&rows=50`)).body;
  const qty0 = (stock0.rows || stock0).reduce((s, r) => s + (r.productId === prod.id ? r.qty : 0), 0);
  const bal0 = (await api('GET', '/partner/balance?teamId=1')).body.find((b) => b.partnerType === 'cus' && b.partnerId === cus.id);

  const sale = buildXlsx([
    ['单号', '日期', '客户', '商品名称', '数量', '单价'],
    ['FULL-1', '2026-10-20', cus.name, prod.name, 2, 50.00],
  ]);
  const imp = await uploadImport(sale, '');
  check('导入销售草稿', imp.status === 200 && imp.body.created.length === 1, imp.body);
  const id = imp.body.created[0].id;
  check('导入后列表 +1', (await api('GET', '/doc/list?teamId=1&rows=1')).body.total === docCount0 + 1);
  const au = await api('POST', '/doc/audit', { teamId: 1, id, auditBy: 'import-safety' });
  check('导入单可审核', au.status === 200, au.body);
  const stock1 = (await api('GET', `/stock/list?teamId=1&productId=${prod.id}&rows=50`)).body;
  const qty1 = (stock1.rows || stock1).reduce((s, r) => s + (r.productId === prod.id ? r.qty : 0), 0);
  check('审核后库存 -2', Math.abs(qty1 - qty0 + 2) < 1e-6, { qty0, qty1 });
  const vo = await api('POST', '/doc/void', { teamId: 1, id });
  check('导入单可作废', vo.status === 200, vo.body);
  const stock2 = (await api('GET', `/stock/list?teamId=1&productId=${prod.id}&rows=50`)).body;
  const qty2 = (stock2.rows || stock2).reduce((s, r) => s + (r.productId === prod.id ? r.qty : 0), 0);
  check('作废后库存回到原位', Math.abs(qty2 - qty0) < 1e-6, { qty0, qty2 });
  const bal2 = (await api('GET', '/partner/balance?teamId=1')).body.find((b) => b.partnerType === 'cus' && b.partnerId === cus.id);
  check('作废后客户余额不变', (!bal0 && !bal2) || (bal0 && bal2 && bal0.balance === bal2.balance), { bal0, bal2 });

  // ---------- 7) 作废后的单号不能重复导入？—— srcBillNo 幂等只看存在性（含作废单） ----------
  const reImp = await uploadImport(sale, '');
  check('已导入单号（即使已作废）仍跳过', reImp.body.summary.skipCount === 1, reImp.body.summary);

  console.log(`[test-doc-import-safety] 通过 ${pass} / ${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('[test-doc-import-safety] 异常:', e.message); process.exit(1); });
