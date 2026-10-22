const B = process.env.OC_BASE || 'http://127.0.0.1:7741/api';
const { authHeader } = require('./test-helpers.cjs');
async function j(path, body) {
  const opt = body
    ? { method: 'POST', headers: { 'content-type': 'application/json', ...(await authHeader()) }, body: JSON.stringify(body) }
    : { headers: await authHeader() };
  const r = await fetch(B + path, opt);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { _html: t.slice(0, 80) }; }
}
(async () => {
  const T = (await j('/auth/me')).user.teamId;
  // 导入含批发价的行
  const r = await j('/product/import', {
    teamId: T,
    rows: [
      { name: '导入测试甲', unit: '件', catName: '导入测试类', barcode: 'IT001', spec: '500ml', purchasePrice: '1.50', salePrice: '3.00', retailPrice: '3.50', wholePrice: '2.80', lowQty: '24', remark: '导入验证' },
      { name: '导入测试乙', unit: '件', purchasePrice: '￥2.00', salePrice: '4.00', retailPrice: '4.50', wholePrice: '3.60', lowQty: '' },
    ],
  });
  console.log('import:', JSON.stringify(r));
  const list = await j(`/product?teamId=${T}`);
  for (const p of list.filter((x) => x.name.startsWith('导入测试'))) {
    console.log('  ->', p.name, 'sale', p.salePrice, 'retail', p.retailPrice, 'whole', p.wholePrice, 'buy', p.purchasePrice);
  }
  // 清理
  for (const p of list.filter((x) => x.name.startsWith('导入测试'))) {
    await fetch(`${B}/product/${p.id}?teamId=${T}`, { method: 'DELETE', headers: await authHeader() });
  }
  const cats = await j(`/cat?teamId=${T}`);
  for (const c of cats.filter((x) => x.name === '导入测试类')) {
    await fetch(`${B}/cat/${c.id}?teamId=${T}`, { method: 'DELETE', headers: await authHeader() });
  }
  console.log('cleaned');
})();
