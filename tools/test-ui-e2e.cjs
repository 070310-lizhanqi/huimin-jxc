/**
 * UI 端到端测试（playwright，headless Chromium）。
 * 覆盖：登录 → 顶部菜单逐项渲染巡检 → 数据备份页签（v0.4.0 新增 UI）→ 开单页关键控件。
 * 有断言、有退出码：任一失败 exit 1（此前 test-menu-sweep 只打印不判失败）。
 *
 * 前置：服务已启动。BASE 优先读数据目录 port.txt（端口可能自适应）。
 * 缺 playwright 时本脚本自行跳过（exit 0），不计入失败。
 */
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('[skip] 未安装 playwright，跳过 UI E2E'); process.exit(0); }

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

let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log(`  ok - ${name}`); }
  else { fail++; console.log(`  FAIL - ${name}${detail ? '：' + detail : ''}`); }
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // ---------- 1. 登录 ----------
  // 缓存破坏：前端静态资源无版本参数，浏览器可能复用旧 JS（开发迭代期尤其明显），
  // 会让「已修复的前端」在测试里表现为空白页。加一次性查询参数规避。
  await page.goto(BASE + '?t=' + Date.now() + '#/login', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const userBox = page.getByRole('textbox', { name: '用户名' });
  await userBox.fill('admin');
  await page.getByRole('textbox', { name: '密码' }).fill('admin123456');
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await page.waitForTimeout(2000);
  ok(page.url().includes('#/dashboard'), '登录跳转到工作台', page.url());
  const dashText = await page.locator('body').innerText();
  ok(/常用功能|新增销售数据|库存总量/.test(dashText), '工作台渲染关键区块');
  ok(errors.length === 0, '登录与工作台无 JS 报错', errors.slice(0, 2).join(' ; '));

  // ---------- 2. 菜单巡检（用真实路由）----------
  const routes = ['#/product', '#/partner?tab=cus', '#/stock', '#/doc/sale?type=stockout',
    '#/doc/purchase?type=stockin', '#/report?tab=out', '#/jxcstat', '#/aging?mode=ar',
    '#/price', '#/settings', '#/base', '#/ledger', '#/finance', '#/forecast', '#/statement?mode=ar'];
  let rendered = 0;
  for (const h of routes) {
    errors.length = 0;
    await page.evaluate((hash) => { location.hash = hash; }, h);
    await page.waitForTimeout(650);
    const st = await page.evaluate(() => {
      const main = document.querySelector('.page-card') || document.querySelector('.content');
      return { len: (main?.innerText || '').trim().length };
    });
    if (st.len > 20 && errors.length === 0) rendered++;
    else console.log(`    [FAIL] ${h} len=${st.len} err=${errors.slice(0, 1).join('')}`);
  }
  ok(rendered === routes.length, `${routes.length} 个主要页面全部正常渲染（实际 ${rendered}）`);

  // ---------- 3. 数据备份页签（v0.4.0 新 UI）----------
  errors.length = 0;
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForTimeout(800);
  const backupTab = page.getByText('数据备份', { exact: true });
  ok((await backupTab.count()) >= 1, '设置页存在「数据备份」页签');
  await backupTab.first().click();
  await page.waitForTimeout(1000);
  const bt = await page.locator('body').innerText();
  ok(/立即备份/.test(bt), '备份页有「立即备份」按钮');
  ok(/备份时间|还没有备份/.test(bt), '备份列表区域已渲染');
  // 点一次立即备份，验证 UI→API 闭环
  await page.getByRole('button', { name: /立即备份/ }).click();
  await page.waitForTimeout(1500);
  const bt2 = await page.locator('body').innerText();
  ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(bt2), '点击后台出现备份记录（时间戳可见）');
  ok(errors.length === 0, '备份页无 JS 报错', errors.slice(0, 2).join(' ; '));

  // ---------- 4. 开单页：列表态 + 点「新增」进编辑态（结算区）----------
  errors.length = 0;
  await page.evaluate(() => { location.hash = '#/doc/sale?type=stockout'; });
  await page.waitForTimeout(900);
  const docText = await page.locator('body').innerText();
  ok(/销售出库/.test(docText) && /全部状态|新增/.test(docText), '开单页列表态渲染（含筛选与新增入口）');
  // 点新增 → 整页开单编辑态，验证结算区与明细区
  await page.getByRole('button', { name: /新增/ }).first().click();
  await page.waitForTimeout(1200);
  const editText = await page.locator('body').innerText();
  ok(/应收金额|结算信息/.test(editText), '整页开单编辑态结算区渲染');
  ok(/选择商品|添加一行|商品名称/.test(editText), '整页开单明细区渲染');
  ok(errors.length === 0, '开单页无 JS 报错', errors.slice(0, 2).join(' ; '));

  await browser.close();
  console.log(`\n===== UI E2E: ${pass} PASS / ${fail} FAIL =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('UI E2E 异常:', e); process.exit(1); });