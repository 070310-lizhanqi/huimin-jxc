/**
 * 生成一整套真实演示业务流水（覆盖最近 120 天），让工作台/报表/账龄图表都有内容。
 *
 * 做三件事：
 *   1) 清掉测试残留档案（名字带「回归」「测试」的）与全部业务流水
 *   2) 经 HTTP API 建单 → 审核过账，保证库存/往来/资金三条链路都是真实数据
 *   3) 单据日期分散到过去 120 天，让账龄分档、趋势图、排行都有数据
 *
 * 用法：node tools/seed-demo-full.cjs
 * 前置：服务已在 7741 端口运行，账套「鲜果批发部」+ admin/admin123456 已存在
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const BASE = 'http://127.0.0.1:7741/api';
const DB_PATH = path.join(__dirname, '..', 'data', 'huimin-clone.db');
const USER = 'admin';
const PASS = 'admin123456';

let TOKEN = '';

async function api(method, p, body, params) {
  let url = BASE + p;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.set(k, String(v));
    const s = qs.toString();
    if (s) url += '?' + s;
  }
  const opt = { method, headers: {} };
  if (TOKEN) opt.headers.authorization = 'Bearer ' + TOKEN;
  // GET/HEAD 不能带 body（body 为 null 时也不发）
  if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
    opt.headers['content-type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(url, opt);
  let j = null;
  try { j = await res.json(); } catch { j = { error: 'non-json' }; }
  if (res.status >= 400) throw new Error(`${method} ${p} → ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

/** 相对今天偏移 n 天的 YYYY-MM-DD */
function dayAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function createAndAudit(doc) {
  const r = await api('POST', '/doc/create', doc);
  await api('POST', '/doc/audit', { teamId: doc.teamId, id: r.id });
  return r;
}

(async () => {
  // ---------- 1. 清理 ----------
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN');
  for (const t of ['doc_item', 'doc', 'stock_ledger', 'stock', 'settlement', 'partner_balance', 'price_memory', 'bill_seq']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  // 测试残留档案
  const dirty = db.prepare(`SELECT id, name FROM product WHERE name LIKE '%回归%' OR name LIKE '%测试%'`).all();
  for (const r of dirty) db.prepare('DELETE FROM product WHERE id = ?').run(r.id);
  const dirtyCat = db.prepare(`SELECT id, name FROM cat WHERE name LIKE '%回归%' OR name LIKE '%测试%'`).all();
  for (const r of dirtyCat) db.prepare('DELETE FROM cat WHERE id = ?').run(r.id);
  const dirtyWh = db.prepare(`SELECT id, name FROM warehouse WHERE name LIKE '%回归%' OR name LIKE '%测试%'`).all();
  for (const r of dirtyWh) {
    db.prepare('DELETE FROM reservoir WHERE warehouseId = ?').run(r.id);
    db.prepare('DELETE FROM warehouse WHERE id = ?').run(r.id);
  }
  db.exec('DELETE FROM sqlite_sequence');
  db.exec('COMMIT');
  db.exec('PRAGMA foreign_keys = ON;');
  console.log(`清理完成：删除测试商品 ${dirty.length}、分类 ${dirtyCat.length}、仓库 ${dirtyWh.length}，业务流水清空`);

  // ---------- 2. 登录 ----------
  const login = await api('POST', '/auth/login', { username: USER, password: PASS });
  TOKEN = login.token;
  const teamId = login.user.teamId;
  console.log(`登录成功 teamId=${teamId}`);

  // ---------- 3. 读档案 ----------
  const [prods, cuss, vens, whs, accs, clerks, resvs] = await Promise.all([
    api('GET', '/product', null, { teamId }),
    api('GET', '/customer', null, { teamId }),
    api('GET', '/vendor', null, { teamId }),
    api('GET', '/warehouse', null, { teamId }),
    api('GET', '/account', null, { teamId }),
    api('GET', '/clerk', null, { teamId }),
    api('GET', '/reservoir', null, { teamId }),
  ]);
  const P = (name) => prods.find((x) => x.name === name);
  const C = (name) => cuss.find((x) => x.name === name);
  const V = (name) => vens.find((x) => x.name === name);
  const mainWh = whs.find((x) => x.name === '主仓库') || whs[0];
  const coldWh = whs.find((x) => x.name === '冷链仓') || whs[0];
  const cash = accs.find((x) => x.name === '现金') || accs[0];
  const bank = accs.find((x) => x.name === '对公账户') || accs[0];
  const wx = accs.find((x) => x.name === '微信收款') || accs[0];
  const cl1 = clerks[0];
  const cl2 = clerks[1] || clerks[0];
  const resvA = resvs.find((r) => r.name === 'A区常温货架');
  const resvCold = resvs.find((r) => r.name === '冷藏1号库');

  const item = (name, qty, price, extra = {}) => ({
    productId: P(name).id, qty, price, amount: qty * price, ...extra,
  });

  // ---------- 4. 期初库存（120 天前，让库存账龄落到最老一档）----------
  const initItems = [
    item('红富士苹果', 120, P('红富士苹果').purchasePrice),
    item('赣南脐橙', 150, P('赣南脐橙').purchasePrice),
    item('海南香蕉', 300, P('海南香蕉').purchasePrice),
    item('智利车厘子', 40, P('智利车厘子').purchasePrice),
  ];
  await createAndAudit({
    teamId, type: 'stockinit', date: dayAgo(118), warehouseId: mainWh.id,
    remark: '开业期初库存', items: initItems,
  });
  console.log(`期初库存 ${initItems.length} 行（118 天前）`);

  // ---------- 5. 采购入库：分散到 100/75/50/28/12/5 天前，部分付款 ----------
  const PO = [
    { d: 100, ven: '山东果源农产品合作社', wh: mainWh, items: [['红富士苹果', 80, 7600], ['赣南脐橙', 100, 4200]], pay: 0.5, acc: bank },
    { d: 75, ven: '广州进口果品贸易公司', wh: coldWh, items: [['智利车厘子', 30, 21000], ['新西兰奇异果', 60, 5000]], pay: 0.4, acc: bank },
    { d: 50, ven: '江西赣南脐橙基地', wh: mainWh, items: [['赣南脐橙', 120, 4300], ['海南香蕉', 200, 300]], pay: 1, acc: cash },
    { d: 28, ven: '山东果源农产品合作社', wh: mainWh, items: [['红富士苹果', 60, 7800], ['阳光玫瑰葡萄', 40, 3600]], pay: 0.6, acc: wx },
    { d: 12, ven: '广州进口果品贸易公司', wh: coldWh, items: [['泰国金枕榴莲', 18, 15500], ['智利车厘子', 12, 21500]], pay: 0.3, acc: bank },
    { d: 5, ven: '山东果源农产品合作社', wh: mainWh, items: [['精品水果礼盒', 20, 11500], ['海南香蕉', 150, 310]], pay: 0, acc: null },
  ];
  const poDocs = [];
  for (const p of PO) {
    const items = p.items.map(([n, q, pr]) => item(n, q, pr, { reservoirId: p.wh.id === coldWh.id ? resvCold?.id : resvA?.id }));
    const total = items.reduce((a, b) => a + b.amount, 0);
    const paid = Math.round(total * p.pay);
    const r = await createAndAudit({
      teamId, type: 'stockin', date: dayAgo(p.d), warehouseId: p.wh.id,
      partnerType: 'ven', partnerId: V(p.ven).id, clerkId: cl1.id,
      remark: `${p.ven} 补货`, items, paidAmount: paid,
      accountId: paid > 0 ? p.acc.id : null,
    });
    poDocs.push({ ...r, total, paid, d: p.d, venId: V(p.ven).id });
    console.log(`  采购入库 ${r.billNo} ${dayAgo(p.d)} ￥${(total / 100).toFixed(2)} 已付 ￥${(paid / 100).toFixed(2)}`);
  }

  // ---------- 6. 采购退货（45 天前，冲减应付）----------
  {
    const items = [item('赣南脐橙', 20, 4300)];
    const r = await createAndAudit({
      teamId, type: 'pin', date: dayAgo(45), warehouseId: mainWh.id,
      partnerType: 'ven', partnerId: V('江西赣南脐橙基地').id,
      remark: '到货破损退回', items,
    });
    console.log(`  采购退货 ${r.billNo}（45 天前）`);
  }

  // ---------- 7. 销售订单（不动库存，留 2 张已审核 + 1 张待审核）----------
  const soOrders = [
    { d: 20, cus: '鲜果超市（总店）', items: [['红富士苹果', 40, 9800], ['赣南脐橙', 50, 5800]], status: 'audit' },
    { d: 8, cus: '橙心橙意水果连锁', items: [['智利车厘子', 10, 26800], ['新西兰奇异果', 20, 6800]], status: 'audit' },
    { d: 2, cus: '果篮水果店', items: [['阳光玫瑰葡萄', 15, 5000], ['海南香蕉', 60, 420]], status: 'pending' },
  ];
  for (const o of soOrders) {
    const items = o.items.map(([n, q, pr]) => item(n, q, pr));
    const r = await api('POST', '/doc/create', {
      teamId, type: 'sorder', date: dayAgo(o.d),
      partnerType: 'cus', partnerId: C(o.cus).id, clerkId: cl2.id,
      remark: '客户下单', items,
    });
    if (o.status === 'audit') await api('POST', '/doc/audit', { teamId, id: r.id });
    else await api('POST', '/doc/submit', { teamId, id: r.id });
    console.log(`  销售订单 ${r.billNo} ${dayAgo(o.d)} → ${o.cus} [${o.status}]`);
  }

  // ---------- 8. 销售出库：分散到 95/70/40/22/10/3 天前，赊销 + 部分收款 ----------
  const SO = [
    { d: 95, cus: '鲜果超市（总店）', wh: mainWh, cl: cl1, items: [['红富士苹果', 30, 9800], ['赣南脐橙', 40, 5800]], paid: 0 },
    { d: 70, cus: '果篮水果店', wh: mainWh, cl: cl1, items: [['海南香蕉', 80, 420], ['赣南脐橙', 30, 5800]], paid: 0.5 },
    { d: 40, cus: '橙心橙意水果连锁', wh: coldWh, cl: cl2, items: [['智利车厘子', 12, 26800], ['新西兰奇异果', 25, 6800]], paid: 0 },
    { d: 22, cus: '王先生（个人）', wh: mainWh, cl: cl2, items: [['精品水果礼盒', 6, 16800]], paid: 1 },
    { d: 10, cus: '甜蜜时光烘焙坊', wh: mainWh, cl: cl1, items: [['海南香蕉', 100, 420], ['阳光玫瑰葡萄', 20, 5000]], paid: 0.3 },
    { d: 3, cus: '鲜果超市（总店）', wh: coldWh, cl: cl2, items: [['泰国金枕榴莲', 6, 19800], ['智利车厘子', 5, 26800]], paid: 0 },
    { d: 1, cus: '橙心橙意水果连锁', wh: mainWh, cl: cl1, items: [['红富士苹果', 25, 9800], ['赣南脐橙', 35, 5800]], paid: 0 },
  ];
  const soDocs = [];
  for (const s of SO) {
    const items = s.items.map(([n, q, pr]) => item(n, q, pr));
    const total = items.reduce((a, b) => a + b.amount, 0);
    const paid = Math.round(total * s.paid);
    const r = await createAndAudit({
      teamId, type: 'stockout', date: dayAgo(s.d), warehouseId: s.wh.id,
      partnerType: 'cus', partnerId: C(s.cus).id, clerkId: s.cl.id,
      remark: s.paid === 0 ? '月结客户，暂未收款' : '部分收款',
      items, paidAmount: paid,
      accountId: paid > 0 ? wx.id : null,
    });
    soDocs.push({ ...r, total, paid, d: s.d, cus: s.cus });
    console.log(`  销售出库 ${r.billNo} ${dayAgo(s.d)} → ${s.cus} ￥${(total / 100).toFixed(2)} 已收 ￥${(paid / 100).toFixed(2)}`);
  }

  // ---------- 9. 销售退货（33 天前，冲减应收）----------
  {
    const items = [item('智利车厘子', 2, 26800)];
    const r = await createAndAudit({
      teamId, type: 'sret', date: dayAgo(33), warehouseId: coldWh.id,
      partnerType: 'cus', partnerId: C('橙心橙意水果连锁').id,
      remark: '客户反馈有压伤，退回 2 箱', items,
    });
    console.log(`  销售退货 ${r.billNo}（33 天前）`);
  }

  // ---------- 10. 补登收款（把部分欠款收回，制造账龄差异）----------
  const receipts = [
    { d: 60, cus: '鲜果超市（总店）', amount: 300000, acc: bank, remark: '9 月货款回款' },
    { d: 30, cus: '果篮水果店', amount: 150000, acc: wx, remark: '微信回款' },
    { d: 6, cus: '甜蜜时光烘焙坊', amount: 80000, acc: wx, remark: '部分回款' },
  ];
  for (const r of receipts) {
    await api('POST', '/settlement/create', {
      teamId, type: 'receipt', partnerType: 'cus', partnerId: C(r.cus).id,
      amount: r.amount, accountId: r.acc.id, date: dayAgo(r.d), remark: r.remark,
    });
    console.log(`  收款 ￥${(r.amount / 100).toFixed(2)} ← ${r.cus}（${dayAgo(r.d)}）`);
  }

  // ---------- 11. 补登付款（清掉部分应付）----------
  const payments = [
    { d: 55, ven: '广州进口果品贸易公司', amount: 200000, acc: bank, remark: '进口货款结算' },
    { d: 15, ven: '山东果源农产品合作社', amount: 120000, acc: bank, remark: '苹果货款' },
  ];
  for (const p of payments) {
    await api('POST', '/settlement/create', {
      teamId, type: 'payment', partnerType: 'ven', partnerId: V(p.ven).id,
      amount: p.amount, accountId: p.acc.id, date: dayAgo(p.d), remark: p.remark,
    });
    console.log(`  付款 ￥${(p.amount / 100).toFixed(2)} → ${p.ven}（${dayAgo(p.d)}）`);
  }

  // ---------- 12. 留几张草稿（工作台「待处理草稿」+ 待审核页有内容）----------
  {
    const r1 = await api('POST', '/doc/create', {
      teamId, type: 'stockout', date: dayAgo(0), warehouseId: mainWh.id,
      partnerType: 'cus', partnerId: C('果篮水果店').id, clerkId: cl1.id,
      remark: '今日待发货', items: [item('红富士苹果', 10, 9800)],
    });
    const r2 = await api('POST', '/doc/create', {
      teamId, type: 'stockin', date: dayAgo(0), warehouseId: mainWh.id,
      partnerType: 'ven', partnerId: V('山东果源农产品合作社').id,
      remark: '到货待验收', items: [item('赣南脐橙', 40, 4300)],
    });
    const r3 = await api('POST', '/doc/submit', { teamId, id: r1.id });
    console.log(`  草稿 ${r2.billNo}、待审核 ${r1.billNo}（今日）`);
  }

  // ---------- 13. 汇总核对 ----------
  const stats = await api('GET', '/stats/dashboard', null, { teamId });
  const ar = await api('GET', '/report/aging', null, { teamId, mode: 'ar' });
  const ap = await api('GET', '/report/aging', null, { teamId, mode: 'ap' });
  const sa = await api('GET', '/report/stock-aging', null, { teamId });
  console.log('\n=== 演示数据完成 ===');
  console.log(`库存总量 ${stats.totalQty}，库存货值 ￥${(stats.stockValue / 100).toFixed(2)}，低库存预警 ${stats.lowStockCount}，草稿 ${stats.draftCount}`);
  console.log('应收账龄分档(元):', JSON.stringify(Object.fromEntries(
    Object.entries(ar.totals).map(([k, v]) => [k, (v / 100).toFixed(2)]))));
  console.log('应付账龄分档(元):', JSON.stringify(Object.fromEntries(
    Object.entries(ap.totals).map(([k, v]) => [k, (v / 100).toFixed(2)]))));
  console.log(`库存账龄合计 ￥${(sa.totals.total / 100).toFixed(2)}`);
})().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
