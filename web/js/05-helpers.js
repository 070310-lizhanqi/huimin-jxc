'use strict';
/* web/js/05-helpers.js —— 由 app.js 拆分（lines 182-209） */
/* ================= 通用小工具 ================= */
/** 今天日期 YYYY-MM-DD（本地时区，避免 toISOString 的 UTC 偏移） */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
/** 商品规格 */
const specOf = (id) => (byId(store.products, id)?.spec || '—');
/** 商品单位 */
const unitOf = (id) => (byId(store.products, id)?.unit || '—');

/* 名称解析 */
const byId = (arr, id) => arr.find(x => x.id === id) || null;
const prodLabel = (id) => {
  const p = byId(store.products, id);
  return p ? p.name + (p.spec ? `（${p.spec}）` : '') : `商品#${id}`;
};
const partnerLabel = (row) => {
  if (!row.partnerType || !row.partnerId) return null;
  const p = row.partnerType === 'cus' ? byId(store.customers, row.partnerId) : byId(store.vendors, row.partnerId);
  return p ? p.name : null;
};
const accountLabel = (id) => (id ? (byId(store.accounts, id)?.name ?? `账户#${id}`) : null);
const clerkLabel = (id) => (id ? (byId(store.clerks, id)?.name ?? `#${id}`) : null);
const whLabel = (id) => (id ? (byId(store.warehouses, id)?.name ?? `仓库#${id}`) : null);
const catLabel = (id) => (id ? (byId(store.cats, id)?.name ?? '') : '');

