/* 验证 v0.2.7 前端行为：全局错误捕获 / 401 去抖清理 / 登录后回跳原页面 */
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('[skip] no playwright'); process.exit(0); }
const fs = require('fs'), path = require('path');
function resolveBase() {
  const dir = process.env.ORANGE_DATA_DIR || path.join(process.cwd(), 'data');
  try { const p = Number(fs.readFileSync(path.join(dir, 'port.txt'), 'utf8').trim()); if (p > 0) return `http://127.0.0.1:${p}/`; } catch {}
  if (process.env.OC_BASE) return process.env.OC_BASE.replace(/\/(api\/?)?$/, '/');
  return 'http://127.0.0.1:7741/';
}
const BASE = resolveBase();
let pass = 0, fail = 0;
const ok = (c, n, d) => { if (c) { pass++; console.log('  ok - ' + n); } else { fail++; console.log('  FAIL - ' + n + (d ? '：' + d : '')); } };

(async () => {
  const b = await chromium.launch({ headless: true });

  // ---------- 1. 全局错误捕获：手动抛未捕获错误与未处理拒绝，应出现 toast ----------
  {
    const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(BASE + '?t=' + Date.now() + '#/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.getByRole('textbox', { name: '用户名' }).fill('admin');
    await page.getByRole('textbox', { name: '密码' }).fill('admin123456');
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await page.waitForTimeout(2000);
    await page.evaluate(() => { setTimeout(() => { throw new Error('E2E未捕获错误标记'); }, 0); });
    await page.waitForTimeout(900);
    let txt = await page.locator('body').innerText();
    ok(/页面出错/.test(txt) && /E2E未捕获错误标记/.test(txt), 'window.onerror 触发全局 toast 提示', txt.slice(-200));
    // 未处理的 Promise 拒绝
    await page.evaluate(() => { Promise.reject(new Error('E2E未处理拒绝标记')); });
    await page.waitForTimeout(900);
    txt = await page.locator('body').innerText();
    ok(/E2E未处理拒绝标记/.test(txt), 'unhandledrejection 触发全局 toast 提示');
    await page.close();
  }

  // ---------- 2. 401 去抖：并发多个失效请求只清理一次、只跳转一次 ----------
  {
    const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(BASE + '?t=' + Date.now() + '#/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.getByRole('textbox', { name: '用户名' }).fill('admin');
    await page.getByRole('textbox', { name: '密码' }).fill('admin123456');
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await page.waitForTimeout(2000);
    // 先跳到某业务页，便于验证回跳
    await page.evaluate(() => { location.hash = '#/aging?mode=ar'; });
    await page.waitForTimeout(900);
    // 把令牌换成无效值，然后并发 6 个请求。
    // 必须走应用自身的 req() 包装（api.get）：401 清理逻辑在 req 里，
    // 用裸 fetch 会绕过被测代码，等于没测。
    // 同时打桩 sessionStorage.setItem 计数：去抖生效时 6 个并发 401 只应写一次回跳地址。
    const res = await page.evaluate(async () => {
      localStorage.setItem('oc_token', 'invalid.token.value');
      auth.token = 'invalid.token.value';
      let setItemCalls = 0;
      const origSet = sessionStorage.setItem.bind(sessionStorage);
      sessionStorage.setItem = function (k, v) { if (k === 'oc_return_hash') setItemCalls++; return origSet(k, v); };
      const calls = [];
      for (let i = 0; i < 6; i++) {
        calls.push(api.get('/doc/list', { teamId: 1, type: 'stockin' }).catch(() => {}));
      }
      await Promise.all(calls);
      sessionStorage.setItem = origSet;
      return { hash: location.hash, token: localStorage.getItem('oc_token'), returnKey: sessionStorage.getItem('oc_return_hash'), setItemCalls };
    });
    // 6 个并发 401 只执行一次清理（写入一次回跳地址）
    ok(res.setItemCalls === 1, '6 个并发 401 只执行一次清理（去抖生效）', `setItemCalls=${res.setItemCalls}`);
    ok(res.token === null, '并发 401 后令牌被清除', JSON.stringify(res));
    ok(res.hash === '#/login', '并发 401 后跳转登录页', res.hash);
    ok(res.returnKey && res.returnKey.includes('aging'), '记录失效前页面用于回跳', JSON.stringify(res.returnKey));
    await page.close();
  }

  // ---------- 3. 登录后回跳原页面 ----------
  {
    const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(BASE + '?t=' + Date.now() + '#/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    // 预置回跳地址，模拟「被踢出后回来」
    await page.evaluate(() => sessionStorage.setItem('oc_return_hash', '#/aging?mode=ar'));
    await page.getByRole('textbox', { name: '用户名' }).fill('admin');
    await page.getByRole('textbox', { name: '密码' }).fill('admin123456');
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await page.waitForTimeout(2200);
    ok(page.url().includes('aging'), '登录后回跳失效前页面（而非工作台）', page.url());
    const rk = await page.evaluate(() => sessionStorage.getItem('oc_return_hash'));
    ok(rk === null, '回跳后清除记录（避免下次登录误跳）', String(rk));
    await page.close();
  }

  // ---------- 4. 主动退出不回跳 ----------
  {
    const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(BASE + '?t=' + Date.now() + '#/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    await page.getByRole('textbox', { name: '用户名' }).fill('admin');
    await page.getByRole('textbox', { name: '密码' }).fill('admin123456');
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await page.waitForTimeout(2000);
    await page.evaluate(() => { location.hash = '#/aging?mode=ar'; });
    await page.waitForTimeout(800);
    // 主动退出：点顶栏退出按钮 + 确认
    await page.locator('.nav-logout').click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /确定/ }).click();
    await page.waitForTimeout(1200);
    const rk = await page.evaluate(() => sessionStorage.getItem('oc_return_hash'));
    ok(rk === null, '主动退出不保留回跳地址', String(rk));
    // 再登录应回工作台
    await page.getByRole('textbox', { name: '用户名' }).fill('admin');
    await page.getByRole('textbox', { name: '密码' }).fill('admin123456');
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await page.waitForTimeout(2200);
    ok(page.url().includes('dashboard'), '主动退出后登录回工作台', page.url());
    await page.close();
  }

  await b.close();
  console.log(`\n===== v0.2.7 前端行为: ${pass} PASS / ${fail} FAIL =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('前端行为验证异常:', e); process.exit(1); });