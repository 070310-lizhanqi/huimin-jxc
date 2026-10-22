/**
 * 回归测试：Excel/CSV 单据智能导入（v0.2.1）。
 * 闭环① MVP 场景：xlsx/CSV 解析、列自动识别、类型推断、单号分组、落库草稿、审核过账。
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

/** 原始字节上传导入接口 */
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
  console.log('[test-doc-import] 闭环①：Excel/CSV 单据智能导入 MVP');

  // 前置：拿演示档案
  const prods = (await api('GET', '/product?teamId=1')).body;
  const cuss = (await api('GET', '/customer?teamId=1')).body;
  const ven = (await api('GET', '/vendor?teamId=1')).body[0];
  const prod = prods[0], cus = cuss[0];
  const docCountBefore = (await api('GET', '/doc/list?teamId=1&rows=1')).body.total;

  // ---------- 场景 1：CSV 销售导入（单号分组，2 单 3 行） ----------
  const csv = [
    '单号,日期,客户,商品名称,数量,单价,金额',
    `XS001,2026-10-20,${cus.name},${prod.name},2,10.00,20.00`,
    `XS001,2026-10-20,${cus.name},${prods[1].name},1,5.50,5.50`,
    `XS002,2026-10-19,${cus.name},${prod.name},3,8.00,24.00`,
  ].join('\r\n');
  const dry = await uploadImport(Buffer.from('\ufeff' + csv, 'utf8'), '?dryRun=1');
  check('CSV dryRun 返回 200', dry.status === 200, dry.body);
  check('CSV 识别为 2 张单', dry.body.summary && dry.body.summary.billCount === 2, dry.body.summary);
  check('CSV 类型推断为销售出库', dry.body.bills.every((b) => b.type === 'stockout'), dry.body.bills && dry.body.bills.map((b) => b.type));
  check('dryRun 未建单', (await api('GET', '/doc/list?teamId=1&rows=1')).body.total === docCountBefore);

  const real = await uploadImport(Buffer.from('\ufeff' + csv, 'utf8'), '');
  check('CSV 实际导入 200', real.status === 200, real.body);
  check('CSV 建了 2 张草稿', real.body.created && real.body.created.length === 2, real.body.created);
  const c1 = real.body.created[0];
  check('单号分组：XS001 含 2 个明细', c1.itemCount === 2, c1);
  // 查详情核对金额与客户
  const info1 = (await api('GET', `/doc/info?teamId=1&id=${c1.id}`)).body;
  check('XS001 客户正确', info1.doc.partnerId === cus.id && info1.doc.partnerType === 'cus', info1.doc);
  check('XS001 金额 = 2000+550 = 2550 分', info1.doc.totalAmount === 2550, info1.doc.totalAmount);
  check('XS001 草稿状态', info1.doc.status === 'draft', info1.doc.status);
  check('XS001 记录外部单号', info1.doc.srcBillNo === 'XS001', info1.doc.srcBillNo);

  // 幂等：重复导入同一文件 → 全部跳过
  const again = await uploadImport(Buffer.from('\ufeff' + csv, 'utf8'), '');
  check('重复导入被幂等跳过', again.body.summary.skipCount === 2 && again.body.created.length === 0, again.body.summary);

  // ---------- 场景 2：xlsx 采购导入（共享字符串 + 数字，供应商推断） ----------
  const xlsx = buildXlsx([
    ['日期', '供应商', '商品名称', '数量', '单价', '备注'],
    ['2026-10-18', ven.name, prod.name, 10, 3.25, '上午到货'],
    ['2026-10-18', ven.name, prods[1].name, 5, 2.00, ''],
  ]);
  const dry2 = await uploadImport(xlsx, '?dryRun=1');
  check('xlsx dryRun 返回 200', dry2.status === 200, dry2.body);
  check('xlsx 类型推断为采购入库', dry2.body.bills.every((b) => b.type === 'stockin'), dry2.body.bills && dry2.body.bills.map((b) => b.type));
  check('xlsx 无单号列按日期+供应商聚合为 1 单', dry2.body.summary.billCount === 1, dry2.body.summary);

  const real2 = await uploadImport(xlsx, '');
  check('xlsx 导入成功', real2.status === 200 && real2.body.created.length === 1, real2.body);
  const c2 = real2.body.created[0];
  const info2 = (await api('GET', `/doc/info?teamId=1&id=${c2.id}`)).body;
  check('xlsx 金额 = 3250+1000 = 4250 分', info2.doc.totalAmount === 4250, info2.doc.totalAmount);
  check('xlsx 备注写入', (info2.doc.remark || '').includes('Excel导入') && (info2.doc.remark || '').includes('上午到货'), info2.doc.remark);

  // 审核链路：审核 xlsx 采购单 → 库存 +15
  const stockBefore = (await api('GET', `/stock/list?teamId=1&productId=${prod.id}&rows=50`)).body;
  const qtyBefore = (stockBefore.rows || stockBefore).reduce((s, r) => s + (r.productId === prod.id ? r.qty : 0), 0);
  const audit = await api('POST', '/doc/audit', { teamId: 1, id: c2.id, auditBy: 'import-test' });
  check('导入单可审核', audit.status === 200, audit.body);
  const stockAfter = (await api('GET', `/stock/list?teamId=1&productId=${prod.id}&rows=50`)).body;
  const qtyAfter = (stockAfter.rows || stockAfter).reduce((s, r) => s + (r.productId === prod.id ? r.qty : 0), 0);
  check('审核后库存 +10', Math.abs(qtyAfter - qtyBefore - 10) < 1e-6, { qtyBefore, qtyAfter });

  // ---------- 场景 3：显式类型列 + 混合方向 ----------
  const mixed = buildXlsx([
    ['类型', '单号', '日期', '客户', '供应商', '商品名称', '数量', '单价'],
    ['销售出库', 'MX1', '2026-10-20', cus.name, '', prod.name, 1, 9.99],
    ['采购入库', 'MX2', '2026-10-20', '', ven.name, prod.name, 4, 1.00],
  ]);
  const m = await uploadImport(mixed, '');
  check('混合类型导入 2 单', m.body.created.length === 2 && m.body.created.every((c) => c.itemCount === 1), m.body.created && m.body.summary);
  const tset = new Set(m.body.created.map((c) => c.type));
  check('混合类型方向正确', tset.has('stockout') && tset.has('stockin'), [...tset]);

  // ---------- 场景 4：错误行报告 ----------
  const bad = buildXlsx([
    ['单号', '日期', '客户', '商品名称', '数量', '单价'],
    ['E1', '2026-10-20', cus.name, '不存在的商品', 1, 1],
    ['E2', '2026-10-20', cus.name, prod.name, 0, 1],
    ['E3', '2026-10-20', cus.name, prod.name, 1, 'abc'],
  ]);
  const b = await uploadImport(bad, '');
  check('错误行被拒绝且报行号', b.body.rowErrors.length === 3, b.body.rowErrors);
  check('未识别商品报错', b.body.rowErrors.some((e) => e.msg.includes('不存在的商品')), b.body.rowErrors);
  check('零数量报错', b.body.rowErrors.some((e) => e.msg.includes('数量无效')), b.body.rowErrors);
  check('非法单价报错', b.body.rowErrors.some((e) => e.msg.includes('单价无效')), b.body.rowErrors);
  check('错误单未入库', b.body.created.length === 0, b.body.summary);

  // ---------- 场景 5：缺必需列 ----------
  const noQty = buildXlsx([['商品名称', '客户'], [prod.name, cus.name]]);
  const nq = await uploadImport(noQty, '');
  check('缺数量列 400', nq.status === 400 && /数量/.test(nq.body.error || ''), nq.body);

  const garbage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);
  const g = await uploadImport(garbage, '');
  check('二进制垃圾 400', g.status === 400, g.body);

  console.log(`[test-doc-import] 通过 ${pass} / ${pass + fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('[test-doc-import] 异常:', e.message); process.exit(1); });
