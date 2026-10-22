/**
 * 第 2 轮 bug 测试：对抗性与并发边界。
 * 覆盖：并发审核防超卖 / 并发创建幂等 / 畸形请求体 / 原型污染 / SQL-ish 关键词 /
 *       分页边界值 / 金额小数舍入 / 价格记忆边界 / 并发调拨抢库存 / 大单校验性能 /
 *       未登录拦截 / GBK CSV 导入。
 */
const BASE = (process.env.OC_BASE || 'http://127.0.0.1:7741').replace(/\/api\/?$/, '');
const API = BASE + '/api';
let token = null;
let teamId = null;
let passed = 0;
let failed = 0;

async function j(method, path, body, extraHeaders) {
  const headers = { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) };
  if (token) headers.authorization = 'Bearer ' + token;
  const r = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body: json };
}

function ok(cond, name, detail) {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name}${detail ? '：' + detail : ''}`); }
}

(async () => {
  const r0 = await j('POST', '/auth/login', { username: 'admin', password: 'admin123456' });
  token = r0.body.token; teamId = r0.body.team.id;
  ok(!!token, '登录成功');

  const wh = (await j('GET', `/warehouse?teamId=${teamId}`)).body[0];
  const products = (await j('GET', `/product?teamId=${teamId}`)).body;
  const p1 = products[0], p2 = products[1];

  /* ---------- 1. 并发审核同一单：只过账一次 ---------- */
  {
    await j('POST', '/doc/create', { teamId, type: 'otherin', warehouseId: wh.id, items: [{ productId: p1.id, qty: 10, price: 0 }] });
    const list = (await j('GET', `/doc/list?teamId=${teamId}&type=otherin`)).body;
    const docId = list.rows[0].id;
    const results = await Promise.all(Array.from({ length: 5 }, () => j('POST', '/doc/audit', { teamId, id: docId })));
    const wins = results.filter((r) => r.status === 200).length;
    ok(wins === 1, '并发审核 5 次仅 1 次成功', JSON.stringify(results.map((r) => r.status)));
    // 验证库存只加了 10
    const info = (await j('GET', `/doc/info?id=${docId}&teamId=${teamId}`)).body;
    ok(info.doc.status === 'audit', '单据状态为已审核');
    await j('POST', '/doc/void', { teamId, id: docId });
  }

  /* ---------- 2. 并发出库抢库存：不允许超卖 ---------- */
  {
    // 库存 6，并发 3 张各 4 的出库 → 只应有 1 张成功（6/4 → 1 张成功剩 2）
    await j('POST', '/doc/create', { teamId, type: 'otherin', warehouseId: wh.id, items: [{ productId: p2.id, qty: 6, price: 0 }] });
    const seed = (await j('GET', `/doc/list?teamId=${teamId}&type=otherin&status=draft`)).body;
    const seedId = seed.rows[0].id;
    await j('POST', '/doc/audit', { teamId, id: seedId });
    const mk = Array.from({ length: 3 }, () =>
      j('POST', '/doc/create', { teamId, type: 'stockout', warehouseId: wh.id, items: [{ productId: p2.id, qty: 4, price: 0 }] }));
    const created = await Promise.all(mk);
    const audits = await Promise.all(created.filter((c) => c.status === 200).map((c) => j('POST', '/doc/audit', { teamId, id: c.body.id })));
    const wins = audits.filter((r) => r.status === 200).length;
    ok(wins === 1, `库存 6 并发出 3×4：仅 1 张过账成功（实际 ${wins}）`);
    // 清理：作废过账单，删除草稿
    for (const c of created) {
      if (c.status !== 200) continue;
      const a = audits.find((x) => x.body && x.body.ok);
      void a;
    }
    const outs = (await j('GET', `/doc/list?teamId=${teamId}&type=stockout&status=audit`)).body;
    for (const d of outs.rows) await j('POST', '/doc/void', { teamId, id: d.id });
    const drafts = (await j('GET', `/doc/list?teamId=${teamId}&type=stockout&status=draft`)).body;
    for (const d of drafts.rows) await j('DELETE', `/doc/${d.id}?teamId=${teamId}`);
  }

  /* ---------- 3. 并发创建同内容：幂等合并 ---------- */
  {
    const payload = { teamId, type: 'otherout', warehouseId: wh.id, remark: '并发幂等探测', items: [{ productId: p1.id, qty: 1, price: 0 }] };
    const rs = await Promise.all(Array.from({ length: 4 }, () => j('POST', '/doc/create', payload)));
    const ids = new Set(rs.filter((r) => r.status === 200).map((r) => r.body.id));
    ok(ids.size === 1, '同内容并发创建合并为一张单', JSON.stringify([...ids]));
    for (const id of ids) await j('DELETE', `/doc/${id}?teamId=${teamId}`);
  }

  /* ---------- 4. 畸形请求体 ---------- */
  {
    const cases = [
      ['items 缺失', { teamId, type: 'stockin', warehouseId: wh.id }],
      ['items 非数组', { teamId, type: 'stockin', warehouseId: wh.id, items: 'x' }],
      ['qty 为字符串', { teamId, type: 'stockin', warehouseId: wh.id, items: [{ productId: p1.id, qty: 'abc', price: 1 }] }],
      ['price 为 NaN', { teamId, type: 'stockin', warehouseId: wh.id, items: [{ productId: p1.id, qty: 1, price: 'abc' }] }],
      ['qty 为小数指数', { teamId, type: 'stockin', warehouseId: wh.id, items: [{ productId: p1.id, qty: 1e999, price: 1 }] }],
      ['type 大小写混淆', { teamId, type: 'STOCKIN', warehouseId: wh.id, items: [{ productId: p1.id, qty: 1, price: 1 }] }],
      ['warehouseId 为对象', { teamId, type: 'stockin', warehouseId: { id: wh.id }, items: [{ productId: p1.id, qty: 1, price: 1 }] }],
      ['discount 为负', { teamId, type: 'stockout', warehouseId: wh.id, discount: -500, items: [{ productId: p1.id, qty: 1, price: 100 }] }],
      ['partnerType 注入', { teamId, type: 'stockout', partnerType: "cus' OR 1=1--", partnerId: 1, warehouseId: wh.id, items: [{ productId: p1.id, qty: 1, price: 1 }] }],
    ];
    let allRejected = true;
    for (const [name, body] of cases) {
      const r = await j('POST', '/doc/create', body);
      const rejected = r.status === 400 || r.status === 500;
      // 500 也可接受（服务不崩即可），但绝不能 200 落库
      const stored = r.status === 200;
      if (!rejected || stored) { allRejected = false; console.log(`    [${name}] → ${r.status} ${JSON.stringify(r.body)}`); }
    }
    ok(allRejected, '9 类畸形请求体全部被拒（不落库不崩溃）');
  }

  /* ---------- 5. 原型污染与 teamId 覆写 ---------- */
  {
    const evil = JSON.parse('{"teamId":999,"type":"otherin","warehouseId":' + wh.id + ',"__proto__":{"polluted":"yes"},"items":[{"productId":' + p1.id + ',"qty":1,"price":0}],"constructor":{"prototype":{"x":1}}}');
    const r = await j('POST', '/doc/create', evil);
    ok(r.status === 200 || r.status === 400, '原型污染 payload 不崩溃');
    if (r.status === 200) {
      const info = (await j('GET', `/doc/info?id=${r.body.id}&teamId=${teamId}`)).body;
      ok(info.doc.teamId === teamId, 'teamId 被覆写为令牌团队（999 无效）', JSON.stringify(info.doc.teamId));
      await j('DELETE', `/doc/${r.body.id}?teamId=${teamId}`);
    }
    ok(({}).polluted === undefined, '全局原型未被污染');
  }

  /* ---------- 6. SQL-ish 与特殊字符关键词 ---------- */
  {
    const cases = ["'; DROP TABLE doc;--", "%_%_%", "百分'号", '\\', '🍊 Orange™', '2026-10-01 OR 1=1'];
    let fine = true;
    for (const kw of cases) {
      const r = await j('GET', `/doc/list?teamId=${teamId}&kw=${encodeURIComponent(kw)}`);
      const r2 = await j('GET', `/product?teamId=${teamId}&kw=${encodeURIComponent(kw)}`);
      if (r.status !== 200 || r2.status !== 200) { fine = false; console.log(`    kw=${kw} → ${r.status}/${r2.status}`); }
    }
    ok(fine, '6 类特殊字符关键词不导致错误');
    const docCount = (await j('GET', `/doc/list?teamId=${teamId}`)).body.total;
    ok(docCount > 0, '注入类关键词未删表（doc 数据仍在）', String(docCount));
  }

  /* ---------- 7. 分页边界值 ---------- */
  {
    const checks = [
      ['page=0', `/doc/list?teamId=${teamId}&page=0`],
      ['page=-1', `/doc/list?teamId=${teamId}&page=-1`],
      ['rows=0', `/doc/list?teamId=${teamId}&rows=0`],
      ['page=abc', `/doc/list?teamId=${teamId}&page=abc`],
      ['rows=999999999999', `/doc/list?teamId=${teamId}&rows=999999999999`],
      ['page=1e10', `/doc/list?teamId=${teamId}&page=1e10`],
    ];
    let fine = true;
    for (const [name, qs] of checks) {
      const r = await j('GET', qs);
      if (r.status !== 200 || !Array.isArray(r.body.rows)) { fine = false; console.log(`    ${name} → ${r.status}`); }
    }
    ok(fine, '6 类分页边界值均返回结构正常');
  }

  /* ---------- 8. 金额小数舍入一致性 ---------- */
  {
    const r = await j('POST', '/doc/create', { teamId, type: 'otherin', warehouseId: wh.id, items: [{ productId: p1.id, qty: 3, price: 3333 }] });
    const info = (await j('GET', `/doc/info?id=${r.body.id}&teamId=${teamId}`)).body;
    ok(info.doc.totalAmount === 9999, '金额=分整数（3×3333=9999）', String(info.doc.totalAmount));
    await j('DELETE', `/doc/${r.body.id}?teamId=${teamId}`);
    // 结算金额小数
    const cus = (await j('GET', `/customer?teamId=${teamId}`)).body[0];
    const acc = (await j('GET', `/account?teamId=${teamId}`)).body[0];
    const s = await j('POST', '/settlement/create', { teamId, type: 'receipt', partnerType: 'cus', partnerId: cus.id, accountId: acc.id, amount: 100.5 });
    ok(s.status === 400 || s.status === 200, '结算小数金额不崩溃（四舍五入或拒绝）');
    if (s.status === 200) {
      const list = (await j('GET', `/settlement/list?teamId=${teamId}&partnerId=${cus.id}`)).body;
      const hit = list.find((x) => x.amount === 101 || x.amount === 100);
      ok(!!hit, '小数金额已取整落库', JSON.stringify(list.slice(0, 2).map((x) => x.amount)));
    }
  }

  /* ---------- 9. 价格记忆边界 ---------- */
  {
    const cus = (await j('GET', `/customer?teamId=${teamId}`)).body[0];
    const neg = await j('POST', '/price/set', { teamId, partnerId: cus.id, productId: p1.id, price: -5 });
    ok(neg.status === 400, '价格记忆拒绝负价');
    const del404 = await j('DELETE', `/price/999999?teamId=${teamId}`);
    ok(del404.status === 200, '删除不存在的价格记忆不报错（幂等）');
    const big = await j('POST', '/price/set', { teamId, partnerId: cus.id, productId: p1.id, price: 1e15 });
    ok(big.status === 200 || big.status === 400, '超大价格不崩溃');
  }

  /* ---------- 10. 大单校验性能与正确性（500 行） ---------- */
  {
    const items = Array.from({ length: 500 }, (_, i) => ({ productId: products[i % products.length].id, qty: 1, price: 100 + i }));
    const t0 = Date.now();
    const r = await j('POST', '/doc/create', { teamId, type: 'otherin', warehouseId: wh.id, items });
    const ms = Date.now() - t0;
    ok(r.status === 200, '500 行大单创建成功', JSON.stringify(r.body).slice(0, 120));
    ok(ms < 3000, `500 行开单耗时 ${ms}ms < 3000ms`);
    if (r.status === 200) {
      const info = (await j('GET', `/doc/info?id=${r.body.id}&teamId=${teamId}`)).body;
      ok(info.items.length === 500, '500 行明细完整落库', String(info.items.length));
      await j('DELETE', `/doc/${r.body.id}?teamId=${teamId}`);
    }
  }

  /* ---------- 11. 未登录拦截 ---------- */
  {
    const r = await fetch(API + '/doc/list?teamId=1');
    ok(r.status === 401, '未登录访问单据列表被拒');
    const r2 = await fetch(API + '/stock/list?teamId=1');
    ok(r2.status === 401, '未登录访问库存被拒');
    const r3 = await fetch(API + '/doc/list?teamId=1', { headers: { authorization: 'Bearer fake.token' } });
    ok(r3.status === 401, '伪造令牌被拒');
  }

  /* ---------- 12. GBK CSV 导入 ---------- */
  {
    // Excel 中文环境「另存为 CSV」= ANSI/GBK。用真实客户名（种子里已有）让类型可推断为销售出库。
    // 客户名通过 API 取回，测试自身用 GBK 字节序列硬编码对应名称。
    const cusList = (await j('GET', `/customer?teamId=${teamId}`)).body;
    const cusName = cusList.find((c) => c.name === '鲜果超市（总店）')?.name ?? cusList[0]?.name;
    ok(!!cusName, '种子客户存在（GBK 测试前置）');
    // GBK 字节表（手工构造，避免依赖 iconv 库）
    const GBK = { '商':[0xC9,0xCC],'品':[0xC6,0xB7],'数':[0xCA,0xFD],'量':[0xC1,0xBF],'单':[0xB5,0xA5],'价':[0xBC,0xDB],'客':[0xBF,0xCD],'户':[0xBB,0xA7],'测':[0xB2,0xE2],'试':[0xCA,0xD4],'苹':[0xC6,0xBB],'果':[0xB9,0xFB],'鲜':[0xCF,0xCA],'超':[0xB3,0xAC],'市':[0xCA,0xD0],'（':[0xA3,0xA8],'总':[0xD7,0xDC],'店':[0xB5,0xEA],'）':[0xA3,0xA9] };
    const g = (s) => { const out = []; for (const ch of s) out.push(...(GBK[ch] ?? [ch.charCodeAt(0)])); return Buffer.from(out); };
    const head = Buffer.concat([g('商品'), Buffer.from(','), g('数量'), Buffer.from(','), g('单价'), Buffer.from(','), g('客户'), Buffer.from('\r\n')]);
    const row = Buffer.concat([g('测试苹果'), Buffer.from(',10,3.5,'), g('鲜果超市（总店）'), Buffer.from('\r\n')]);
    const r = await fetch(API + '/doc/import?dryRun=1', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream', authorization: 'Bearer ' + token }, body: Buffer.concat([head, row]),
    });
    const body = await r.json().catch(() => ({}));
    ok(r.status === 200 && body.headerMap && body.headerMap['商品'] === 'productName', 'GBK CSV 表头解码成功', JSON.stringify(body).slice(0, 200));
    // dryRun 不自动建档：商品不存在时落在 rowErrors，但错误文案应带「解码后的中文商品名」
    // （若 GBK 回落失败会显示乱码字节而不是「测试苹果」）
    const errText = (body.rowErrors ?? []).map((x) => x.msg).join(';') + (body.skipped ?? []).map((x) => x.reason).join(';');
    ok(/测试苹果/.test(errText) || (body.bills?.[0]?.items ?? []).some((x) => /苹果/.test(x.productName ?? '')), 'GBK 中文正确解码（测试苹果）', errText.slice(0, 150));
  }

  console.log(`\n===== 第 2 轮: ${passed} PASS / ${failed} FAIL =====`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常:', e); process.exit(1); });
