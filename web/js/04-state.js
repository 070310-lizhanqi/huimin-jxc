'use strict';
/* web/js/04-state.js —— 由 app.js 拆分（lines 137-181） */
/* ================= 共享状态 ================= */
const store = reactive({
  teamId: null, team: null, teams: [],
  cats: [], products: [], warehouses: [], reservoirs: [],
  customers: [], vendors: [], clerks: [], accounts: [], units: [],
  print: { company: '', address: '', phone: '', footer: '', showLogo: true },
  loaded: false,
});

async function loadTeams() {
  store.teams = await api.get('/team/list');
}
async function loadBase() {
  const t = store.teamId;
  const [cats, products, warehouses, reservoirs, customers, vendors, clerks, accounts, units] = await Promise.all([
    api.get('/cat', { teamId: t }), api.get('/product', { teamId: t }),
    api.get('/warehouse', { teamId: t }), api.get('/reservoir', { teamId: t }),
    api.get('/customer', { teamId: t }), api.get('/vendor', { teamId: t }),
    api.get('/clerk', { teamId: t }), api.get('/account', { teamId: t }),
    api.get('/unit', { teamId: t }).catch(() => []),
  ]);
  store.cats = cats; store.products = products; store.warehouses = warehouses;
  store.reservoirs = reservoirs; store.customers = customers; store.vendors = vendors;
  store.clerks = clerks; store.accounts = accounts; store.units = units;
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
}
async function ensureTeam() {
  // 团队隔离后：登录用户只有一个团队，直接用它
  await loadTeams();
  const id = store.teams.length ? store.teams[0].id : 0;
  if (!id) throw new Error('当前账号未关联账套');
  await pickTeam(id);
}

