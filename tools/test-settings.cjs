const B = process.env.OC_BASE || 'http://127.0.0.1:7741/api';
const { authHeader } = require('./test-helpers.cjs');
let T = null;
async function get(path) {
  const r = await fetch(B + path, { headers: await authHeader() });
  return JSON.parse(await r.text());
}
async function post(path, body) {
  const r = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(await authHeader()) }, body: JSON.stringify(body) });
  return JSON.parse(await r.text());
}
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`PASS | ${name}${extra ? ' | ' + extra : ''}`); }
  else { fail++; console.log(`FAIL | ${name}${extra ? ' | ' + extra : ''}`); }
};

(async () => {
  T = (await get('/auth/me')).user.teamId;
  // 1. 默认设置
  const s0 = await get(`/setting/get?teamId=${T}`);
  ok('读默认设置', s0.prefix && s0.prefix.stockout === 'CK' && s0.noMode === 'day', `prefix.stockout=${s0.prefix?.stockout} noMode=${s0.noMode}`);
  ok('打印默认抬头', s0.print && typeof s0.print.footer === 'string', `footer=${s0.print?.footer?.slice(0, 10)}`);

  // 2. 改前缀
  const p1 = await post('/setting/prefix', { teamId: T, prefix: { stockout: 'SO', stockin: 'SI' } });
  ok('保存前缀 stockout=SO', p1.ok && p1.prefix.stockout === 'SO' && p1.prefix.stockin === 'SI', `stockout=${p1.prefix?.stockout}`);

  // 3. 非法前缀
  const p2 = await post('/setting/prefix', { teamId: T, prefix: { stockout: 'TOO_LONG_X' } });
  ok('非法前缀被拒', !!p2.error, p2.error || '');

  // 4. 建单验证前缀生效
  const wh = (await get(`/warehouse?teamId=${T}`))[0];
  const prods = await get(`/product?teamId=${T}`);
  const prod = prods.find((p) => p.name === '红富士苹果') || prods[0];
  const cus = await post('/customer', { teamId: T, name: '设置测试客户' + (Date.now() % 10000) });
  const CUS_ID = cus.id;
  // 先入库备货
  const d0 = await post('/doc/create', {
    teamId: T, type: 'stockin', warehouseId: wh.id, remark: '设置测试备货',
    items: [{ productId: prod.id, qty: 20, price: 5000 }],
  });
  ok('入库单使用新前缀 SI', String(d0.billNo || '').startsWith('SI'), d0.billNo || JSON.stringify(d0));
  await post('/doc/audit', { teamId: T, id: d0.id });

  const d1 = await post('/doc/create', {
    teamId: T, type: 'stockout', partnerType: 'cus', partnerId: CUS_ID, warehouseId: wh.id, remark: '设置测试出库',
    items: [{ productId: prod.id, qty: 1, price: 8000 }],
  });
  ok('出库单使用新前缀 SO', String(d1.billNo || '').startsWith('SO'), d1.billNo || JSON.stringify(d1));

  // 5. 改重置方式为 month
  const m1 = await post('/setting/no-mode', { teamId: T, noMode: 'month' });
  ok('保存编号重置=month', m1.ok && m1.noMode === 'month');

  const d2 = await post('/doc/create', {
    teamId: T, type: 'stockout', partnerType: 'cus', partnerId: CUS_ID, warehouseId: wh.id, remark: '按月编号测试',
    items: [{ productId: prod.id, qty: 1, price: 8000 }],
  });
  // 应为 SO + YYYYMM + 序号
  const expectLen = 'SO'.length + 6 + 4;
  ok('按月编号格式', d2.billNo && d2.billNo.length === expectLen, `${d2.billNo} len=${d2.billNo?.length} expect=${expectLen}`);

  // 6. 非法重置方式
  const m2 = await post('/setting/no-mode', { teamId: T, noMode: 'week' });
  ok('非法重置方式被拒', !!m2.error, m2.error || '');

  // 7. 保存打印抬头
  const pr = await post('/setting/print', {
    teamId: T,
    print: { company: '测试商贸有限公司', address: '深圳市南山区', phone: '0755-12345678', footer: '谢谢惠顾', showLogo: false },
  });
  ok('保存打印抬头', pr.ok && pr.print.company === '测试商贸有限公司' && pr.print.showLogo === false, pr.print?.company);

  // 8. 读回
  const s2 = await get(`/setting/get?teamId=${T}`);
  ok('读回打印抬头', s2.print.company === '测试商贸有限公司' && s2.print.footer === '谢谢惠顾');
  ok('读回前缀', s2.prefix.stockout === 'SO' && s2.prefix.stockin === 'SI');
  ok('读回重置方式', s2.noMode === 'month');

  // 9. 缺 teamId（由令牌注入，不报错且写入本团队）
  const e1 = await post('/setting/prefix', { prefix: { stockout: 'X' } });
  ok('缺 teamId 时令牌注入不报错', e1.ok && e1.prefix.stockout === 'X', JSON.stringify(e1).slice(0, 80));

  // 10. 恢复默认
  const r1 = await post('/setting/reset', { teamId: T, scope: 'all' });
  ok('恢复默认前缀', r1.ok && r1.prefix.stockout === 'CK' && r1.noMode === 'day', `stockout=${r1.prefix?.stockout}`);
  const s3 = await get(`/setting/get?teamId=${T}`);
  ok('恢复后打印抬头为空', s3.print.company === '');

  // 清理草稿
  for (const d of [d1, d2]) {
    if (d.id) await fetch(`${B}/doc/${d.id}?teamId=${T}`, { method: 'DELETE', headers: await authHeader() });
  }
  // 出库备货回滚：作废刚才的入库单
  await post('/doc/void', { teamId: T, id: d0.id });

  console.log(`\n===== ${pass} PASS / ${fail} FAIL =====`);
  process.exit(fail ? 1 : 0);
})();
