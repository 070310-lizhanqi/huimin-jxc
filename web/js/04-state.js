'use strict';
/* web/js/04-state.js —— 由 app.js 拆分（lines 137-181） */
/* ================= 共享状态 ================= */
const store = reactive({
  teamId: null,
  team: null,
  teams: [],
  cats: [],
  products: [],
  warehouses: [],
  reservoirs: [],
  customers: [],
  vendors: [],
  clerks: [],
  accounts: [],
  units: [],
  print: { company: '', address: '', phone: '', footer: '', showLogo: true },
  loaded: false,
  /* 低库存角标（顶栏铃铛）：pickTeam 后刷新，数据来自 /stats/dashboard */
  lowStockCount: 0,
  lowStockItems: [],
});

/** 刷新低库存角标：失败静默（角标只是提示，不值得打扰用户） */
async function refreshLowStock() {
  if (!store.teamId) return;
  try {
    // B-前1：与工作台首屏共用 fetchDashboardStats（同一 promise 去重 + 30 秒缓存），
    // pickTeam 后不再与工作台各拉一次 /stats/dashboard
    const s = await fetchDashboardStats();
    store.lowStockCount = Number(s.lowStockCount ?? 0);
    store.lowStockItems = (s.lowStockItems || []).map((r) => ({
      ...r,
      prodName: byId(store.products, r.productId)?.name || `#${r.productId}`,
    }));
  } catch {
    /* ignore */
  }
}

/** 档案集合 key → 接口路径（loadBase 与 refreshBase 共用，顺序与旧 loadBase 一致） */
const ARCHIVE_PATHS = {
  cats: '/cat',
  products: '/product',
  warehouses: '/warehouse',
  reservoirs: '/reservoir',
  customers: '/customer',
  vendors: '/vendor',
  clerks: '/clerk',
  accounts: '/account',
  units: '/unit',
};
async function loadBase() {
  const t = store.teamId;
  // Promise.all 任一失败整个 reject 导致后续赋值全不执行——例如 /unit 接口失败时
  // 商品/客户/仓库也都不加载。allSettled 让各接口独立成败，失败项回落空数组。
  const keys = Object.keys(ARCHIVE_PATHS);
  const results = await Promise.allSettled(keys.map((k) => api.get(ARCHIVE_PATHS[k], { teamId: t })));
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') store[keys[i]] = r.value;
    else {
      store[keys[i]] = [];
      failed.push(ARCHIVE_PATHS[keys[i]]);
    }
  });
  if (failed.length) console.warn('[loadBase] 部分档案加载失败：', failed.join(', '));
  // 打印抬头（失败不阻塞主流程）
  try {
    const s = await api.get('/setting/get', { teamId: t });
    if (s && s.print) store.print = s.print;
  } catch {
    /* 忽略 */
  }
}
/**
 * B-前1 局部刷新：增删改后只重拉被改的那一个档案集合（如改商品只拉 /product），
 * 不再全量重拉 9 个档案 + 打印设置。keys 用 store 的集合名
 * （products/customers/vendors/warehouses/reservoirs/cats/units/clerks/accounts），
 * 未知 key 直接忽略；失败项回落空数组并 console.warn（与 loadBase 同款容错）。
 * 注意：调用方只传本次真正改动的集合——跨集合联动（如商品导入自动建分类）
 * 要把联动的集合也传进来。
 */
async function refreshBase(keys) {
  const t = store.teamId;
  const wanted = (Array.isArray(keys) ? keys : []).filter((k) => ARCHIVE_PATHS[k]);
  if (!wanted.length) return;
  const results = await Promise.allSettled(wanted.map((k) => api.get(ARCHIVE_PATHS[k], { teamId: t })));
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') store[wanted[i]] = r.value;
    else {
      store[wanted[i]] = [];
      failed.push(ARCHIVE_PATHS[wanted[i]]);
    }
  });
  if (failed.length) console.warn('[refreshBase] 部分档案加载失败：', failed.join(', '));
}
/**
 * B-前1 /stats/dashboard 共享：pickTeam 的 refreshLowStock 与工作台首屏各拉一次是重复请求。
 * 进行中的请求用同一 promise 去重（两者在启动时几乎同时发出，必命中）。
 * 注意：这里刻意不用时间缓存——审核/作废单据后统计卡必须立即是新数，30 秒缓存会让
 * 用户刚审完单切回工作台时看到旧统计；去重只解决"同时发出"这一例，不解决"先后发出"。
 * 手动刷新（工作台 reloadAll/loadDash）传 force=true，绕过进行中的去重请求强制拉新。
 * 缓存按 teamId 隔离，换账套不会串数据。
 */
let _dashPromise = null; // { promise, teamId }
async function fetchDashboardStats(force) {
  const t = store.teamId;
  if (!force && _dashPromise && _dashPromise.teamId === t) return _dashPromise.promise;
  const p = api.get('/stats/dashboard', { teamId: t });
  _dashPromise = { promise: p, teamId: t };
  try {
    return await p;
  } finally {
    if (_dashPromise && _dashPromise.promise === p) _dashPromise = null;
  }
}
async function loadTeams() {
  store.teams = await api.get('/team/list');
}
async function pickTeam(id) {
  store.teamId = id;
  store.team = store.teams.find((t) => t.id === id) || null;
  localStorage.setItem('oc_teamId', String(id));
  await loadBase();
  store.loaded = true;
  refreshLowStock();
}
async function ensureTeam() {
  // 团队隔离后：登录用户只有一个团队，直接用它
  await loadTeams();
  const id = store.teams.length ? store.teams[0].id : 0;
  if (!id) throw new Error('当前账号未关联账套');
  await pickTeam(id);
}
