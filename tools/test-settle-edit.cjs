/**
 * 收付款单 修改/删除 的余额冲回测试。
 * 关键不变量：任何操作后，账户余额与往来余额必须与流水推导值一致。
 */
const BASE = process.env.OC_BASE || 'http://127.0.0.1:7741/api';
const { authHeader } = require('./test-helpers.cjs');
let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('PASS |', name, detail ?? ''); }
  else { fail++; console.log('FAIL |', name, '|', detail ?? ''); }
}
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await res.json(); } catch { j = { error: 'non-json' }; }
  return { status: res.status, body: j };
}
const M = (c) => (c / 100).toFixed(2);

(async () => {
  const me = (await api('GET', '/auth/me')).body;
  const teamId = me.user.teamId;

  const cus = (await api('POST', '/customer', { teamId, name: '客户甲' })).body;
  const acc = (await api('POST', '/account', { teamId, name: '现金', type: 'cash', balance: 100000 })).body;
  const acc2 = (await api('POST', '/account', { teamId, name: '银行', type: 'bank', balance: 200000 })).body;

  const balOf = async (pt, pid) => {
    const list = (await api('GET', `/partner/balance?teamId=${teamId}`)).body;
    const row = list.find((b) => b.partnerType === pt && b.partnerId === pid);
    return row ? row.balance : 0;
  };
  const accBal = async (id) => {
    const list = (await api('GET', `/account?teamId=${teamId}`)).body;
    const a = list.find((x) => x.id === id);
    return a ? a.balance : null;
  };

  // ---- 1. 建一张赊销应收 1000，再收款 400 ----
  const inv = (await api('POST', '/doc/create', {
    teamId, type: 'sorder', items: [{ productId: 1, qty: 1, price: 100000 }],
  })).body;
  // sorder 不动库存与往来，直接用收付款测试
  const r1 = await api('POST', '/settlement/create', {
    teamId, type: 'receipt', partnerType: 'cus', partnerId: cus.id, accountId: acc.id, amount: 40000,
  });
  ok(r1.status === 200, '建收款 400', JSON.stringify(r1.body));
  ok(await balOf('cus', cus.id) === -40000, '客户余额 -400（预收）', String(await balOf('cus', cus.id)));
  ok(await accBal(acc.id) === 140000, '现金 1000+400=1400', String(await accBal(acc.id)));

  // ---- 2. 改金额 400 → 700 ----
  const list1 = (await api('GET', `/settlement/list?teamId=${teamId}`)).body;
  const sid = list1[0].id;
  const u1 = await api('PUT', `/settlement/${sid}`, { teamId, amount: 70000 });
  ok(u1.status === 200, '改金额 400→700', JSON.stringify(u1.body));
  ok(await balOf('cus', cus.id) === -70000, '客户余额 -700', String(await balOf('cus', cus.id)));
  ok(await accBal(acc.id) === 170000, '现金 1000+700=1700', String(await accBal(acc.id)));

  // ---- 3. 改账户 现金 → 银行 ----
  const u2 = await api('PUT', `/settlement/${sid}`, { teamId, accountId: acc2.id });
  ok(u2.status === 200, '改账户现金→银行', JSON.stringify(u2.body));
  ok(await accBal(acc.id) === 100000, '现金回到 1000', String(await accBal(acc.id)));
  ok(await accBal(acc2.id) === 270000, '银行 2000+700=2700', String(await accBal(acc2.id)));
  ok(await balOf('cus', cus.id) === -70000, '客户余额不变 -700', String(await balOf('cus', cus.id)));

  // ---- 4. 删除 → 全部冲回 ----
  const d1 = await api('DELETE', `/settlement/${sid}?teamId=${teamId}`);
  ok(d1.status === 200, '删除收款单', JSON.stringify(d1.body));
  ok(await balOf('cus', cus.id) === 0, '客户余额回到 0', String(await balOf('cus', cus.id)));
  ok(await accBal(acc2.id) === 200000, '银行回到 2000', String(await accBal(acc2.id)));
  const list2 = (await api('GET', `/settlement/list?teamId=${teamId}`)).body;
  const mySettles = Array.isArray(list2) ? list2.filter((x) => x.partnerId === cus.id) : list2.rows ?? [];
  ok(mySettles.length === 0, '本客户流水已删除', String(mySettles.length));

  // ---- 5. 付款余额校验 ----
  const ven = (await api('POST', '/vendor', { teamId, name: '供应商乙' })).body;
  const p1 = await api('POST', '/settlement/create', {
    teamId, type: 'payment', partnerType: 'ven', partnerId: ven.id, accountId: acc.id, amount: 100000,
  });
  ok(p1.status === 200, '付款 1000（现金恰好够）', JSON.stringify(p1.body));
  ok(await accBal(acc.id) === 0, '现金归零', String(await accBal(acc.id)));

  const p2 = await api('POST', '/settlement/create', {
    teamId, type: 'payment', partnerType: 'ven', partnerId: ven.id, accountId: acc.id, amount: 100,
  });
  ok(p2.status === 400 && /余额不足/.test(p2.body.error ?? ''), '超额付款被拦', JSON.stringify(p2.body));

  // ---- 6. 改单时的可用余额 = 当前余额 + 旧记录占用 ----
  const payList = (await api('GET', `/settlement/list?teamId=${teamId}&type=payment`)).body;
  const pid = payList[0].id;
  // 现金 0 元，但旧付款占了 1000，所以改金额到 900 应该成功
  const u3 = await api('PUT', `/settlement/${pid}`, { teamId, amount: 90000 });
  ok(u3.status === 200, '改付款 1000→900（同账户可用=0+1000）', JSON.stringify(u3.body));
  ok(await accBal(acc.id) === 10000, '现金回补 100', String(await accBal(acc.id)));

  // 改到 1100 应失败（可用 = 0 + 900 = 900 < 1100）
  const u4 = await api('PUT', `/settlement/${pid}`, { teamId, amount: 110000 });
  ok(u4.status === 400 && /余额不足/.test(u4.body.error ?? ''), '改超额被拦', JSON.stringify(u4.body));

  // ---- 7. 改到另一个账户时，可用余额不叠加旧额度（银行 2000 元，改 1500 可行）----
  const u5 = await api('PUT', `/settlement/${pid}`, { teamId, accountId: acc2.id, amount: 150000 });
  ok(u5.status === 200, '换账户改 1500（银行 2000 够）', JSON.stringify(u5.body));
  ok(await accBal(acc.id) === 100000, '现金回补 1000', String(await accBal(acc.id)));
  ok(await accBal(acc2.id) === 50000, '银行 2000-1500=500', String(await accBal(acc2.id)));

  // 换到第三个账户时，可用余额不叠加旧账户占用的额度
  const acc3 = (await api('POST', '/account', { teamId, name: '微信', type: 'cash', balance: 10000 })).body;
  const u5b = await api('PUT', `/settlement/${pid}`, { teamId, accountId: acc3.id, amount: 150000 });
  ok(u5b.status === 400 && /余额不足/.test(u5b.body.error ?? ''),
    '换第三账户超额不借用旧额度（微信仅 100 元）', JSON.stringify(u5b.body));

  // ---- 8. 不存在的记录 ----
  const u6 = await api('PUT', '/settlement/99999999', { teamId, amount: 100 });
  ok(u6.status === 404, '改不存在记录 404', JSON.stringify(u6.body));
  const d6 = await api('DELETE', `/settlement/99999999?teamId=${teamId}`);
  ok(d6.status === 404, '删不存在记录 404', JSON.stringify(d6.body));

  // ---- 9. 金额非法 ----
  const u7 = await api('PUT', `/settlement/${pid}`, { teamId, amount: 0 });
  ok(u7.status === 400, '金额 0 被拦', JSON.stringify(u7.body));
  const u8 = await api('PUT', `/settlement/${pid}`, { teamId, amount: -100 });
  ok(u8.status === 400, '金额负数被拦', JSON.stringify(u8.body));

  // ---- 10. teamId 由令牌注入：越权 teamId 被覆写，改单仍落本团队
  const u9 = await api('PUT', `/settlement/${pid}`, { teamId: 999999, amount: 100 });
  ok(u9.status === 200, '越权 teamId 被令牌覆写，改单成功', JSON.stringify(u9.body));

  console.log(`\n===== ${pass}/${pass + fail} PASS =====`);
  process.exit(fail ? 1 : 0);
})();
