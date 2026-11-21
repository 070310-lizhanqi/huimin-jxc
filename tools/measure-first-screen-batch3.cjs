/**
 * 首屏请求数重放计数（B-前1，第二批第二波 W3）。
 *
 * 按前端真实启动顺序重放请求并计数（全部为 GET，只读）：
 *   ensureTeam → loadTeams(1) → pickTeam → loadBase(9 档案 + /setting/get = 10)
 *   → refreshLowStock(/stats/dashboard) → 工作台 onMounted(7 并行 + 2 top + 3 rank = 12)
 *
 * 两种模式对照：
 *   before：旧逻辑——refreshLowStock 与工作台各发一次 /stats/dashboard（共 2 次）；
 *   after：新逻辑——两者共用 fetchDashboardStats（同一 promise 去重 + 30 秒缓存），
 *           工作台首屏复用 pickTeam 时已在途/已缓存的那一次。
 * 计数的是脚本实际发出的 HTTP 请求数（不是静态数），并单独统计 /stats/dashboard 次数。
 *
 * 用法：OC_BASE=http://127.0.0.1:17747/api node tools/measure-first-screen-batch3.cjs
 * 注意：不要命名为 test-*.cjs，否则会被 run-tests.cjs 当作回归脚本执行。
 */
'use strict';
const { authHeader } = require('./test-helpers.cjs');
const OC_BASE = process.env.OC_BASE || 'http://127.0.0.1:7741/api';
const TEAM = 1;

let count = 0;
let dashCount = 0;
const seen = [];
async function apiGet(path, params = {}) {
  const h = await authHeader();
  const qs = new URLSearchParams({ teamId: String(TEAM), ...params }).toString();
  count++;
  if (path === '/stats/dashboard') dashCount++;
  seen.push(path);
  const r = await fetch(`${OC_BASE}${path}?${qs}`, { headers: h });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

// ---- 与 web/js/04-state.js 同款共享逻辑（逐行对照，含 teamId 隔离与 30 秒缓存） ----
let _dashCache = null;
let _dashPromise = null;
async function fetchDashboardStats(force) {
  const t = TEAM;
  if (!force) {
    if (_dashPromise && _dashPromise.teamId === t) return _dashPromise.promise;
    if (_dashCache && _dashCache.teamId === t && Date.now() - _dashCache.at < 30000) return _dashCache.data;
  }
  const p = apiGet('/stats/dashboard');
  _dashPromise = { promise: p, teamId: t };
  try {
    const s = await p;
    _dashCache = { at: Date.now(), data: s, teamId: t };
    return s;
  } finally {
    if (_dashPromise && _dashPromise.promise === p) _dashPromise = null;
  }
}

const ARCHIVE_PATHS = ['/cat', '/product', '/warehouse', '/reservoir', '/customer', '/vendor', '/clerk', '/account', '/unit'];
async function loadBase() {
  await Promise.allSettled(ARCHIVE_PATHS.map((p) => apiGet(p)));
  await apiGet('/setting/get');
}

async function dashboardMounted(dashFetch) {
  const settled = await Promise.allSettled([
    dashFetch(),
    apiGet('/stats/sales-summary', { range: 'month' }),
    apiGet('/stats/trend'),
    apiGet('/doc/list', { page: '1', rows: '8' }),
    apiGet('/report/aging', { mode: 'ar' }),
    apiGet('/report/aging', { mode: 'ap' }),
    apiGet('/report/stock-aging'),
  ].filter(Boolean));
  void settled;
  await Promise.allSettled([
    apiGet('/report/aging/top', { mode: 'ar', limit: '5' }),
    apiGet('/report/aging/top', { mode: 'ap', limit: '5' }),
  ]);
  await Promise.all(['order', 'out', 'receipt'].map(() => apiGet('/report/sale-rank', { dimension: 'order', by: 'cus', range: 'month', limit: '8' })));
}

async function run(mode) {
  count = 0;
  dashCount = 0;
  seen.length = 0;
  _dashCache = null;
  _dashPromise = null;
  // ensureTeam → loadTeams
  await apiGet('/team/list');
  // pickTeam → loadBase（10 个请求）
  await loadBase();
  // refreshLowStock 与工作台 onMounted：真实时序里 refreshLowStock 是 fire-and-forget，
  // 工作台挂载时它的请求正在途中——这里先启动不 await，再进工作台
  let lowStockP;
  if (mode === 'before') lowStockP = apiGet('/stats/dashboard');
  else lowStockP = fetchDashboardStats();
  await dashboardMounted(mode === 'before' ? () => apiGet('/stats/dashboard') : () => fetchDashboardStats());
  await lowStockP;
  return { total: count, dashboard: dashCount };
}

(async () => {
  const before = await run('before');
  const after = await run('after');
  console.log('[measure-first-screen-batch3] 首屏请求数重放（实测 HTTP 请求数）');
  console.log(`  改前（旧逻辑）：共 ${before.total} 个请求，其中 /stats/dashboard ${before.dashboard} 次`);
  console.log(`  改后（共享去重）：共 ${after.total} 个请求，其中 /stats/dashboard ${after.dashboard} 次`);
  console.log(`  节省：${before.total - after.total} 个请求（全部来自重复的 /stats/dashboard）`);
  console.log('  明细（改前）：loadTeams 1 + loadBase 10 + refreshLowStock 1 + 工作台 7 + top 2 + rank 3 = 24');
  console.log('  明细（改后）：loadTeams 1 + loadBase 10 + 工作台 7 + top 2 + rank 3 = 23（refreshLowStock 与工作台共用 1 次 /stats/dashboard）');
  console.log('  注：其余 22 个请求分属不同接口（档案/统计/排行各有独立 range/by 参数），C-前4 禁止合并为 /dashboard/all 大接口，故首屏只能省这 1 个重复请求；B-前1 的大头收益在增删改局部刷新（10 → 1–2 个）。');
})().catch((e) => { console.error('[measure-first-screen-batch3] 异常:', e); process.exit(1); });
