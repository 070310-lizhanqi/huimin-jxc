/* 遍历顶部菜单所有下拉项，逐一点击并检查页面是否正常渲染（无报错、无空白） */
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:7741/';
const results = [];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE + '?v=menu1#/dashboard', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // 收集所有下拉菜单项
  const menus = await page.evaluate(() => {
    const out = [];
    for (const li of document.querySelectorAll('.nav-item')) {
      const link = li.querySelector('.nav-link');
      const name = (link?.innerText || '').trim().replace('▾', '').trim();
      if (!name) continue;
      const subs = [...li.querySelectorAll('a')].map(a => ({
        text: a.innerText.trim(),
        href: a.getAttribute('href') || a.getAttribute('data-hash') || '',
      })).filter(x => x.text && x.text !== name);
      out.push({ name, subs });
    }
    return out;
  });

  for (const m of menus) {
    for (const sub of m.subs) {
      errors.length = 0;
      // 直接改 hash 更稳定
      const hash = sub.href && sub.href.startsWith('#') ? sub.href : null;
      if (!hash) { results.push({ menu: m.name, item: sub.text, ok: false, reason: 'no hash' }); continue; }
      await page.evaluate((h) => { location.hash = h.replace(/^#/, ''); }, hash);
      await page.waitForTimeout(700);
      const state = await page.evaluate(() => {
        const main = document.querySelector('.page') || document.querySelector('.content') || document.querySelector('main');
        const title = document.querySelector('.page-title')?.innerText.trim() || '';
        const text = (main?.innerText || '').trim();
        return { title, len: text.length, first: text.slice(0, 60).replace(/\n/g, ' ') };
      });
      const ok = state.len > 30 && errors.length === 0;
      results.push({
        menu: m.name, item: sub.text, hash,
        ok, title: state.title, len: state.len,
        first: state.first,
        err: errors.slice(0, 2).join(' ; ') || '',
      });
    }
  }

  await browser.close();

  const bad = results.filter(r => !r.ok);
  console.log(`总计 ${results.length} 项，正常 ${results.length - bad.length}，异常 ${bad.length}`);
  for (const r of results) {
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} | ${r.menu}/${r.item} | ${r.hash} | len=${r.len} | ${r.title || ''} ${r.err ? '| ' + r.err : ''}`);
  }
})().catch((e) => { console.error('SUITE ERROR', e); process.exit(1); });
