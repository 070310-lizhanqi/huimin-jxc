'use strict';
/* web/js/04-state.js —— 由 app.js 拆分（lines 137-181） */
/* ================= 共享状态 ================= */
const store = reactive({
  teamId: null, team: null, teams: [],
  cats: [], products: [], warehouses: [], reservoirs: [],
  customers: [], vendors: [], clerks: [], accounts: [], units: [],
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
    const s = await api.get('/stats/dashboard', { teamId: store.teamId });
    store.lowStockCount = Number(s.lowStockCount ?? 0);
    store.lowStockItems = (s.lowStockItems || []).map((r) => ({
      ...r,
      prodName: byId(store.products, r.productId)?.name || `#${r.productId}`,
    }));
  } catch { /* ignore */ }
}

async function loadTeams() {
  store.teams = await api.get('/team/list');
}
async function loadBase() {
  const t = store.teamId;
  // Promise.all 任一失败整个 reject 导致后续赋值全不执行——例如 /unit 接口失败时
  // 商品/客户/仓库也都不加载。allSettled 让各接口独立成败，失败项回落空数组。
  const keys = ['cats', 'products', 'warehouses', 'reservoirs', 'customers', 'vendors', 'clerks', 'accounts', 'units'];
  const paths = ['/cat', '/product', '/warehouse', '/reservoir', '/customer', '/vendor', '/clerk', '/account', '/unit'];
  const results = await Promise.allSettled(paths.map((p) => api.get(p, { teamId: t })));
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') store[keys[i]] = r.value;
    else { store[keys[i]] = []; failed.push(paths[i]); }
  });
  if (failed.length) console.warn('[loadBase] 部分档案加载失败：', failed.join(', '));
  // 打印抬头（失败不阻塞主流程）
  try {
    const s = await api.get('/setting/get', { teamId: t });
    if (s && s.print) store.print = s.print;
  } catch { /* 忽略 */ }
}
async function pickTeam(id) {
  store.teamId = id;
  store.team = store.teams.find(t => t.id === id) || null;
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

