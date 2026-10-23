'use strict';
/* web/js/05-helpers.js —— 由 app.js 拆分（lines 182-209） */
/* ================= 通用小工具 ================= */
/** 今天日期 YYYY-MM-DD（本地时区，避免 toISOString 的 UTC 偏移） */
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
/** 元 → 分：加 epsilon 纠正 1.005*100=100.49999999999999 这类浮点误差；非法输入按 0 */
function toCents(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100 + Number.EPSILON * Math.sign(n) * 100);
}
/** HTML 转义：拼打印页/弹窗 HTML 时必须包一层，防用户输入的名称/备注注入脚本 */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
/** 商品规格 */
const specOf = (id) => (byId(store.products, id)?.spec || '—');
/** 商品单位 */
const unitOf = (id) => (byId(store.products, id)?.unit || '—');

/* 名称解析：byId 是 O(n) 线性 find，在模板每行都被调用（prodLabel/whLabel/partnerLabel 等），
 * 列表 1000 行 × 每行 6 次 find = 6000 次线性扫，直接卡 UI 线程。
 * 这里对常用档案建 Map<id, entity> 缓存；源数组被替换时（loadBase/档案编辑）通过
 * 版本号比对失效重建。 */
const _mapCache = new WeakMap();
function toMap(arr) {
  let m = _mapCache.get(arr);
  if (m && m._size === arr.length) return m;
  m = new Map();
  for (const x of arr) m.set(x.id, x);
  m._size = arr.length;
  _mapCache.set(arr, m);
  return m;
}
const byId = (arr, id) => {
  if (!arr || !arr.length) return null;
  return toMap(arr).get(id) || null;
};
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

