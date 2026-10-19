'use strict';
/* web/js/06-router.js —— 由 app.js 拆分（lines 210-224） */
/* ================= 路由 ================= */
const route = reactive({ page: 'dashboard', sub: '', q: {} });
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [path, qs] = h.split('?');
  const segs = path.split('/').filter(Boolean);
  route.page = segs[0] || 'dashboard';
  route.sub = segs[1] || '';
  route.q = {};
  if (qs) for (const [k, v] of new URLSearchParams(qs)) route.q[k] = v;
}
window.addEventListener('hashchange', parseHash);
parseHash();
function nav(hash) { location.hash = hash; }

