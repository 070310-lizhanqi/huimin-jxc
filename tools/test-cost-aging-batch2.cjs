/**
 * 回归测试：第二批 C 组（成本与账龄）——B-数4 / B-数8 / B-数5 / 订金错桶 / 负数舍入。
 *
 * 自启服务：PORT=7753，数据目录 /tmp/huimin-b2-c（每次重建），跑完停掉自己的服务。
 * 用法：先 pnpm build，再 node tools/test-cost-aging-batch2.cjs；退出码 0=全过。
 *
 * 覆盖：
 *  B-数4：零价入库不计入成本分母（report/product、stock-forecast、stock-aging）；
 *         全零价商品回落到 purchasePrice。
 *  B-数8：stock/list estUnitCost、/stats/dashboard stockValue、/stock/summary 三处
 *         统一为历史采购均价（估算）；补录早日期入库单不再成为“最近价”。
 *  B-数5：① partner_balance 驱动的无单据预收客户单独列示（不进账龄桶）；
 *         ② 超收挂到超收发生日（结算日期）的桶；③ 单据/结算 date<=今天截断；
 *         排除 refDocId 指向作废单的手工结算。
 *  订金错桶：销售单订金与退货单订金均按单归属，不落到旧单桶。
 *  负数舍入：allocateDocDiscounts 对称舍入（-1.5 → -2，与 +1.5 → 2 对称）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 7753;
const DATA_DIR = '/tmp/huimin-b2-c';
const ROOT = path.join(__dirname, '..');

process.env.OC_BASE = `http://127.0.0.1:${PORT}/api`;
// B-安5 密码策略（并行组已落地）：口令不得包含用户名，test-helpers 默认的
// admin/admin123456 在新库注册会被拒；本脚本自备合规口令，与共享默认解耦
process.env.ORANGE_USER = 'admin';
process.env.ORANGE_PASS = 'B2cost!9Xq';
const { api } = require('./test-helpers.cjs');

let pass = 0, fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`PASS ${label}`); }
  else { fail++; console.log(`FAIL ${label} ${extra}`); }
}

const pad = (n) => String(n).padStart(2, '0');
function fmt(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function dOff(off) { const d = new Date(); d.setDate(d.getDate() + off); return fmt(d); }
const TODAY = fmt(new Date());
const OLD = '2024-06-01'; // 距今天 >720 天，固定进 over720 桶
const FUTURE = '2027-01-15';

const BUCKETS = [30, 60, 90, 180, 360, 720];
function bucketOf(days) {
  for (let i = 0; i < BUCKETS.length; i++) if (days <= BUCKETS[i]) return ['d30', 'd60', 'd90', 'd180', 'd360', 'd720'][i];
  return 'over720';
}
function daysBetween(from, to) {
  return Math.max(0, Math.floor((new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000));
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/status`);
      if (r.ok) return true;
    } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  const me = (await api('GET', '/auth/me')).body;
  const teamId = me.user.teamId;
  ok(teamId > 0, '登录取 teamId');
  const wh = (await api('POST', '/warehouse', { teamId, name: 'B2成本账龄测试仓' })).body;
  ok(!!wh.id, '建仓库', JSON.stringify(wh));

  const mkProd = async (name, purchasePrice) => {
    const r = await api('POST', '/product', { teamId, name, unit: '件', purchasePrice, salePrice: purchasePrice * 2, lowQty: 0 });
    if (!r.body.id) throw new Error('建商品失败: ' + JSON.stringify(r.body));
    return r.body.id;
  };
  const mkCus = async (name) => {
    const r = await api('POST', '/customer', { teamId, name });
    if (!r.body.id) throw new Error('建客户失败: ' + JSON.stringify(r.body));
    return r.body.id;
  };
  const mkDoc = async (body) => {
    const r = await api('POST', '/doc/create', { teamId, ...body });
    if (r.status !== 200 || !r.body.id) throw new Error('建单失败: ' + JSON.stringify(r.body));
    return r.body.id;
  };
  const audit = async (id) => {
    const r = await api('POST', '/doc/audit', { teamId, id });
    if (r.status !== 200) throw new Error('审核失败: ' + JSON.stringify(r.body));
  };
  const mkStockin = async (pid, qty, price, date) => {
    const id = await mkDoc({ type: 'stockin', warehouseId: wh.id, date, items: [{ productId: pid, qty, price }] });
    await audit(id);
    return id;
  };
  const mkSale = async (cusId, pid, qty, price, date, extra = {}) => {
    const id = await mkDoc({ type: 'stockout', partnerType: 'cus', partnerId: cusId, warehouseId: wh.id, date, items: [{ productId: pid, qty, price }], ...extra });
    await audit(id);
    return id;
  };
  const agingRow = async (cusId) => {
    const r = await api('GET', `/report/aging?teamId=${teamId}&mode=ar`);
    return { ag: r.body, row: (r.body.rows || []).find((x) => x.partnerId === cusId) };
  };

  // ================= B-数4 + B-数8：成本口径 =================
  const cusA = await mkCus('B2成本客户');
  const prodA = await mkProd('B2商品A-零价混合', 9999);
  const prodB = await mkProd('B2商品B-全零价', 777);
  const prodC = await mkProd('B2商品C-补录早日期', 9999);
  // A：10×1000 + 10×0（零价）+ 10×2000；旧口径 (10000+0+20000)/30=1000，新口径 (10000+20000)/20=1500
  await mkStockin(prodA, 10, 1000, dOff(-32));
  await mkStockin(prodA, 10, 0, dOff(-31));
  await mkStockin(prodA, 10, 2000, dOff(-30));
  // B：全零价入库 5×0 → 无正价成本，回落 purchasePrice=777
  await mkStockin(prodB, 5, 0, dOff(-30));
  // C：先建 10×3000（10-27 前后日期），再补录一张早日期 10×1000（d-40）
  await mkStockin(prodC, 10, 3000, dOff(-27));
  await mkStockin(prodC, 10, 1000, dOff(-40));
  // A 卖 5 件 @5000，让它进 /report/product
  await mkSale(cusA, prodA, 5, 5000, dOff(-29));

  let r = await api('GET', `/report/product?teamId=${teamId}&from=${dOff(-40)}&to=${TODAY}`);
  const rowA = (r.body.rows || []).find((x) => x.productId === prodA);
  ok(!!rowA, 'report/product 含商品A');
  ok(rowA && rowA.avgCost === 1500, `B-数4 report/product avgCost=1500（零价不计分母），实际 ${rowA && rowA.avgCost}`);
  ok(rowA && rowA.estCost === 7500, `B-数4 estCost=7500（5×1500），实际 ${rowA && rowA.estCost}`);
  ok(rowA && rowA.estProfit === 17500, `B-数4 estProfit=17500（25000-7500），实际 ${rowA && rowA.estProfit}`);

  r = await api('GET', `/report/stock-forecast?teamId=${teamId}`);
  const fcA = (r.body.rows || []).find((x) => x.productId === prodA);
  const fcB = (r.body.rows || []).find((x) => x.productId === prodB);
  const fcC = (r.body.rows || []).find((x) => x.productId === prodC);
  ok(fcA && fcA.unitCost === 1500, `B-数4 stock-forecast A unitCost=1500，实际 ${fcA && fcA.unitCost}`);
  ok(fcB && fcB.unitCost === 777, `B-数4 stock-forecast B 全零价回落 purchasePrice=777，实际 ${fcB && fcB.unitCost}`);
  ok(fcB && fcB.amount === 3885, `B-数4 stock-forecast B amount=3885（5×777），实际 ${fcB && fcB.amount}`);
  ok(fcC && fcC.unitCost === 2000, `B-数4 stock-forecast C unitCost=2000，实际 ${fcC && fcC.unitCost}`);

  r = await api('GET', `/report/stock-aging?teamId=${teamId}`);
  const saA = (r.body.items || []).find((x) => x.productId === prodA);
  const saB = (r.body.items || []).find((x) => x.productId === prodB);
  ok(saA && saA.amount === 37500, `B-数4 stock-aging A amount=37500（25×1500），实际 ${saA && saA.amount}`);
  ok(saB && saB.amount === 3885, `B-数4 stock-aging B amount=3885，实际 ${saB && saB.amount}`);

  // B-数8：三处统一为历史采购均价（估算）
  r = await api('GET', `/stock/list?teamId=${teamId}`);
  const stA = (r.body || []).find((x) => x.productId === prodA);
  const stB = (r.body || []).find((x) => x.productId === prodB);
  const stC = (r.body || []).find((x) => x.productId === prodC);
  ok(stA && stA.estUnitCost === 1500, `B-数8 stock/list A estUnitCost=1500（非最近价2000/旧均价1000），实际 ${stA && stA.estUnitCost}`);
  ok(stB && stB.estUnitCost === 777, `B-数8 stock/list B estUnitCost=777（回落采购价），实际 ${stB && stB.estUnitCost}`);
  ok(stC && stC.estUnitCost === 2000, `B-数8 stock/list C estUnitCost=2000（补录早日期单不做最近价），实际 ${stC && stC.estUnitCost}`);
  // 货值：A 25×1500 + B 5×777 + C 20×2000 = 81385
  r = await api('GET', `/stats/dashboard?teamId=${teamId}`);
  ok(r.body.stockValue === 81385, `B-数8 dashboard stockValue=81385，实际 ${r.body.stockValue}`);
  r = await api('GET', `/stock/summary?teamId=${teamId}`);
  ok(r.body.stockValue === 81385, `B-数8 stock/summary stockValue=81385，实际 ${r.body.stockValue}`);
  ok(r.body.totalQty === 50, `B-数8 stock/summary totalQty=50，实际 ${r.body.totalQty}`);

  // ================= B-数5 ①：无单据预收客户 =================
  const cusPre = await mkCus('B2预收客户');
  let s = await api('POST', '/settlement/create', { teamId, type: 'receipt', partnerType: 'cus', partnerId: cusPre, amount: 5000, date: dOff(-20) });
  ok(s.status === 200, '预收客户手工收款 5000', JSON.stringify(s.body));
  let { row: rowPre } = await agingRow(cusPre);
  ok(!!rowPre, 'B-数5① 预收客户出现在账龄中', JSON.stringify(rowPre));
  ok(rowPre && rowPre.total === -5000, `B-数5① 预收行 total=-5000，实际 ${rowPre && rowPre.total}`);
  ok(rowPre && ['d30', 'd60', 'd90', 'd180', 'd360', 'd720', 'over720'].every((k) => rowPre[k] === 0),
    `B-数5① 预收行不进账龄桶（各桶均为 0），实际 ${JSON.stringify(rowPre)}`);
  ok(rowPre && rowPre.advance === true, 'B-数5① 预收行带 advance 标记');
  const balPre = (await api('GET', `/partner/balance?teamId=${teamId}`)).body.find((b) => b.partnerType === 'cus' && b.partnerId === cusPre);
  ok(balPre && balPre.balance === -5000, `B-数5① 预收客户 partner_balance=-5000，实际 ${balPre && balPre.balance}`);

  // ================= B-数5 ②：超收挂超收发生日桶 =================
  const cusOver = await mkCus('B2超收客户');
  await mkSale(cusOver, prodA, 1, 10000, OLD); // 2024-06-01 老单 10000，进 over720
  s = await api('POST', '/settlement/create', { teamId, type: 'receipt', partnerType: 'cus', partnerId: cusOver, amount: 15000, date: dOff(-11) });
  ok(s.status === 200, '超收客户收款 15000（超收 5000）');
  let { row: rowOver } = await agingRow(cusOver);
  ok(!!rowOver, 'B-数5② 超收客户有账龄行');
  ok(rowOver && rowOver.total === -5000, `B-数5② 超收 total=-5000，实际 ${rowOver && rowOver.total}`);
  ok(rowOver && rowOver.d30 === -5000, `B-数5② 超收 -5000 在 d30 桶（结算日 ${dOff(-11)}），实际 d30=${rowOver && rowOver.d30}`);
  ok(rowOver && rowOver.over720 === 0, `B-数5② 超收不在 over720 桶，实际 over720=${rowOver && rowOver.over720}`);

  // ================= B-数5 ③：未来截断 + 作废单手工结算排除 =================
  const cusFut = await mkCus('B2未来单客户');
  await mkSale(cusFut, prodA, 1, 10000, FUTURE); // 未来单，不应进账龄
  let { row: rowFut } = await agingRow(cusFut);
  ok(!rowFut, `B-数5③ 未来日期单据不进账龄，实际 ${JSON.stringify(rowFut)}`);

  const cusFutSettle = await mkCus('B2未来结算客户');
  await mkSale(cusFutSettle, prodA, 1, 10000, dOff(-51));
  s = await api('POST', '/settlement/create', { teamId, type: 'receipt', partnerType: 'cus', partnerId: cusFutSettle, amount: 10000, date: FUTURE });
  ok(s.status === 200, '未来日期收款登记成功（应被账龄截断忽略）');
  let { row: rowFutS } = await agingRow(cusFutSettle);
  ok(rowFutS && rowFutS.total === 10000, `B-数5③ 未来结算不冲减账龄，total=10000，实际 ${rowFutS && rowFutS.total}`);
  ok(rowFutS && rowFutS[bucketOf(51)] === 10000, `B-数5③ 未结 10000 在 ${bucketOf(51)} 桶，实际 ${JSON.stringify(rowFutS)}`);

  const cusVoid = await mkCus('B2作废单结算客户');
  await mkSale(cusVoid, prodA, 1, 10000, dOff(-51));
  const voidSale = await mkSale(cusVoid, prodA, 1, 8000, dOff(-50));
  let v = await api('POST', '/doc/void', { teamId, id: voidSale });
  ok(v.status === 200, '作废第二张销售单', JSON.stringify(v.body));
  s = await api('POST', '/settlement/create', { teamId, type: 'receipt', partnerType: 'cus', partnerId: cusVoid, amount: 8000, date: dOff(-49), refDocId: voidSale });
  ok(s.status === 200, '指向作废单的手工收款登记成功（应被账龄排除）');
  let { row: rowVoid } = await agingRow(cusVoid);
  ok(rowVoid && rowVoid.total === 10000, `B-数5③ 作废单手工结算不冲减账龄，total=10000，实际 ${rowVoid && rowVoid.total}`);
  ok(rowVoid && rowVoid[bucketOf(51)] === 10000, `B-数5③ 未结 10000 在 ${bucketOf(51)} 桶，实际 ${JSON.stringify(rowVoid)}`);

  // ================= 订金错桶 =================
  // 销售单订金按单归属：老单 10000（无订金）+ 新单 10000（订金 6000）
  const cusDep = await mkCus('B2订金客户');
  await mkSale(cusDep, prodA, 1, 10000, OLD);
  await mkSale(cusDep, prodA, 1, 10000, dOff(-20), { deposit: 6000 });
  let { row: rowDep } = await agingRow(cusDep);
  ok(rowDep && rowDep.total === 14000, `订金按单归属 total=14000，实际 ${rowDep && rowDep.total}`);
  ok(rowDep && rowDep.over720 === 10000, `订金按单归属 老单 over720=10000（订金不冲老单），实际 ${rowDep && rowDep.over720}`);
  ok(rowDep && rowDep.d30 === 4000, `订金按单归属 新单 d30=4000（10000-6000），实际 ${rowDep && rowDep.d30}`);

  // 退货单订金按单归属：老单 10000 + 退货 4000（订金 4000）+ 新单 10000
  const cusSretDep = await mkCus('B2退货订金客户');
  await mkSale(cusSretDep, prodA, 1, 10000, OLD);
  const sretId = await mkDoc({ type: 'sret', partnerType: 'cus', partnerId: cusSretDep, warehouseId: wh.id, date: dOff(-51), deposit: 4000, items: [{ productId: prodA, qty: 1, price: 4000 }] });
  await audit(sretId);
  await mkSale(cusSretDep, prodA, 1, 10000, dOff(-20));
  let { row: rowSret } = await agingRow(cusSretDep);
  ok(rowSret && rowSret.total === 20000, `退货订金按单归属 total=20000，实际 ${rowSret && rowSret.total}`);
  ok(rowSret && rowSret.over720 === 10000, `退货订金按单归属 over720=10000，实际 ${rowSret && rowSret.over720}`);
  ok(rowSret && rowSret.d30 === 10000, `退货订金按单归属 新单 d30=10000（退货订金不冲新单），实际 ${rowSret && rowSret.d30}`);
  ok(rowSret && rowSret[bucketOf(51)] === 0, `退货订金按单归属 退货单 ${bucketOf(51)} 桶为 0（-(4000-4000)），实际 ${JSON.stringify(rowSret)}`);

  // 账龄合计内部勾稽：totals.total 与各行 total 之和一致，各桶合计与行桶之和一致
  const { ag } = await agingRow(cusDep);
  const sumTotal = ag.rows.reduce((a, x) => a + x.total, 0);
  ok(ag.totals.total === sumTotal, `账龄 totals.total=${ag.totals.total} 与行合计 ${sumTotal} 一致`);
  for (const k of ['d30', 'd60', 'd90', 'd180', 'd360', 'd720', 'over720']) {
    const sk = ag.rows.reduce((a, x) => a + (x[k] || 0), 0);
    ok(ag.totals[k] === sk, `账龄 totals.${k}=${ag.totals[k]} 与行合计 ${sk} 一致`);
  }

  // ================= 负数舍入（单元级） =================
  const { allocateDocDiscounts } = require(path.join(ROOT, 'dist', 'server', 'report.js'));
  // 负数行：折扣 3 分，毛额 100（-50 + 150）：负行分摊 -1.5 → 对称舍入 -2，净额 -48
  const netNeg = allocateDocDiscounts([
    { docId: 1, productId: 1, type: 'stockout', discount: 3, qty: 1, amount: -50 },
    { docId: 1, productId: 2, type: 'stockout', discount: 3, qty: 1, amount: 150 },
  ]);
  ok(netNeg.get('1:1') === -48, `负数舍入 -1.5→-2，负行净额=-48，实际 ${netNeg.get('1:1')}`);
  ok(netNeg.get('1:2') === 145, `负数舍入 正行分摊 4.5→5，净额=145，实际 ${netNeg.get('1:2')}`);
  // 正数行对称：+1.5 → 2
  const netPos = allocateDocDiscounts([
    { docId: 2, productId: 1, type: 'stockout', discount: 6, qty: 1, amount: 50 },
    { docId: 2, productId: 2, type: 'stockout', discount: 6, qty: 1, amount: 150 },
  ]);
  ok(netPos.get('2:1') === 48, `正数舍入 +1.5→2，净额=48，实际 ${netPos.get('2:1')}`);
  ok(netPos.get('2:2') === 146, `正数舍入 尾差归最大行，净额=146，实际 ${netPos.get('2:2')}`);
  // 单内分摊合计仍等于整单折扣
  const sumNeg = [...netNeg.values()].reduce((a, b) => a + b, 0);
  ok(sumNeg === 97, `负数单分摊后合计=97（毛额 100-折扣 3），实际 ${sumNeg}`);
  // 与 docs.ts lineAmount（B 组）同一种对称舍入：sign(n)*Math.round(|n|)，-0.5→-1
  const { roundHalfAwayFromZero } = require(path.join(ROOT, 'dist', 'server', 'report.js'));
  ok(roundHalfAwayFromZero(-0.5) === -1, `对称舍入 -0.5→-1，实际 ${roundHalfAwayFromZero(-0.5)}`);
  ok(roundHalfAwayFromZero(0.5) === 1, `对称舍入 +0.5→+1，实际 ${roundHalfAwayFromZero(0.5)}`);
  ok(roundHalfAwayFromZero(-1.5) === -2 && roundHalfAwayFromZero(1.5) === 2, '对称舍入 ±1.5→±2');

  console.log(`\n[test-cost-aging-batch2] 通过 ${pass}，失败 ${fail}`);
  return fail;
}

(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), ORANGE_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const stop = async () => {
    child.kill('SIGTERM');
    await Promise.race([new Promise((r) => child.on('exit', r)), new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  };
  try {
    if (!(await waitUp())) {
      console.log('FAIL 服务未在 7753 启动\n--- stdout ---\n' + out.slice(-2000) + '\n--- stderr ---\n' + err.slice(-2000));
      await stop();
      process.exit(2);
    }
    const fail = await main();
    await stop();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log('FAIL 异常: ' + (e && e.stack || e));
    await stop();
    process.exit(2);
  }
})();
