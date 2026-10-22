/**
 * UI 业务流端到端测试（playwright，headless Chromium）。
 *
 * 与 test-ui-e2e.cjs 的分工：
 * - test-ui-e2e：页面渲染巡检 + 关键控件存在性（广度）
 * - 本脚本：在真实界面上点完一条完整业务链（深度）——
 *   采购入库 → 审核 → 销售出库 → 审核 → 收款 → 报表可见。
 *   后端 API 层已被多轮脚本覆盖，但「用户在界面上点出来的账」与「API 发出来的账」
 *   之间隔着表单绑定 / 字段映射这层胶水，只有走 UI 才能覆盖。
 *
 * 前置：服务已启动；账套里已有种子档案（admin/admin123456、仓库、客户、商品）。
 * 缺 playwright 时自行跳过（exit 0），不计入失败。
 */
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('[skip] 未安装 playwright，跳过 UI 业务流 E2E'); process.exit(0); }

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function resolveBase() {
  const dir = process.env.ORANGE_DATA_DIR || path.join(process.cwd(), 'data');
  try {
    const p = Number(fs.readFileSync(path.join(dir, 'port.txt'), 'utf8').trim());
    if (p > 0) return `http://127.0.0.1:${p}/`;
  } catch { /* ignore */ }
  return 'http://127.0.0.1:7741/';
}
const BASE = resolveBase();
const DATA_DIR = process.env.ORANGE_DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH = process.env.ORANGE_DB_PATH || path.join(DATA_DIR, 'huimin-clone.db');

let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log(`  ok - ${name}`); }
  else { fail++; console.log(`  FAIL - ${name}${detail ? '：' + detail : ''}`); }
};

/** 直连库核对：以「数据库落库结果」为准，验证 UI 操作确实写对了账 */
function query(sql, ...args) {
  const db = new DatabaseSync(DB_PATH);
  try { return db.prepare(sql).all(...args); }
  finally { db.close(); }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const stamp = Date.now().toString().slice(-6);
  const custName = 'E2E客户' + stamp;
  const venName = 'E2E供应商' + stamp;
  const prodName = 'E2E商品' + stamp;

  // ---------- 0. 登录 ----------
  await page.goto(BASE + '?t=' + Date.now() + '#/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await page.getByRole('textbox', { name: '用户名' }).fill('admin');
  await page.getByRole('textbox', { name: '密码' }).fill('admin123456');
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await page.waitForTimeout(2000);
  ok(page.url().includes('#/dashboard'), '登录进入工作台', page.url());

  // 通过 API 建档案（档案 CRUD 已被 API 测试覆盖，这里只作为 UI 业务流的前置数据）
  const token = await page.evaluate(() => localStorage.getItem('oc_token'));
  const jreq = async (method, p, b) => {
    const r = await fetch(BASE + 'api' + p, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: b !== undefined ? JSON.stringify(b) : undefined,
    });
    return r.json();
  };
  const me = await jreq('GET', '/auth/me');
  const teamId = (me.team && me.team.id) || 1;
  const cust = await jreq('POST', '/customer', { teamId, name: custName });
  const ven = await jreq('POST', '/vendor', { teamId, name: venName });
  const prod = await jreq('POST', '/product', { teamId, name: prodName, unit: '件', salePrice: 5000, purchasePrice: 3000 });
  ok(!!cust.id && !!ven.id && !!prod.id, '前置档案创建成功（客户 + 供应商 + 商品）', JSON.stringify({ cust: cust.id, ven: ven.id, prod: prod.id }));
  // 刷新前端档案缓存
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);

  /**
   * 在开单页完成「新增 → 填表头 → 选商品 → 填数量单价 → 保存并审核」并返回列表。
   * type: stockin / stockout；partnerLabel: 客户或供应商下拉的搜索词；
   * expectStatus: 审核后期望的库存影响方向校验由调用方负责。
   */
  async function createAndAuditDoc(routeHash, partnerName, qty, price) {
    await page.evaluate((h) => { location.hash = h; }, routeHash);
    await page.waitForTimeout(900);
    // 进编辑态
    await page.getByRole('button', { name: /新增/ }).first().click();
    await page.waitForTimeout(1200);

    // 选往来单位（表头第一个 el-select，filterable）
    const selects = page.locator('.de-grid .el-select');
    await selects.first().click();
    await page.waitForTimeout(300);
    await page.keyboard.type(partnerName.slice(0, 8));
    await page.waitForTimeout(600);
    await page.locator('.el-select-dropdown__item:visible').first().click();
    await page.waitForTimeout(300);

    // 选商品（明细首行 el-select）
    const itemSelect = page.locator('.item-edit tbody tr').first().locator('.el-select');
    await itemSelect.click();
    await page.waitForTimeout(300);
    await page.keyboard.type(prodName.slice(0, 8));
    await page.waitForTimeout(600);
    await page.locator('.el-select-dropdown__item:visible').first().click();
    await page.waitForTimeout(400);

    // 数量 / 单价（明细首行的两个数字输入）
    const numInputs = page.locator('.item-edit tbody tr').first().locator('input[type=number]');
    await numInputs.nth(0).fill('');
    await numInputs.nth(0).type(String(qty));
    await numInputs.nth(1).fill('');
    await numInputs.nth(1).type(String(price));
    await page.waitForTimeout(400);

    // 保存并审核
    await page.getByRole('button', { name: '保存并审核' }).click();
    await page.waitForTimeout(2200);
    return page.locator('body').innerText();
  }

  // ---------- 1. 采购入库（UI 全流程）----------
  errors.length = 0;
  const afterIn = await createAndAuditDoc('#/doc/purchase?type=stockin', venName, 10, 30);
  const inListText = afterIn;
  ok(/采购入库/.test(inListText), '采购入库保存后回到列表态');
  ok(errors.length === 0, '采购入库全流程无 JS 报错', errors.slice(0, 2).join(' ; '));

  // 以数据库为准：入库单已审核，库存 +10
  const inDocs = query(`SELECT id, status, totalAmount FROM doc WHERE type='stockin' AND partnerId = ? ORDER BY id DESC LIMIT 1`, ven.id);
  ok(inDocs.length === 1 && inDocs[0].status === 'audit', 'UI 提交的入库单在库中为已审核', JSON.stringify(inDocs[0]));
  const stockRows = query(`SELECT qty FROM stock WHERE productId = ? AND teamId = ?`, prod.id, teamId);
  const stockAfterIn = stockRows.reduce((s, r) => s + Number(r.qty), 0);
  ok(Math.abs(stockAfterIn - 10) < 1e-6, `入库后库存 = 10（实际 ${stockAfterIn}）`);

  // ---------- 2. 销售出库（UI 全流程）----------
  await page.evaluate(() => { location.hash = '#/doc/sale?type=stockout'; });
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: /新增/ }).first().click();
  await page.waitForTimeout(1200);
  {
    const selects = page.locator('.de-grid .el-select');
    await selects.first().click();
    await page.waitForTimeout(300);
    await page.keyboard.type(custName.slice(0, 8));
    await page.waitForTimeout(600);
    await page.locator('.el-select-dropdown__item:visible').first().click();
    await page.waitForTimeout(300);

    const itemSelect = page.locator('.item-edit tbody tr').first().locator('.el-select');
    await itemSelect.click();
    await page.waitForTimeout(300);
    await page.keyboard.type(prodName.slice(0, 8));
    await page.waitForTimeout(600);
    await page.locator('.el-select-dropdown__item:visible').first().click();
    await page.waitForTimeout(400);

    const numInputs = page.locator('.item-edit tbody tr').first().locator('input[type=number]');
    await numInputs.nth(0).fill(''); await numInputs.nth(0).type('4');
    await numInputs.nth(1).fill(''); await numInputs.nth(1).type('50');
    await page.waitForTimeout(400);
    // 结算区「设为全收」：本次收款 = 应收（200），验证结算区绑定
    const fullPaid = page.getByText('设为全收', { exact: true });
    ok((await fullPaid.count()) >= 1, '销售出库结算区渲染「设为全收」');
    await fullPaid.first().click();
    await page.waitForTimeout(300);
  }
  errors.length = 0;
  await page.getByRole('button', { name: '保存并审核' }).click();
  await page.waitForTimeout(2200);
  ok(errors.length === 0, '销售出库全流程无 JS 报错', errors.slice(0, 2).join(' ; '));

  const stockRows2 = query(`SELECT qty FROM stock WHERE productId = ? AND teamId = ?`, prod.id, teamId);
  const stockAfterOut = stockRows2.reduce((s, r) => s + Number(r.qty), 0);
  ok(Math.abs(stockAfterOut - 6) < 1e-6, `出库 4 后库存 = 6（实际 ${stockAfterOut}）`);

  const outDoc = query(`SELECT id, totalAmount, paidAmount, status FROM doc WHERE type='stockout' AND partnerId = ? ORDER BY id DESC LIMIT 1`, cust.id);
  ok(outDoc.length === 1 && outDoc[0].status === 'audit', 'UI 提交的出库单已审核', JSON.stringify(outDoc[0]));
  ok(Number(outDoc[0].totalAmount) === 20000, `出库单金额 = 200.00 元（实际 ${Number(outDoc[0].totalAmount) / 100}）`);
  // 「设为全收」应写入 paidAmount（分）
  ok(Number(outDoc[0].paidAmount) === 20000, `UI「设为全收」写入本次收款 = 200.00 元（实际 ${Number(outDoc[0].paidAmount) / 100}）`);

  // 审核自动生成的收款（isAuto=1）与客户余额 -200
  const autoSettle = query(`SELECT amount FROM settlement WHERE refDocId = ? AND type='receipt' AND isAuto=1`, outDoc[0].id);
  ok(autoSettle.length === 1 && Number(autoSettle[0].amount) === 20000, '审核自动生成收款记录 200.00 元', JSON.stringify(autoSettle[0]));
  const bal = query(`SELECT balance FROM partner_balance WHERE teamId=1 AND partnerType='cus' AND partnerId=?`, cust.id);
  ok(bal.length === 1 && Number(bal[0].balance) === 0, `客户应收余额 = 0（收满，实际 ${bal.length ? Number(bal[0].balance) / 100 : 'N/A'}）`);

  // ---------- 3. 报表页能看到这条销售 ----------
  errors.length = 0;
  await page.evaluate(() => { location.hash = '#/report?tab=out'; });
  await page.waitForTimeout(1400);
  const repText = await page.locator('body').innerText();
  ok(/销售|报表|合计/.test(repText), '报表页渲染');
  ok(errors.length === 0, '报表页无 JS 报错', errors.slice(0, 2).join(' ; '));

  // ---------- 4. 对账单页渲染（客户口径）----------
  errors.length = 0;
  await page.evaluate(() => { location.hash = '#/statement?mode=ar'; });
  await page.waitForTimeout(1400);
  const stText = await page.locator('body').innerText();
  ok(/对账|应收|客户/.test(stText), '对账单页渲染');
  ok(errors.length === 0, '对账单页无 JS 报错', errors.slice(0, 2).join(' ; '));

  await browser.close();
  console.log(`\n===== UI 业务流 E2E: ${pass} PASS / ${fail} FAIL =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('UI 业务流 E2E 异常:', e); process.exit(1); });