/* 橙子进销存 前端 SPA —— Vue3 全局构建 + Element Plus + echarts（无构建步骤） */
'use strict';
const { createApp, ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } = Vue;
const { ElMessage, ElMessageBox } = ElementPlus;

/* ================= API ================= */
/* 登录态：令牌存 localStorage，所有请求自动携带；收到 401 立即回登录页 */
const TOKEN_KEY = 'oc_token';
const auth = reactive({ token: localStorage.getItem(TOKEN_KEY) || '', user: null, team: null, ready: false });

function setToken(t) {
  auth.token = t || '';
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}
function logout() {
  setToken('');
  auth.user = null; auth.team = null;
  store.loaded = false;
  store.teamId = null; store.team = null; store.teams = [];
  location.hash = '#/login';
}

async function req(method, path, body, params) {
  let url = '/api' + path;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += '?' + s;
  }
  const opt = { method, headers: {} };
  if (auth.token) opt.headers.authorization = 'Bearer ' + auth.token;
  if (body !== undefined) {
    opt.headers['content-type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(url, opt);
  let data = null;
  try { data = await r.json(); } catch { /* non-json */ }
  // 令牌失效：清空登录态并跳登录页（登录接口自身的 401 交给调用方提示）
  if (r.status === 401 && !path.startsWith('/auth/login')) {
    if (auth.token) { setToken(''); auth.user = null; auth.team = null; }
    if (location.hash !== '#/login') location.hash = '#/login';
  }
  if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  return data;
}
const api = {
  get: (p, params) => req('GET', p, undefined, params),
  post: (p, body) => req('POST', p, body ?? {}),
  put: (p, body) => req('PUT', p, body ?? {}),
  del: (p, params) => req('DELETE', p, undefined, params),
};

/* ================= 工具 ================= */
function toast(msg, type = 'success') {
  ElMessage({ message: msg, type, duration: 2400, showClose: false });
}
async function confirmBox(msg, tip = '提示') {
  try {
    await ElMessageBox.confirm(msg, tip, {
      type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消',
    });
    return true;
  } catch { return false; }
}
function fmtMoney(cents) {
  if (cents == null) return '—';
  return (Number(cents) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const STATUS_TEXT = { draft: '草稿', pending: '待审核', audit: '已审核', void: '已作废' };

/* 异步动作防抖：返回包装函数，执行时置 flag 为 true，模板用 :disabled="flag" 禁用按钮 */
function busyFn(flagRef) {
  return (fn) => async (...args) => {
    if (flagRef.value) return;
    flagRef.value = true;
    try { return await fn(...args); }
    finally { flagRef.value = false; }
  };
}

/* CSV 导出：rows 为对象数组，headers 为 [{key,label}]；前端生成下载 */
function exportCsv(filename, rows, headers) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.map((h) => esc(h.label)).join(',')];
  for (const r of rows) lines.push(headers.map((h) => esc(r[h.key])).join(','));
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
  toast('已导出 ' + filename);
}

/* ================= 单据元信息 ================= */
const DOC_META = {
  stockinit: { label: '期初库存', warehouse: true, batch: true },  quo: { label: '报价单', partner: 'cus', warehouse: false, order: true, convertTo: 'sorder', convertLabel: '转销售订单', priceField: 'salePrice' },
  porder: { label: '采购订单', partner: 'ven', warehouse: false, order: true, convertTo: 'stockin', convertLabel: '生成采购入库', priceField: 'purchasePrice' },
  stockin: { label: '采购入库', partner: 'ven', warehouse: true, batch: true, priceField: 'purchasePrice',
    payLabel: '减本次付款', recvLabel: '应付金额' },
  pin: { label: '采购退货', partner: 'ven', warehouse: true, priceField: 'purchasePrice',
    payLabel: '减本次付款', recvLabel: '应付金额' },
  sorder: { label: '销售订单', partner: 'cus', warehouse: false, order: true, convertTo: 'stockout', convertLabel: '生成销售出库', priceField: 'salePrice' },
  stockout: { label: '销售出库', partner: 'cus', warehouse: true, priceField: 'salePrice' },
  sret: { label: '销售退货', partner: 'cus', warehouse: true, batch: true, priceField: 'salePrice' },
  transfer: { label: '调拨单', warehouse: true, toWarehouse: true },
  adjust: { label: '库存调整', warehouse: true, negative: true },
  // 盘点单明细填「实盘数量」（绝对数，可为 0），审核时按与账面差额自动盈亏
  stocktake: { label: '盘点单', warehouse: true, stocktake: true },
  otherin: { label: '其它入库', warehouse: true, batch: true },
  otherout: { label: '其它出库', warehouse: true },
  // 生产组装：正数行 = 产出成品入库，负数行 = 耗用原料出库
  assembly: { label: '生产组装', warehouse: true, negative: true, assemblyNote: '正数行产出成品入库，负数行耗用原料出库' },
  // 出库申请单：先申请后出库，不动库存，审核后可一键生成销售出库
  outapply: { label: '出库申请单', partner: 'cus', warehouse: false, order: true, convertTo: 'stockout', convertLabel: '生成销售出库', priceField: 'salePrice' },
  // 生产任务：下达生产计划，不动库存，审核后可一键生成生产组装单
  prodtask: { label: '生产任务', warehouse: false, order: true, convertTo: 'assembly', convertLabel: '生成生产组装单' },
};
const DOC_GROUPS = {
  purchase: { label: '采购管理', types: ['porder', 'stockin', 'pin'] },
  sale: { label: '销售管理', types: ['quo', 'sorder', 'stockout', 'sret'] },
  inventory: { label: '库存单据', types: ['stockinit', 'transfer', 'adjust', 'stocktake', 'otherin', 'otherout', 'assembly'] },
  // 出库申请 / 生产任务：申请类单据，走库存模块
  apply: { label: '申请与任务', types: ['outapply', 'prodtask'] },
};

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

/* ================= 单据查看器（共享组件） ================= */
const DocViewer = {
  props: { docId: { type: Number, default: null } },
  emits: ['close'],
  setup(props, { emit }) {
    const data = ref(null);
    watch(() => props.docId, async (v) => {
      data.value = null;
      if (!v) return;
      try { data.value = await api.get('/doc/info', { id: v, teamId: store.teamId }); }
      catch (e) { toast(e.message, 'error'); emit('close'); }
    }, { immediate: true });
    const close = () => emit('close');
    function printDoc() {
      const d = data.value;
      if (!d) return;
      const w = window.open('', '_blank', 'width=820,height=900');
      if (!w) return toast('浏览器拦截了打印窗口，请允许弹出窗口', 'error');
      const items = d.items.map((it) => `<tr>
        <td>${escapeHtml(prodLabel(it.productId))}</td>
        <td style="text-align:right">${it.qty}</td>
        <td style="text-align:right">${fmtMoney(it.price)}</td>
        <td style="text-align:right">${fmtMoney(it.amount)}</td>
        <td>${escapeHtml(it.batchNo || '')}</td>
        <td>${it.toWarehouseId ? escapeHtml(whLabel(it.toWarehouseId) || '') : ''}</td>
        <td>${escapeHtml(it.remark || '')}</td>
      </tr>`).join('');
      const conf = store.print || {};
      const headHtml = (conf.company || conf.address || conf.phone)
        ? `<div class="head">
             ${conf.showLogo ? '<span class="logo">橙</span>' : ''}
             <div>
               ${conf.company ? `<div class="co">${escapeHtml(conf.company)}</div>` : ''}
               <div class="co-sub">${escapeHtml(conf.address || '')}${conf.phone ? (conf.address ? ' · ' : '') + escapeHtml(conf.phone) : ''}</div>
             </div>
           </div>`
        : '';
      w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(d.doc.billNo)}</title>
        <style>
          body { font-family: 'Microsoft YaHei', sans-serif; padding: 28px; color: #222; font-size: 13px; }
          .head { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid #e0e0e0; padding-bottom: 10px; margin-bottom: 14px; }
          .head .logo { width: 34px; height: 34px; border-radius: 50%; background: #f26f21; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; }
          .head .co { font-size: 15px; font-weight: 600; }
          .head .co-sub { color: #888; font-size: 12px; }
          h2 { text-align: center; margin: 0 0 4px; }
          .sub { text-align: center; color: #888; margin-bottom: 18px; font-size: 12px; }
          table.meta { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
          table.meta td { padding: 3px 6px; }
          table.items { width: 100%; border-collapse: collapse; }
          table.items th, table.items td { border: 1px solid #bbb; padding: 6px 8px; font-size: 12.5px; }
          table.items th { background: #f5f5f5; }
          .total { margin-top: 10px; text-align: right; font-size: 13px; }
          .foot { margin-top: 26px; display: flex; justify-content: space-between; }
        </style></head><body>
        ${headHtml}
        <h2>${escapeHtml(DOC_META[d.doc.type]?.label || d.doc.type)}</h2>
        <div class="sub">单号：${escapeHtml(d.doc.billNo)} 　日期：${escapeHtml((d.doc.date || '').slice(0, 10))}</div>
        <table class="meta"><tr>
          <td>往来单位：${escapeHtml(partnerLabel(d.doc) || '—')}</td>
          <td>仓库：${escapeHtml(whLabel(d.doc.warehouseId) || '—')}</td>
          <td>业务员：${escapeHtml(clerkLabel(d.doc.clerkId) || '—')}</td>
          <td>状态：${escapeHtml(STATUS_TEXT[d.doc.status] || d.doc.status)}</td>
        </tr></table>
        <table class="items"><thead><tr><th>商品</th><th>数量</th><th>单价</th><th>金额</th><th>批次</th><th>调往仓库</th><th>备注</th></tr></thead>
        <tbody>${items}</tbody></table>
        <div class="total">合计数量：${d.doc.totalQty}　合计金额：￥${fmtMoney(d.doc.totalAmount)}</div>
        ${d.doc.remark ? `<div style="margin-top:8px">备注：${escapeHtml(d.doc.remark)}</div>` : ''}
        ${conf.footer ? `<div style="margin-top:14px;text-align:center;color:#888;font-size:12px">${escapeHtml(conf.footer)}</div>` : ''}
        <div class="foot"><span>制单人：____________</span><span>审核人：____________</span><span>签收人：____________</span></div>
        <script>window.onload = () => window.print();<\/script>
      </body></html>`);
      w.document.close();
    }
    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }
    return { data, close, printDoc, fmtMoney, prodLabel, partnerLabel, whLabel, clerkLabel, STATUS_TEXT, DOC_META, accountLabel,
      oweOf: computed(() => {
        const d = data.value && data.value.doc;
        if (!d) return 0;
        return Math.max(0, (d.totalAmount || 0) - (d.paidAmount || 0) - (d.deposit || 0));
      }) };
  },
  template: `
  <div class="modal-mask" v-if="docId" @click.self="close">
    <div class="modal">
      <div class="modal-head">
        <span class="mt">{{ data ? (DOC_META[data.doc.type]?.label || data.doc.type) + ' ' + data.doc.billNo : '单据详情' }}</span>
        <span class="x" @click="close">×</span>
      </div>
      <div class="modal-body" v-if="data">
        <div class="form-grid">
          <div class="fitem"><label>单号</label><span class="billno">{{ data.doc.billNo }}</span></div>
          <div class="fitem"><label>日期</label><span>{{ (data.doc.date || '').slice(0, 10) }}</span></div>
          <div class="fitem" v-if="data.doc.partnerType"><label>{{ data.doc.partnerType === 'cus' ? '客户' : '供应商' }}</label><span>{{ partnerLabel(data.doc) || '#' + data.doc.partnerId }}</span></div>
          <div class="fitem"><label>仓库</label><span>{{ whLabel(data.doc.warehouseId) || '—' }}</span></div>
          <div class="fitem"><label>业务员</label><span>{{ clerkLabel(data.doc.clerkId) || '—' }}</span></div>
          <div class="fitem"><label>状态</label><span :class="'tag tag-' + data.doc.status">{{ STATUS_TEXT[data.doc.status] || data.doc.status }}</span></div>
          <div class="fitem" v-if="data.doc.refOrderId"><label>源订单</label><span class="muted">单据 #{{ data.doc.refOrderId }}</span></div>
          <div class="fitem" v-if="data.doc.receiverName"><label>收件人</label><span>{{ data.doc.receiverName }}</span></div>
          <div class="fitem" v-if="data.doc.receiverMobile"><label>收件手机</label><span>{{ data.doc.receiverMobile }}</span></div>
          <div class="fitem" v-if="data.doc.receiverAddress" style="grid-column:1/-1"><label>收件地址</label><span>{{ data.doc.receiverAddress }}</span></div>
          <div class="fitem" style="grid-column:1/-1"><label>备注</label><span>{{ data.doc.remark || '—' }}</span></div>
          <!-- 结算区（折扣/收付/账户/订金） -->
          <template v-if="(data.doc.discount||0) > 0 || (data.doc.paidAmount||0) > 0 || (data.doc.deposit||0) > 0 || data.doc.accountId">
            <div class="fitem"><label>整单折扣</label><span class="money">{{ fmtMoney(data.doc.discount || 0) }}</span></div>
            <div class="fitem"><label>本次收付</label><span class="money">{{ fmtMoney(data.doc.paidAmount || 0) }}</span></div>
            <div class="fitem"><label>抵扣订金</label><span class="money">{{ fmtMoney(data.doc.deposit || 0) }}</span></div>
            <div class="fitem"><label>收付账户</label><span>{{ accountLabel(data.doc.accountId) || '—' }}</span></div>
          </template>
        </div>
        <table class="tbl" style="margin-top:10px">
          <thead><tr><th>商品</th><th class="r">数量</th><th class="r">单价</th><th class="r">金额</th><th>批次</th><th>调往仓库</th><th>备注</th></tr></thead>
          <tbody>
            <tr v-for="it in data.items" :key="it.id">
              <td>{{ prodLabel(it.productId) }}</td>
              <td class="r">{{ it.qty }}</td>
              <td class="r money">{{ fmtMoney(it.price) }}</td>
              <td class="r money">{{ fmtMoney(it.amount) }}</td>
              <td>{{ it.batchNo || '—' }}</td>
              <td>{{ it.toWarehouseId ? (whLabel(it.toWarehouseId) || '') : '—' }}</td>
              <td>{{ it.remark || '—' }}</td>
            </tr>
          </tbody>
        </table>
        <div class="tfoot-bar">
          <span>合计数量 <b>{{ data.doc.totalQty }}</b></span>
          <span>商品金额 <b class="money">{{ fmtMoney((data.doc.totalAmount || 0) + (data.doc.discount || 0)) }}</b></span>
          <span v-if="(data.doc.discount||0) > 0">折扣 <b class="money">-{{ fmtMoney(data.doc.discount || 0) }}</b></span>
          <span>应收金额 <b class="money" style="color:var(--brand)">{{ fmtMoney(data.doc.totalAmount) }}</b></span>
          <span v-if="oweOf > 0">本次欠款 <b class="money" style="color:#f56c6c">{{ fmtMoney(oweOf) }}</b></span>
        </div>
      </div>
      <div class="modal-body" v-else style="text-align:center;padding:50px"><span class="muted">加载中…</span></div>
      <div class="modal-foot">
        <button class="btn" v-if="data" @click="printDoc"><el-icon><Printer/></el-icon> 打印</button>
        <span style="flex:1"></span>
        <button class="btn" @click="close">关闭</button>
      </div>
    </div>
  </div>`,
};

/* ================= 工作台（对齐橙子云 6 格图表墙） ================= */
const DashboardPage = {
  components: { DocViewer },
  setup() {
    const stats = ref(null);
    const sales = ref(null);
    const range = ref('month');
    const trend = ref([]);
    const recent = ref({ rows: [], total: 0 });
    const arAging = ref(null);
    const apAging = ref(null);
    const stockAging = ref(null);
    const arTop = ref([]);
    const apTop = ref([]);
    const viewerId = ref(null);
    const trendEl = ref(null);
    const arEl = ref(null);
    const apEl = ref(null);
    const stockEl = ref(null);
    const arTopEl = ref(null);
    const apTopEl = ref(null);
    const charts = [];

    /**
     * 三张独立排行卡（对齐真实橙子云工作台）：
     * 销售订单排行 / 销售出库排行 / 销售收款排行，各自独立切维度与时间范围
     */
    const DIM_ALL = [
      { k: 'clerk', label: '业务员' },
      { k: 'cus', label: '客户' },
      { k: 'product', label: '商品' },
    ];
    const RANK_CARDS = [
      { k: 'order', label: '销售订单排行', dims: DIM_ALL, more: '#/doc/sale?type=sorder', emptyText: '本月还没有销售订单' },
      { k: 'out', label: '销售出库排行', dims: DIM_ALL, more: '#/doc/sale?type=stockout', emptyText: '本月还没有销售出库' },
      { k: 'receipt', label: '销售收款排行', dims: [{ k: 'cus', label: '客户' }, { k: 'clerk', label: '业务员' }], more: '#/finance', emptyText: '本月还没有收款记录' },
    ];
    const rankRange = ref('month');
    const rankData = reactive({ order: [], out: [], receipt: [] });
    const rankBy = reactive({ order: 'cus', out: 'cus', receipt: 'cus' });
    const rankRefs = reactive({});
    /** 常用功能快捷入口（对齐橙子云工作台，可在页面上增删，存 localStorage） */
    const QUICK_DEFAULT = [
      { label: '销售出库', icon: 'Sell', to: '#/doc/sale?type=stockout&new=1' },
      { label: '采购入库', icon: 'ShoppingCart', to: '#/doc/purchase?type=stockin&new=1' },
      { label: '收款', icon: 'Money', to: '#/finance' },
      { label: '付款', icon: 'Wallet', to: '#/finance' },
      { label: '商品', icon: 'Goods', to: '#/product' },
      { label: '客户', icon: 'User', to: '#/partner?tab=cus' },
      { label: '供应商', icon: 'OfficeBuilding', to: '#/partner?tab=ven' },
      { label: '库存查询', icon: 'Box', to: '#/stock' },
      { label: '库存盘点', icon: 'DocumentChecked', to: '#/doc/inventory?type=stocktake&new=1' },
      { label: '进销存统计', icon: 'DataLine', to: '#/jxcstat' },
      { label: '库存预估', icon: 'TrendCharts', to: '#/forecast' },
      { label: '客户对账单', icon: 'Tickets', to: '#/statement?mode=ar' },
    ];
    const QUICK_KEY = 'orange.quick.' + store.teamId;
    const quickEdit = ref(false);

    function loadQuick() {
      try {
        const raw = localStorage.getItem(QUICK_KEY);
        const arr = raw ? JSON.parse(raw) : null;
        if (Array.isArray(arr) && arr.length) {
          // 只保留仍存在的默认项（防止旧版本残留失效入口）
          const map = new Map(QUICK_DEFAULT.map((x) => [x.label, x]));
          const kept = arr.map((l) => map.get(l)).filter(Boolean);
          return kept.length ? kept : QUICK_DEFAULT.slice();
        }
      } catch (e) { /* 忽略损坏的本地数据 */ }
      return QUICK_DEFAULT.slice();
    }
    const QUICK = ref(loadQuick());

    function persistQuick() {
      try { localStorage.setItem(QUICK_KEY, JSON.stringify(QUICK.value.map((x) => x.label))); } catch (e) { /* 存储满时忽略 */ }
    }
    function removeQuick(label) {
      QUICK.value = QUICK.value.filter((x) => x.label !== label);
      persistQuick();
    }
    function restoreQuick() {
      QUICK.value = QUICK_DEFAULT.slice();
      persistQuick();
    }
    function resetQuick() {
      QUICK.value = QUICK_DEFAULT.slice();
      persistQuick();
      quickEdit.value = false;
    }

    /** 四项 KPI（对齐橙子云「新增销售数据」） */
    const kpis = computed(() => {
      const s = sales.value;
      if (!s) return [];
      return [
        { label: '订单', val: String(s.orderCount ?? 0), unit: '张', sub: fmtMoney(s.orderAmount) + ' 元' },
        { label: '出库', val: String(s.outCount ?? 0), unit: '张', sub: fmtMoney(s.outAmount) + ' 元' },
        { label: '收款', val: String(s.receiptCount ?? 0), unit: '笔', sub: fmtMoney(s.receiptAmount) + ' 元' },
        // 毛利是金额不是张数：加 ¥ 前缀并降一号字，避免和上面三个计数挤在同一视觉层级
        { label: '毛利', val: fmtMoney(s.grossProfit), unit: '', prefix: '¥', sub: '净销售额 − 成本', money: true },
      ];
    });

    const lowStockItems = computed(() => (stats.value?.lowStockItems ?? []).map((r) => ({
      ...r,
      prodName: byId(store.products, r.productId)?.name || `#${r.productId}`,
    })));
    const showGuide = computed(() => !store.products.length && stats.value
      && Number(stats.value.draftCount ?? 0) === 0 && Number(stats.value.totalQty ?? 0) === 0);

    /** 环形图公共配置 */
    const BUCKET_LABELS = ['30天内', '60天内', '90天内', '180天内', '360天内', '720天内', '超过720天'];
    const BUCKET_COLORS = ['#5b8ff9', '#8fd16a', '#f6bd16', '#f56c6c', '#6dc8ec', '#5ad8a6', '#ff9845'];
    const BUCKET_KEYS = ['d30', 'd60', 'd90', 'd180', 'd360', 'd720', 'over720'];

    /**
     * 账龄环形图：中心显示未结合计，左侧图例两行排版（档位 + 占比/金额）。
     * 全部为 0 时不画图（由模板渲染空状态），避免出现「暂无数据(0%:0.00)」这种原始图例。
     * 中心金额用各档位净值之和（与下方「未结合计」一致）；环图面积用绝对值占比，
     * 否则负档位（退货冲减后的负数）会在饼图里消失导致视觉与数字不符。
     */
    function donut(el, totals, unit, centerLabel) {
      if (!el) return null;
      const c = echarts.init(el);
      const raw = BUCKET_KEYS.map((k) => Number(totals?.[k] ?? 0));
      const sumAbs = raw.reduce((a, v) => a + Math.abs(v), 0);
      // 中心与合计用净值；饼图扇区用绝对值（负档位也显示出来，占比按绝对值算）
      const sumNet = Number(totals?.total ?? raw.reduce((a, v) => a + v, 0));
      const data = BUCKET_KEYS.map((k, i) => ({
        name: BUCKET_LABELS[i],
        value: Math.abs(raw[i]),
        rawValue: raw[i],
        itemStyle: { color: BUCKET_COLORS[i] },
      })).filter((d) => d.value > 0);
      c.setOption({
        tooltip: {
          trigger: 'item',
          formatter: (p) => {
            const rv = p.data?.rawValue ?? p.value;
            const sign = rv < 0 ? '（退货冲减）' : '';
            return `${p.name}\n${fmtMoney(rv)} ${unit} · ${p.percent}%${sign}`;
          },
          backgroundColor: 'rgba(45,55,68,.94)', borderWidth: 0,
          textStyle: { color: '#fff', fontSize: 12 }, padding: [7, 11],
        },
        legend: {
          orient: 'vertical', left: 2, top: 'middle',
          itemWidth: 8, itemHeight: 8, itemGap: 9,
          icon: 'circle',
          textStyle: {
            fontSize: 12, color: '#5c6670', lineHeight: 15,
            rich: {
              nm: { fontSize: 12, color: '#5c6670', width: 58 },
              pc: { fontSize: 12, color: '#303133', fontWeight: 600, align: 'right' },
              am: { fontSize: 11, color: '#9aa3ad' },
            },
          },
          formatter: (name) => {
            const d = data.find((x) => x.name === name);
            if (!d) return '';
            const pct = sumAbs > 0 ? Math.round((d.value / sumAbs) * 100) : 0;
            return `{nm|${name}}{pc|${pct}%}\n{am|${fmtMoney(d.rawValue)}}`;
          },
        },
        series: [{
          type: 'pie', radius: ['54%', '78%'], center: ['76%', '50%'],
          avoidLabelOverlap: false,
          label: {
            show: true, position: 'center',
            formatter: () => `${fmtMoney(sumNet)}\n{unit|${centerLabel || '未结合计'}}`,
            rich: {
              unit: { fontSize: 11, color: '#9aa3ad', lineHeight: 20 },
            },
            color: '#303133', fontSize: 15, fontWeight: 600, lineHeight: 20,
          },
          labelLine: { show: false },
          itemStyle: { borderColor: '#fff', borderWidth: 2 },
          emphasis: { scale: true, scaleSize: 4 },
          data,
        }],
      });
      charts.push(c);
      return c;
    }

    /** 账龄是否有数据（全档位为 0 视为无） */
    function hasAging(a) {
      const t = a?.totals;
      if (!t) return false;
      return BUCKET_KEYS.some((k) => Math.abs(t[k] ?? 0) > 0);
    }

    /** 横向条形排行图 */
    /**
     * 横向条形排行图。
     * 负值（退货冲减后往来余额为负）用红色反向条 + 负号标签，避免出现「一根灰短条」的观感。
     */
    function barRank(el, rows, unit) {
      if (!el) return null;
      const c = echarts.init(el);
      const data = (rows || []).slice().reverse();
      const hasNeg = data.some((r) => r.amount < 0);
      c.setOption({
        grid: { left: 104, right: 52, top: 8, bottom: 8 },
        tooltip: {
          trigger: 'axis', axisPointer: { type: 'shadow' },
          backgroundColor: 'rgba(45,55,68,.94)', borderWidth: 0,
          textStyle: { color: '#fff', fontSize: 12 }, padding: [7, 11],
          formatter: (p) => `${p[0].name}\n${fmtMoney(p[0].value)} ${unit}`,
        },
        xAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: '#f2f3f5' } },
          axisLabel: { color: '#9aa3ad', fontSize: 11, formatter: (v) => (v === 0 ? '0' : fmtMoney(v)) },
          axisLine: { show: false }, axisTick: { show: false },
          // 有负值时把 0 轴画出来，负条才有基线
          ...(hasNeg ? {} : {}),
        },
        yAxis: {
          type: 'category', data: data.map((r) => r.name),
          axisLine: { lineStyle: { color: '#e8eaed' } }, axisTick: { show: false },
          axisLabel: { color: '#5c6670', fontSize: 12, width: 96, overflow: 'truncate', ellipsis: '…' },
        },
        series: [{
          type: 'bar', barMaxWidth: 14,
          data: data.map((r) => ({
            value: r.amount,
            itemStyle: {
              color: r.amount < 0 ? '#f56c6c' : '#ff9845',
              borderRadius: r.amount < 0 ? [3, 0, 0, 3] : [0, 3, 3, 0],
            },
          })),
          label: {
            show: true, position: 'right', fontSize: 11,
            color: (p) => (p.value < 0 ? '#f56c6c' : '#8a919c'),
            formatter: (p) => fmtMoney(p.value),
            // 负值标签放到条的左侧，避免贴住零点
            ...(hasNeg ? {} : {}),
          },
          labelLayout: (params) => (params.rect && params.rect.width < 0 ? { x: params.rect.x - 8 } : {}),
        }],
      });
      charts.push(c);
      return c;
    }

    function renderTrend() {
      if (!trendEl.value) return;
      const byDay = {};
      for (const r of trend.value) byDay[r.day] = r;
      const days = [];
      const inData = [];
      const outData = [];
      const now = new Date();
      for (let i = 13; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        days.push(`${d.getMonth() + 1}/${d.getDate()}`);
        const row = byDay[key];
        inData.push(row ? row.inQty : 0);
        outData.push(row ? row.outQty : 0);
      }
      const c = echarts.init(trendEl.value);
      c.setOption({
        grid: { left: 44, right: 12, top: 34, bottom: 26 },
        tooltip: { trigger: 'axis' },
        legend: { data: ['入库', '出库'], right: 0, top: 0, itemWidth: 12 },
        xAxis: { type: 'category', data: days, axisLine: { lineStyle: { color: '#e8eaed' } }, axisLabel: { color: '#8a919c' } },
        yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f0f1f3' } }, axisLabel: { color: '#8a919c' } },
        series: [
          { name: '入库', type: 'bar', data: inData, itemStyle: { color: '#ff9a3c', borderRadius: [3, 3, 0, 0] }, barMaxWidth: 16 },
          { name: '出库', type: 'bar', data: outData, itemStyle: { color: '#b8c2cc', borderRadius: [3, 3, 0, 0] }, barMaxWidth: 16 },
        ],
      });
      charts.push(c);
    }

    /**
     * 加载单张排行卡：
     *   dimension=order  （销售订单，按单据金额）
     *   dimension=out    （销售出库）
     *   dimension=receipt（销售收款）
     */
    async function loadRank(kind) {
      const dim = kind === 'order' ? 'order' : kind === 'receipt' ? 'receipt' : 'out';
      const by = dim === 'receipt' ? 'cus' : (rankBy[kind] || 'cus');
      const rows = await api.get('/report/sale-rank', {
        teamId: store.teamId, dimension: dim, by, range: rankRange.value, limit: 8,
      }).then((r) => r.rows || []).catch(() => []);
      rankData[kind] = rows;
      await nextTick();
      const el = document.getElementById('rank-' + kind);
      if (el) {
        echarts.getInstanceByDom(el)?.dispose();
        barRank(el, rows, '元');
      }
    }
    async function loadAllRanks() {
      await Promise.all(['order', 'out', 'receipt'].map((k) => loadRank(k)));
    }

    async function reloadAll() {
      const [s, sum] = await Promise.all([
        api.get('/stats/dashboard', { teamId: store.teamId }),
        api.get('/stats/sales-summary', { teamId: store.teamId, range: range.value }),
      ]);
      stats.value = s;
      sales.value = sum;
      await loadAllRanks();
    }

    function onResize() { for (const c of charts) c.resize(); }


    onMounted(async () => {
      const [s, sum, t, d, ar, ap, sa] = await Promise.all([
        api.get('/stats/dashboard', { teamId: store.teamId }),
        api.get('/stats/sales-summary', { teamId: store.teamId, range: range.value }),
        api.get('/stats/trend', { teamId: store.teamId }),
        api.get('/doc/list', { teamId: store.teamId, page: 1, rows: 8 }),
        api.get('/report/aging', { teamId: store.teamId, mode: 'ar' }),
        api.get('/report/aging', { teamId: store.teamId, mode: 'ap' }),
        api.get('/report/stock-aging', { teamId: store.teamId }),
      ]);
      stats.value = s; sales.value = sum; trend.value = t; recent.value = d;
      arAging.value = ar; apAging.value = ap; stockAging.value = sa;
      const [art, apt] = await Promise.all([
        api.get('/report/aging/top', { teamId: store.teamId, mode: 'ar', limit: 5 }),
        api.get('/report/aging/top', { teamId: store.teamId, mode: 'ap', limit: 5 }),
      ]);
      arTop.value = art.rows || [];
      apTop.value = apt.rows || [];
      await nextTick();
      renderTrend();
      donut(arEl.value, ar.totals, '元', '应收未结');
      donut(apEl.value, ap.totals, '元', '应付未结');
      donut(stockEl.value, sa.totals, '元', '库存货值');
      barRank(arTopEl.value, arTop.value.map((r) => ({ name: r.partnerName, amount: r.total })), '元');
      barRank(apTopEl.value, apTop.value.map((r) => ({ name: r.partnerName, amount: r.total })), '元');
      await loadAllRanks();
      window.addEventListener('resize', onResize);
    });
    onBeforeUnmount(() => {
      window.removeEventListener('resize', onResize);
      for (const c of charts) c.dispose();
      charts.length = 0;
    });

    return {
      stats, sales, range, trend, recent, viewerId, kpis, lowStockItems, showGuide,
      arAging, apAging, stockAging, arTop, apTop,
      trendEl, arEl, apEl, stockEl, arTopEl, apTopEl,
      RANK_CARDS, rankData, rankRange, rankBy, rankRefs, loadAllRanks, loadRank,
      QUICK, quickEdit, removeQuick, restoreQuick, resetQuick,
      BUCKET_LABELS, BUCKET_COLORS, BUCKET_KEYS, hasAging,
      reloadAll, store,
      fmtMoney, prodLabel, partnerLabel, STATUS_TEXT, DOC_META, nav, whLabel,
    };
  },
  template: `
  <div>
    <!-- 团队标题条（对齐橙子云：白卡左上角团队名） -->
    <div class="team-bar">
      <span class="team-name">{{ store.team?.name || '当前账套' }}</span>
      <span class="team-sub">欢迎回来，祝您生意兴隆</span>
    </div>

    <!-- 常用功能（对齐橙子云工作台：右侧 添加/移除） -->
    <div class="chart-card" style="margin-bottom:14px">
      <div class="ct">
        常用功能
        <span class="ct-ops">
          <a class="ct-op" @click="quickEdit = !quickEdit">{{ quickEdit ? '完成' : '添加' }}</a>
          <a class="ct-op" v-if="quickEdit" @click="resetQuick">移除</a>
        </span>
      </div>
      <div class="quick-grid">
        <a class="qk" v-for="q in QUICK" :key="q.label" :class="{ editing: quickEdit }" @click="quickEdit ? removeQuick(q.label) : nav(q.to)">
          <el-icon class="qk-icon"><component :is="q.icon"/></el-icon>
          <span>{{ q.label }}</span>
          <i class="qk-x" v-if="quickEdit">×</i>
        </a>
        <a class="qk qk-add" v-if="quickEdit" @click="restoreQuick">
          <el-icon class="qk-icon"><Plus/></el-icon>
          <span>恢复默认</span>
        </a>
      </div>
    </div>

    <!-- 新手引导 -->
    <div v-if="showGuide" class="card" style="margin-bottom:14px;padding:18px 20px;border-left:4px solid var(--brand)">
      <div style="font-weight:600;font-size:15px;margin-bottom:8px">欢迎使用橙子进销存 —— 3 步开账</div>
      <div style="display:flex;gap:24px;flex-wrap:wrap;font-size:13px;color:var(--text)">
        <div style="flex:1;min-width:200px">
          <div style="font-weight:600;margin-bottom:4px;color:var(--brand)">① 第 1 步 · 建档</div>
          <div class="muted">到「商品」新建商品（含进价/售价/安全库存），到「往来单位」添加客户和供应商，到「基础档案」建仓库。</div>
          <button class="btn sm primary" style="margin-top:8px" @click="nav('#/product')">去建商品</button>
        </div>
        <div style="flex:1;min-width:200px">
          <div style="font-weight:600;margin-bottom:4px;color:var(--brand)">② 第 2 步 · 开单入库</div>
          <div class="muted">「采购 → 采购入库」开一张入库单，填商品和数量后点「审核」，库存立即增加。</div>
          <button class="btn sm primary" style="margin-top:8px" @click="nav('#/doc/purchase?type=stockin&new=1')">去开入库单</button>
        </div>
        <div style="flex:1;min-width:200px">
          <div style="font-weight:600;margin-bottom:4px;color:var(--brand)">③ 第 3 步 · 销售与收款</div>
          <div class="muted">「销售 → 销售出库」出库后，「资金 → 收付款」登记收款。顶部「使用帮助」有完整说明。</div>
          <button class="btn sm" style="margin-top:8px" @click="nav('#/help')">看使用帮助</button>
        </div>
      </div>
    </div>

    <!-- 第 1 行：新增销售数据 + 客户/供应商欠款账龄 -->
    <div class="dash-row">
      <div class="chart-card">
        <div class="ct">
          新增销售数据
          <span class="ct-ops">
            <a v-for="r in [{k:'today',t:'今日'},{k:'month',t:'本月'},{k:'year',t:'本年'}]" :key="r.k"
               :class="['ct-op', { on: range === r.k }]" @click="range = r.k; reloadAll()">{{ r.t }}</a>
          </span>
        </div>
        <div class="kpi4">
          <div class="kpi" v-for="k in kpis" :key="k.label">
            <div class="kpi-label">{{ k.label }}</div>
            <div class="kpi-val" :class="{ 'kpi-amt': k.money }">
              <i class="kpi-cur" v-if="k.prefix">{{ k.prefix }}</i>{{ k.val }}<i class="kpi-unit" v-if="k.unit">{{ k.unit }}</i>
            </div>
            <div class="kpi-sub">{{ k.sub }}</div>
          </div>
        </div>
        <div class="dash-mini">
          <div class="dmi"><span>库存总量</span><b>{{ stats?.totalQty ?? 0 }}</b></div>
          <div class="dmi"><span>库存货值</span><b>{{ fmtMoney(stats?.stockValue) }}</b></div>
          <div class="dmi"><span>待处理草稿</span><b>{{ stats?.draftCount ?? 0 }}</b></div>
          <div class="dmi" :class="{ warn: (stats?.lowStockCount ?? 0) > 0 }"><span>低库存预警</span><b>{{ stats?.lowStockCount ?? 0 }}</b></div>
        </div>
      </div>

      <div class="chart-card">
        <div class="ct">客户欠款账龄统计 <span class="ct-ops"><a class="ct-op" @click="nav('#/report')">更多</a></span></div>
        <div ref="arEl" style="height:186px" v-show="hasAging(arAging)"></div>
        <div class="empty-chart" v-show="!hasAging(arAging)">
          <el-icon><Wallet/></el-icon>
          <span>暂无应收欠款</span>
          <em>销售出库审核后未收款的部分会在这里按账龄分档</em>
        </div>
        <div class="ag-sum" v-show="hasAging(arAging)">未结合计 <b>{{ fmtMoney(arAging?.totals?.total) }}</b> 元</div>
      </div>

      <div class="chart-card">
        <div class="ct">供应商欠款账龄统计 <span class="ct-ops"><a class="ct-op" @click="nav('#/report')">更多</a></span></div>
        <div ref="apEl" style="height:186px" v-show="hasAging(apAging)"></div>
        <div class="empty-chart" v-show="!hasAging(apAging)">
          <el-icon><CreditCard/></el-icon>
          <span>暂无应付欠款</span>
          <em>采购入库审核后未付款的部分会在这里按账龄分档</em>
        </div>
        <div class="ag-sum" v-show="hasAging(apAging)">未结合计 <b>{{ fmtMoney(apAging?.totals?.total) }}</b> 元</div>
      </div>
    </div>

    <!-- 第 2 行：库存账龄 + 客户/供应商欠款排行 -->
    <div class="dash-row">
      <div class="chart-card">
        <div class="ct">库存账龄统计 <span class="ct-ops"><a class="ct-op" @click="nav('#/report')">更多</a></span></div>
        <div ref="stockEl" style="height:186px" v-show="hasAging(stockAging)"></div>
        <div class="empty-chart" v-show="!hasAging(stockAging)">
          <el-icon><Box/></el-icon>
          <span>暂无库存</span>
          <em>入库审核后，各批次库存按入库日期分档统计货值</em>
        </div>
        <div class="ag-sum" v-show="hasAging(stockAging)">库存货值 <b>{{ fmtMoney(stockAging?.totals?.total) }}</b> 元 · 数量 {{ stockAging?.totals?.qty ?? 0 }}</div>
      </div>

      <div class="chart-card">
        <div class="ct">客户欠款排行 <span class="ct-ops"><a class="ct-op" @click="nav('#/report')">更多</a></span></div>
        <div ref="arTopEl" style="height:186px" v-show="arTop.length"></div>
        <div class="empty-chart" v-show="!arTop.length">
          <el-icon><User/></el-icon>
          <span>暂无客户欠款</span>
          <em>有未收款的销售出库单后，这里按欠款金额排序</em>
        </div>
      </div>

      <div class="chart-card">
        <div class="ct">供应商欠款排行 <span class="ct-ops"><a class="ct-op" @click="nav('#/report')">更多</a></span></div>
        <div ref="apTopEl" style="height:186px" v-show="apTop.length"></div>
        <div class="empty-chart" v-show="!apTop.length">
          <el-icon><Shop/></el-icon>
          <span>暂无供应商欠款</span>
          <em>有未付款的采购入库单后，这里按欠款金额排序</em>
        </div>
      </div>
    </div>

    <!-- 第 3 行：三张独立销售排行卡（对齐橙子云：订单/出库/收款各一格） -->
    <div class="dash-row">
      <div class="chart-card" v-for="rk in RANK_CARDS" :key="rk.k">
        <div class="ct">
          {{ rk.label }}
          <span class="ct-ops">
            <a v-for="r in [{k:'month',t:'本月'},{k:'year',t:'本年'}]" :key="r.k"
               :class="['ct-op', { on: rankRange === r.k }]" @click="rankRange = r.k; loadAllRanks()">{{ r.t }}</a>
            <a class="ct-op" @click="nav(rk.more)">更多</a>
          </span>
        </div>
        <div :ref="el => rankRefs[rk.k] = el" :id="'rank-' + rk.k" style="height:186px" v-show="rankData[rk.k]?.length"></div>
        <div class="empty-chart" v-show="!rankData[rk.k]?.length">
          <el-icon><DataLine/></el-icon>
          <span>{{ rk.emptyText || '暂无数据' }}</span>
          <em>审核通过的单据会参与统计</em>
        </div>
        <div class="rank-by">
          <a v-for="b in rk.dims" :key="b.k" :class="['ct-op', { on: (rankBy[rk.k] || rk.dims[0].k) === b.k }]"
             @click="rankBy[rk.k] = b.k; loadRank(rk.k)">{{ b.label }}</a>
        </div>
      </div>
    </div>

    <!-- 第 4 行：近 14 天出入库趋势 -->
    <div class="dash-row" style="grid-template-columns: 1fr">
      <div class="chart-card">
        <div class="ct">近 14 天出入库趋势</div>
        <div ref="trendEl" style="height:230px"></div>
      </div>
    </div>

    <!-- 低库存预警 -->
    <div class="card" v-if="lowStockItems.length" style="margin-bottom:14px;border-left:4px solid #e6a23c">
      <div style="padding:12px 14px;font-weight:600;font-size:14px;border-bottom:1px solid var(--border);color:#b88230">
        <el-icon style="vertical-align:-2px"><WarningFilled/></el-icon> 低库存预警（{{ lowStockItems.length }} 项低于安全库存，建议补货）
      </div>
      <table class="tbl">
        <thead><tr><th>商品</th><th class="r">当前库存</th><th class="r">安全库存</th><th class="r">缺口</th></tr></thead>
        <tbody>
          <tr v-for="r in lowStockItems" :key="r.productId">
            <td style="font-weight:500">{{ r.prodName }}</td>
            <td class="r" style="color:#f56c6c;font-weight:600">{{ r.qty }}</td>
            <td class="r">{{ r.lowQty }}</td>
            <td class="r">{{ Math.max(0, r.lowQty - r.qty) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 最新单据 -->
    <div class="card">
      <div style="padding:12px 14px;font-weight:600;font-size:14px;border-bottom:1px solid var(--border)">最新单据</div>
      <table class="tbl">
        <thead><tr><th>单号</th><th>类型</th><th>往来单位</th><th>仓库</th><th class="r">数量</th><th class="r">金额</th><th>状态</th><th>日期</th></tr></thead>
        <tbody>
          <tr v-if="!recent.rows.length"><td colspan="8"><div class="empty">暂无单据</div></td></tr>
          <tr v-for="d in recent.rows" :key="d.id" style="cursor:pointer" @click="viewerId = d.id">
            <td><span class="billno">{{ d.billNo }}</span></td>
            <td>{{ DOC_META[d.type]?.label || d.type }}</td>
            <td>{{ partnerLabel(d) || '—' }}</td>
            <td>{{ whLabel(d.warehouseId) || '—' }}</td>
            <td class="r" nowrap>{{ d.totalQty }}</td>
            <td class="r money" nowrap>{{ fmtMoney(d.totalAmount) }}</td>
            <td><span :class="'tag tag-' + d.status">{{ STATUS_TEXT[d.status] }}</span></td>
            <td class="muted">{{ (d.date || '').slice(5, 10) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <doc-viewer :doc-id="viewerId" @close="viewerId = null"/>
  </div>`,
};

/* ================= 商品管理 ================= */
const ProductPage = {
  setup() {
    const kw = ref('');
    const list = ref([]);
    const editor = reactive({ open: false, id: null, form: {} });

    async function load() {
      list.value = await api.get('/product', { teamId: store.teamId, kw: kw.value });
    }
    onMounted(load);

    function openNew() {
      editor.id = null;
      editor.form = { name: '', barcode: '', unit: '件', spec: '', catId: null, salePrice: 0, retailPrice: 0, purchasePrice: 0, lowQty: 0, remark: '' };
      editor.open = true;
    }
    function openEdit(p) {
      editor.id = p.id;
      editor.form = {
        name: p.name, barcode: p.barcode || '', unit: p.unit || '件', spec: p.spec || '',
        catId: p.catId, salePrice: (p.salePrice || 0) / 100, retailPrice: (p.retailPrice || 0) / 100,
        purchasePrice: (p.purchasePrice || 0) / 100, lowQty: p.lowQty ?? 0, remark: p.remark || '',
      };
      editor.open = true;
    }
    async function save() {
      const f = editor.form;
      if (!String(f.name || '').trim()) return toast('请输入商品名称', 'error');
      const body = {
        teamId: store.teamId, name: f.name, barcode: f.barcode, unit: f.unit, spec: f.spec,
        catId: f.catId || null,
        salePrice: Math.round(Number(f.salePrice) * 100) || 0,
        retailPrice: Math.round(Number(f.retailPrice) * 100) || 0,
        purchasePrice: Math.round(Number(f.purchasePrice) * 100) || 0,
        lowQty: Number(f.lowQty) || 0,
        remark: f.remark,
      };
      try {
        if (editor.id) await api.put(`/product/${editor.id}`, body);
        else await api.post('/product', body);
        editor.open = false;
        toast('已保存');
        await loadBase();
        load();
      } catch (e) { toast(e.message, 'error'); }
    }
    async function del(p) {
      if (!(await confirmBox(`删除商品「${p.name}」？被单据引用或仍有库存的商品将被拒绝。`))) return;
      try { await api.del(`/product/${p.id}`, { teamId: store.teamId }); toast('已删除'); await loadBase(); load(); }
      catch (e) { toast(e.message, 'error'); }
    }

    /* ---- 批量导入 ---- */
    const imp = reactive({ open: false, text: '', result: null });
    const IMP_COLS = ['名称', '单位', '分类', '条码', '规格', '进价', '售价', '零售价', '批发价', '安全库存', '备注'];
    const IMP_MAP = { 名称: 'name', 单位: 'unit', 分类: 'catName', 条码: 'barcode', 规格: 'spec', 进价: 'purchasePrice', 售价: 'salePrice', 零售价: 'retailPrice', 批发价: 'wholePrice', 安全库存: 'lowQty', 备注: 'remark' };
    const impRows = computed(() => {
      const out = [];
      const lines = imp.text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      for (const [i, line] of lines.entries()) {
        const cells = (line.includes('\t') ? line.split('\t') : line.split(/[,，]/)).map((s) => s.trim());
        const r = {
          name: cells[0] || '', unit: cells[1] || '', catName: cells[2] || '', barcode: cells[3] || '',
          spec: cells[4] || '', purchasePrice: cells[5] || '', salePrice: cells[6] || '',
          retailPrice: cells[7] || '', wholePrice: cells[8] || '', lowQty: cells[9] || '', remark: cells[10] || '',
          _line: i + 1, _err: cells[0] ? '' : '名称为空',
        };
        out.push(r);
      }
      return out;
    });
    async function doImport() {
      const rows = impRows.value.map(({ _line, _err, ...r }) => r);
      if (!rows.length) return toast('请先粘贴数据', 'error');
      try {
        const r = await api.post('/product/import', { teamId: store.teamId, rows });
        imp.result = r;
        if (r.success > 0) { toast(`成功导入 ${r.success} 个商品`); await loadBase(); load(); }
        if (!r.errors.length) imp.open = false;
      } catch (e) { toast(e.message, 'error'); }
    }
        /** 商品单位候选：优先取单位档案，退化为内置常用单位 */
    const unitOpts = computed(() => {
      const fromStore = (store.units || []).map((u) => u.name).filter(Boolean);
      const builtin = ['个', '件', '箱', '瓶', '包', '袋', '公斤', '米', '台', '套'];
      return Array.from(new Set([...fromStore, ...builtin]));
    });

    return { kw, list, editor, load, openNew, openEdit, save, del, fmtMoney, catLabel, store, exportCsv, imp, IMP_COLS, IMP_MAP, impRows, doImport, unitOpts };
  },
  template: `
  <div>
    <div class="page-card">
      <div class="page-head">
        <span class="hd-title">商品</span>
        <span class="hd-sp"></span>
        <button class="btn" @click="exportCsv('商品列表.csv', list, [
          { key: 'name', label: '名称' }, { key: 'spec', label: '规格' },
          { key: 'barcode', label: '条码' }, { key: 'unit', label: '单位' },
          { key: 'purchasePrice', label: '进价(元)' }, { key: 'salePrice', label: '售价(元)' },
          { key: 'lowQty', label: '安全库存' }, { key: 'remark', label: '备注' },
        ])"><el-icon><Download/></el-icon> 导出</button>
        <button class="btn" @click="imp.open = true; imp.result = null"><el-icon><Upload/></el-icon> 批量导入</button>
        <button class="btn primary" @click="openNew">+ 新增商品</button>
      </div>
      <div class="filterbar">
        <input class="finp w-key" v-model="kw" placeholder="商品名称 / 条码 / 规格" @keyup.enter="load"/>
        <button class="btn" @click="load">查询</button>
        <span class="fb-gap"></span>
        <span class="muted">共 {{ list.length }} 条</span>
      </div>
      <table class="tbl">
        <thead><tr><th>名称</th><th>规格</th><th>分类</th><th>条码</th><th>单位</th><th class="r">进价</th><th class="r">售价</th><th class="r">批发价</th><th class="r">零售价</th><th class="r">安全库存</th><th>备注</th><th style="width:130px">操作</th></tr></thead>
        <tbody>
          <tr v-if="!list.length"><td colspan="12"><div class="empty">暂无商品</div></td></tr>
          <tr v-for="p in list" :key="p.id">
            <td style="font-weight:500">{{ p.name }}</td>
            <td>{{ p.spec || '—' }}</td>
            <td>{{ catLabel(p.catId) || '—' }}</td>
            <td class="muted">{{ p.barcode || '—' }}</td>
            <td>{{ p.unit }}</td>
            <td class="r money">{{ fmtMoney(p.purchasePrice) }}</td>
            <td class="r money">{{ fmtMoney(p.salePrice) }}</td>
            <td class="r money">{{ fmtMoney(p.wholePrice) }}</td>
            <td class="r money">{{ fmtMoney(p.retailPrice) }}</td>
            <td class="r">{{ p.lowQty ?? 0 }}</td>
            <td class="muted">{{ p.remark || '—' }}</td>
            <td>
              <button class="btn sm" @click="openEdit(p)">编辑</button>
              <button class="btn sm danger" style="margin-left:6px" @click="del(p)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="modal-mask" v-if="editor.open" @click.self="editor.open = false">
      <div class="modal mid">
        <div class="modal-head"><span class="mt">{{ editor.id ? '编辑商品' : '新建商品' }}</span><span class="x" @click="editor.open = false">×</span></div>
        <div class="modal-body fcols">
          <div class="fitem"><label>名称</label><input v-model="editor.form.name" placeholder="商品名称"/></div>
          <div class="fitem"><label>规格</label><input v-model="editor.form.spec" placeholder="如 500ml"/></div>
          <div class="fitem"><label>分类</label>
            <div class="fctrl"><el-select v-model="editor.form.catId" filterable clearable placeholder="选择分类">
              <el-option v-for="c in store.cats" :key="c.id" :label="c.name" :value="c.id"/>
            </el-select></div>
          </div>
          <div class="fitem"><label>条码</label><input v-model="editor.form.barcode"/></div>
          <div class="fitem"><label>单位</label>
            <el-select v-model="editor.form.unit" filterable allow-create default-first-option placeholder="件 / 瓶 / 箱" style="width:100%">
              <el-option v-for="u in unitOpts" :key="u" :label="u" :value="u"/>
            </el-select>
          </div>
          <div class="fitem"><label>进价(元)</label><input type="number" step="0.01" min="0" v-model.number="editor.form.purchasePrice"/></div>
          <div class="fitem"><label>售价(元)</label><input type="number" step="0.01" min="0" v-model.number="editor.form.salePrice"/></div>
          <div class="fitem"><label>零售价(元)</label><input type="number" step="0.01" min="0" v-model.number="editor.form.retailPrice"/></div>
        <div class="fitem"><label>批发价(元)</label><input type="number" step="0.01" min="0" v-model.number="editor.form.wholePrice" placeholder="客户等级=批发时使用"/></div>
          <div class="fitem"><label>安全库存</label><input type="number" step="any" min="0" v-model.number="editor.form.lowQty" placeholder="低于此数量预警"/></div>
          <div class="fitem span2"><label>备注</label><input v-model="editor.form.remark"/></div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="editor.open = false">取消</button>
          <button class="btn primary" @click="save">保存</button>
        </div>
      </div>
    </div>

    <!-- 批量导入弹窗 -->
    <div class="modal-mask" v-if="imp.open" @click.self="imp.open = false">
      <div class="modal">
        <div class="modal-head"><span class="mt">商品批量导入</span><span class="x" @click="imp.open = false">×</span></div>
        <div class="modal-body" v-if="!imp.result">
          <div style="background:#f8f9fb;border-radius:8px;padding:10px 14px;font-size:12.5px;color:var(--muted);line-height:1.8;margin-bottom:10px">
            每行一个商品，列顺序：<b>{{ IMP_COLS.join('、') }}</b>（制表符 Tab 或英文逗号分隔，从 Excel 直接复制粘贴即可）。<br/>
            名称必填；分类不存在会自动创建；价格支持「12.8」「￥12.8」「1,280」等写法；名称重复的行会被跳过并在结果中提示。
          <textarea v-model="imp.text" rows="8" style="width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:12.5px;font-family:Consolas,monospace" placeholder="可口可乐	件	饮料	6901234567890	500ml	1.50	3.00	3.50	2.80	24	畅销品&#10;农夫山泉	件	饮料	6909876543210	550ml	0.90	2.00	2.50	1.80	48	"></textarea>
          <table class="tbl" style="margin-top:10px" v-if="impRows.length">
            <thead><tr><th class="r">#</th><th v-for="c in IMP_COLS" :key="c">{{ c }}</th><th>校验</th></tr></thead>
            <tbody>
              <tr v-for="r in impRows" :key="r._line" :style="r._err ? { background: '#fff1f0' } : {}">
                <td class="r muted">{{ r._line }}</td>
                <td v-for="c in IMP_COLS" :key="c">{{ r[IMP_MAP[c]] || '—' }}</td>
                <td :style="r._err ? { color: '#f56c6c' } : { color: '#53a551' }">{{ r._err || 'OK' }}</td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>
        <div class="modal-body" v-else>
          <div style="font-size:14px;line-height:2">
            ⋯ <b>{{ imp.result.total }}</b> 行：成功导入 <b style="color:#53a551">{{ imp.result.success }}</b> 个，失败 <b style="color:#f56c6c">{{ imp.result.errors.length }}</b> 个。
          <table class="tbl" v-if="imp.result.errors.length" style="margin-top:8px">
            <thead><tr><th class="r" style="width:60px">行号</th><th>失败原因</th></tr></thead>
            <tbody>
              <tr v-for="e in imp.result.errors" :key="e.row"><td class="r">{{ e.row }}</td><td>{{ e.msg }}</td></tr>
            </tbody>
          </table>
          <div class="muted" style="font-size:12.5px;margin-top:10px">失败的行不会导入；可修正后重新粘贴导入（已成功的不会重复创建）。</div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="imp.open = false">关闭</button>
        <button v-if="!imp.result" class="btn primary" :disabled="!impRows.length" @click="doImport">导入 {{ impRows.length }} 行</button>
        <button v-else class="btn primary" @click="imp.result = null">继续导入</button>
      </div>
    </div>
  </div>
</div>`,
};

/* ================= 往来单位 ================= */
const PartnerPage = {
  setup() {
    const lockTab = route.q.tab === 'cus' || route.q.tab === 'ven' ? route.q.tab : '';
    const tab = ref(lockTab === 'ven' ? 'ven' : 'cus');
    watch(() => route.q.tab, (t) => { if (t === 'cus' || t === 'ven') { tab.value = t; kw.value = ''; } });
    const kw = ref('');
    const editor = reactive({ open: false, id: null, form: {} });

    const list = computed(() => {
      const src = tab.value === 'cus' ? store.customers : store.vendors;
      const k = kw.value.trim();
      return k ? src.filter(x => x.name.includes(k)) : src;
    });

    function openNew() {
      editor.id = null;
      editor.form = tab.value === 'cus'
        ? { name: '', mobile: '', address: '', remark: '', priceLevel: 'salePrice' }
        : { name: '', mobile: '', address: '', remark: '' };
      editor.open = true;
    }
    function openEdit(p) {
      editor.id = p.id;
      editor.form = tab.value === 'cus'
        ? { name: p.name, mobile: p.mobile || '', address: p.address || '', remark: p.remark || '', priceLevel: p.priceLevel || 'salePrice' }
        : { name: p.name, mobile: p.mobile || '', address: p.address || '', remark: p.remark || '' };
      editor.open = true;
    }
    async function save() {
      if (!String(editor.form.name || '').trim()) return toast('请输入名称', 'error');
      const table = tab.value === 'cus' ? 'customer' : 'vendor';
      const body = { teamId: store.teamId, ...editor.form };
      try {
        if (editor.id) await api.put(`/${table}/${editor.id}`, body);
        else await api.post(`/${table}`, body);
        editor.open = false;
        toast('已保存');
        await loadBase();
      } catch (e) { toast(e.message, 'error'); }
    }
    async function del(p) {
      if (!(await confirmBox(`删除「${p.name}」？被单据或收付款引用的将被拒绝。`))) return;
      const table = tab.value === 'cus' ? 'customer' : 'vendor';
      try { await api.del(`/${table}/${p.id}`, { teamId: store.teamId }); toast('已删除'); await loadBase(); }
      catch (e) { toast(e.message, 'error'); }
    }
    const LEVEL = { salePrice: '标准售价', wholePrice: '批发价', retailPrice: '零售价' };
    function reload() { return loadBase(); }
    return { tab, lockTab, kw, list, editor, openNew, openEdit, save, del, store, LEVEL, reload };
  },
  template: `
  <div>
    <div class="page-card">
      <div class="page-head">
        <span class="hd-title">{{ tab === 'cus' ? '客户' : '供应商' }}</span>
        <span class="hd-sp"></span>
        <button class="btn primary" @click="openNew">+ 新增{{ tab === 'cus' ? '客户' : '供应商' }}</button>
      </div>
      <div class="filterbar">
        <span class="tabs-inline" v-if="!lockTab">
          <button class="btn sm" :class="{primary: tab==='cus'}" @click="tab='cus'; kw=''">客户</button>
          <button class="btn sm" :class="{primary: tab==='ven'}" @click="tab='ven'; kw=''">供应商</button>
        </span>
        <input class="finp w-key" v-model="kw" placeholder="名称 / 手机" @keyup.enter="reload"/>
        <button class="btn" @click="reload">查询</button>
        <span class="fb-gap"></span>
        <span class="muted">共 {{ list.length }} 条</span>
      </div>
      <table class="tbl">
        <thead><tr><th>名称</th><th>手机</th><th>地址</th><th v-if="tab === 'cus'">价格等级</th><th>备注</th><th style="width:130px">操作</th></tr></thead>
        <tbody>
          <tr v-if="!list.length"><td :colspan="tab === 'cus' ? 6 : 5"><div class="empty">暂无数据</div></td></tr>
          <tr v-for="p in list" :key="p.id">
            <td style="font-weight:500">{{ p.name }}</td>
            <td class="muted">{{ p.mobile || '—' }}</td>
            <td class="muted">{{ p.address || '—' }}</td>
            <td v-if="tab === 'cus'"><span class="tag" :class="p.priceLevel === 'wholePrice' ? 'ok' : ''">{{ LEVEL[p.priceLevel || 'salePrice'] || '标准售价' }}</span></td>
            <td class="muted">{{ p.remark || '—' }}</td>
            <td>
              <button class="btn sm" @click="openEdit(p)">编辑</button>
              <button class="btn sm danger" style="margin-left:6px" @click="del(p)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="modal-mask" v-if="editor.open" @click.self="editor.open = false">
      <div class="modal narrow">
        <div class="modal-head"><span class="mt">{{ editor.id ? '编辑' : '新建' }}{{ tab === 'cus' ? '客户' : '供应商' }}</span><span class="x" @click="editor.open = false">×</span></div>
        <div class="modal-body">
          <div class="fitem"><label>名称</label><input v-model="editor.form.name"/></div>
          <div class="fitem"><label>手机</label><input v-model="editor.form.mobile"/></div>
          <div class="fitem" v-if="tab === 'cus'"><label>价格等级</label>
            <select v-model="editor.form.priceLevel">
              <option value="salePrice">标准售价</option>
              <option value="wholePrice">批发价</option>
              <option value="retailPrice">零售价</option>
            </select>
          </div>
          <div class="fitem"><label>地址</label><input v-model="editor.form.address"/></div>
          <div class="fitem span2"><label>备注</label><input v-model="editor.form.remark"/></div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="editor.open = false">取消</button>
          <button class="btn primary" @click="save">保存</button>
        </div>
      </div>
    </div>

    <doc-viewer :doc-id="viewerId" @close="viewerId = null"/>
  </div>`,
};

/* ================= 基础档案 ================= */
const BasePage = {
  setup() {
    const BASE_TABS = ['warehouse', 'reservoir', 'cat', 'unit', 'clerk', 'account'];
    const baseTabParam = route.q.tab;
    const tab = ref(BASE_TABS.includes(baseTabParam) ? baseTabParam : 'warehouse');
    watch(() => route.q.tab, (t) => { if (BASE_TABS.includes(t)) { tab.value = t; loadBase(); } });
    const tabs = [
      { key: 'warehouse', label: '仓库' },
      { key: 'reservoir', label: '库位' },
      { key: 'cat', label: '商品分类' },
      { key: 'unit', label: '商品单位' },
      { key: 'clerk', label: '业务员' },
      { key: 'account', label: '资金账户' },
    ];
    const editor = reactive({ open: false, kind: '', id: null, form: {} });

    const list = computed(() => {
      switch (tab.value) {
        case 'warehouse': return store.warehouses;
        case 'reservoir': return store.reservoirs;
        case 'cat': return store.cats;
        case 'clerk': return store.clerks;
        case 'account': return store.accounts;
        case 'unit': return store.units;
        default: return [];
      }
    });

    function openNew() {
      const k = tab.value;
      editor.kind = k; editor.id = null;
      editor.form = k === 'reservoir' ? { warehouseId: null, name: '' }
        : k === 'cat' ? { parentId: null, name: '' }
        : k === 'clerk' ? { name: '', mobile: '' }
        : k === 'account' ? { name: '', type: 'cash', balance: 0 }
        : { name: '', remark: '' };
      editor.open = true;
    }
    function openEdit(row) {
      const k = tab.value;
      editor.kind = k; editor.id = row.id;
      editor.form = k === 'reservoir' ? { warehouseId: row.warehouseId, name: row.name }
        : k === 'cat' ? { parentId: row.parentId, name: row.name }
        : k === 'clerk' ? { name: row.name, mobile: row.mobile || '' }
        : k === 'account' ? { name: row.name, type: row.type || 'cash', balance: (row.balance || 0) / 100 }
        : { name: row.name, remark: row.remark || '' };
      editor.open = true;
    }
    async function save() {
      const k = editor.kind;
      if (!String(editor.form.name || '').trim()) return toast('请输入名称', 'error');
      const body = { teamId: store.teamId, ...editor.form };
      if (k === 'account') body.balance = Math.round(Number(body.balance) * 100) || 0;
      try {
        if (editor.id) await api.put(`/${k}/${editor.id}`, body);
        else await api.post(`/${k}`, body);
        editor.open = false;
        toast('已保存');
        await loadBase();
      } catch (e) { toast(e.message, 'error'); }
    }
    async function del(row) {
      if (!(await confirmBox(`删除「${row.name}」？被引用的记录将被拒绝。`))) return;
      try { await api.del(`/${tab.value}/${row.id}`, { teamId: store.teamId }); toast('已删除'); await loadBase(); }
      catch (e) { toast(e.message, 'error'); }
    }
    const whName = (id) => byId(store.warehouses, id)?.name || `#${id}`;
    const catName = (id) => byId(store.cats, id)?.name || '';
    const typeText = { cash: '现金', bank: '银行', wechat: '微信', alipay: '支付宝' };
    return { tab, tabs, list, editor, openNew, openEdit, save, del, whName, catName, typeText, fmtMoney, store };
  },
  template: `
  <div>
    <div class="page-card">
      <div class="page-head">
        <span class="hd-title">基础档案</span>
        <div class="tabs">
          <span class="tb" v-for="t in tabs" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">{{ t.label }}</span>
        </div>
        <div class="hd-right"><button class="btn primary" @click="openNew">＋ 新增</button></div>
      </div>
      <div class="tbl-wrap">
        <table class="tbl" v-if="tab==='warehouse'">
        <thead><tr><th style="width:38%">仓库名称</th><th>备注</th><th style="width:130px">操作</th></tr></thead>
        <tbody>
          <tr v-if="!list.length"><td colspan="3"><div class="empty">暂无仓库</div></td></tr>
          <tr v-for="r in list" :key="r.id"><td style="font-weight:500">{{ r.name }}</td><td class="muted">{{ r.remark || '—' }}</td>
            <td><button class="btn sm" @click="openEdit(r)">编辑</button><button class="btn sm danger" style="margin-left:6px" @click="del(r)">删除</button></td></tr>
        </tbody>
      </table>
      <table class="tbl" v-else-if="tab==='reservoir'">
        <thead><tr><th style="width:38%">库位名称</th><th>所属仓库</th><th style="width:130px">操作</th></tr></thead>
        <tbody>
          <tr v-if="!list.length"><td colspan="3"><div class="empty">暂无库位</div></td></tr>
          <tr v-for="r in list" :key="r.id"><td style="font-weight:500">{{ r.name }}</td><td>{{ whName(r.warehouseId) }}</td>
            <td><button class="btn sm" @click="openEdit(r)">编辑</button><button class="btn sm danger" style="margin-left:6px" @click="del(r)">删除</button></td></tr>
        </tbody>
      </table>
      <table class="tbl" v-else-if="tab==='cat'">
        <thead><tr><th style="width:38%">分类名称</th><th>上级分类</th><th style="width:130px">操作</th></tr></thead>
        <tbody>
          <tr v-if="!list.length"><td colspan="3"><div class="empty">暂无分类</div></td></tr>
          <tr v-for="r in list" :key="r.id"><td style="font-weight:500">{{ r.name }}</td><td class="muted">{{ r.parentId ? catName(r.parentId) : '—' }}</td>
            <td><button class="btn sm" @click="openEdit(r)">编辑</button><button class="btn sm danger" style="margin-left:6px" @click="del(r)">删除</button></td></tr>
        </tbody>
      </table>
      <table class="tbl" v-else-if="tab==='clerk'">
        <thead><tr><th style="width:38%">姓名</th><th>手机</th><th style="width:130px">操作</th></tr></thead>
        <tbody>
          <tr v-if="!list.length"><td colspan="3"><div class="empty">暂无业务员</div></td></tr>
          <tr v-for="r in list" :key="r.id"><td style="font-weight:500">{{ r.name }}</td><td class="muted">{{ r.mobile || '—' }}</td>
            <td><button class="btn sm" @click="openEdit(r)">编辑</button><button class="btn sm danger" style="margin-left:6px" @click="del(r)">删除</button></td></tr>
        </tbody>
      </table>
      <table class="tbl" v-else-if="tab==='unit'">
        <thead><tr><th style="width:38%">单位名称</th><th>备注</th><th style="width:130px">操作</th></tr></thead>
        <tbody>
          <tr v-if="!list.length"><td colspan="3"><div class="empty">暂无单位</div></td></tr>
          <tr v-for="r in list" :key="r.id"><td style="font-weight:500">{{ r.name }}</td><td class="muted">{{ r.remark || '—' }}</td>
            <td><button class="btn sm" @click="openEdit(r)">编辑</button><button class="btn sm danger" style="margin-left:6px" @click="del(r)">删除</button></td></tr>
        </tbody>
      </table>
      <table class="tbl" v-else>
        <thead><tr><th style="width:38%">账户名称</th><th>类型</th><th class="r">余额</th><th style="width:130px">操作</th></tr></thead>
        <tbody>
          <tr v-if="!list.length"><td colspan="4"><div class="empty">暂无账户</div></td></tr>
          <tr v-for="r in list" :key="r.id"><td style="font-weight:500">{{ r.name }}</td><td>{{ typeText[r.type] || r.type }}</td><td class="r money">{{ fmtMoney(r.balance) }}</td>
            <td><button class="btn sm" @click="openEdit(r)">编辑</button><button class="btn sm danger" style="margin-left:6px" @click="del(r)">删除</button></td></tr>
        </tbody>
      </table>
      </div>
    </div>

    <div class="modal-mask" v-if="editor.open" @click.self="editor.open = false">
      <div class="modal narrow">
        <div class="modal-head"><span class="mt">编辑档案</span><span class="x" @click="editor.open = false">×</span></div>
        <div class="modal-body">
          <div class="fitem"><label>名称</label><input v-model="editor.form.name"/></div>
          <div class="fitem" v-if="editor.kind==='reservoir'"><label>所属仓库</label>
            <div class="fctrl"><el-select v-model="editor.form.warehouseId" placeholder="选择仓库">
              <el-option v-for="w in store.warehouses" :key="w.id" :label="w.name" :value="w.id"/>
            </el-select></div>
          </div>
          <div class="fitem" v-if="editor.kind==='cat'"><label>上级分类</label>
            <div class="fctrl"><el-select v-model="editor.form.parentId" clearable placeholder="无（顶级分类）">
              <el-option v-for="c in store.cats.filter(c => c.id !== editor.id)" :key="c.id" :label="c.name" :value="c.id"/>
            </el-select></div>
          </div>
          <div class="fitem" v-if="editor.kind==='clerk'"><label>手机</label><input v-model="editor.form.mobile"/></div>
          <div class="fitem" v-if="editor.kind==='account'"><label>类型</label>
            <div class="fctrl"><el-select v-model="editor.form.type">
              <el-option v-for="(v, k) in typeText" :key="k" :label="v" :value="k"/>
            </el-select></div>
          </div>
          <div class="fitem" v-if="editor.kind==='account'"><label>期初余额(元)</label><input type="number" step="0.01" v-model.number="editor.form.balance"/></div>
          <div class="fitem" v-if="editor.kind==='warehouse'"><label>备注</label><input v-model="editor.form.remark"/></div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="editor.open = false">取消</button>
          <button class="btn primary" @click="save">保存</button>
        </div>
      </div>
    </div>
  </div>`,
};

/* ================= 单据页（采购/销售/库存共用） ================= */
/* 实时库存页（原误命名为 DocPage，现正名） */
const StockPage = {
  components: { DocViewer },
  props: { group: { type: String, default: 'purchase' } },
  setup(props) {

    const kw = ref('');
    const warehouseId = ref(null);
    const ifShowZero = ref(true);
    const list = ref([]);
    /** detail=按库位明细（原始行）；prod=按商品汇总（同商品多仓多库位合并） */
    const view = ref('prod');

    async function load() {
      list.value = await api.get('/stock/list', {
        teamId: store.teamId, kw: kw.value,
        warehouseId: warehouseId.value,
        ifShowZero: ifShowZero.value ? '' : '0',
      });
    }
    onMounted(load);
    const totalQty = computed(() => list.value.reduce((s, r) => s + r.qty, 0));
    const lowQtyMap = computed(() => {
      const m = {};
      for (const p of store.products) if (p.lowQty > 0) m[p.id] = p.lowQty;
      return m;
    });
    function isLow(r) { return lowQtyMap.value[r.productId] != null && r.qty <= lowQtyMap.value[r.productId]; }
    function resvName(id) { return id ? (byId(store.reservoirs, id)?.name ?? `#${id}`) : '—'; }

    /**
     * 按商品汇总：同一商品可能散在多个仓库/库位，汇总视图把它们加总，
     * 并把占用的仓库名、库位数收在 whs / locs 里供表格展示。
     */
    const summary = computed(() => {
      const map = new Map();
      for (const r of list.value) {
        let s = map.get(r.productId);
        if (!s) {
          s = {
            productId: r.productId, prodName: r.prodName, spec: r.spec, unit: r.unit,
            code: r.code, qty: 0, whs: new Set(), locs: 0, batchNo: '', rows: 0,
          };
          map.set(r.productId, s);
        }
        s.qty += r.qty;
        s.rows += 1;
        if (r.warehouseName) s.whs.add(r.warehouseName);
        if (r.reservoirId) s.locs += 1;
        if (r.batchNo && !s.batchNo) s.batchNo = r.batchNo;
      }
      return [...map.values()]
        .map((s) => ({ ...s, whs: [...s.whs].join('、') }))
        .filter((s) => ifShowZero.value || s.qty !== 0);
    });

    /** 汇总行是否低库存：安全库存是商品级阈值，故按汇总数量判断才对 */
    function isLowSum(s) { return lowQtyMap.value[s.productId] != null && s.qty <= lowQtyMap.value[s.productId]; }
    const lowCount = computed(() => summary.value.filter(isLowSum).length);

    /** 汇总行点「N 条明细」→ 切到明细视图并按商品名过滤，需重新请求后端 */
    async function drillTo(s) {
      view.value = 'detail';
      kw.value = s.prodName;
      await load();
    }

    function doExport() {
      if (view.value === 'prod') {
        exportCsv('库存汇总.csv', summary.value.map((s) => ({
          prodName: s.prodName, spec: s.spec || '', unit: s.unit,
          whs: s.whs, rows: s.rows, qty: s.qty, lowQty: lowQtyMap.value[s.productId] ?? '',
        })), [
          { key: 'prodName', label: '商品' }, { key: 'spec', label: '规格' }, { key: 'unit', label: '单位' },
          { key: 'whs', label: '所在仓库' }, { key: 'rows', label: '库存行数' },
          { key: 'qty', label: '合计数量' }, { key: 'lowQty', label: '安全库存' },
        ]);
        return;
      }
      exportCsv('实时库存.csv', list.value.map((r) => ({
        prodName: r.prodName, spec: r.spec || '', unit: r.unit,
        warehouse: r.warehouseName || '', reservoirId: r.reservoirId || '', batchNo: r.batchNo || '',
        qty: r.qty, lowQty: lowQtyMap.value[r.productId] ?? '',
      })), [
        { key: 'prodName', label: '商品' }, { key: 'spec', label: '规格' }, { key: 'unit', label: '单位' },
        { key: 'warehouse', label: '仓库' }, { key: 'batchNo', label: '批次' },
        { key: 'qty', label: '数量' }, { key: 'lowQty', label: '安全库存' },
      ]);
    }
    return {
      kw, warehouseId, ifShowZero, list, load, totalQty, isLow, resvName, doExport, lowQtyMap, store,
      view, summary, isLowSum, lowCount, drillTo,
    };
  },
  template: `
  <div>
    <div class="page-card">
      <div class="page-head">
        <span class="hd-title">库存查询</span>
        <div class="tabs" style="margin-left:14px">
          <span class="tb" :class="{ on: view === 'prod' }" @click="view = 'prod'">按商品汇总</span>
          <span class="tb" :class="{ on: view === 'detail' }" @click="view = 'detail'">按库位明细</span>
        </div>
        <span class="hd-sp"></span>
        <button class="btn" @click="doExport"><el-icon><Download/></el-icon> 导出</button>
      </div>
      <div class="filterbar">
        <div class="fctrl" style="width:200px"><el-select v-model="warehouseId" filterable clearable placeholder="全部仓库" @change="load">
          <el-option v-for="w in store.warehouses" :key="w.id" :label="w.name" :value="w.id"/>
        </el-select></div>
        <input class="finp w-key" v-model="kw" placeholder="商品名称 / 条码" @keyup.enter="load"/>
        <button class="btn" @click="load">查询</button>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)">
          <input type="checkbox" v-model="ifShowZero" @change="load"/>显示零库存</label>
        <span class="fb-gap"></span>
        <span class="muted">库存总量 <b style="color:var(--text)">{{ totalQty }}</b> ·
          {{ view === 'prod' ? summary.length + ' 个商品' : list.length + ' 条记录' }}<template v-if="lowCount"> ·
          <b style="color:#e6a23c">{{ lowCount }} 项低库存</b></template></span>
      </div>
      <div class="tbl-wrap">
        <table class="tbl" v-if="view === 'prod'">
          <thead><tr>
            <th>商品</th><th>规格</th><th>单位</th><th>所在仓库</th><th class="r">库存行数</th>
            <th class="r">合计数量</th><th class="r">安全库存</th><th></th>
          </tr></thead>
          <tbody>
            <tr v-if="!summary.length"><td colspan="8"><div class="empty">暂无库存数据</div></td></tr>
            <tr v-for="s in summary" :key="s.productId">
              <td style="font-weight:500">{{ s.prodName }}</td>
              <td>{{ s.spec || '—' }}</td>
              <td>{{ s.unit }}</td>
              <td class="muted">{{ s.whs || '—' }}</td>
              <td class="r muted">
                <a v-if="s.rows > 1" href="javascript:;" class="lnk" @click="drillTo(s)"
                   :title="'该商品分散在 ' + s.rows + ' 条库存记录里，点击查看明细'">{{ s.rows }} 条明细</a>
                <span v-else>{{ s.rows }}</span>
              </td>
              <td class="r" :style="{ color: s.qty < 0 ? '#f56c6c' : '', fontWeight: 600 }">{{ s.qty }}</td>
              <td class="r muted">{{ lowQtyMap[s.productId] ?? '—' }}</td>
              <td style="width:78px">
                <span v-if="isLowSum(s)" class="tag" style="background:#fdf6ec;color:#b88230">低库存</span>
              </td>
            </tr>
          </tbody>
        </table>
        <table class="tbl" v-else>
          <thead><tr><th>商品</th><th>规格</th><th>单位</th><th>仓库</th><th>库位</th><th>批次</th><th class="r">数量</th><th class="r">安全库存</th><th></th></tr></thead>
          <tbody>
            <tr v-if="!list.length"><td colspan="9"><div class="empty">暂无库存数据</div></td></tr>
            <tr v-for="(r, i) in list" :key="i">
              <td style="font-weight:500">{{ r.prodName }}</td>
              <td>{{ r.spec || '—' }}</td>
              <td>{{ r.unit }}</td>
              <td>{{ r.warehouseName || '—' }}</td>
              <td class="muted">{{ resvName(r.reservoirId) }}</td>
              <td>{{ r.batchNo || '—' }}</td>
              <td class="r" :style="{ color: r.qty < 0 ? '#f56c6c' : '' }">{{ r.qty }}</td>
              <td class="r muted">{{ lowQtyMap[r.productId] ?? '—' }}</td>
              <td style="width:78px">
                <span v-if="isLow(r)" class="tag" style="background:#fdf6ec;color:#b88230">低库存</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>`,
};

/* ================= 单据页（列表 + 整页开单，对齐橙子云布局） ================= */
const DocPage = {
  components: { DocViewer },
  props: { group: { type: String, default: 'purchase' } },
  setup(props) {
    const grp = DOC_GROUPS[props.group] || DOC_GROUPS.purchase;
    const activeType = ref(grp.types.includes(route.q.type) ? route.q.type : grp.types[0]);
    const status = ref('');
    const kw = ref('');
    const page = ref(1);
    const rows = ref(20);
    const list = ref([]);
    const total = ref(0);
    // 筛选条：日期区间 + 往来单位（对齐橙子云列表页密集筛选条）
    const filterFrom = ref('');
    const filterTo = ref('');
    const filterPartner = ref(null);
    const viewerId = ref(null);
    const editor = reactive({ open: false, id: null, billNo: '', type: grp.types[0], form: null, status: '', ro: false });
    const saving = ref(false);
    const busyId = ref(null);
    /** 列表/明细分页签（真实橙子云有这个二级切换，明细=展开商品行） */
    const viewTab = ref('list');
    /** 复选框选中的单据 id（批量操作/批量提交用） */
    const selected = ref([]);
    const selAll = computed(() => list.value.length > 0 && list.value.every((d) => selected.value.includes(d.id)));

    function toggleAll(ev) {
      selected.value = ev.target.checked ? list.value.map((d) => d.id) : [];
    }
    function toggleOne(id, ev) {
      const set = new Set(selected.value);
      if (ev.target.checked) set.add(id); else set.delete(id);
      selected.value = [...set];
    }
    /* 当前仓库的库存快照：productId -> 可用数量（用于明细表「库存数量」列） */
    const stockMap = ref({});
    // 客户价格记忆：选中客户后批量取回，选商品时优先使用
    const priceMem = ref({});
    async function loadPriceMem(pid) {
      if (!pid) { priceMem.value = {}; return; }
      try {
        const r = await api.get('/price/memory', { teamId: store.teamId, partnerId: pid });
        const m = {};
        for (const it of r.list || []) m[it.productId] = it.price;
        priceMem.value = m;
      } catch { priceMem.value = {}; }
    }

    const meta = computed(() => DOC_META[activeType.value]);
    const partners = computed(() => meta.value.partner === 'ven' ? store.vendors : store.customers);
    const pages = computed(() => Math.max(1, Math.ceil(total.value / rows.value)));
    const pageBtns = computed(() => {
      const n = pages.value, c = page.value, arr = [];
      for (let p = 1; p <= n; p++) if (p === 1 || p === n || Math.abs(p - c) <= 2) arr.push(p);
      return arr;
    });
    function onRowsChange(e) { rows.value = Number(e.target.value) || 20; page.value = 1; load(); }

    /* 编辑态合计 */
    const grossAmt = computed(() => editor.form
      ? editor.form.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0) : 0);
    const totalQty = computed(() => editor.form ? editor.form.items.reduce((s, it) => s + (Number(it.qty) || 0), 0) : 0);
    const totalAmt = computed(() => Math.max(0, grossAmt.value - (Number(editor.form?.discount) || 0)));
    const oweAmt = computed(() => Math.max(0, totalAmt.value - (Number(editor.form?.paidAmount) || 0) - (Number(editor.form?.deposit) || 0)));
    const emeta = computed(() => DOC_META[editor.type] || {});
    const epartners = computed(() => emeta.value.partner === 'ven' ? store.vendors : store.customers);
    /* 列表页底部合计 */
    const sumQty = computed(() => list.value.reduce((s, d) => s + (Number(d.totalQty) || 0), 0));
    const sumAmount = computed(() => list.value.reduce((s, d) => s + (Number(d.totalAmount) || 0), 0));
    const sumPaid = computed(() => list.value.reduce((s, d) => s + (Number(d.paidAmount) || 0) + (Number(d.deposit) || 0), 0));
    /** 表尾合计行的前置单元格数：单号+日期+商品摘要+备注 = 4，另加可选的往来单位/仓库列 */
    const sumCols = computed(() => 4 + (meta.value.partner ? 1 : 0) + (meta.value.warehouse ? 1 : 0) + (meta.value.toWarehouse ? 1 : 0));

    async function load() {
      const r = await api.get('/doc/list', {
        teamId: store.teamId, type: activeType.value, status: status.value,
        kw: kw.value, page: page.value, rows: rows.value,
        from: filterFrom.value || '', to: filterTo.value || '',
        partnerId: filterPartner.value || '',
      });
      list.value = r.rows; total.value = r.total;
    }
    function resetFilter() {
      kw.value = ''; status.value = ''; filterFrom.value = ''; filterTo.value = '';
      filterPartner.value = null; page.value = 1; load();
    }
    async function loadStock(warehouseId) {
      if (!warehouseId) { stockMap.value = {}; return; }
      const rows2 = await api.get('/stock/list', { teamId: store.teamId, warehouseId, ifShowZero: '' });
      const m = {};
      for (const r of rows2) m[r.productId] = (m[r.productId] || 0) + r.qty;
      stockMap.value = m;
    }
    watch(activeType, () => { page.value = 1; load(); });
    watch(() => route.q.type, (t) => {
      if (t && DOC_META[t] && grp.types.includes(t) && t !== activeType.value) activeType.value = t;
    });
    watch(() => editor.form && editor.form.warehouseId, (w) => { if (editor.open && emeta.value.warehouse) loadStock(w); });
    // 换客户：重新拉该客户的价格记忆，并把「未手改过」的行价刷成记忆价
    watch(() => editor.form && editor.form.partnerId, async (pid, old) => {
      if (!editor.open || !emeta.value.partner) return;
      await loadPriceMem(pid);
      const f = emeta.value.priceField;
      if (!f || old === undefined) return;
      for (const it of editor.form.items) {
        if (!it.productId) continue;
        const mem = priceMem.value[it.productId];
        if (mem != null) it.price = mem / 100;
      }
    });
    onMounted(() => {
      load();
      if (route.q.new) openEditor(null, activeType.value);
    });

    function blankItem() {
      return { productId: null, qty: 1, price: 0, batchNo: '', toWarehouseId: null, remark: '' };
    }
    function blankForm() {
      return {
        date: todayStr(),
        partnerId: null, clerkId: null,
        warehouseId: store.warehouses[0]?.id ?? null,
        remark: '',
        receiverName: '', receiverMobile: '', receiverAddress: '',
        discount: 0, paidAmount: 0, accountId: null, deposit: 0,
        items: [blankItem()],
      };
    }
    function onPick(it) {
      const p = byId(store.products, it.productId);
      if (!p) return;
      let f = emeta.value.priceField;
      if (!f || Number(it.price)) return;
      // 客户价格等级（批发价/零售价）优先，再退到单据默认价格字段
      if (emeta.value.partner === 'cus' && editor.form.partnerId) {
        const cus = byId(store.customers, editor.form.partnerId);
        if (cus && cus.priceLevel && cus.priceLevel in p) f = cus.priceLevel;
      }
      // 客户价格记忆优先于商品标准价（一客一价是批发场景的常态）
      const mem = priceMem.value[it.productId];
      it.price = (mem != null ? mem : (p[f] || 0)) / 100;
    }
    function openEditor(row, type) {
      editor.type = type || activeType.value;
      if (row) {
        api.get('/doc/info', { id: row.id, teamId: store.teamId }).then(({ doc, items }) => {
          editor.id = doc.id; editor.billNo = doc.billNo;
          /*
           * 只读态：已审核 / 已作废 / 待审核 的单据不允许再改内容。
           * 之前完全没有这个判断，导致「查看明细」进去后能改数量单价再点「保存草稿」，
           * 把已过账单据的库存与结算依据擅自改掉。
           */
          editor.status = doc.status;
          editor.ro = doc.status !== 'draft';
          editor.form = {
            date: (doc.date || '').slice(0, 10),
            partnerId: doc.partnerId, clerkId: doc.clerkId,
            warehouseId: doc.warehouseId || store.warehouses[0]?.id || null,
            remark: doc.remark || '',
            receiverName: doc.receiverName || '', receiverMobile: doc.receiverMobile || '',
            receiverAddress: doc.receiverAddress || '',
            discount: (doc.discount || 0) / 100, paidAmount: (doc.paidAmount || 0) / 100,
            accountId: doc.accountId || null, deposit: (doc.deposit || 0) / 100,
            items: items.map(it => ({
              productId: it.productId, qty: it.qty, price: (it.price || 0) / 100,
              batchNo: it.batchNo || '', toWarehouseId: it.toWarehouseId, remark: it.remark || '',
            })),
          };
          if (!editor.form.items.length) editor.form.items.push(blankItem());
          editor.open = true;
          if (emeta.value.warehouse) loadStock(editor.form.warehouseId);
          loadPriceMem(editor.form.partnerId);
        }).catch(e => toast(e.message, 'error'));
      } else {
        editor.id = null; editor.billNo = '';
        editor.status = 'draft'; editor.ro = false;
        editor.form = blankForm();
        editor.open = true;
        if (emeta.value.warehouse) loadStock(editor.form.warehouseId);
      }
    }
    function backToList() { editor.open = false; load(); }
    function addItem() { editor.form.items.push(blankItem()); }
    function removeItem(idx) {
      if (editor.form.items.length <= 1) return toast('至少保留一行明细', 'error');
      editor.form.items.splice(idx, 1);
    }
    /* 扫码开单：按条码（或商品名精确匹配）找到商品 → 已有行则数量+1，否则新增行 */
    function scanBarcode(code) {
      const s = String(code || '').trim();
      if (!s || !editor.form) return;
      const p = store.products.find((x) => (x.barcode || '').trim() === s);
      if (!p) return toast(`未找到条码 ${s} 对应的商品`, 'warning');
      const hit = editor.form.items.find((it) => it.productId === p.id);
      if (hit) { hit.qty = (Number(hit.qty) || 0) + 1; return toast(`${p.name} 数量 +1`); }
      // 复用末尾空行
      const empty = editor.form.items.find((it) => !it.productId);
      const row = empty || blankItem();
      row.productId = p.id;
      row.qty = 1;
      row.price = 0;
      onPick(row);
      if (!empty) editor.form.items.push(row);
      toast(`已加入 ${p.name}`);
    }
    const scanCode = ref('');
    function doScan() {
      scanBarcode(scanCode.value);
      scanCode.value = '';
    }
    function lineAmt(it) { return ((Number(it.qty) || 0) * (Number(it.price) || 0)).toFixed(2); }
    function stockOf(pid) { return stockMap.value[pid] ?? 0; }
    function setFullPaid() {
      if (!editor.form) return;
      editor.form.paidAmount = Number(totalAmt.value.toFixed(2));
    }
    function fullDiscount() {
      if (!editor.form) return;
      editor.form.discount = Number(grossAmt.value.toFixed(2));
    }

    async function persist() {
      const m = emeta.value;
      const f = editor.form;
      if (m.warehouse && !f.warehouseId) throw new Error('请选择仓库');
      if (!f.items.length) throw new Error('至少一条明细');
      for (const [i, it] of f.items.entries()) {
        if (!it.productId) throw new Error(`第 ${i + 1} 行未选商品`);
        if (!Number(it.qty)) throw new Error(`第 ${i + 1} 行数量不能为 0`);
        if (!m.negative && Number(it.qty) < 0) throw new Error(`第 ${i + 1} 行数量不能为负`);
        if (Number(it.price) < 0) throw new Error(`第 ${i + 1} 行单价不能为负`);
      }
      if (Number(f.discount) > grossAmt.value) throw new Error('整单折扣不能超过单据金额');
      if (Number(f.paidAmount) + Number(f.deposit) > totalAmt.value) {
        throw new Error('本次收款 + 抵扣订金不能超过应收金额');
      }
      const body = {
        teamId: store.teamId, type: editor.type, date: f.date,
        partnerType: m.partner || null, partnerId: f.partnerId || null,
        clerkId: f.clerkId || null,
        warehouseId: m.warehouse ? f.warehouseId : null,
        remark: f.remark || null,
        receiverName: f.receiverName || null,
        receiverMobile: f.receiverMobile || null,
        receiverAddress: f.receiverAddress || null,
        discount: Math.round((Number(f.discount) || 0) * 100),
        paidAmount: Math.round((Number(f.paidAmount) || 0) * 100),
        accountId: f.accountId || null,
        deposit: Math.round((Number(f.deposit) || 0) * 100),
        items: f.items.map(it => ({
          productId: it.productId, qty: Number(it.qty), price: Math.round(Number(it.price) * 100),
          batchNo: it.batchNo || null, toWarehouseId: it.toWarehouseId || null, remark: it.remark || null,
        })),
      };
      if (editor.id) {
        await api.put('/doc/edit', { id: editor.id, ...body });
        return editor.id;
      }
      const r = await api.post('/doc/create', body);
      editor.id = r.id; editor.billNo = r.billNo;
      return r.id;
    }

    async function save() {
      if (saving.value) return;
      saving.value = true;
      try {
        await persist();
        toast('已保存');
        editor.open = false;
        load();
      } catch (e) { toast(e.message, 'error'); }
      finally { saving.value = false; }
    }

    async function saveAndAudit() {
      if (saving.value) return;
      saving.value = true;
      try {
        const id = await persist();
        await api.post('/doc/audit', { teamId: store.teamId, id });
        toast('已保存并审核');
        editor.open = false;
        load();
      } catch (e) { toast(e.message, 'error'); }
      finally { saving.value = false; }
    }

    async function audit(row) {
      if (busyId.value) return;
      if (!(await confirmBox(`审核后「${row.billNo}」将过账写入库存与往来余额，确认审核？`))) return;
      busyId.value = row.id;
      try { await api.post('/doc/audit', { teamId: store.teamId, id: row.id, auditBy: store.team?.name || '管理员' }); toast('已审核'); load(); }
      catch (e) { toast(e.message, 'error'); }
      finally { busyId.value = null; }
    }
    /** 提交审核：草稿 -> 待审核 */
    async function submitDoc(row) {
      if (busyId.value) return;
      busyId.value = row.id;
      try { await api.post('/doc/submit', { teamId: store.teamId, id: row.id }); toast('已提交审核'); load(); }
      catch (e) { toast(e.message, 'error'); }
      finally { busyId.value = null; }
    }
    /** 驳回：待审核 -> 草稿（需填原因） */
    async function rejectDoc(row) {
      if (busyId.value) return;
      let reason = '';
      try {
        const r = await ElMessageBox.prompt('请输入驳回原因（可留空）', `驳回 ${row.billNo}`, {
          confirmButtonText: '确认驳回', cancelButtonText: '取消',
          inputPlaceholder: '如：价格录错，请核对后重新提交', inputValue: '',
        });
        reason = (r.value || '').trim();
      } catch { return; }
      busyId.value = row.id;
      try { await api.post('/doc/reject', { teamId: store.teamId, id: row.id, reason }); toast('已驳回，单据回到草稿'); load(); }
      catch (e) { toast(e.message, 'error'); }
      finally { busyId.value = null; }
    }
    /** 批量提交当前页草稿 */
    async function submitAllDrafts() {
      const ids = list.value.filter((d) => d.status === 'draft').map((d) => d.id);
      if (!ids.length) return toast('当前页没有草稿', 'warning');
      if (!(await confirmBox(`将当前页 ${ids.length} 张草稿全部提交审核？`))) return;
      try {
        const r = await api.post('/doc/submit-batch', { teamId: store.teamId, ids });
        toast(`已提交 ${r.done} 张${r.skipped?.length ? `，跳过 ${r.skipped.length} 张` : ''}`);
        load();
      } catch (e) { toast(e.message, 'error'); }
    }
    async function voidDoc(row) {
      if (busyId.value) return;
      if (!(await confirmBox(`作废「${row.billNo}」将反向冲回库存与往来余额，确认作废？`))) return;
      busyId.value = row.id;
      try { await api.post('/doc/void', { teamId: store.teamId, id: row.id }); toast('已作废'); load(); }
      catch (e) { toast(e.message, 'error'); }
      finally { busyId.value = null; }
    }
    async function delDoc(row) {
      if (busyId.value) return;
      if (!(await confirmBox(`删除草稿「${row.billNo}」？删除后不可恢复。`))) return;
      busyId.value = row.id;
      try { await api.del(`/doc/${row.id}`, { teamId: store.teamId }); toast('已删除'); load(); }
      catch (e) { toast(e.message, 'error'); }
      finally { busyId.value = null; }
    }
    async function convert(row) {
      if (busyId.value) return;
      const m = DOC_META[row.type];
      if (!(await confirmBox(`将订单「${row.billNo}」转化为${DOC_META[m.convertTo].label}草稿？`))) return;
      busyId.value = row.id;
      try {
        const r = await api.post('/doc/convert', { teamId: store.teamId, id: row.id });
        toast(`已生成 ${r.billNo}`);
        activeType.value = m.convertTo;
      } catch (e) { toast(e.message, 'error'); }
      finally { busyId.value = null; }
    }
    /** 明细视图数据：展开当前页所有单据的商品行 */
    const flatItems = ref([]);
    async function loadFlatItems() {
      const rows = [];
      for (const d of list.value) {
        try {
          const info = await api.get('/doc/info', { teamId: store.teamId, id: d.id });
          for (const it of (info.items || [])) {
            rows.push({
              docId: d.id, billNo: d.billNo, date: d.date, status: d.status,
              partnerName: partnerLabel(d),
              prodName: it.prodName || prodLabel(it.productId),
              spec: it.spec || specOf(it.productId), unit: it.unit || unitOf(it.productId),
              qty: it.qty, price: it.price, amount: it.amount,
            });
          }
        } catch { /* 单张失败不影响整体 */ }
      }
      flatItems.value = rows;
    }
    watch(viewTab, (v) => { if (v === 'summary') loadFlatItems(); });

    async function copyDoc(row) {
      if (busyId.value) return;
      busyId.value = row.id;
      try {
        const r = await api.post('/doc/copy', { teamId: store.teamId, id: row.id });
        toast(`已复制为草稿 ${r.billNo}（批次/库位未复制，请编辑确认后审核）`);
        load();
      } catch (e) { toast(e.message, 'error'); }
      finally { busyId.value = null; }
    }
    /** 操作列「更多」下拉的统一分发：按 command 调对应动作 */
    function moreAction(cmd, row) {
      switch (cmd) {
        case 'audit': audit(row); break;
        case 'edit': openEditor(row, activeType.value); break;
        case 'view': viewerId.value = row.id; break;
        case 'copy': copyDoc(row); break;
        case 'delete': delDoc(row); break;
        case 'void': voidDoc(row); break;
        default: break;
      }
    }
    function doExport() {
      exportCsv(`${DOC_META[activeType.value].label}列表.csv`, list.value.map((d) => ({
        billNo: d.billNo, date: (d.date || '').slice(0, 10),
        partner: partnerLabel(d) || '', warehouse: whLabel(d.warehouseId) || '',
        totalQty: d.totalQty, totalAmount: (Number(d.totalAmount) / 100).toFixed(2),
        status: STATUS_TEXT[d.status] || d.status, remark: d.remark || '',
      })), [
        { key: 'billNo', label: '单号' }, { key: 'date', label: '日期' },
        { key: 'partner', label: '往来单位' }, { key: 'warehouse', label: '仓库' },
        { key: 'totalQty', label: '合计数量' }, { key: 'totalAmount', label: '合计金额(元)' },
        { key: 'status', label: '状态' }, { key: 'remark', label: '备注' },
      ]);
    }
    return {
      grp, activeType, status, kw, page, rows, list, total, pages, pageBtns, viewerId, editor,
      meta, emeta, partners, epartners, stockMap, grossAmt, totalQty, totalAmt, oweAmt, saving, busyId,
      load, openEditor, backToList, addItem, removeItem, onPick, lineAmt, stockOf, priceMem, loadPriceMem, setFullPaid, fullDiscount,
      scanCode, doScan, scanBarcode, viewTab, selected, selAll, toggleAll, toggleOne, flatItems, loadFlatItems,
      save, saveAndAudit, audit, submitDoc, rejectDoc, submitAllDrafts, voidDoc, delDoc, convert, copyDoc, doExport, onRowsChange, moreAction,
      filterFrom, filterTo, filterPartner, resetFilter, sumQty, sumAmount, sumPaid, sumCols,
      fmtMoney, partnerLabel, whLabel, prodLabel, store, STATUS_TEXT, DOC_META, specOf, unitOf,
    };
  },
  template: `
  <!-- ===== 列表态 ===== -->
  <div class="page-card" v-if="!editor.open">
    <div class="page-head">
      <span class="page-title">{{ DOC_META[activeType].label }}</span>
      <div class="tabs">
        <span class="tb" :class="{ on: viewTab === 'list' }" @click="viewTab = 'list'">列表</span>
        <span class="tb" :class="{ on: viewTab === 'summary' }" @click="viewTab = 'summary'">明细</span>
      </div>
    </div>
    <!-- 单据类型页签（列表/明细之下） -->
    <div class="typebar">
      <span class="tbt" v-for="t in grp.types" :key="t" :class="{ on: t === activeType }" @click="activeType = t">{{ DOC_META[t].label }}</span>
    </div>
    <div class="filterbar">
      <el-date-picker v-model="filterFrom" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" class="finp w-date" @change="page=1;load()"/>
      <span class="muted">至</span>
      <el-date-picker v-model="filterTo" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" class="finp w-date" @change="page=1;load()"/>
      <el-select v-model="status" clearable placeholder="全部状态" style="width:110px" @change="page=1;load()">
        <el-option label="草稿" value="draft"/><el-option label="待审核" value="pending"/><el-option label="已审核" value="audit"/><el-option label="已作废" value="void"/>
      </el-select>
      <el-select v-if="meta.partner" v-model="filterPartner" clearable filterable placeholder="全部往来单位" style="width:170px" @change="page=1;load()">
        <el-option v-for="c in partners" :key="c.id" :label="c.name" :value="c.id"/>
      </el-select>
      <input class="finp w-key" v-model="kw" placeholder="单号 / 备注 模糊" @keyup.enter="page=1;load()"/>
      <button class="btn" @click="page=1;load()">查询</button>
      <button class="btn icon-only" title="重置" @click="resetFilter"><el-icon><RefreshLeft/></el-icon></button>
      <button class="btn icon-only" title="刷新" @click="load()"><el-icon><Refresh/></el-icon></button>
      <span class="fb-gap"></span>
      <span class="muted fb-count">共 {{ total }} 条</span>
      <button class="btn" @click="submitAllDrafts">批量提交</button>
      <button class="btn primary" @click="openEditor(null, activeType)">＋ 新增</button>
    </div>
    <div class="tbl-wrap">
      <!-- ===== 明细视图（把单据行展开成商品明细） ===== -->
      <table class="tbl tbl-list" v-if="viewTab === 'summary'">
        <thead><tr>
          <th style="width:15%">单号</th><th style="width:96px">日期</th>
          <th style="width:19%">商品</th><th style="width:80px">规格</th>
          <th style="width:56px">单位</th>
          <th class="r" style="width:70px">数量</th><th class="r" style="width:70px">单价</th>
          <th class="r" style="width:88px">金额</th>
          <th v-if="meta.partner" style="width:12%">{{ meta.partner === 'ven' ? '供应商' : '客户' }}</th>
          <th style="width:70px">状态</th>
        </tr></thead>
        <tbody>
          <tr v-for="(r, i) in flatItems" :key="i">
            <td><span class="billno link" @click="viewerId = r.docId">{{ r.billNo }}</span></td>
            <td nowrap style="width:96px">{{ (r.date || '').slice(0, 10) }}</td>
            <td><span class="ellip d-ib" :title="r.prodName">{{ r.prodName || '—' }}</span></td>
            <td><span class="ellip d-ib" :title="r.spec">{{ r.spec || '—' }}</span></td>
            <td>{{ r.unit || '—' }}</td>
            <td class="r">{{ r.qty }}</td>
            <td class="r money">{{ fmtMoney(r.price) }}</td>
            <td class="r money">{{ fmtMoney(r.amount) }}</td>
            <td v-if="meta.partner"><span class="ellip d-ib" :title="r.partnerName">{{ r.partnerName || '—' }}</span></td>
            <td><span class="tag" :class="'st-' + r.status">{{ STATUS_TEXT[r.status] || r.status }}</span></td>
          </tr>
          <tr v-if="!flatItems.length"><td :colspan="meta.partner ? 10 : 9"><div class="empty">暂无明细</div></td></tr>
        </tbody>
      </table>

      <!-- ===== 列表视图 ===== -->
      <table class="tbl tbl-list" v-if="viewTab === 'list'">
        <thead><tr>
          <th style="width:34px" class="ck"><input type="checkbox" :checked="selAll" @change="toggleAll($event)"/></th>
          <th style="width:13%">单号</th><th style="width:96px">日期</th>
          <th v-if="meta.partner" style="width:11%">{{ meta.partner === 'ven' ? '供应商' : '客户' }}</th>
          <th v-if="meta.warehouse" style="width:8%">仓库</th>
          <th v-if="meta.toWarehouse" style="width:9%">调往</th>
          <th style="width:19%">商品摘要</th><th style="width:10%">备注</th>
          <th class="r" style="width:50px">数量</th><th class="r" style="width:9%">金额</th>
          <th style="width:62px">状态</th><th style="width:238px">操作</th>
        </tr></thead>
        <tbody>
          <tr v-if="!list.length"><td :colspan="meta.toWarehouse ? 12 : 11"><div class="empty">暂无单据</div></td></tr>
          <tr v-for="d in list" :key="d.id">
            <td class="ck"><input type="checkbox" :checked="selected.includes(d.id)" @change="toggleOne(d.id, $event)"/></td>
            <td><span class="billno link" @click="viewerId = d.id">{{ d.billNo }}</span><div v-if="d.refOrderId" class="muted" style="font-size:11px">源单 #{{ d.refOrderId }}</div></td>
            <td nowrap style="width:96px">{{ (d.date || '').slice(0, 10) }}</td>
            <td v-if="meta.partner"><span class="ellip d-ib" :title="partnerLabel(d) || ''">{{ partnerLabel(d) || '—' }}</span></td>
            <td v-if="meta.warehouse"><span class="ellip d-ib" :title="whLabel(d.warehouseId) || ''">{{ whLabel(d.warehouseId) || '—' }}</span></td>
            <td v-if="meta.toWarehouse"><span class="ellip d-ib" :title="d.toWarehouseNames || ''">{{ d.toWarehouseNames || '—' }}</span></td>
            <td class="muted ellip" :title="d.summary || ''">
              {{ d.summary || '—' }}<template v-if="d.itemCount > 3"> 等 {{ d.itemCount }} 项</template>
            </td>
            <td class="muted ellip" :title="d.remark || ''">{{ d.remark || '—' }}</td>
            <td class="r" nowrap>{{ d.totalQty }}</td>
            <td class="r money" nowrap>{{ fmtMoney(d.totalAmount) }}</td>
            <td><span :class="'tag tag-' + d.status">{{ STATUS_TEXT[d.status] }}</span></td>
            <td>
              <!--
                操作列：只保留 1–2 个高频按钮，其余收进「更多」下拉。
                原因：草稿态原有 6 个按钮，把操作列挤到 238px 仍换行，右侧留白又被表格吃掉。
              -->
              <div class="row-actions" v-if="d.status === 'draft'">
                <button class="btn sm primary" :disabled="busyId === d.id" @click="submitDoc(d)">提交</button>
                <button class="btn sm" @click="viewerId = d.id">查看</button>
                <el-dropdown trigger="click" placement="bottom-end" @command="(c) => moreAction(c, d)">
                  <button class="btn sm more-btn">更多<el-icon class="more-ic"><ArrowDown/></el-icon></button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="audit" :disabled="busyId === d.id">直接审核</el-dropdown-item>
                      <el-dropdown-item command="edit">编辑单据</el-dropdown-item>
                      <el-dropdown-item command="copy">复制单据</el-dropdown-item>
                      <el-dropdown-item command="delete" divided>删除草稿</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
              <div class="row-actions" v-else-if="d.status === 'pending'">
                <button class="btn sm primary" :disabled="busyId === d.id" @click="audit(d)">{{ busyId === d.id ? '审核中…' : '审核' }}</button>
                <button class="btn sm" :disabled="busyId === d.id" @click="rejectDoc(d)">驳回</button>
                <el-dropdown trigger="click" placement="bottom-end" @command="(c) => moreAction(c, d)">
                  <button class="btn sm more-btn">更多<el-icon class="more-ic"><ArrowDown/></el-icon></button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="view">查看单据</el-dropdown-item>
                      <el-dropdown-item command="edit">查看明细</el-dropdown-item>
                      <el-dropdown-item command="copy">复制单据</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
              <div class="row-actions" v-else-if="d.status === 'audit'">
                <button v-if="DOC_META[d.type]?.order" class="btn sm primary" :disabled="busyId === d.id" @click="convert(d)">{{ DOC_META[d.type].convertLabel }}</button>
                <button class="btn sm" @click="viewerId = d.id">查看</button>
                <el-dropdown trigger="click" placement="bottom-end" @command="(c) => moreAction(c, d)">
                  <button class="btn sm more-btn">更多<el-icon class="more-ic"><ArrowDown/></el-icon></button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="copy">复制单据</el-dropdown-item>
                      <el-dropdown-item command="edit">查看明细</el-dropdown-item>
                      <el-dropdown-item command="void" divided>作废单据</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
              <div class="row-actions" v-else>
                <button class="btn sm" @click="viewerId = d.id">查看</button>
                <button class="btn sm" @click="openEditor(d, activeType)">明细</button>
              </div>
            </td>
          </tr>
        </tbody>
        <tfoot v-if="list.length">
          <tr class="sum-row">
            <td></td>
            <td :colspan="sumCols">本页合计</td>
            <td class="r">{{ sumQty }}</td>
            <td class="r money">{{ fmtMoney(sumAmount) }}</td>
            <td></td><td></td>
          </tr>
        </tfoot>
      </table>
    </div>
    <div class="pager">
      <button class="btn" @click="doExport"><el-icon><Download/></el-icon> 导出</button>
      <span class="fb-gap"></span>
      <select :value="rows" @change="onRowsChange($event)">
        <option :value="20">20 条/页</option><option :value="50">50 条/页</option><option :value="100">100 条/页</option>
      </select>
      <span class="sp"></span>
      <button class="pg" :disabled="page<=1" @click="page--;load()">‹</button>
      <button class="pg" v-for="p in pageBtns" :key="p" :class="{on: p===page}" @click="page=p;load()">{{ p }}</button>
      <button class="pg" :disabled="page>=pages" @click="page++;load()">›</button>
      <span style="margin-left:10px">共 {{ total }} 条</span>
    </div>
  </div>

  <!-- ===== 整页开单态（对齐橙子云） ===== -->
  <div class="page-card doc-editor" v-else>
    <div class="de-head">
      <span class="de-title">{{ DOC_META[editor.type].label }}</span>
      <span class="billno" v-if="editor.billNo">{{ editor.billNo }}</span>
      <span v-else class="muted" style="font-size:12px">保存后自动生成单号</span>
      <span v-if="editor.ro" class="ro-badge">
        <el-icon><Lock/></el-icon>
        {{ STATUS_TEXT[editor.status] }} · 只读
      </span>
      <span class="de-sp"></span>
      <button class="btn" @click="backToList">返回列表</button>
      <template v-if="!editor.ro">
        <button class="btn" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存草稿' }}</button>
        <button class="btn primary" :disabled="saving" @click="saveAndAudit">保存并审核</button>
      </template>
    </div>
    <div class="ro-tip" v-if="editor.ro">
      该单据已{{ STATUS_TEXT[editor.status] }}，内容不可修改。如需调整请先作废并重新开单。
    </div>

    <div class="de-body" :class="{ ro: editor.ro }">
      <!-- 表头字段区：四列密集布局 -->
      <div class="de-grid">
        <div class="fi">
          <label>单号</label>
          <div class="fc"><input :value="editor.billNo || '保存后自动生成'" disabled/></div>
        </div>
        <div class="fi">
          <label><span class="req">*</span>日期</label>
          <div class="fc"><el-date-picker v-model="editor.form.date" type="date" value-format="YYYY-MM-DD" style="width:100%" :disabled="editor.ro"/></div>
        </div>
        <div class="fi" v-if="emeta.partner">
          <label><span class="req">*</span>{{ emeta.partner === 'ven' ? '供应商' : '客户' }}</label>
          <div class="fc">
            <el-select v-model="editor.form.partnerId" filterable clearable placeholder="搜索名称/拼音/手机" style="width:100%" :disabled="editor.ro">
              <el-option v-for="p in epartners" :key="p.id" :label="p.name" :value="p.id">
                <span>{{ p.name }}</span><span class="opt-sub">{{ p.mobile || '' }}</span>
              </el-option>
            </el-select>
          </div>
        </div>
        <div class="fi" v-if="emeta.warehouse">
          <label><span class="req">*</span>仓库</label>
          <div class="fc">
            <el-select v-model="editor.form.warehouseId" placeholder="选择仓库" style="width:100%" :disabled="editor.ro">
              <el-option v-for="w in store.warehouses" :key="w.id" :label="w.name" :value="w.id"/>
            </el-select>
          </div>
        </div>

        <div class="fi">
          <label>业务员</label>
          <div class="fc">
            <el-select v-model="editor.form.clerkId" filterable clearable placeholder="选择" style="width:100%" :disabled="editor.ro">
              <el-option v-for="c in store.clerks" :key="c.id" :label="c.name" :value="c.id"/>
            </el-select>
          </div>
        </div>

        <template v-if="emeta.partner === 'cus'">
          <div class="fi"><label>收件人</label><div class="fc"><input v-model="editor.form.receiverName" placeholder="收件人姓名" :disabled="editor.ro"/></div></div>
          <div class="fi"><label>收件手机</label><div class="fc"><input v-model="editor.form.receiverMobile" placeholder="联系电话" :disabled="editor.ro"/></div></div>
          <div class="fi"><label>收件地址</label><div class="fc"><input v-model="editor.form.receiverAddress" placeholder="详细地址" :disabled="editor.ro"/></div></div>
        </template>

        <div class="fi span-all"><label>备注</label><div class="fc"><input v-model="editor.form.remark" placeholder="整单备注" :disabled="editor.ro"/></div></div>
      </div>

      <!-- 明细表 -->
      <table class="item-edit">
        <thead><tr>
          <th style="min-width:240px">商品名称</th>
          <th style="width:90px">规格</th>
          <th style="width:60px">单位</th>
          <th style="width:80px" class="r">{{ emeta.stocktake ? '账面数量' : '库存数量' }}</th>
          <th style="width:90px" class="r">{{ emeta.stocktake ? '实盘数量' : '数量' }}</th>
          <th style="width:100px" class="r">单价(元)</th>
          <th style="width:100px" class="r">金额</th>
          <th v-if="emeta.batch" style="width:110px">批次</th>
          <th v-if="emeta.toWarehouse" style="width:130px">调往仓库</th>
          <th>行备注</th>
          <th style="width:46px"></th>
        </tr></thead>
        <tbody>
          <tr v-for="(it, idx) in editor.form.items" :key="idx">
            <td>
              <el-select v-model="it.productId" filterable placeholder="选择商品 / 输入编码" size="small" :disabled="editor.ro" @change="onPick(it)">
                <el-option v-for="p in store.products" :key="p.id" :label="p.name + (p.spec ? '（' + p.spec + '）' : '')" :value="p.id"/>
              </el-select>
            </td>
            <td class="muted">{{ specOf(it.productId) }}</td>
            <td class="muted">{{ unitOf(it.productId) }}</td>
            <td class="r" :class="{ 'stock-low': stockOf(it.productId) <= 0 && it.productId }">{{ stockOf(it.productId) }}</td>
            <td class="r"><input type="number" step="any" class="num" v-model.number="it.qty" :disabled="editor.ro"/></td>
            <td class="r">
              <input type="number" step="0.01" min="0" class="num" v-model.number="it.price" :disabled="editor.ro"/>
              <div v-if="priceMem[it.productId] != null" class="mem-price"
                :class="{ used: Math.round(it.price * 100) === priceMem[it.productId] }">
                记忆价 {{ fmtMoney(priceMem[it.productId]) }}
              </div>
            </td>
            <td class="r money-amt">{{ lineAmt(it) }}</td>
            <td v-if="emeta.batch"><input v-model="it.batchNo" placeholder="留空自动 FIFO" :disabled="editor.ro"/></td>
            <td v-if="emeta.toWarehouse">
              <select v-model="it.toWarehouseId" :disabled="editor.ro">
                <option :value="null">请选择</option>
                <option v-for="w in store.warehouses" :key="w.id" :value="w.id">{{ w.name }}</option>
              </select>
            </td>
            <td><input v-model="it.remark" :disabled="editor.ro"/></td>
            <td style="text-align:center" v-if="!editor.ro"><button class="btn sm danger" @click="removeItem(idx)">删</button></td>
          </tr>
        </tbody>
      </table>
      <div class="de-add">
        <button class="btn sm" @click="addItem">＋ 添加一行</button>
        <span class="scan-box">
          <el-icon><Aim/></el-icon>
          <input v-model="scanCode" placeholder="扫码开单：扫描或输入条码后回车" @keyup.enter="doScan"/>
        </span>
        <span v-if="emeta.stocktake" class="muted">填写实盘数量，审核时按与账面差额自动盈亏</span>
        <span v-else-if="emeta.assemblyNote" class="muted">提示：{{ emeta.assemblyNote }}</span>
        <span v-else-if="emeta.negative" class="muted">提示：数量可为负数（盘亏 / 冲减）</span>
        <span class="fb-gap"></span>
        <span>合计数量 <b>{{ totalQty }}</b></span>
      </div>

      <!-- 底部结算区（仅涉及往来结算的单据显示） -->
      <div class="de-settle" v-if="emeta.partner">
        <div class="ds-head">结算信息</div>
        <div class="ds-row">
          <div class="fi"><label>减整单折扣</label>
            <div class="fc"><input type="number" step="0.01" min="0" class="num" v-model.number="editor.form.discount" :disabled="editor.ro"/>
              <span class="lnk" title="把折扣设为全部商品金额（整单全免）" @click="fullDiscount">全额减</span></div>
          </div>
          <div class="fi"><label>{{ emeta.payLabel || '减本次收款' }}</label>
            <div class="fc"><input type="number" step="0.01" min="0" class="num" v-model.number="editor.form.paidAmount" :disabled="editor.ro"/>
              <span class="lnk" title="本次收款 = 应收金额" @click="setFullPaid">设为全收</span></div>
          </div>
          <div class="fi"><label>{{ emeta.payLabel ? '付款账户' : '收款账户' }}</label>
            <div class="fc">
              <el-select v-model="editor.form.accountId" clearable placeholder="选择账户" style="width:100%" :disabled="editor.ro">
                <el-option v-for="a in store.accounts" :key="a.id" :label="a.name" :value="a.id"/>
              </el-select>
            </div>
          </div>
          <div class="fi"><label>抵扣订金</label>
            <div class="fc"><input type="number" step="0.01" min="0" class="num" v-model.number="editor.form.deposit" :disabled="editor.ro"/></div>
          </div>
        </div>
        <div class="ds-total">
          <div class="ds-item">商品金额 <b class="money">{{ grossAmt.toFixed(2) }}</b></div>
          <div class="ds-item">折扣 <b class="money">-{{ (Number(editor.form.discount)||0).toFixed(2) }}</b></div>
          <div class="ds-item big">{{ emeta.recvLabel || '应收金额' }} <b class="money">{{ totalAmt.toFixed(2) }}</b></div>
          <div v-if="oweAmt > 0.005" class="ds-item">本次欠款 <b class="money owe">{{ oweAmt.toFixed(2) }}</b></div>
          <div v-else class="ds-item settled">✓ 已结清 <b class="money">0.00</b></div>
        </div>
      </div>
      <!-- 非结算类单据：只显示金额小结 -->
      <div class="de-settle" v-else>
        <div class="ds-total plain">
          <div class="ds-item">合计数量 <b>{{ totalQty }}</b></div>
          <div class="ds-item big">合计金额 <b class="money">{{ totalAmt.toFixed(2) }}</b></div>
        </div>
      </div>
    </div>
  </div>

  <doc-viewer :doc-id="viewerId" @close="viewerId = null"/>`,
};

/* ================= 库存流水 ================= */
const LedgerPage = {
  components: { DocViewer },
  setup() {
    const productId = ref(null);
    const list = ref([]);
    const viewerId = ref(null);

    async function load() {
      list.value = await api.get('/stock/ledger', { teamId: store.teamId, productId: productId.value });
    }
    onMounted(load);
    return { productId, list, viewerId, load, store, fmtMoney };
  },
  template: `
  <div>
    <div class="page-card">
      <div class="page-head">
        <span class="hd-title">库存流水</span>
        <span class="hd-sp"></span>
      </div>
      <div class="filterbar">
        <div class="fctrl" style="width:260px"><el-select v-model="productId" filterable clearable placeholder="全部商品" @change="load">
          <el-option v-for="p in store.products" :key="p.id" :label="p.name + (p.spec ? '（' + p.spec + '）' : '')" :value="p.id"/>
        </el-select></div>
        <button class="btn" @click="load">查询</button>
        <span class="fb-gap"></span>
        <span class="muted">共 {{ list.length }} 条</span>
      </div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr><th>时间</th><th>商品</th><th>仓库</th><th>批次</th><th>方向</th><th class="r">数量</th><th class="r">成本单价</th><th>关联单据</th></tr></thead>
          <tbody>
            <tr v-if="!list.length"><td colspan="8"><div class="empty">暂无流水</div></td></tr>
            <tr v-for="l in list" :key="l.id">
              <td class="muted" style="white-space:nowrap">{{ l.createdAt }}</td>
              <td style="font-weight:500">{{ store.products.find(p => p.id === l.productId)?.name || '#' + l.productId }}</td>
              <td>{{ store.warehouses.find(w => w.id === l.warehouseId)?.name || '—' }}</td>
              <td>{{ l.batchNo || '—' }}</td>
              <td><span :class="'tag ' + (l.direction === 'in' ? 'tag-audit' : 'tag-void')">{{ l.direction === 'in' ? '入库' : '出库' }}</span></td>
              <td class="r">{{ l.qty }}</td>
              <td class="r money">{{ fmtMoney(l.unitCost) }}</td>
              <td><span class="link" @click="viewerId = l.refDocId">单据 #{{ l.refDocId }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <doc-viewer :doc-id="viewerId" @close="viewerId = null"/>
  </div>`,
};

/* ================= 收付款（资金） ================= */
const FinancePage = {
  setup() {
    const settlements = ref([]);
    const balances = ref([]);
    const tab = ref('settle');
    const editor = reactive({ open: false, form: {} });
    const viewerId = ref(null);

    async function load() {
      const [s, b] = await Promise.all([
        api.get('/settlement/list', { teamId: store.teamId }),
        api.get('/partner/balance', { teamId: store.teamId }),
      ]);
      settlements.value = s;
      balances.value = b;
      loadDocNos();
    }
    onMounted(load);

    // 关联单据单号缓存：收付款记录里只有 refDocId，需要单独查
    const docNos = ref({});
    async function loadDocNos() {
      const ids = settlements.value.map((s) => s.refDocId).filter(Boolean);
      const uniq = [...new Set(ids)].filter((id) => !docNos.value[id]);
      if (!uniq.length) return;
      const next = { ...docNos.value };
      await Promise.all(uniq.map(async (id) => {
        try {
          const d = await api.get('/doc/info', { teamId: store.teamId, id });
          next[id] = d.doc?.billNo ?? ('#' + id);
        } catch { next[id] = '#' + id; }
      }));
      docNos.value = next;
    }
    function docNoOf(id) { return docNos.value[id] ?? ('#' + id); }
    function gotoDoc(id) { viewerId.value = id; }

    const receivable = computed(() => balances.value.filter(b => b.partnerType === 'cus' && b.balance > 0).reduce((s, b) => s + b.balance, 0));
    const payable = computed(() => balances.value.filter(b => b.partnerType === 'ven' && b.balance > 0).reduce((s, b) => s + b.balance, 0));
    const balRows = computed(() => balances.value.map(b => ({
      ...b,
      name: b.partnerType === 'cus' ? (byId(store.customers, b.partnerId)?.name ?? `#${b.partnerId}`) : (byId(store.vendors, b.partnerId)?.name ?? `#${b.partnerId}`),
    })));

    function openNew(type) {
      editor.form = {
        type, partnerType: type === 'receipt' ? 'cus' : 'ven', partnerId: null,
        accountId: store.accounts[0]?.id ?? null, amount: 0,
        date: new Date().toISOString().slice(0, 10), remark: '',
      };
      editor.open = true;
    }
    const partnerOpts = computed(() => editor.form.partnerType === 'cus' ? store.customers : store.vendors);
    function partnerName(f) {
      const list = f.partnerType === 'cus' ? store.customers : store.vendors;
      return list.find((p) => p.id === f.partnerId)?.name ?? ('#' + f.partnerId);
    }
    async function save() {
      const f = editor.form;
      if (!f.partnerId) return toast('请选择往来单位', 'error');
      if (!(Number(f.amount) > 0)) return toast('金额必须大于 0', 'error');
      try {
        if (f.id) {
          await api.put('/settlement/' + f.id, {
            teamId: store.teamId, accountId: f.accountId || null,
            amount: Math.round(Number(f.amount) * 100), date: f.date, remark: f.remark,
          });
        } else {
          await api.post('/settlement/create', {
            teamId: store.teamId, type: f.type, partnerType: f.partnerType, partnerId: f.partnerId,
            accountId: f.accountId || null, amount: Math.round(Number(f.amount) * 100),
            date: f.date, remark: f.remark,
          });
        }
        editor.open = false;
        toast(f.id ? '已保存' : '已登记');
        load();
        loadBase();
      } catch (e) { toast(e.message, 'error'); }
    }

    function openEdit(s) {
      editor.form = {
        id: s.id, type: s.type, partnerType: s.partnerType, partnerId: s.partnerId,
        accountId: s.accountId, amount: s.amount / 100, date: s.date, remark: s.remark || '',
      };
      editor.open = true;
    }

    async function remove(s) {
      const ok = await confirmBox(
        `确定删除这笔${s.type === 'receipt' ? '收款' : '付款'}记录（${fmtMoney(s.amount)}）？删除后会冲回往来余额与账户余额。`,
        '删除确认',
      );
      if (!ok) return;
      try {
        await api.del('/settlement/' + s.id, { teamId: store.teamId });
        toast('已删除');
        load();
        loadBase();
      } catch (e) { toast(e.message, 'error'); }
    }
    return { settlements, tab, editor, viewerId, receivable, payable, balRows, openNew, openEdit, remove, save, partnerOpts, partnerName, docNoOf, gotoDoc, load, store, fmtMoney };
  },
  template: `
  <div>
    <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
      <div class="stat">
        <div class="ico" style="background:#e6fffb;color:#13c2c2"><el-icon><Wallet/></el-icon></div>
        <div><div class="num money">{{ fmtMoney(receivable) }}</div><div class="lbl">应收金额合计（客户欠款）</div></div>
      </div>
      <div class="stat">
        <div class="ico" style="background:#fff1f0;color:#f5222d"><el-icon><CreditCard/></el-icon></div>
        <div><div class="num money">{{ fmtMoney(payable) }}</div><div class="lbl">应付金额合计（供应商欠款）</div></div>
      </div>
    </div>
    <div class="page-card" style="margin-top:14px">
      <div class="page-head">
        <span class="hd-title">收付款</span>
        <div class="tabs">
          <span class="tb" :class="{ on: tab === 'settle' }" @click="tab = 'settle'">收付款记录</span>
          <span class="tb" :class="{ on: tab === 'bal' }" @click="tab = 'bal'">往来余额</span>
        </div>
        <div class="hd-right">
          <button class="btn" @click="openNew('payment')">+ 付款</button>
          <button class="btn primary" @click="openNew('receipt')">+ 收款</button>
        </div>
      </div>
      <div class="tbl-wrap" v-if="tab==='settle'">
        <table class="tbl">
          <thead><tr><th>日期</th><th>类型</th><th>往来单位</th><th>资金账户</th><th class="r">金额</th><th>关联单据</th><th>备注</th><th class="c" style="width:110px">操作</th></tr></thead>
          <tbody>
            <tr v-if="!settlements.length"><td colspan="8"><div class="empty">暂无收付款记录</div></td></tr>
            <tr v-for="s in settlements" :key="s.id">
              <td>{{ s.date }}</td>
              <td><span :class="'tag ' + (s.type === 'receipt' ? 'tag-audit' : 'tag-void')">{{ s.type === 'receipt' ? '收款' : '付款' }}</span></td>
              <td>{{ (s.partnerType === 'cus' ? store.customers.find(c => c.id === s.partnerId) : store.vendors.find(v => v.id === s.partnerId))?.name || '#' + s.partnerId }}</td>
              <td>{{ store.accounts.find(a => a.id === s.accountId)?.name || '—' }}</td>
              <td class="r money">{{ fmtMoney(s.amount) }}</td>
              <td>
                <a v-if="s.refDocId" class="lnk" @click="gotoDoc(s.refDocId)">{{ docNoOf(s.refDocId) }}</a>
                <span v-else class="muted">—</span>
              </td>
              <td class="muted">{{ s.remark || '—' }}</td>
              <td class="c">
                <a class="lnk" @click="openEdit(s)">编辑</a>
                <a class="lnk danger" @click="remove(s)">删除</a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="tbl-wrap" v-else>
        <table class="tbl">
          <thead><tr><th>往来单位</th><th>类型</th><th class="r">余额</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-if="!balRows.length"><td colspan="4"><div class="empty">暂无往来余额</div></td></tr>
            <tr v-for="b in balRows" :key="b.partnerType + b.partnerId">
              <td style="font-weight:500">{{ b.name }}</td>
              <td>{{ b.partnerType === 'cus' ? '客户' : '供应商' }}</td>
              <td class="r money" :style="{ color: b.balance > 0 ? '' : '#53a551' }">{{ fmtMoney(b.balance) }}</td>
              <td class="muted">{{ b.partnerType === 'cus' ? (b.balance > 0 ? '客户欠款（应收）' : b.balance < 0 ? '客户预付（预收）' : '已结清') : (b.balance > 0 ? '欠供应商（应付）' : b.balance < 0 ? '供应商预付冲抵' : '已结清') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="modal-mask" v-if="editor.open" @click.self="editor.open = false">
      <div class="modal narrow">
        <div class="modal-head"><span class="mt">{{ editor.form.id ? '修改' : '登记' }}{{ editor.form.type === 'receipt' ? '收款' : '付款' }}</span><span class="x" @click="editor.open = false">×</span></div>
        <div class="modal-body">
          <div class="fitem"><label>往来单位</label>
            <div class="fctrl">
              <template v-if="editor.form.id">
                <div class="ro-field">{{ partnerName(editor.form) }}</div>
              </template>
              <template v-else>
                <el-select v-model="editor.form.partnerId" filterable placeholder="选择往来单位">
                  <el-option v-for="p in partnerOpts" :key="p.id" :label="p.name" :value="p.id"/>
                </el-select>
              </template>
            </div>
          </div>
          <div class="fitem"><label>资金账户</label>
            <div class="fctrl"><el-select v-model="editor.form.accountId" clearable placeholder="选择账户（可空）">
              <el-option v-for="a in store.accounts" :key="a.id" :label="a.name" :value="a.id"/>
            </el-select></div>
          </div>
          <div class="fitem"><label>金额(元)</label><input type="number" step="0.01" min="0.01" v-model.number="editor.form.amount"/></div>
          <div class="fitem"><label>日期</label>
            <div class="fctrl"><el-date-picker v-model="editor.form.date" type="date" value-format="YYYY-MM-DD"/></div>
          </div>
          <div class="fitem span2"><label>备注</label><input v-model="editor.form.remark"/></div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="editor.open = false">取消</button>
          <button class="btn primary" @click="save">保存</button>
        </div>
      </div>
    </div>

    <doc-viewer :doc-id="viewerId" @close="viewerId = null"/>
  </div>`,
};

/* ================= 使用帮助 ================= */
const HelpPage = {
  setup() {
    const tab = ref('quick');
    const tabs = [
      { key: 'quick', label: '快速上手' },
      { key: 'flow', label: '单据与流转' },
      { key: 'pages', label: '各页面说明' },
      { key: 'faq', label: '常见问题' },
    ];
    return { tab, tabs, nav };
  },
  template: `
  <div>
    <div class="toolbar">
      <button class="btn" v-for="t in tabs" :key="t.key" :class="{primary: tab===t.key}" @click="tab=t.key">{{ t.label }}</button>
    </div>

    <div class="card" v-if="tab==='quick'" style="padding:20px 24px;max-width:860px">
      <h3 style="margin:0 0 6px">快速上手（5 分钟开始记账）</h3>
      <p class="muted" style="margin-top:0">按顺序完成前三步即可正常使用，后面按业务需要逐步使用。</p>
      <ol style="line-height:2.1;font-size:13.5px;padding-left:20px">
        <li><b>建仓库</b> —— 「档案设置 → 仓库」新建至少一个仓库（如「主仓」）。所有库存都挂在仓库下。</li>
        <li><b>建商品</b> —— 「商品管理 → + 新建商品」：名称、单位、进价、售价，建议填写<b>安全库存</b>（低于它工作台会预警）。</li>
        <li><b>建往来单位</b> —— 「往来单位」添加客户与供应商；开单时选择对方，应收应付自动累计。</li>
        <li><b>采购入库</b> —— 「采购管理 → 采购入库 → + 新建」：选供应商、商品、数量、单价，保存草稿后点<b>审核</b>，库存立即增加、若赊购则记应付。</li>
        <li><b>销售出库</b> —— 「销售管理 → 销售出库」：选客户开单审核，库存扣减、赊销记应收。</li>
        <li><b>收款付款</b> —— 「资金 → 收付款 → + 收款/+ 付款」：核销应收应付，可选资金账户记录余额。</li>
      </ol>
      <div style="background:#f8f9fb;border-radius:8px;padding:12px 16px;font-size:13px;color:var(--muted)">
        💡 单据分「草稿 / 已审核 / 已作废」三态：草稿可随意改删；<b>审核后才会影响库存和往来余额</b>；作废会反向冲回。      </div>
    </div>

    <div class="card" v-else-if="tab==='flow'" style="padding:20px 24px;max-width:860px">
      <h3 style="margin:0 0 12px">单据类型与流转规则</h3>
      <table class="tbl">
        <thead><tr><th>单据</th><th>对方</th><th>审核后对库存的影响</th><th>审核后对往来的影响</th></tr></thead>
        <tbody>
          <tr><td>采购订单</td><td>供应商</td><td class="muted">不影响（可一键转采购入库）</td><td class="muted">不影响</td></tr>
          <tr><td>采购入库</td><td>供应商</td><td>库存 +</td><td>应付 +</td></tr>
          <tr><td>采购退货</td><td>供应商</td><td>库存 −</td><td>应付 −</td></tr>
          <tr><td>销售订单</td><td>客户</td><td class="muted">不影响（可一键转销售出库）</td><td class="muted">不影响</td></tr>
          <tr><td>销售出库</td><td>客户</td><td>库存 −</td><td>应收 +</td></tr>
          <tr><td>销售退货</td><td>客户</td><td>库存 +</td><td>应收 −</td></tr>
          <tr><td>调拨单</td><td class="muted">—</td><td>仓库间移动（总数不变）</td><td class="muted">—</td></tr>
          <tr><td>库存调整</td><td class="muted">—</td><td>盘盈 + / 盘亏 −（数量可负）</td><td class="muted">—</td></tr>
          <tr><td>盘点单</td><td class="muted">—</td><td>按实盘数校准</td><td class="muted">—</td></tr>
          <tr><td>出库申请单</td><td>客户</td><td class="muted">不影响（审核后一键转销售出库）</td><td class="muted">不影响</td></tr>
          <tr><td>生产任务</td><td class="muted">—</td><td class="muted">不影响（审核后一键转生产组装）</td><td class="muted">不影响</td></tr>
        </tbody>
      </table>
      <div style="margin-top:14px;font-size:13.5px;line-height:1.9">
        <b>典型业务闭环：</b><br/>
        采购：采购订单（草稿→审核）→ 生成采购入库 → 审核（库存+、应付+）→ 收付款页登记付款（应付−）<br/>
        销售：销售订单（草稿→审核）→ 生成销售出库 → 审核（库存−、应收+）→ 收付款页登记收款（应收−）<br/>
        退货：采购退货直接审核即可冲回库存与应付；销售退货同理。      </div>
      <div style="background:#fff8e6;border-radius:8px;padding:12px 16px;font-size:13px;margin-top:12px">
        ⚠️ 出库类单据审核时会校验库存：库存不足会提示「可用 N，需要 M」并拒绝审核。批次出库按先进先出（FIFO）扣减。      </div>
    </div>

    <div class="card" v-else-if="tab==='pages'" style="padding:20px 24px;max-width:860px">
      <h3 style="margin:0 0 12px">各页面功能说明</h3>
      <table class="tbl">
        <thead><tr><th style="width:130px">页面</th><th>能做什么</th></tr></thead>
        <tbody>
          <tr><td>工作台</td><td>库存/资金总览、低库存预警、近 14 天出入库趋势、快捷开单入口、最新单据。</td></tr>
          <tr><td>采购管理</td><td>采购订单 / 采购入库 / 采购退货三类单据的查询、新建、审核、转化、导出、打印。</td></tr>
          <tr><td>销售管理</td><td>销售订单 / 销售出库 / 销售退货，同上。</td></tr>
          <tr><td>库存单据</td><td>调拨单（仓库间移库）、库存调整（盘盈亏）、盘点单。</td></tr>
          <tr><td>实时库存</td><td>按仓库+商品查即时库存，低库存标红，可导出 CSV。</td></tr>
          <tr><td>库存流水</td><td>每一笔出入库的时间线，可追溯来源单据。</td></tr>
          <tr><td>销售报表</td><td>按日期范围统计净销售额、毛利估算、商品销售排行（含加权成本）、客户排行，可导出 CSV。</td></tr>
          <tr><td>商品管理</td><td>商品档案：价格、规格、条码、安全库存，可导出；支持从 Excel 粘贴批量导入。</td></tr>
          <tr><td>往来单位</td><td>客户与供应商档案。</td></tr>
          <tr><td>档案设置</td><td>仓库 / 库位 / 商品分类 / 业务员 / 资金账户。</td></tr>
          <tr><td>收付款</td><td>登记收款付款、查看应收应付与每个往来单位的余额明细。</td></tr>
        </tbody>
      </table>
    </div>

    <div class="card" v-else style="padding:20px 24px;max-width:860px">
      <h3 style="margin:0 0 12px">常见问题</h3>
      <div style="font-size:13.5px;line-height:1.7">
        <p><b>Q：单据审核后还能改吗？</b><br/>A：不能。已审核单据只能「作废」（自动反向冲回库存与往来），然后重新开单。这是保证账目可追溯的设计。</p>
        <p><b>Q：删除商品/客户时提示被引用？</b><br/>A：被单据引用或仍有库存的档案不能删除，避免历史单据出现悬空引用。可以不处理，或先作废相关单据。</p>
        <p><b>Q：库存明明有货，审核出库却提示不足？</b><br/>A：库存按「仓库+库位+批次」维度分别记账。检查出库仓库是否选对；带批次的商品按批次分别扣减。</p>
        <p><b>Q：应收/应付什么时候产生？</b><br/>A：入库/出库单审核且选择了往来单位时产生。订单不产生；收付款用于冲减。客户余额为负表示预收款。</p>
        <p><b>Q：双击了保存会重复开单吗？</b><br/>A：不会。系统对完全相同的单据内容在 5 秒内自动去重，返回同一张单。</p>
        <p><b>Q：怎么备份数据？</b><br/>A：数据存于服务端 data/orange-clone.db（SQLite 单文件），复制该文件即完成备份。</p>
      </div>
    </div>
  </div>`,
};

/* ================= 报表 ================= */
const ReportPage = {
  setup() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const range = reactive([`${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, today]);
    const REPORT_TABS = ['day', 'product', 'cus'];
    const repTabParam = route.q.tab;
    const tab = ref(REPORT_TABS.includes(repTabParam) ? repTabParam : 'day');
    watch(() => route.q.tab, (t) => { if (REPORT_TABS.includes(t)) { tab.value = t; load(); } });
    const loading = ref(false);
    const sales = ref({ days: [], totals: { saleAmount: 0, retAmount: 0, saleQty: 0, retQty: 0, orderCount: 0 } });
    const products = ref([]);
    const customers = ref([]);
    const chartEl = ref(null);
    let chart = null;

    const fmtD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    async function load() {
      if (!range[0] || !range[1]) return toast('请选择日期范围', 'error');
      loading.value = true;
      try {
        const params = { teamId: store.teamId, from: range[0], to: range[1] };
        const [s, p, c] = await Promise.all([
          api.get('/report/sales', params),
          api.get('/report/product', params),
          api.get('/report/customer', params),
        ]);
        sales.value = s;
        products.value = p.rows || [];
        customers.value = c.rows || [];
        nextTick(renderChart);
      } catch (e) { toast(e.message, 'error'); }
      finally { loading.value = false; }
    }

    function renderChart() {
      if (!chartEl.value) return;
      if (!chart) chart = echarts.init(chartEl.value);
      const map = new Map((sales.value.days || []).map((d) => [d.day, d]));
      const cats = [];
      const net = [];
      let d = new Date(range[0] + 'T00:00:00');
      const end = new Date(range[1] + 'T00:00:00');
      while (d <= end) {
        const key = fmtD(d);
        cats.push(key.slice(5));
        const row = map.get(key);
        net.push(row ? Math.round((row.saleAmount - row.retAmount)) / 100 : 0);
        d.setDate(d.getDate() + 1);
      }
      chart.setOption({
        grid: { left: 60, right: 16, top: 30, bottom: 28 },
        tooltip: { trigger: 'axis', valueFormatter: (v) => `¥${Number(v).toLocaleString()}` },
        xAxis: { type: 'category', data: cats },
        yAxis: { type: 'value' },
        series: [{ type: 'bar', name: '净销售额(元)', data: net, itemStyle: { color: '#ff9a3c' }, barMaxWidth: 26 }],
      });
    }
    onMounted(load);
    onBeforeUnmount(() => { if (chart) { chart.dispose(); chart = null; } });

    const cards = computed(() => {
      const t = sales.value.totals || {};
      return [
        { label: '净销售额', val: fmtMoney((t.saleAmount || 0) - (t.retAmount || 0)), icon: 'TrendCharts' },
        { label: '毛利（估算）', val: fmtMoney(products.value.reduce((a, r) => a + (r.estProfit || 0), 0)), icon: 'Histogram' },
        { label: '销售单数', val: t.orderCount || 0, icon: 'Tickets' },
        { label: '退货金额', val: fmtMoney(t.retAmount || 0), icon: 'RefreshLeft' },
      ];
    });

    function doExport() {
      if (tab.value === 'day') {
        exportCsv(`销售按日_${range[0]}_${range[1]}.csv`,
          (sales.value.days || []).map((d) => ({
            日期: d.day, 销售金额: fmtMoney(d.saleAmount), 退货金额: fmtMoney(d.retAmount),
            净销售额: fmtMoney(d.saleAmount - d.retAmount), 销售数量: d.saleQty, 退货数量: d.retQty, 单数: d.orderCount,
          })), [
            { key: '日期', label: '日期' }, { key: '销售金额', label: '销售金额' }, { key: '退货金额', label: '退货金额' },
            { key: '净销售额', label: '净销售额' }, { key: '销售数量', label: '销售数量' }, { key: '退货数量', label: '退货数量' }, { key: '单数', label: '单数' },
          ]);
      } else if (tab.value === 'product') {
        exportCsv(`商品销售排行_${range[0]}_${range[1]}.csv`,
          products.value.map((r, i) => ({
            排名: i + 1, 商品: r.prodName, 单位: r.unit || '', 净数量: r.netQty, 净销售额: fmtMoney(r.netAmount),
            加权成本: fmtMoney(r.avgCost || 0), 毛利估算: fmtMoney(r.estProfit || 0),
          })), [
            { key: '排名', label: '排名' }, { key: '商品', label: '商品' }, { key: '单位', label: '单位' },
            { key: '净数量', label: '净数量' }, { key: '净销售额', label: '净销售额' },
            { key: '加权成本', label: '加权成本' }, { key: '毛利估算', label: '毛利估算' },
          ]);
      } else {
        exportCsv(`客户销售排行_${range[0]}_${range[1]}.csv`,
          customers.value.map((r) => ({
            客户: r.cusName || '（未指定）', 销售金额: fmtMoney(r.saleAmount), 退货金额: fmtMoney(r.retAmount),
            净销售额: fmtMoney(r.saleAmount - r.retAmount), 单数: r.orderCount,
          })), [
            { key: '客户', label: '客户' }, { key: '销售金额', label: '销售金额' }, { key: '退货金额', label: '退货金额' },
            { key: '净销售额', label: '净销售额' }, { key: '单数', label: '单数' },
          ]);
      }
    }

    return { range, tab, loading, sales, products, customers, chartEl, cards, load, doExport, fmtMoney, STATUS_TEXT: { draft: '草稿', pending: '待审核', audit: '已审核', void: '已作废' } };
  },
  template: `
  <div class="page-card">
    <div class="page-head">
      <div class="hd-title">销售报表</div>
      <div class="tabs">
        <span v-for="(t, k) in { day: '按日明细', product: '商品排行', customer: '客户排行' }" :key="k" :class="['tab', { active: tab === k }]" @click="tab = k">{{ t }}</span>
      </div>
      <div class="hd-right">
        <button class="btn" @click="doExport"><el-icon><Download/></el-icon> 导出</button>
      </div>
    </div>
    <div class="filterbar">
      <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" style="width:260px" :clearable="false" @change="load"/>
      <button class="btn primary" :disabled="loading" @click="load">{{ loading ? '查询中…' : '查询' }}</button>
      <span class="muted" style="font-size:12.5px" v-if="tab === 'product'">成本按已审核采购入库的加权平均价估算</span>
    </div>

    <div class="stat-grid">
      <div class="card stat" v-for="c in cards" :key="c.label">
        <div class="stat-label"><el-icon><component :is="c.icon"/></el-icon> {{ c.label }}</div>
        <div class="stat-val">{{ c.val }}</div>
      </div>
    </div>

    <div class="card" style="margin:0 0 12px">
      <div class="card-title" style="margin-bottom:8px">净销售额趋势（元）</div>
      <div ref="chartEl" style="height:280px"></div>
    </div>

    <div class="tbl-wrap">
      <table class="tbl" v-if="tab === 'day'">
        <thead><tr><th>日期</th><th class="r">销售金额</th><th class="r">退货金额</th><th class="r">净销售额</th><th class="r">销售数量</th><th class="r">退货数量</th><th class="r">单数</th></tr></thead>
        <tbody>
          <tr v-for="d in sales.days" :key="d.day">
            <td>{{ d.day }}</td><td class="r">{{ fmtMoney(d.saleAmount) }}</td><td class="r">{{ fmtMoney(d.retAmount) }}</td>
            <td class="r"><b>{{ fmtMoney(d.saleAmount - d.retAmount) }}</b></td>
            <td class="r">{{ d.saleQty }}</td><td class="r">{{ d.retQty }}</td><td class="r">{{ d.orderCount }}</td>
          </tr>
          <tr v-if="!sales.days.length"><td colspan="7" class="muted" style="text-align:center;padding:22px">该范围内没有已审核的销售/退货单。</td></tr>
        </tbody>
      </table>

      <table class="tbl" v-else-if="tab === 'product'">
        <thead><tr><th class="r" style="width:52px">#</th><th>商品</th><th>单位</th><th class="r">净数量</th><th class="r">净销售额</th><th class="r">加权成本</th><th class="r">毛利（估算）</th></tr></thead>
        <tbody>
          <tr v-for="(r, i) in products" :key="r.productId">
            <td class="r muted">{{ i + 1 }}</td><td>{{ r.prodName }}</td><td>{{ r.unit || '—' }}</td>
            <td class="r">{{ r.netQty }}</td><td class="r">{{ fmtMoney(r.netAmount) }}</td><td class="r">{{ fmtMoney(r.avgCost || 0) }}</td>
            <td class="r" :style="{ color: (r.estProfit || 0) < 0 ? '#f56c6c' : '#53a551' }">{{ fmtMoney(r.estProfit || 0) }}</td>
          </tr>
          <tr v-if="!products.length"><td colspan="7" class="muted" style="text-align:center;padding:22px">该范围内没有商品销售数据。</td></tr>
        </tbody>
      </table>

      <table class="tbl" v-else>
        <thead><tr><th class="r" style="width:52px">#</th><th>客户</th><th class="r">销售金额</th><th class="r">退货金额</th><th class="r">净销售额</th><th class="r">单数</th></tr></thead>
        <tbody>
          <tr v-for="(r, i) in customers" :key="r.cusId ?? 0">
            <td class="r muted">{{ i + 1 }}</td><td>{{ r.cusName || '（未指定客户）' }}</td>
            <td class="r">{{ fmtMoney(r.saleAmount) }}</td><td class="r">{{ fmtMoney(r.retAmount) }}</td>
            <td class="r"><b>{{ fmtMoney(r.saleAmount - r.retAmount) }}</b></td><td class="r">{{ r.orderCount }}</td>
          </tr>
          <tr v-if="!customers.length"><td colspan="6" class="muted" style="text-align:center;padding:22px">该范围内没有客户销售数据。</td></tr>
        </tbody>
      </table>
    </div>
  </div>`,
};

/* ================= 根应用 ================= */
/* 顶部导航分组：对齐橙子云（工作台 / 销售 / 采购 / 库存 / 资料 / 设置） */
const MENU = [
  { label: '工作台', page: 'dashboard' },
  { label: '待审核', page: 'approval' },
  { label: '销售', items: [
    { label: '报价单', page: 'doc/sale?type=quo' },
    { label: '销售订单', page: 'doc/sale?type=sorder' },
    { label: '销售出库', page: 'doc/sale?type=stockout' },
    { label: '销售退货', page: 'doc/sale?type=sret' },
    { label: '销售收款', page: 'finance' },
    { label: '订单统计', page: 'report?tab=order' },
    { label: '出库统计', page: 'report?tab=out' },
    { label: '收款统计', page: 'report?tab=receipt' },
    { label: '毛利统计', page: 'report?tab=product' },
    { label: '客户对账单', page: 'statement?mode=ar' },
    { label: '客户欠款账龄', page: 'aging?mode=ar' },
  ] },
  { label: '采购', items: [
    { label: '采购订单', page: 'doc/purchase?type=porder' },
    { label: '采购入库', page: 'doc/purchase?type=stockin' },
    { label: '采购退货', page: 'doc/purchase?type=pin' },
    { label: '采购付款', page: 'finance' },
    { label: '采购统计', page: 'jxcstat' },
    { label: '供应商对账单', page: 'statement?mode=ap' },
    { label: '供应商欠款账龄', page: 'aging?mode=ap' },
  ] },
  { label: '库存', items: [
    { label: '期初库存', page: 'doc/inventory?type=stockinit' },
    { label: '其它入库', page: 'doc/inventory?type=otherin' },
    { label: '其它出库', page: 'doc/inventory?type=otherout' },
    { label: '生产组装', page: 'doc/inventory?type=assembly' },
    { label: '转仓调拨', page: 'doc/inventory?type=transfer' },
    { label: '库存调整', page: 'doc/inventory?type=adjust' },
    { label: '库存盘点', page: 'doc/inventory?type=stocktake' },
    { label: '出库申请单', page: 'doc/apply?type=outapply' },
    { label: '生产任务', page: 'doc/apply?type=prodtask' },
    { label: '库存查询', page: 'stock' },
    { label: '进销存明细', page: 'ledger' },
    { label: '进销存统计', page: 'jxcstat' },
    { label: '库存账龄', page: 'aging?mode=stock' },
    { label: '库存预估', page: 'forecast' },
  ] },
  { label: '资料', items: [
    { label: '客户', page: 'partner?tab=cus' },
    { label: '供应商', page: 'partner?tab=ven' },
    { label: '商品', page: 'product' },
    { label: '商品单位', page: 'base?tab=unit' },
    { label: '商品分类', page: 'base?tab=cat' },
    { label: '客户价格', page: 'price' },
    { label: '基础档案', page: 'base' },
  ] },
  { label: '设置', items: [
    { label: '功能设置', page: 'settings' },
    { label: '收付款账户', page: 'base?tab=account' },
    { label: '使用帮助', page: 'help' },
  ] },
];
/* ================= 进销存统计 ================= */
const JxcStatPage = {
  setup() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const range = reactive([`${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, today]);
    const loading = ref(false);
    const byType = ref([]);
    const rows = ref([]);
    const totals = ref({ inQty: 0, inAmount: 0, outQty: 0, outAmount: 0 });

    const TYPE_LABEL = {
      stockin: '采购入库', pin: '采购退货', stockout: '销售出库', sret: '销售退货',
      otherin: '其它入库', otherout: '其它出库', transfer: '转仓调拨', adjust: '库存调整',
      stocktake: '库存盘点', assembly: '生产组装', stockinit: '期初库存',
    };
    const IN_SET = new Set(['stockin', 'otherin', 'sret', 'stockinit']);
    const OUT_SET = new Set(['stockout', 'otherout', 'pin']);

    async function load() {
      if (!range[0] || !range[1]) return toast('请选择日期范围', 'error');
      loading.value = true;
      try {
        const r = await api.get('/report/jxc-stat', { teamId: store.teamId, from: range[0], to: range[1] });
        byType.value = (r.byType || []).map((b) => ({
          ...b,
          label: TYPE_LABEL[b.type] || b.type,
          dir: IN_SET.has(b.type) ? '入' : OUT_SET.has(b.type) ? '出' : '—',
        }));
        rows.value = r.rows || [];
        totals.value = r.totals || { inQty: 0, inAmount: 0, outQty: 0, outAmount: 0 };
      } catch (e) { toast(e.message, 'error'); }
      finally { loading.value = false; }
    }

    const cards = computed(() => [
      { label: '入库数量', val: totals.value.inQty, unit: '' },
      { label: '入库金额', val: fmtMoney(totals.value.inAmount), unit: '元' },
      { label: '出库数量', val: totals.value.outQty, unit: '' },
      { label: '出库金额', val: fmtMoney(totals.value.outAmount), unit: '元' },
    ]);

    function doExport() {
      exportCsv(`进销存统计_${range[0]}_${range[1]}.csv`,
        rows.value.map((r) => ({
          商品: r.prodName, 规格: r.spec || '', 单位: r.unit || '',
          入库数量: r.inQty, 入库金额: fmtMoney(r.inAmount),
          出库数量: r.outQty, 出库金额: fmtMoney(r.outAmount),
          结存数量: r.inQty - r.outQty,
        })), [
          { key: '商品', label: '商品' }, { key: '规格', label: '规格' }, { key: '单位', label: '单位' },
          { key: '入库数量', label: '入库数量' }, { key: '入库金额', label: '入库金额' },
          { key: '出库数量', label: '出库数量' }, { key: '出库金额', label: '出库金额' },
          { key: '结存数量', label: '结存数量' },
        ]);
    }

    onMounted(load);
    return { range, loading, byType, rows, totals, cards, load, doExport, fmtMoney };
  },
  template: `
  <div class="page-card">
    <div class="page-head">
      <div class="hd-title">进销存统计</div>
      <div class="hd-right">
        <button class="btn" @click="doExport"><el-icon><Download/></el-icon> 导出</button>
      </div>
    </div>
    <div class="filterbar">
      <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" style="width:260px" :clearable="false" @change="load"/>
      <button class="btn primary" :disabled="loading" @click="load">{{ loading ? '查询中…' : '查询' }}</button>
    </div>

    <div class="stat-grid">
      <div class="card stat" v-for="c in cards" :key="c.label">
        <div class="stat-label">{{ c.label }}</div>
        <div class="stat-val">{{ c.val }}<i class="kpi-unit" v-if="c.unit">{{ c.unit }}</i></div>
      </div>
    </div>

    <div class="card" style="margin:12px 0">
      <div class="card-title" style="margin-bottom:8px">按单据类型汇总</div>
      <table class="tbl">
        <thead><tr><th>单据类型</th><th class="r">方向</th><th class="r">单数</th><th class="r">数量</th><th class="r">金额</th></tr></thead>
        <tbody>
          <tr v-for="b in byType" :key="b.type">
            <td>{{ b.label }}</td>
            <td class="r"><span :class="['tag', b.dir === '入' ? 'ok' : b.dir === '出' ? 'warn' : '']">{{ b.dir }}</span></td>
            <td class="r">{{ b.count }}</td><td class="r">{{ b.qty }}</td><td class="r">{{ fmtMoney(b.amount) }}</td>
          </tr>
          <tr v-if="!byType.length"><td colspan="5" class="muted" style="text-align:center;padding:22px">该范围内没有已审核单据。</td></tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-title" style="margin-bottom:8px">按商品汇总（入 = 采购入库/其它入库/销售退货，出 = 销售出库/其它出库/采购退货）</div>
      <table class="tbl">
        <thead><tr><th class="r" style="width:52px">#</th><th>商品</th><th>规格</th><th>单位</th><th class="r">入库数量</th><th class="r">入库金额</th><th class="r">出库数量</th><th class="r">出库金额</th><th class="r">结存数量</th></tr></thead>
        <tbody>
          <tr v-for="(r, i) in rows" :key="r.productId">
            <td class="r muted">{{ i + 1 }}</td>
            <td>{{ r.prodName }}</td><td>{{ r.spec || '—' }}</td><td>{{ r.unit || '—' }}</td>
            <td class="r">{{ r.inQty }}</td><td class="r">{{ fmtMoney(r.inAmount) }}</td>
            <td class="r">{{ r.outQty }}</td><td class="r">{{ fmtMoney(r.outAmount) }}</td>
            <td class="r"><b>{{ r.inQty - r.outQty }}</b></td>
          </tr>
          <tr v-if="!rows.length"><td colspan="9" class="muted" style="text-align:center;padding:22px">该范围内没有出入库记录。</td></tr>
          <tr v-else style="background:#f7f9fb;font-weight:600">
            <td colspan="4" style="text-align:right">合计</td>
            <td class="r">{{ totals.inQty }}</td><td class="r">{{ fmtMoney(totals.inAmount) }}</td>
            <td class="r">{{ totals.outQty }}</td><td class="r">{{ fmtMoney(totals.outAmount) }}</td>
            <td class="r">{{ totals.inQty - totals.outQty }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>`,
};

/* ================= 库存预估 ================= */
const ForecastPage = {
  setup() {
    const days = ref(30);
    const loading = ref(false);
    const rows = ref([]);
    const kw = ref('');

    async function load() {
      loading.value = true;
      try {
        const r = await api.get('/report/stock-forecast', { teamId: store.teamId, days: days.value });
        rows.value = r.rows || [];
      } catch (e) { toast(e.message, 'error'); }
      finally { loading.value = false; }
    }

    const shown = computed(() => {
      const k = kw.value.trim();
      if (!k) return rows.value;
      return rows.value.filter((r) => (r.prodName || '').includes(k));
    });
    const warnCount = computed(() => rows.value.filter((r) => r.suggestQty > 0).length);

    const fmtDays = (d) => (d === null ? '—' : d >= 999 ? '999+' : String(d));
    const dayClass = (d) => (d === null ? '' : d < 15 ? 'stock-low' : d < 30 ? 'txt-warn' : '');

    function doExport() {
      exportCsv(`库存预估_${days.value}天.csv`,
        shown.value.map((r) => ({
          商品: r.prodName, 规格: r.spec || '', 单位: r.unit || '',
          当前库存: r.qty, 统计期出库: r.outQty, 日均出库: r.avgDailyOut,
          可售天数: fmtDays(r.saleableDays), 单位成本: fmtMoney(r.unitCost),
          库存金额: fmtMoney(r.amount), 建议补货: r.suggestQty,
        })), [
          { key: '商品', label: '商品' }, { key: '规格', label: '规格' }, { key: '单位', label: '单位' },
          { key: '当前库存', label: '当前库存' }, { key: '统计期出库', label: '统计期出库' }, { key: '日均出库', label: '日均出库' },
          { key: '可售天数', label: '可售天数' }, { key: '单位成本', label: '单位成本' },
          { key: '库存金额', label: '库存金额' }, { key: '建议补货', label: '建议补货' },
        ]);
    }

    onMounted(load);
    return { days, loading, rows, kw, shown, warnCount, load, doExport, fmtMoney, fmtDays, dayClass };
  },
  template: `
  <div class="page-card">
    <div class="page-head">
      <div class="hd-title">库存预估</div>
      <div class="hd-right">
        <span class="tag warn" v-if="warnCount" style="margin-right:8px">{{ warnCount }} 个商品建议补货</span>
        <button class="btn" @click="doExport"><el-icon><Download/></el-icon> 导出</button>
      </div>
    </div>
    <div class="filterbar">
      <span class="muted" style="font-size:12.5px">统计窗口</span>
      <el-select v-model="days" style="width:130px" @change="load">
        <el-option :value="7" label="最近 7 天"/><el-option :value="30" label="最近 30 天"/>
        <el-option :value="90" label="最近 90 天"/><el-option :value="180" label="最近 180 天"/>
      </el-select>
      <input class="inp" v-model="kw" placeholder="搜索商品名" style="width:180px"/>
      <button class="btn primary" :disabled="loading" @click="load">{{ loading ? '计算中…' : '刷新' }}</button>
    </div>

    <div class="card">
      <div class="card-title" style="margin-bottom:8px">库存预估（按最近 {{ days }} 天日均出库推算可售天数，低于 15 天给出补货建议）</div>
      <table class="tbl">
        <thead><tr>
          <th class="r" style="width:52px">#</th><th>商品</th><th>规格</th><th>单位</th>
          <th class="r">当前库存</th><th class="r">期出库</th><th class="r">日均出库</th>
          <th class="r">可售天数</th><th class="r">单位成本</th><th class="r">库存金额</th><th class="r">建议补货</th>
        </tr></thead>
        <tbody>
          <tr v-for="(r, i) in shown" :key="r.productId">
            <td class="r muted">{{ i + 1 }}</td>
            <td>{{ r.prodName }}</td><td>{{ r.spec || '—' }}</td><td>{{ r.unit || '—' }}</td>
            <td class="r" :class="r.lowQty && r.qty <= r.lowQty ? 'stock-low' : ''">{{ r.qty }}</td>
            <td class="r">{{ r.outQty }}</td><td class="r">{{ r.avgDailyOut }}</td>
            <td class="r" :class="dayClass(r.saleableDays)">{{ fmtDays(r.saleableDays) }}</td>
            <td class="r">{{ fmtMoney(r.unitCost) }}</td><td class="r">{{ fmtMoney(r.amount) }}</td>
            <td class="r"><b v-if="r.suggestQty > 0" style="color:#f56c6c">{{ r.suggestQty }}</b><span v-else class="muted">—</span></td>
          </tr>
          <tr v-if="!shown.length"><td colspan="11" class="muted" style="text-align:center;padding:22px">没有商品数据。</td></tr>
        </tbody>
      </table>
    </div>
  </div>`,
};

/* ================= 往来对账单 ================= */
const StatementPage = {
  setup() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const range = reactive([`${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, today]);
    const mode = ref(route.q.mode === 'ap' ? 'ap' : 'ar');
    const partnerId = ref(null);
    const loading = ref(false);
    const data = ref(null);

    /* 从菜单进入时按 query.mode 切换（客户/供应商两个入口共用本页） */
    watch(() => route.q.mode, (m) => {
      const next = m === 'ap' ? 'ap' : 'ar';
      if (next !== mode.value) { mode.value = next; partnerId.value = null; data.value = null; }
    });

    const partners = computed(() => (mode.value === 'ar' ? store.customers : store.vendors));

    async function load() {
      if (!partnerId.value) return toast('请选择往来单位', 'error');
      if (!range[0] || !range[1]) return toast('请选择日期范围', 'error');
      loading.value = true;
      try {
        data.value = await api.get('/report/statement', {
          teamId: store.teamId, mode: mode.value, partnerId: partnerId.value,
          from: range[0], to: range[1],
        });
      } catch (e) { toast(e.message, 'error'); data.value = null; }
      finally { loading.value = false; }
    }
    function switchMode() { partnerId.value = null; data.value = null; }

    function doExport() {
      if (!data.value) return toast('请先查询', 'error');
      exportCsv(`对账单_${data.value.partner.name}_${range[0]}_${range[1]}.csv`,
        data.value.lines.map((l) => ({
          日期: l.date, 单据号: l.billNo, 类型: l.label,
          应收: l.debit ? fmtMoney(l.debit) : '', 收款: l.credit ? fmtMoney(l.credit) : '',
          余额: fmtMoney(l.balance), 备注: l.remark || '',
        })), [
          { key: '日期', label: '日期' }, { key: '单据号', label: '单据号' }, { key: '类型', label: '类型' },
          { key: '应收', label: '应收' }, { key: '收款', label: '收款' }, { key: '余额', label: '余额' }, { key: '备注', label: '备注' },
        ]);
    }

    function doPrint() {
      if (!data.value) return toast('请先查询', 'error');
      const d = data.value;
      const isAr = d.mode === 'ar';
      const rowsHtml = d.lines.map((l) => `<tr>
        <td>${l.date}</td><td>${l.billNo}</td><td>${l.label}</td>
        <td class="r">${l.debit ? fmtMoney(l.debit) : ''}</td>
        <td class="r">${l.credit ? fmtMoney(l.credit) : ''}</td>
        <td class="r">${fmtMoney(l.balance)}</td><td>${l.remark || ''}</td></tr>`).join('');
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>对账单</title><style>
        body{font-family:"Microsoft YaHei",sans-serif;font-size:12px;color:#333;padding:18px}
        h2{text-align:center;font-size:17px;margin:0 0 4px}
        .sub{text-align:center;color:#888;font-size:11px;margin-bottom:12px}
        table{width:100%;border-collapse:collapse}
        th,td{border:1px solid #ccc;padding:5px 7px;text-align:left}
        th{background:#f7f9fb}
        .r{text-align:right}.sum{margin-top:10px;text-align:right;font-size:13px}
      </style></head><body>
      <h2>${isAr ? '客户对账单' : '供应商对账单'}</h2>
      <div class="sub">${d.partner.name} ｜ 期间 ${d.from} 至 ${d.to}</div>
      <table><thead><tr><th>日期</th><th>单据号</th><th>类型</th><th class="r">${isAr ? '应收' : '应付'}</th>
      <th class="r">${isAr ? '收款' : '付款'}</th><th class="r">余额</th><th>备注</th></tr></thead>
      <tbody>
      <tr><td colspan="5"><b>期初余额</b></td><td class="r"><b>${fmtMoney(d.opening)}</b></td><td></td></tr>
      ${rowsHtml}
      </tbody></table>
      <div class="sum">期间发生 ${fmtMoney(d.periodDebit)} ／ 已${isAr ? '收' : '付'} ${fmtMoney(d.periodCredit)}　
        期末余额 <b>${fmtMoney(d.closing)}</b> 元</div>
      </body></html>`;
      const w = window.open('', '_blank');
      if (!w) return toast('请允许弹出窗口以打印', 'error');
      w.document.write(html);
      w.document.close();
      w.print();
    }

    onMounted(() => { if (store.customers.length) partnerId.value = null; });
    return { range, mode, partnerId, partners, loading, data, load, switchMode, doExport, doPrint, fmtMoney };
  },
  template: `
  <div class="page-card">
    <div class="page-head">
      <div class="hd-title">{{ mode === 'ar' ? '客户对账单' : '供应商对账单' }}</div>
      <div class="tabs">
        <span :class="['tab', { active: mode === 'ar' }]" @click="mode = 'ar'; switchMode()">客户对账单</span>
        <span :class="['tab', { active: mode === 'ap' }]" @click="mode = 'ap'; switchMode()">供应商对账单</span>
      </div>
      <div class="hd-right">
        <button class="btn" @click="doPrint" :disabled="!data"><el-icon><Printer/></el-icon> 打印</button>
        <button class="btn" @click="doExport" :disabled="!data"><el-icon><Download/></el-icon> 导出</button>
      </div>
    </div>
    <div class="filterbar">
      <el-select v-model="partnerId" filterable placeholder="选择往来单位" style="width:200px">
        <el-option v-for="p in partners" :key="p.id" :value="p.id" :label="p.name"/>
      </el-select>
      <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" style="width:260px" :clearable="false"/>
      <button class="btn primary" :disabled="loading" @click="load">{{ loading ? '查询中…' : '查询' }}</button>
    </div>

    <div v-if="data" class="card">
      <div class="card-title" style="margin-bottom:6px">
        {{ data.partner.name }} ｜ {{ data.from }} 至 {{ data.to }}
        <span class="muted" style="font-size:12.5px;font-weight:400;margin-left:8px" v-if="data.partner.mobile">{{ data.partner.mobile }}</span>
      </div>
      <div class="stat-grid" style="margin:10px 0 4px">
        <div class="card stat"><div class="stat-label">期初余额</div><div class="stat-val">{{ fmtMoney(data.opening) }}</div></div>
        <div class="card stat"><div class="stat-label">期间{{ mode === 'ar' ? '应收' : '应付' }}</div><div class="stat-val">{{ fmtMoney(data.periodDebit) }}</div></div>
        <div class="card stat"><div class="stat-label">期间已{{ mode === 'ar' ? '收' : '付' }}</div><div class="stat-val">{{ fmtMoney(data.periodCredit) }}</div></div>
        <div class="card stat"><div class="stat-label">期末余额</div><div class="stat-val" style="color:#f26f21">{{ fmtMoney(data.closing) }}</div></div>
      </div>

      <table class="tbl" style="margin-top:8px">
        <thead><tr><th>日期</th><th>单据号</th><th>类型</th>
          <th class="r">{{ mode === 'ar' ? '应收' : '应付' }}</th>
          <th class="r">{{ mode === 'ar' ? '收款' : '付款' }}</th>
          <th class="r">余额</th><th>备注</th></tr></thead>
        <tbody>
          <tr style="background:#f7f9fb"><td colspan="5"><b>期初余额</b></td><td class="r"><b>{{ fmtMoney(data.opening) }}</b></td><td></td></tr>
          <tr v-for="(l, i) in data.lines" :key="i">
            <td>{{ l.date }}</td><td>{{ l.billNo }}</td><td>{{ l.label }}</td>
            <td class="r">{{ l.debit ? fmtMoney(l.debit) : '' }}</td>
            <td class="r">{{ l.credit ? fmtMoney(l.credit) : '' }}</td>
            <td class="r">{{ fmtMoney(l.balance) }}</td>
            <td class="muted">{{ l.remark || '' }}</td>
          </tr>
          <tr v-if="!data.lines.length"><td colspan="7" class="muted" style="text-align:center;padding:22px">该期间没有发生额。</td></tr>
          <tr style="background:#f7f9fb;font-weight:600">
            <td colspan="5" style="text-align:right">期末余额</td>
            <td class="r">{{ fmtMoney(data.closing) }}</td><td></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else class="card" style="text-align:center;padding:44px 0;color:#98a2ad">
      选择往来单位与日期范围后点击「查询」，可查看期初余额、期间流水与期末余额。
    </div>
  </div>`,
};

/* ================= 账龄统计（客户欠款 / 供应商欠款 / 库存账龄） ================= */
const AgingPage = {
  setup() {
    const mode = ref(route.q.mode === 'ap' ? 'ap' : route.q.mode === 'stock' ? 'stock' : 'ar');
    const loading = ref(false);
    const rows = ref([]);
    const totals = ref({});
    const asOf = ref('');
    const chartEl = ref(null);
    let chart = null;

    const BUCKET_LABELS = ['30天内', '60天内', '90天内', '180天内', '360天内', '720天内', '超过720天'];
    const BUCKET_COLORS = ['#5b8ff9', '#8fd16a', '#f6bd16', '#f56c6c', '#6dc8ec', '#5ad8a6', '#ff9845'];
    const BUCKET_KEYS = ['d30', 'd60', 'd90', 'd180', 'd360', 'd720', 'over720'];

    watch(() => route.q.mode, (m) => {
      const next = m === 'ap' ? 'ap' : m === 'stock' ? 'stock' : 'ar';
      if (next !== mode.value) { mode.value = next; load(); }
    });

    async function load() {
      loading.value = true;
      try {
        if (mode.value === 'stock') {
          const r = await api.get('/report/stock-aging', { teamId: store.teamId });
          rows.value = r.items || [];
          totals.value = r.totals || {};
          asOf.value = r.asOf;
        } else {
          const r = await api.get('/report/aging', { teamId: store.teamId, mode: mode.value });
          rows.value = r.rows || [];
          totals.value = r.totals || {};
          asOf.value = r.asOf;
        }
        await nextTick();
        renderChart();
      } catch (e) { toast(e.message, 'error'); }
      finally { loading.value = false; }
    }

    function renderChart() {
      if (!chartEl.value) return;
      if (!chart) chart = echarts.init(chartEl.value);
      const t = totals.value || {};
      const data = BUCKET_KEYS.map((k, i) => ({
        name: BUCKET_LABELS[i], value: Math.round((t[k] || 0) / 100), itemStyle: { color: BUCKET_COLORS[i] },
      })).filter((d) => d.value > 0);
      chart.setOption({
        tooltip: { trigger: 'item', valueFormatter: (v) => `¥${Number(v).toLocaleString()}` },
        legend: { right: 8, top: 'middle', orient: 'vertical', itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 12 } },
        series: [{
          type: 'pie', radius: ['48%', '68%'], center: ['32%', '50%'],
          label: { show: false }, labelLine: { show: false },
          data: data.length ? data : [{ name: '暂无数据', value: 1, itemStyle: { color: '#eceff2' } }],
        }],
      }, true);
    }

    const cards = computed(() => {
      const t = totals.value || {};
      if (mode.value === 'stock') {
        return [
          { label: '库存货值', val: fmtMoney(t.total) },
          { label: '库存数量', val: String(t.qty || 0) },
          { label: '30 天内', val: fmtMoney(t.d30) },
          { label: '超过 360 天', val: fmtMoney((t.d360 || 0) + (t.d720 || 0) + (t.over720 || 0)) },
        ];
      }
      return [
        { label: mode.value === 'ar' ? '未结应收' : '未结应付', val: fmtMoney(t.total) },
        { label: '30 天内', val: fmtMoney(t.d30) },
        { label: '30-90 天', val: fmtMoney((t.d60 || 0) + (t.d90 || 0)) },
        { label: '超过 90 天', val: fmtMoney((t.d180 || 0) + (t.d360 || 0) + (t.d720 || 0) + (t.over720 || 0)) },
      ];
    });

    function doExport() {
      if (mode.value === 'stock') {
        exportCsv(`库存账龄_${asOf.value}.csv`,
          rows.value.map((r) => ({
            商品: r.prodName, 仓库: r.warehouseName || '', 批次: r.batchNo || '',
            数量: r.qty, 首次入库: r.firstDate || '', 库龄天数: r.days,
            账龄区间: BUCKET_LABELS[BUCKET_KEYS.indexOf(r.bucket)] || '', 金额: fmtMoney(r.amount),
          })), [
            { key: '商品', label: '商品' }, { key: '仓库', label: '仓库' }, { key: '批次', label: '批次' },
            { key: '数量', label: '数量' }, { key: '首次入库', label: '首次入库' }, { key: '库龄天数', label: '库龄天数' },
            { key: '账龄区间', label: '账龄区间' }, { key: '金额', label: '金额' },
          ]);
        return;
      }
      exportCsv(`${mode.value === 'ar' ? '客户' : '供应商'}欠款账龄_${asOf.value}.csv`,
        rows.value.map((r) => {
          const o = { 往来单位: r.partnerName, 最早单据: r.oldestDate || '' };
          BUCKET_KEYS.forEach((k, i) => { o[BUCKET_LABELS[i]] = fmtMoney(r[k]); });
          o['合计'] = fmtMoney(r.total);
          return o;
        }), [
          { key: '往来单位', label: '往来单位' }, { key: '最早单据', label: '最早单据' },
          ...BUCKET_LABELS.map((l) => ({ key: l, label: l })),
          { key: '合计', label: '合计' },
        ]);
    }

    onMounted(load);
    onBeforeUnmount(() => { if (chart) { chart.dispose(); chart = null; } });
    return {
      mode, loading, rows, totals, asOf, cards, chartEl, load, doExport, fmtMoney,
      BUCKET_LABELS, BUCKET_KEYS, bucketLabel: (k) => BUCKET_LABELS[BUCKET_KEYS.indexOf(k)] || k,
    };
  },
  template: `
  <div class="page-card">
    <div class="page-head">
      <div class="hd-title">{{ mode === 'ar' ? '客户欠款账龄' : mode === 'ap' ? '供应商欠款账龄' : '库存账龄' }}</div>
      <div class="tabs">
        <span :class="['tab', { active: mode === 'ar' }]" @click="mode = 'ar'; load()">客户欠款账龄</span>
        <span :class="['tab', { active: mode === 'ap' }]" @click="mode = 'ap'; load()">供应商欠款账龄</span>
        <span :class="['tab', { active: mode === 'stock' }]" @click="mode = 'stock'; load()">库存账龄</span>
      </div>
      <div class="hd-right">
        <span class="muted" style="font-size:12.5px;margin-right:8px">截止 {{ asOf }}</span>
        <button class="btn" @click="doExport"><el-icon><Download/></el-icon> 导出</button>
      </div>
    </div>

    <div class="stat-grid">
      <div class="card stat" v-for="c in cards" :key="c.label">
        <div class="stat-label">{{ c.label }}</div>
        <div class="stat-val">{{ c.val }}</div>
      </div>
    </div>

    <div class="card" style="margin:12px 0">
      <div class="card-title" style="margin-bottom:8px">账龄分布（元）</div>
      <div ref="chartEl" style="height:230px"></div>
    </div>

    <div class="card">
      <table class="tbl" v-if="mode !== 'stock'">
        <thead><tr>
          <th class="r" style="width:52px">#</th><th>往来单位</th><th>最早单据</th>
          <th v-for="l in BUCKET_LABELS" :key="l" class="r">{{ l }}</th><th class="r">合计</th>
        </tr></thead>
        <tbody>
          <tr v-for="(r, i) in rows" :key="r.partnerId">
            <td class="r muted">{{ i + 1 }}</td>
            <td>{{ r.partnerName }}</td><td class="muted">{{ r.oldestDate || '—' }}</td>
            <td v-for="k in BUCKET_KEYS" :key="k" class="r" :class="r[k] > 0 ? '' : 'muted'">{{ r[k] ? fmtMoney(r[k]) : '—' }}</td>
            <td class="r"><b>{{ fmtMoney(r.total) }}</b></td>
          </tr>
          <tr v-if="!rows.length"><td :colspan="10" class="muted" style="text-align:center;padding:22px">暂无未结{{ mode === 'ar' ? '应收' : '应付' }}。</td></tr>
          <tr v-else style="background:#f7f9fb;font-weight:600">
            <td colspan="3" style="text-align:right">合计</td>
            <td v-for="k in BUCKET_KEYS" :key="k" class="r">{{ totals[k] ? fmtMoney(totals[k]) : '—' }}</td>
            <td class="r">{{ fmtMoney(totals.total) }}</td>
          </tr>
        </tbody>
      </table>

      <table class="tbl" v-else>
        <thead><tr>
          <th class="r" style="width:52px">#</th><th>商品</th><th>仓库</th><th>批次</th>
          <th class="r">数量</th><th>首次入库</th><th class="r">库龄天数</th><th>账龄区间</th><th class="r">金额</th>
        </tr></thead>
        <tbody>
          <tr v-for="(r, i) in rows" :key="i">
            <td class="r muted">{{ i + 1 }}</td>
            <td>{{ r.prodName }}</td><td class="muted">{{ r.warehouseName || '—' }}</td>
            <td class="muted">{{ r.batchNo || '—' }}</td>
            <td class="r">{{ r.qty }}</td><td class="muted">{{ r.firstDate || '—' }}</td>
            <td class="r" :class="r.days > 360 ? 'stock-low' : ''">{{ r.days }}</td>
            <td>{{ bucketLabel(r.bucket) }}</td><td class="r">{{ fmtMoney(r.amount) }}</td>
          </tr>
          <tr v-if="!rows.length"><td colspan="9" class="muted" style="text-align:center;padding:22px">没有库存记录。</td></tr>
          <tr v-else style="background:#f7f9fb;font-weight:600">
            <td colspan="4" style="text-align:right">合计</td>
            <td class="r">{{ totals.qty }}</td><td colspan="3"></td>
            <td class="r">{{ fmtMoney(totals.total) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>`,
};

/* ================= 客户价格记忆 ================= */
const PricePage = {
  setup() {
    const kw = ref('');
    const partnerId = ref(null);
    const rows = ref([]);
    const loading = ref(false);
    const editor = reactive({ open: false, row: null, price: 0 });

    async function load() {
      loading.value = true;
      try {
        const r = await api.get('/price/list', {
          teamId: store.teamId,
          partnerId: partnerId.value || '',
          kw: kw.value.trim(),
        });
        rows.value = r.rows || [];
      } catch (e) { toast(e.message, 'error'); }
      finally { loading.value = false; }
    }

    function openEdit(row) {
      editor.row = row;
      editor.price = row.price / 100;
      editor.open = true;
    }

    async function save() {
      const cents = Math.round(Number(editor.price) * 100);
      if (!(cents >= 0)) return toast('价格不能为负', 'error');
      try {
        await api.post('/price/set', {
          teamId: store.teamId,
          partnerId: editor.row.partnerId,
          productId: editor.row.productId,
          price: cents,
        });
        toast('已更新');
        editor.open = false;
        load();
      } catch (e) { toast(e.message, 'error'); }
    }

    async function del(row) {
      const ok = await confirmBox(`删除「${row.cusName || '客户'} - ${row.prodName}」的价格记忆？`);
      if (!ok) return;
      try {
        await api.del(`/price/${row.id}?teamId=${store.teamId}`);
        toast('已删除');
        load();
      } catch (e) { toast(e.message, 'error'); }
    }

    function diffOf(row) {
      if (!row.salePrice) return '';
      const d = row.price - row.salePrice;
      if (d === 0) return '平价';
      return d > 0 ? `高于标准价 ${fmtMoney(d)}` : `低于标准价 ${fmtMoney(-d)}`;
    }

    onMounted(load);
    return { kw, partnerId, rows, loading, editor, load, openEdit, save, del, diffOf, store, fmtMoney };
  },
  template: `
  <div>
    <div class="page-card">
      <div class="page-head">
        <span class="page-title">客户价格记忆</span>
        <div class="hd-right">
          <button class="btn" @click="load"><el-icon><Refresh/></el-icon> 刷新</button>
        </div>
      </div>

      <div class="filterbar">
        <input class="finp" style="width:150px" v-model="kw" placeholder="商品名称" @keyup.enter="load"/>
        <el-select v-model="partnerId" filterable clearable placeholder="全部客户" style="width:170px" @change="load">
          <el-option v-for="c in store.customers" :key="c.id" :label="c.name" :value="c.id"/>
        </el-select>
        <button class="btn" @click="load">查询</button>
        <span class="muted" style="font-size:12.5px;margin-left:6px">共 {{ rows.length }} 条</span>
      </div>

      <table class="tbl">
        <thead><tr>
          <th style="width:52px" class="r">#</th>
          <th>客户</th><th>商品</th><th>规格</th><th>单位</th>
          <th class="r">记忆成交价</th><th class="r">商品标准售价</th><th>对比</th>
          <th>最后一次成交</th><th class="r">成交次数</th><th style="width:130px">操作</th>
        </tr></thead>
        <tbody>
          <tr v-if="!rows.length"><td colspan="11"><div class="empty">暂无价格记忆。销售类单据审核后，系统会自动记住每个客户的成交价。</div></td></tr>
          <tr v-for="(r, i) in rows" :key="r.id">
            <td class="r muted">{{ i + 1 }}</td>
            <td>{{ r.cusName || '—' }}</td>
            <td style="font-weight:500">{{ r.prodName }}</td>
            <td class="muted">{{ r.spec || '—' }}</td>
            <td class="muted">{{ r.unit || '—' }}</td>
            <td class="r money"><b>{{ fmtMoney(r.price) }}</b></td>
            <td class="r money muted">{{ fmtMoney(r.salePrice) }}</td>
            <td :class="r.price > r.salePrice ? 'txt-warn' : (r.price < r.salePrice ? 'txt-ok' : 'muted')">{{ diffOf(r) }}</td>
            <td class="muted">{{ r.lastDate || '—' }}</td>
            <td class="r">{{ r.times }}</td>
            <td>
              <button class="btn sm" @click="openEdit(r)">改价</button>
              <button class="btn sm danger" style="margin-left:6px" @click="del(r)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="modal-mask" v-if="editor.open" @click.self="editor.open = false">
      <div class="modal narrow">
        <div class="modal-head"><span class="mt">修改价格记忆</span><span class="x" @click="editor.open = false">×</span></div>
        <div class="modal-body">
          <div class="fitem"><label>客户</label><div>{{ editor.row.cusName }}</div></div>
          <div class="fitem"><label>商品</label><div>{{ editor.row.prodName }}（标准价 {{ fmtMoney(editor.row.salePrice) }}）</div></div>
          <div class="fitem"><label>记忆成交价(元)</label><input type="number" step="0.01" min="0" v-model.number="editor.price"/></div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="editor.open = false">取消</button>
          <button class="btn primary" @click="save">保存</button>
        </div>
      </div>
    </div>
  </div>`,
};

/* 功能设置页（单据编号 / 打印抬头）——由 inject-settings.js 注入 app.js */
const SettingsPage = {
  setup() {
    const tab = ref('prefix');
    const loading = ref(false);
    const saving = ref(false);
    const prefix = reactive({});
    const noMode = ref('day');
    const print = reactive({ company: '', address: '', phone: '', footer: '', showLogo: true });
    const defaults = ref({});
    const DOC_LABELS = {
      stockin: '采购入库', stockout: '销售出库', transfer: '转仓调拨', adjust: '库存调整', stocktake: '库存盘点',
      porder: '采购订单', sorder: '销售订单', pin: '采购退货', sret: '销售退货',
      otherin: '其它入库', otherout: '其它出库', assembly: '生产组装', stockinit: '期初库存', quo: '报价单',
      outapply: '出库申请单', prodtask: '生产任务',
    };
    const ORDER = ['stockin', 'stockout', 'porder', 'sorder', 'pin', 'sret',
      'transfer', 'adjust', 'stocktake', 'otherin', 'otherout', 'assembly', 'stockinit', 'quo',
      'outapply', 'prodtask'];

    async function load() {
      loading.value = true;
      try {
        const r = await api.get('/setting/get', { teamId: store.teamId });
        Object.keys(prefix).forEach((k) => delete prefix[k]);
        Object.assign(prefix, r.prefix || {});
        defaults.value = r.defaults || {};
        noMode.value = r.noMode || 'day';
        Object.assign(print, r.print || {});
      } catch (e) { toast(e.message, 'error'); }
      finally { loading.value = false; }
    }

    async function savePrefix() {
      saving.value = true;
      try {
        const r = await api.post('/setting/prefix', { teamId: store.teamId, prefix: { ...prefix } });
        Object.assign(prefix, r.prefix || {});
        toast('单据编号已保存');
      } catch (e) { toast(e.message, 'error'); }
      finally { saving.value = false; }
    }

    async function saveNoMode() {
      saving.value = true;
      try {
        await api.post('/setting/no-mode', { teamId: store.teamId, noMode: noMode.value });
        toast('编号重置方式已保存');
      } catch (e) { toast(e.message, 'error'); }
      finally { saving.value = false; }
    }

    async function savePrint() {
      saving.value = true;
      try {
        await api.post('/setting/print', { teamId: store.teamId, print: { ...print } });
        toast('打印抬头已保存');
      } catch (e) { toast(e.message, 'error'); }
      finally { saving.value = false; }
    }

    async function reset(scope) {
      try {
        const r = await api.post('/setting/reset', { teamId: store.teamId, scope });
        Object.keys(prefix).forEach((k) => delete prefix[k]);
        Object.assign(prefix, r.prefix || {});
        noMode.value = r.noMode || 'day';
        Object.assign(print, r.print || {});
        toast('已恢复默认');
      } catch (e) { toast(e.message, 'error'); }
    }

    /** 预览编号样例 */
    function sample(type) {
      const p = prefix[type] || defaults.value[type] || 'NO';
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const ymd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
      const ym = ymd.slice(0, 6);
      const datePart = noMode.value === 'none' ? '' : noMode.value === 'month' ? ym : ymd;
      return `${p}${datePart}0001`;
    }

    const rows = computed(() => {
      const seen = new Set();
      const out = [];
      for (const t of ORDER) {
        if (seen.has(t) || !defaults.value[t]) continue;
        seen.add(t);
        out.push({ type: t, label: DOC_LABELS[t] || t });
      }
      return out;
    });

    /* ---- 用户与权限 ---- */
    const users = ref([]);
    const userLoading = ref(false);
    const userBusy = ref(false);
    const userDialog = ref(false);
    const userForm = reactive({ username: '', password: '', role: 'clerk' });
    const pwdDialog = ref(false);
    const pwdForm = reactive({ oldPassword: '', newPassword: '', newPassword2: '' });

    async function loadUsers() {
      if (!auth.user) return;
      userLoading.value = true;
      try {
        users.value = await api.get('/auth/users');
      } catch (e) { toast(e.message, 'error'); }
      finally { userLoading.value = false; }
    }

    function openUserDialog() {
      userForm.username = '';
      userForm.password = '';
      userForm.role = 'clerk';
      userDialog.value = true;
    }

    async function saveUser() {
      if (!userForm.username.trim()) { toast('请输入用户名', 'error'); return; }
      if (userForm.password.length < 6) { toast('密码至少 6 位', 'error'); return; }
      userBusy.value = true;
      try {
        await api.post('/auth/users', {
          username: userForm.username.trim(),
          password: userForm.password,
          role: userForm.role,
        });
        toast('已添加用户');
        userDialog.value = false;
        await loadUsers();
      } catch (e) { toast(e.message, 'error'); }
      finally { userBusy.value = false; }
    }

    async function removeUser(row) {
      if (!(await confirmBox(`确定删除用户「${row.name}」？该账号将无法再登录。`, '删除用户'))) return;
      try {
        await api.del(`/auth/users/${row.id}`);
        toast('已删除');
        await loadUsers();
      } catch (e) { toast(e.message, 'error'); }
    }

    function openPwdDialog() {
      pwdForm.oldPassword = '';
      pwdForm.newPassword = '';
      pwdForm.newPassword2 = '';
      pwdDialog.value = true;
    }

    async function savePassword() {
      if (pwdForm.newPassword.length < 6) { toast('新密码至少 6 位', 'error'); return; }
      if (pwdForm.newPassword !== pwdForm.newPassword2) { toast('两次输入的新密码不一致', 'error'); return; }
      userBusy.value = true;
      try {
        await api.post('/auth/password', { oldPassword: pwdForm.oldPassword, newPassword: pwdForm.newPassword });
        toast('密码已修改');
        pwdDialog.value = false;
      } catch (e) { toast(e.message, 'error'); }
      finally { userBusy.value = false; }
    }

    const isAdmin = computed(() => auth.user?.role === 'admin');

    onMounted(load);
    return {
      tab, loading, saving, prefix, noMode, print, defaults, rows, sample,
      savePrefix, saveNoMode, savePrint, reset, store,
      auth, isAdmin, users, userLoading, userBusy, userDialog, userForm,
      pwdDialog, pwdForm, loadUsers, openUserDialog, saveUser, removeUser, openPwdDialog, savePassword,
    };
  },
  template: `
  <div class="page-card">
    <div class="page-head">
      <div class="hd-title">功能设置</div>
      <div class="tabs">
        <span :class="['tab', { active: tab === 'prefix' }]" @click="tab = 'prefix'">单据编号</span>
        <span :class="['tab', { active: tab === 'print' }]" @click="tab = 'print'">打印抬头</span>
        <span :class="['tab', { active: tab === 'user' }]" @click="tab = 'user'; loadUsers()">用户与权限</span>
      </div>
      <div class="hd-right">
        <button class="btn" @click="reset('all')">恢复默认</button>
      </div>
    </div>

    <!-- 单据编号 -->
    <div v-if="tab === 'prefix'" class="card">
      <div class="card-title" style="margin-bottom:10px">单据编号规则</div>
      <div class="filterbar" style="border:none;padding:0 0 8px">
        <span class="muted" style="font-size:12.5px">流水号重置：</span>
        <el-select v-model="noMode" style="width:150px" @change="saveNoMode">
          <el-option value="day" label="按日重置"/>
          <el-option value="month" label="按月重置"/>
          <el-option value="none" label="永不清零"/>
        </el-select>
        <span class="muted" style="font-size:12px">例：{{ sample('stockout') }}</span>
      </div>

      <table class="tbl">
        <thead><tr><th>单据类型</th><th style="width:160px">前缀</th><th style="width:160px">默认</th><th>编号样例</th></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.type">
            <td>{{ r.label }}</td>
            <td><input class="finp" v-model="prefix[r.type]" maxlength="4" style="width:100%;text-transform:uppercase" :placeholder="defaults[r.type]"/></td>
            <td class="muted">{{ defaults[r.type] }}</td>
            <td class="muted" style="font-family:Consolas,monospace">{{ sample(r.type) }}</td>
          </tr>
          <tr v-if="!rows.length"><td colspan="4"><div class="empty">加载中…</div></td></tr>
        </tbody>
      </table>
      <div class="de-add" style="margin-top:12px">
        <span class="muted" style="font-size:12.5px">前缀支持 1-4 位字母或数字；留空则用默认值。</span>
        <span class="fb-gap"></span>
        <button class="btn primary" :disabled="saving" @click="savePrefix">{{ saving ? '保存中…' : '保存编号规则' }}</button>
      </div>
    </div>

    <!-- 打印抬头 -->
    <div v-else-if="tab === 'print'" class="card">
      <div class="card-title" style="margin-bottom:10px">打印抬头（显示在单据打印页顶部）</div>
      <div class="de-grid">
        <div class="fi"><label>公司名称</label><div class="fc"><input v-model="print.company" placeholder="如：深圳市橙子商贸有限公司" maxlength="60"/></div></div>
        <div class="fi"><label>联系电话</label><div class="fc"><input v-model="print.phone" placeholder="如：0755-12345678" maxlength="40"/></div></div>
        <div class="fi span-all"><label>公司地址</label><div class="fc"><input v-model="print.address" placeholder="如：深圳市南山区科技园" maxlength="120"/></div></div>
        <div class="fi span-all"><label>页脚备注</label><div class="fc"><input v-model="print.footer" placeholder="如：本单为业务往来凭证，如有疑问请及时联系。" maxlength="200"/></div></div>
        <div class="fi"><label>显示 Logo</label><div class="fc"><el-switch v-model="print.showLogo"/></div></div>
      </div>
      <div class="de-add" style="margin-top:12px">
        <span class="muted" style="font-size:12.5px">打印页会读取这些信息；未填写则不显示。</span>
        <span class="fb-gap"></span>
        <button class="btn primary" :disabled="saving" @click="savePrint">{{ saving ? '保存中…' : '保存打印抬头' }}</button>
      </div>

      <!-- 打印预览 -->
      <div class="card-title" style="margin:20px 0 10px">效果预览</div>
      <div style="border:1px solid var(--border);border-radius:6px;padding:20px;background:#fff;max-width:720px">
        <div style="display:flex;align-items:center;gap:10px;border-bottom:1px solid #e8eaed;padding-bottom:10px;margin-bottom:10px">
          <span v-if="print.showLogo" style="width:34px;height:34px;border-radius:50%;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700">橙</span>
          <div>
            <div style="font-size:15px;font-weight:600">{{ print.company || '（未填写公司名称）' }}</div>
            <div class="muted" style="font-size:12px">{{ print.address || '（未填写地址）' }}<template v-if="print.phone"> · {{ print.phone }}</template></div>
          </div>
        </div>
        <div style="text-align:center;font-size:16px;font-weight:600;margin:10px 0 4px">销售出库单</div>
        <div style="text-align:center;color:#98a2ad;font-size:12px;margin-bottom:12px">单号：{{ sample('stockout') }} 　日期：2026-10-17</div>
        <table class="tbl" style="border:1px solid #e8eaed">
          <thead><tr><th>商品</th><th class="r">数量</th><th class="r">单价</th><th class="r">金额</th></tr></thead>
          <tbody>
            <tr><td>示例商品</td><td class="r">10</td><td class="r">¥80.00</td><td class="r">¥800.00</td></tr>
          </tbody>
        </table>
        <div class="muted" style="font-size:12px;margin-top:10px;text-align:center">{{ print.footer || '（未填写页脚）' }}</div>
      </div>
    </div>

    <!-- 用户与权限 -->
    <div v-else class="card">
      <div class="card-title" style="margin-bottom:4px">团队用户</div>
      <div class="muted" style="font-size:12.5px;margin-bottom:12px">
        当前账套「{{ auth.team ? auth.team.name : '—' }}」的成员。管理员可添加/删除用户；员工只能使用业务功能，不能管理用户。
      </div>
      <table class="tbl">
        <thead><tr><th style="width:70px">ID</th><th>用户名</th><th style="width:110px">角色</th><th style="width:180px">创建时间</th><th style="width:120px">操作</th></tr></thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td class="muted">{{ u.id }}</td>
            <td>{{ u.name }}<span v-if="auth.user && u.id === auth.user.userId" class="muted" style="margin-left:6px">（我）</span></td>
            <td>
              <span class="role-tag" :class="u.role === 'admin' ? 'admin' : 'clerk'">{{ u.role === 'admin' ? '管理员' : '员工' }}</span>
            </td>
            <td class="muted">{{ (u.createdAt || '').replace('T', ' ').slice(0, 19) || '—' }}</td>
            <td>
              <button class="btn sm danger" v-if="isAdmin && auth.user && u.id !== auth.user.userId" @click="removeUser(u)">删除</button>
              <span v-else class="muted" style="font-size:12px">—</span>
            </td>
          </tr>
          <tr v-if="userLoading"><td colspan="5"><div class="empty">加载中…</div></td></tr>
          <tr v-else-if="!users.length"><td colspan="5"><div class="empty">暂无用户</div></td></tr>
        </tbody>
      </table>
      <div class="de-add" style="margin-top:12px">
        <template v-if="isAdmin">
          <button class="btn primary" @click="openUserDialog">+ 添加用户</button>
          <button class="btn" @click="openPwdDialog">修改我的密码</button>
        </template>
        <span v-else class="muted" style="font-size:12.5px">仅管理员可管理用户</span>
      </div>
    </div>

    <!-- 添加用户弹窗 -->
    <el-dialog v-model="userDialog" title="添加用户" width="420px" append-to-body>
      <div class="de-grid" style="grid-template-columns:1fr">
        <div class="fi"><label>用户名</label><div class="fc"><input v-model="userForm.username" placeholder="至少 2 个字符" maxlength="30" autocomplete="off"/></div></div>
        <div class="fi"><label>初始密码</label><div class="fc"><input v-model="userForm.password" type="password" placeholder="至少 6 位" maxlength="40" autocomplete="new-password"/></div></div>
        <div class="fi"><label>角色</label><div class="fc">
          <el-select v-model="userForm.role" style="width:100%">
            <el-option value="clerk" label="员工（仅业务操作）"/>
            <el-option value="admin" label="管理员（含用户管理）"/>
          </el-select>
        </div></div>
      </div>
      <template #footer>
        <button class="btn" @click="userDialog = false">取消</button>
        <button class="btn primary" :disabled="userBusy" @click="saveUser">{{ userBusy ? '保存中…' : '确定添加' }}</button>
      </template>
    </el-dialog>

    <!-- 修改密码弹窗 -->
    <el-dialog v-model="pwdDialog" title="修改我的密码" width="420px" append-to-body>
      <div class="de-grid" style="grid-template-columns:1fr">
        <div class="fi"><label>原密码</label><div class="fc"><input v-model="pwdForm.oldPassword" type="password" maxlength="40"/></div></div>
        <div class="fi"><label>新密码</label><div class="fc"><input v-model="pwdForm.newPassword" type="password" placeholder="至少 6 位" maxlength="40"/></div></div>
        <div class="fi"><label>确认新密码</label><div class="fc"><input v-model="pwdForm.newPassword2" type="password" maxlength="40"/></div></div>
      </div>
      <template #footer>
        <button class="btn" @click="pwdDialog = false">取消</button>
        <button class="btn primary" :disabled="userBusy" @click="savePassword">{{ userBusy ? '保存中…' : '确定修改' }}</button>
      </template>
    </el-dialog>
  </div>`,
};


/* 待审核工作台：集中处理所有待审核单据——由 inject-approval.js 注入 app.js */
const ApprovalPage = {
  components: { DocViewer },
  setup() {
    const list = ref([]);
    const allRows = ref([]);
    const byType = ref([]);
    const filterType = ref('');
    const loading = ref(false);
    const busyId = ref(null);
    const viewerId = ref(null);

    const TYPE_LABEL = {
      stockin: '采购入库', stockout: '销售出库', transfer: '转仓调拨', adjust: '库存调整', stocktake: '库存盘点',
      porder: '采购订单', sorder: '销售订单', pin: '采购退货', sret: '销售退货',
      otherin: '其它入库', otherout: '其它出库', assembly: '生产组装', stockinit: '期初库存', quo: '报价单',
      outapply: '出库申请单', prodtask: '生产任务',
    };
    const TYPE_COLOR = {
      stockin: '#52a552', stockout: '#f26f21', transfer: '#5b8ff9', adjust: '#e6a23c',
      stocktake: '#8fd16a', porder: '#9b8afb', sorder: '#f56c6c', pin: '#6dc8ec',
      sret: '#5ad8a6', otherin: '#4dabf7', otherout: '#ffa94d', assembly: '#cc5de8',
      stockinit: '#20c997', quo: '#868e96', outapply: '#f783ac', prodtask: '#e8b339',
    };

    /** 当前筛选下要显示的行：不筛选 = 全部待审；按类型 = 该类型 */
    const shown = computed(() => (filterType.value ? allRows.value.filter((d) => d.type === filterType.value) : allRows.value));

    async function load() {
      loading.value = true;
      try {
        const r = await api.get('/doc/pending', { teamId: store.teamId });
        const rows = r.rows || [];
        // 按类型分组（页签用）
        const map = new Map();
        for (const d of rows) {
          if (!map.has(d.type)) map.set(d.type, []);
          map.get(d.type).push(d);
        }
        byType.value = [...map.entries()].map(([type, rs]) => ({
          type, label: TYPE_LABEL[type] || type, count: rs.length,
          amount: rs.reduce((s, x) => s + (x.totalAmount || 0), 0),
        })).sort((a, b) => b.count - a.count);
        allRows.value = rows;
        list.value = byType.value;
      } catch (e) { toast(e.message, 'error'); }
      finally { loading.value = false; }
    }

    async function doAudit(row) {
      if (busyId.value) return;
      if (!(await confirmBox(`审核「${row.billNo}」将过账写入库存与往来余额，确认？`))) return;
      busyId.value = row.id;
      try { await api.post('/doc/audit', { teamId: store.teamId, id: row.id, auditBy: store.team?.name || '管理员' }); toast('已审核'); load(); }
      catch (e) { toast(e.message, 'error'); }
      finally { busyId.value = null; }
    }

    async function doReject(row) {
      if (busyId.value) return;
      let reason = '';
      try {
        const r = await ElMessageBox.prompt('请输入驳回原因', `驳回 ${row.billNo}`, {
          confirmButtonText: '确认驳回', cancelButtonText: '取消',
          inputPlaceholder: '如：价格录错，请核对后重新提交', inputValue: '',
        });
        reason = (r.value || '').trim();
      } catch { return; }
      busyId.value = row.id;
      try { await api.post('/doc/reject', { teamId: store.teamId, id: row.id, reason }); toast('已驳回'); load(); }
      catch (e) { toast(e.message, 'error'); }
      finally { busyId.value = null; }
    }

    /** 一键审核当前筛选下的全部 */
    async function auditAll() {
      const rows = shown.value;
      if (!rows.length) return toast('没有待审核单据', 'warning');
      if (!(await confirmBox(`将审核 ${rows.length} 张单据，审核后不可撤销（可作废），确认？`))) return;
      let okCount = 0, errs = [];
      for (const r of rows) {
        try { await api.post('/doc/audit', { teamId: store.teamId, id: r.id, auditBy: store.team?.name || '管理员' }); okCount++; }
        catch (e) { errs.push(`${r.billNo}: ${e.message}`); }
      }
      toast(`审核成功 ${okCount} 张${errs.length ? `，失败 ${errs.length} 张` : ''}`, errs.length ? 'warning' : 'success');
      if (errs.length) console.warn('审核失败明细', errs);
      load();
    }

    onMounted(load);
    return { list, allRows, byType, filterType, shown, loading, busyId, viewerId, load, doAudit, doReject, auditAll, TYPE_LABEL, TYPE_COLOR, store, fmtMoney, partnerLabel, whLabel, STATUS_TEXT };
  },
  template: `
  <div class="page-card">
    <div class="page-head">
      <div class="hd-title">待审核</div>
      <div class="tabs">
        <span :class="['tb', { on: !filterType }]" @click="filterType = ''">全部 ({{ list.reduce((s,x)=>s+x.count,0) }})</span>
        <span v-for="g in byType" :key="g.type" :class="['tb', { on: filterType === g.type }]" @click="filterType = g.type">
          {{ g.label }} ({{ g.count }})
        </span>
      </div>
      <div class="hd-right">
        <button class="btn" @click="load">刷新</button>
        <button class="btn primary" :disabled="loading || !shown.length" @click="auditAll"><el-icon><Select/></el-icon> 一键审核{{ filterType ? '本类' : '全部' }}</button>
      </div>
    </div>

    <div v-if="!shown.length" class="empty" style="padding:60px 0">
      <el-icon style="font-size:38px;color:#d0d5dc"><CircleCheck/></el-icon>
      <div style="margin-top:10px">暂无待审核单据</div>
      <div class="muted" style="font-size:12.5px;margin-top:4px">业务员在单据列表点「提交」后会出现在这里</div>
    </div>

    <div v-else class="tbl-wrap">
      <table class="tbl">
        <thead><tr>
          <th style="width:130px">单据类型</th><th>单号</th><th>提交时间</th>
          <th>往来单位</th><th>商品摘要</th><th class="r">金额</th><th style="width:230px">操作</th>
        </tr></thead>
        <tbody>
          <tr v-for="d in shown" :key="d.id">
            <td><span class="tag" :style="{ background: (TYPE_COLOR[d.type]||'#909399') + '1a', color: TYPE_COLOR[d.type]||'#909399' }">{{ TYPE_LABEL[d.type] || d.type }}</span></td>
            <td><span class="billno link" @click="viewerId = d.id">{{ d.billNo }}</span></td>
            <td class="muted">{{ d.submitAt || d.date }}</td>
            <td>{{ partnerLabel(d) || '—' }}</td>
            <td class="muted ellip" :title="d.summary || ''">{{ d.summary || '—' }}</td>
            <td class="r money" nowrap>{{ fmtMoney(d.totalAmount) }}</td>
            <td>
              <div class="row-actions">
                <button class="btn sm primary" :disabled="busyId === d.id" @click="doAudit(d)">{{ busyId === d.id ? '…' : '审核' }}</button>
                <button class="btn sm" :disabled="busyId === d.id" @click="doReject(d)">驳回</button>
                <button class="btn sm" @click="viewerId = d.id">查看</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <doc-viewer :doc-id="viewerId" @close="viewerId = null"/>
  </div>`,
};


/* ================= 登录 / 注册 ================= */
const BRAND_SVG = `<svg viewBox="0 0 32 32" fill="none"><path d="M16 4c-1.2 0-2.2.6-3 1.6-.7-.5-1.6-.8-2.5-.8-2.4 0-4.3 1.9-4.3 4.3 0 .5.1 1 .3 1.5C5 11.6 4 13.2 4 15c0 1.6.8 3 2 3.9-.3.6-.5 1.3-.5 2 0 2.4 1.9 4.3 4.3 4.3.6 0 1.2-.1 1.7-.4.7 1.2 2 2 3.5 2s2.8-.8 3.5-2c.5.3 1.1.4 1.7.4 2.4 0 4.3-1.9 4.3-4.3 0-.7-.2-1.4-.5-2 1.2-.9 2-2.3 2-3.9 0-1.8-1-3.4-2.5-4.4.2-.5.3-1 .3-1.5 0-2.4-1.9-4.3-4.3-4.3-.9 0-1.8.3-2.5.8C18.2 4.6 17.2 4 16 4z" fill="#f26f21"/><path d="M11.5 13.5c0 1.4 1.1 2.5 2.5 2.5s2.5-1.1 2.5-2.5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>`;

const LoginPage = {
  setup() {
    const mode = ref('login'); // login | register
    const form = reactive({ username: '', password: '', password2: '', teamName: '' });
    const err = ref('');
    const busy = ref(false);
    const firstRun = ref(false); // 系统尚未初始化 → 默认注册并填账套名

    onMounted(async () => {
      try {
        const s = await api.get('/auth/status');
        if (!s.initialized) { mode.value = 'register'; firstRun.value = true; }
      } catch { /* 探测失败就按登录处理 */ }
    });

    function switchMode() {
      err.value = '';
      mode.value = mode.value === 'login' ? 'register' : 'login';
    }

    async function submit() {
      err.value = '';
      if (!form.username.trim()) { err.value = '请输入用户名'; return; }
      if (!form.password) { err.value = '请输入密码'; return; }
      if (mode.value === 'register') {
        if (form.password.length < 6) { err.value = '密码至少 6 位'; return; }
        if (form.password !== form.password2) { err.value = '两次输入的密码不一致'; return; }
      }
      busy.value = true;
      try {
        const path = mode.value === 'login' ? '/auth/login' : '/auth/register';
        const body = mode.value === 'login'
          ? { username: form.username.trim(), password: form.password }
          : { username: form.username.trim(), password: form.password, teamName: form.teamName.trim() || '我的账套' };
        const r = await api.post(path, body);
        setToken(r.token);
        auth.user = r.user;
        auth.team = r.team || { id: r.teamId, name: r.teamName };
        toast(mode.value === 'login' ? '登录成功' : '账套创建成功');
        location.hash = '#/dashboard';
      } catch (e) {
        err.value = e.message;
      } finally {
        busy.value = false;
      }
    }

    return { mode, form, err, busy, firstRun, submit, switchMode, BRAND_SVG };
  },
  template: `
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-brand">
        <span v-html="BRAND_SVG"></span>
        <span class="t">橙子进销存</span>
      </div>
      <p class="login-sub">{{ mode === 'login' ? '登录你的账套，开始今天的经营' : (firstRun ? '首次使用，请创建管理员账号与账套' : '新建管理员账号') }}</p>
      <el-form @submit.prevent="submit" label-position="top">
        <el-form-item label="用户名">
          <el-input v-model="form.username" size="large" placeholder="请输入用户名" autocomplete="username" clearable/>
        </el-form-item>
        <el-form-item v-if="mode === 'register'" label="账套名称">
          <el-input v-model="form.teamName" size="large" placeholder="如：鲜果批发部" maxlength="30" clearable/>
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" size="large" placeholder="至少 6 位" show-password autocomplete="current-password" @keyup.enter="submit"/>
        </el-form-item>
        <el-form-item v-if="mode === 'register'" label="确认密码">
          <el-input v-model="form.password2" type="password" size="large" placeholder="再次输入密码" show-password autocomplete="new-password" @keyup.enter="submit"/>
        </el-form-item>
        <div class="login-err">{{ err }}</div>
        <el-button type="primary" class="login-btn" :loading="busy" @click="submit">
          {{ mode === 'login' ? '登 录' : '创建账套' }}
        </el-button>
      </el-form>
      <div class="login-foot">
        <template v-if="mode === 'login'">还没有账号？<a @click="switchMode">创建账套</a></template>
        <template v-else>已有账号？<a @click="switchMode">返回登录</a></template>
      </div>
    </div>
  </div>`,
};

const PAGES = {
  approval: ApprovalPage,
  settings: SettingsPage,
  dashboard: DashboardPage,
  product: ProductPage,
  partner: PartnerPage,
  base: BasePage,
  stock: StockPage,
  ledger: LedgerPage,
  finance: FinancePage,
  help: HelpPage,
  report: ReportPage,
  aging: AgingPage,
  price: PricePage,
  jxcstat: JxcStatPage,
  forecast: ForecastPage,
  statement: StatementPage,
  doc: DocPage,
};

const App = {
  setup() {
    const ready = ref(false);
    const booting = ref(true);
    const switchTo = ref(null);
    const openMenu = ref(-1);

    async function boot() {
      if (!auth.token) {
        auth.ready = true;
        booting.value = false;
        ready.value = false;
        if (location.hash !== '#/login') location.hash = '#/login';
        return;
      }
      try {
        const me = await api.get('/auth/me');
        auth.user = me.user;
        auth.team = me.team;
        await ensureTeam();
        switchTo.value = store.teamId;
        ready.value = true;
      } catch (e) {
        // 令牌失效已在 req 中清理并跳登录
        if (auth.token) toast('登录状态校验失败：' + e.message, 'error');
        ready.value = false;
      } finally {
        auth.ready = true;
        booting.value = false;
      }
    }

    onMounted(boot);

    // 登录页登录成功后触发重新引导
    watch(() => auth.token, (t, old) => {
      if (t && !old) { ready.value = false; boot(); }
    });

    /* 当前页面标识（含 query 里的 type） */
    const curKey = computed(() => {
      const keys = Object.keys(route.q).sort();
      const qs = keys.length ? '?' + keys.map((k) => k + '=' + route.q[k]).join('&') : '';
      return route.page + (route.sub ? '/' + route.sub : '') + qs;
    });

    const pageComp = computed(() => PAGES[route.page] || DashboardPage);
    const pageTitle = computed(() => {
      for (const g of MENU) {
        if (g.items) {
          for (const m of g.items) if (m.page === curKey.value) return m.label;
        }
      }
      return '工作台';
    });
    const pageKey = computed(() => `${store.teamId}:${route.page}:${route.sub}:${JSON.stringify(route.q)}`);

    function go(menuPage) {
      openMenu.value = -1;
      nav('#/' + menuPage);
    }
    function onNavClick(i, g) {
      if (g.page && !g.items) { nav('#/' + g.page); openMenu.value = -1; return; }
      openMenu.value = openMenu.value === i ? -1 : i;
    }
    function onDocClick(e) {
      if (!e.target.closest('.nav-item')) openMenu.value = -1;
    }
    onMounted(() => document.addEventListener('click', onDocClick));
    onBeforeUnmount(() => document.removeEventListener('click', onDocClick));

    async function onSwitchTeam(id) {
      if (!id || id === store.teamId) return;
      await pickTeam(id);
      toast('已切换团队');
    }

    async function onLogout() {
      if (!(await confirmBox('确定退出登录？', '退出'))) return;
      logout();
      toast('已退出登录');
    }

    return { ready, booting, switchTo, store, route, pageComp, pageTitle, pageKey, curKey, onSwitchTeam, MENU, nav, go, openMenu, onNavClick, auth, onLogout, BRAND_SVG };
  },
  template: `
  <login-page v-if="auth.ready && !auth.token"/>
  <div class="shell" v-else-if="auth.token">
    <header class="topnav">
      <div class="brand" @click="nav('#/dashboard')">
        <span class="brand-mark" v-html="BRAND_SVG"></span>
        <span class="brand-txt">橙子进销存</span>
      </div>
      <div class="nav-item" v-for="(g, i) in MENU" :key="g.label">
        <div class="nav-link" :class="{ on: curKey.startsWith(g.page || '__none') || (g.items && g.items.some(m => m.page === curKey)) }" @click.stop="onNavClick(i, g)">
          {{ g.label }}<span class="caret" v-if="g.items">▾</span>
        </div>
        <div class="nav-menu" v-if="g.items && openMenu === i">
          <div class="mi" v-for="m in g.items" :key="m.label + m.page" :class="{ cur: m.page === curKey }" @click.stop="go(m.page)">{{ m.label }}</div>
        </div>
      </div>
      <div class="nav-right">
        <span class="nav-icon" title="使用帮助" @click="nav('#/help')"><el-icon><QuestionFilled/></el-icon></span>
        <el-select v-if="store.teams.length > 1" v-model="switchTo" size="small" style="width:150px;margin-left:6px" @change="onSwitchTeam">
          <el-option v-for="t in store.teams" :key="t.id" :label="t.name" :value="t.id"/>
        </el-select>
        <span class="nav-user" v-if="auth.user">
          <span class="nm">{{ auth.user.name }}</span>
          <span class="role" v-if="auth.user.role === 'admin'">管理员</span>
          <span class="role" v-else>员工</span>
        </span>
        <span class="nav-logout" title="退出登录" @click="onLogout"><el-icon><SwitchButton/></el-icon></span>
      </div>
    </header>
    <div class="tipbar">
      {{ auth.team ? auth.team.name : '当前账套' }} · 数据保存在本地 SQLite，账套之间完全隔离
    </div>
    <div class="body">
      <div class="content">
        <div v-if="!ready" style="padding:80px;text-align:center" class="muted">加载中…</div>
        <component v-else :is="pageComp" :key="pageKey" :group="route.sub"/>
      </div>
    </div>
  </div>
  <div v-else class="login-wrap"><div class="muted" style="color:#fff">正在进入…</div></div>`,
};

/* ================= 挂载 ================= */
const app = createApp(App);
app.use(ElementPlus, { locale: ElementPlusLocaleZhCn });
for (const [name, comp] of Object.entries(ElementPlusIconsVue)) app.component(name, comp);
app.component('doc-viewer', DocViewer);
app.component('login-page', LoginPage);
app.mount('#app');
