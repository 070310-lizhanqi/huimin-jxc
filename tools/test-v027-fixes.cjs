/**
 * v0.2.7 修复项回归测试：
 * 1) 业务日期校验（validBizDate）——单据与收付款共用一个口径：
 *    格式错 / 不存在（2026-02-30）/ 年份越界 一律 400 拒绝；
 *    合法日期照常通过，缺省日期回落当天。
 * 2) 备份保留策略——创建超过上限后自动裁剪最旧的，且不误删非备份文件。
 */
const { api } = require('./test-helpers.cjs');
const path = require('path');
const fs = require('fs');

let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log(`  ok - ${name}`); }
  else { fail++; console.log(`  FAIL - ${name}${detail ? '：' + detail : ''}`); }
};

(async () => {
  // 前置：档案
  const stamp = Date.now().toString().slice(-6);
  const cus = (await api('POST', '/customer', { teamId: 1, name: '日期校验客户' + stamp })).body;
  const ven = (await api('POST', '/vendor', { teamId: 1, name: '日期校验供应商' + stamp })).body;
  const prod = (await api('POST', '/product', { teamId: 1, name: '日期校验商品' + stamp, unit: '件' })).body;
  const wh = (await api('GET', '/warehouse', undefined, { teamId: 1 })).body;
  const whId = (wh.rows || wh)[0].id;
  const acct = (await api('GET', '/account', undefined, { teamId: 1 })).body;
  const acctId = (acct.rows || acct)[0].id;

  const docBody = (date) => ({
    teamId: 1, type: 'stockin', date, partnerType: 'ven', partnerId: ven.id,
    warehouseId: whId, items: [{ productId: prod.id, qty: 1, price: 1000 }],
  });

  /* ---------- 1. 单据日期校验 ---------- */
  {
    const bad = [
      ['2026/10/01', '格式错（斜杠分隔）'],
      ['2026-2-3', '格式错（未补零）'],
      ['2026-02-30', '格式对但 2 月无 30 日'],
      ['2026-13-01', '月份 13'],
      ['2026-04-31', '4 月无 31 日'],
      ['1899-05-06', '年份过早'],
      ['2101-01-01', '年份过晚'],
    ];
    for (const [d, why] of bad) {
      const r = await api('POST', '/doc/create', docBody(d));
      ok(r.status === 400 && /日期/.test(r.body.error || ''), `单据拒绝脏日期：${why}（${d}）`, JSON.stringify(r.body));
    }
    // 闰年边界：2024-02-29 存在，2026-02-29 不存在
    const leap = await api('POST', '/doc/create', docBody('2024-02-29'));
    ok(leap.status === 200, '单据接受合法闰日 2024-02-29', JSON.stringify(leap.body));
    const noLeap = await api('POST', '/doc/create', docBody('2026-02-29'));
    ok(noLeap.status === 400, '单据拒绝非闰年 2026-02-29', JSON.stringify(noLeap.body));
    // 缺省日期回落当天
    const noDate = await api('POST', '/doc/create', { ...docBody(undefined), date: undefined });
    ok(noDate.status === 200, '单据缺省日期回落当天', JSON.stringify(noDate.body));
  }

  /* ---------- 2. 收付款日期校验 ---------- */
  {
    const settle = (date) => ({
      teamId: 1, type: 'receipt', partnerType: 'cus', partnerId: cus.id, amount: 1000, date,
    });
    const bad = ['2099-13-45', '2026-02-30', '2026/01/01', '1999-01-01'];
    for (const d of bad) {
      const r = await api('POST', '/settlement/create', settle(d));
      ok(r.status === 400 && /日期/.test(r.body.error || ''), `收付款拒绝脏日期：${d}`, JSON.stringify(r.body));
    }
    const good = await api('POST', '/settlement/create', settle('2026-03-15'));
    ok(good.status === 200 && good.body.id, '收付款接受合法日期', JSON.stringify(good.body));
    // 修改时同样校验
    const upd = await api('PUT', '/settlement/' + good.body.id, settle('2026-02-30'));
    ok(upd.status === 400 && /日期/.test(upd.body.error || ''), '收付款修改拒绝脏日期', JSON.stringify(upd.body));
  }

  /* ---------- 3. 备份保留策略 ---------- */
  {
    const dir = path.join(process.cwd(), 'data', 'backups');
    // 放一个不合规文件，验证裁剪不会误删
    const guard = path.join(dir, 'keep-me.txt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(guard, 'non-backup file');
    // 连续创建直到超过保留上限：多创建几份确保触发裁剪
    let last = null;
    let sawPrune = 0;
    const bulk = 40;
    for (let i = 0; i < bulk; i++) {
      const r = await api('POST', '/backup/create');
      if (r.status !== 200) { ok(false, `第 ${i + 1} 次备份创建失败`, JSON.stringify(r.body)); break; }
      last = r.body;
      if (Number(r.body.pruned) > 0) sawPrune += Number(r.body.pruned);
    }
    ok(!!last, `连续创建 ${bulk} 份备份全部成功`);
    // 触发过裁剪：说明「超限即删最旧」确实在跑
    ok(sawPrune > 0, `创建过程中实际清理了超限旧备份（共 ${sawPrune} 份）`);
    const list = (await api('GET', '/backup/list')).body;
    const cnt = list.rows.length;
    ok(cnt === 30, `备份份数被精确收敛到保留上限 30（实际 ${cnt}）`, `rows=${cnt}`);
    ok(fs.existsSync(guard), '裁剪不删除非备份文件（keep-me.txt）');
    fs.rmSync(guard, { force: true });
    // 关键不变量：本次刚创建的备份绝不能被自己触发的裁剪删掉（同秒连点场景）
    ok(list.rows.some((r) => r.file === last.file), '刚创建的备份未被裁剪删除', last.file);
    // 返回体带 pruned 计数
    ok(last && typeof last.pruned === 'number', '备份返回体含 pruned 字段（本次清理数）', JSON.stringify(last));
  }

  console.log(`\n===== v0.2.7 回归: ${pass} PASS / ${fail} FAIL =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });