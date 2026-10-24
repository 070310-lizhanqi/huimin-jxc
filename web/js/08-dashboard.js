'use strict';
/* web/js/08-dashboard.js —— 由 app.js 拆分（lines 368-938） */
/* ================= 工作台（对齐惠民云 6 格图表墙） ================= */
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
     * 三张独立排行卡（对齐真实惠民云工作台）：
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
      // 收款排行只有「客户」维度：收款单无业务员，后端 receipt 维度强制按客户聚合
      { k: 'receipt', label: '销售收款排行', dims: [{ k: 'cus', label: '客户' }], more: '#/finance', emptyText: '本月还没有收款记录' },
    ];
    const rankRange = ref('month');
    const rankData = reactive({ order: [], out: [], receipt: [] });
    const rankBy = reactive({ order: 'cus', out: 'cus', receipt: 'cus' });
    const rankRefs = reactive({});
    /** 常用功能快捷入口（对齐惠民云工作台，可在页面上增删，存 localStorage） */
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
    // 快捷入口存储 key 按 teamId 动态生成：原先在 setup 时取 store.teamId 还是 null，
    // 固化成 "orange.quick.null"，换账套后读到别的账号的快捷配置。
    // 改 computed 让 key 随 teamId 变化自动重算。
    const QUICK_KEY = computed(() => 'orange.quick.' + (store.teamId ?? 'anon'));
    const quickEdit = ref(false);

    function loadQuick() {
      try {
        const raw = localStorage.getItem(QUICK_KEY.value);
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
    // teamId 变化（换账套）时重新加载该账号的快捷配置
    watch(() => store.teamId, () => { QUICK.value = loadQuick(); });

    function persistQuick() {
      try { localStorage.setItem(QUICK_KEY.value, JSON.stringify(QUICK.value.map((x) => x.label))); } catch (e) { /* 存储满时忽略 */ }
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

    /** 四项 KPI（对齐惠民云「新增销售数据」） */
    const kpis = computed(() => {
      const s = sales.value;
      if (!s) return [];
      return [
        { label: '订单', num: Number(s.orderCount ?? 0), decimals: 0, unit: '张', sub: fmtMoney(s.orderAmount) + ' 元' },
        { label: '出库', num: Number(s.outCount ?? 0), decimals: 0, unit: '张', sub: fmtMoney(s.outAmount) + ' 元' },
        { label: '收款', num: Number(s.receiptCount ?? 0), decimals: 0, unit: '笔', sub: fmtMoney(s.receiptAmount) + ' 元' },
        // 毛利是金额不是张数：加 ¥ 前缀并降一号字，避免和上面三个计数挤在同一视觉层级
        { label: '毛利', num: Number(s.grossProfit || 0) / 100, decimals: 2, unit: '', prefix: '¥', sub: '净销售额 − 成本', money: true },
      ];
    });

    const lowStockItems = computed(() => (stats.value?.lowStockItems ?? []).map((r) => ({
      ...r,
      prodName: byId(store.products, r.productId)?.name || `#${r.productId}`,
    })));
    /** 新手引导：空账套显示；「不再显示」按账套记忆（换账套/新建账套会重新出现） */
    const guideDoneKey = computed(() => 'oc.guide.done.' + (store.teamId ?? ''));
    const guideHidden = ref(false);
    try { guideHidden.value = Boolean(localStorage.getItem('oc.guide.done.' + (store.teamId ?? ''))); } catch { /* ignore */ }
    function dismissGuide() {
      guideHidden.value = true;
      try { localStorage.setItem(guideDoneKey.value, '1'); } catch { /* ignore */ }
    }
    const showGuide = computed(() => !guideHidden.value && !store.products.length && stats.value
      && Number(stats.value.draftCount ?? 0) === 0 && Number(stats.value.totalQty ?? 0) === 0);

    /** 环形图公共配置（色板/标签与 22-aging 共享 AGING_* 常量） */
    const BUCKET_LABELS = AGING_LABELS;
    /* 图表统一用色（品牌橙系单色渐变）：账龄由深到浅表达「越老越严重」的递进，
       超 720 天一档用警示红；替代此前 AntV 默认蓝绿混搭（与品牌橙零关联） */
    const C = { brand: '#f26f21', brandSoft: '#ff8a3d', brandLight: '#ffc08a', grayAxis: '#8a919c', grayText: '#5c6670', neg: '#e85656', outBar: '#b8c2cc' };
    const BUCKET_COLORS = AGING_COLORS;
    const BUCKET_KEYS = AGING_KEYS;
    /* 深色 tooltip：三处图表共用一套观感（此前趋势图是 ECharts 默认白底） */
    const CHART_TOOLTIP = {
      backgroundColor: 'rgba(45,55,68,.94)', borderWidth: 0,
      textStyle: { color: '#fff', fontSize: 12 }, padding: [7, 11],
    };

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
          ...CHART_TOOLTIP,
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
      c.setOption({
        grid: { left: 104, right: 52, top: 8, bottom: 8 },
        tooltip: {
          trigger: 'axis', axisPointer: { type: 'shadow' },
          ...CHART_TOOLTIP,
          formatter: (p) => `${p[0].name}\n${fmtMoney(p[0].value)} ${unit}`,
        },
        xAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: '#f2f3f5' } },
          axisLabel: { color: '#9aa3ad', fontSize: 11, formatter: (v) => (v === 0 ? '0' : fmtMoney(v)) },
          axisLine: { show: false }, axisTick: { show: false },
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
              color: r.amount < 0 ? C.neg : C.brand,
              borderRadius: r.amount < 0 ? [3, 0, 0, 3] : [0, 3, 3, 0],
            },
          })),
          label: {
            show: true, position: 'right', fontSize: 11,
            color: (p) => (p.value < 0 ? C.neg : C.grayAxis),
            formatter: (p) => fmtMoney(p.value),
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
      // 重复调用前先 dispose 旧实例：每次 reloadAll 重新 init 会累积 echarts 实例，
      // 长会话内存持续上涨。getInstanceByDom 是官方查重接口。
      const existing = echarts.getInstanceByDom(trendEl.value);
      if (existing) existing.dispose();
      const c = echarts.init(trendEl.value);
      c.setOption({
        grid: { left: 44, right: 12, top: 34, bottom: 26 },
        tooltip: { trigger: 'axis', ...CHART_TOOLTIP, valueFormatter: (v) => String(v) },
        legend: { data: ['入库', '出库'], right: 0, top: 0, itemWidth: 12, textStyle: { color: C.grayText } },
        xAxis: { type: 'category', data: days, axisLine: { lineStyle: { color: '#e8eaed' } }, axisLabel: { color: C.grayAxis } },
        yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f0f1f3' } }, axisLabel: { color: C.grayAxis } },
        series: [
          { name: '入库', type: 'bar', data: inData, itemStyle: { color: C.brand, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 16 },
          { name: '出库', type: 'bar', data: outData, itemStyle: { color: C.outBar, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 16 },
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
        // dispose 后从 charts 数组移除旧实例：onResize 对已 disposed 实例 resize() 会报警告
        const inst = echarts.getInstanceByDom(el);
        if (inst) {
          const i = charts.indexOf(inst);
          if (i >= 0) charts.splice(i, 1);
          inst.dispose();
        }
        barRank(el, rows, '元');
      }
    }
    async function loadAllRanks() {
      await Promise.all(['order', 'out', 'receipt'].map((k) => loadRank(k)));
    }

    /* 请求序守卫：快速切「今日/本月/本年」时，慢响应不得覆盖新选择 */
    let loadSeq = 0;

    /** 销售概要（订单/出库/收款/毛利 KPI）：range 变化只影响它和排行卡 */
    async function loadSales() {
      // 自取序号而非依赖调用方传参：模板 @click 直接调 loadSales() 时
      // 不传参会绕过 mySeq!==loadSeq 守卫，慢的旧响应照样覆盖新区间
      const mySeq = ++loadSeq;
      const s = await api.get('/stats/sales-summary', { teamId: store.teamId, range: range.value });
      if (mySeq !== loadSeq) return;
      sales.value = s;
    }

    /** 仪表盘统计卡：与 range 无关，手动刷新时才重新拉 */
    async function loadDash() {
      stats.value = await api.get('/stats/dashboard', { teamId: store.teamId });
    }

    async function reloadAll() {
      const mySeq = ++loadSeq;
      try {
        await Promise.all([loadDash(), loadSales()]);
        await loadAllRanks();
      } catch (e) {
        if (mySeq === loadSeq) toast('工作台数据加载失败：' + e.message, 'error');
      }
    }

    function onResize() { for (const c of charts) c.resize(); }

    /* 自动刷新：前台收银场景页面常开，每 5 分钟静默刷新一次（页面隐藏时跳过） */
    let refreshTimer = 0;
    /* 卸载标志：onMounted 是长 async，首屏请求未返回前用户可能已切走页面——
       卸载钩子先执行（当时无可清理），await 恢复后若继续注册监听/interval，
       就变成对已卸载组件每 5 分钟发一轮请求的泄漏。每个 await 后都要检查 */
    let disposed = false;

    onMounted(async () => {
      // 7 个首屏请求各自独立：一个接口失败只影响它对应区块，不再整体空白
      const settled = await Promise.allSettled([
        api.get('/stats/dashboard', { teamId: store.teamId }),
        api.get('/stats/sales-summary', { teamId: store.teamId, range: range.value }),
        api.get('/stats/trend', { teamId: store.teamId }),
        api.get('/doc/list', { teamId: store.teamId, page: 1, rows: 8 }),
        api.get('/report/aging', { teamId: store.teamId, mode: 'ar' }),
        api.get('/report/aging', { teamId: store.teamId, mode: 'ap' }),
        api.get('/report/stock-aging', { teamId: store.teamId }),
      ]);
      if (disposed) return;
      const [s, sum, t, d, ar, ap, sa] = settled.map((r) => (r.status === 'fulfilled' ? r.value : null));
      const failed = settled.filter((r) => r.status === 'rejected').length;
      if (failed) toast(`工作台有 ${failed} 个数据区块加载失败，可点右上角刷新重试`, 'warning');
      stats.value = s; sales.value = sum; trend.value = t; recent.value = d;
      arAging.value = ar; apAging.value = ap; stockAging.value = sa;
      const tops = await Promise.allSettled([
        api.get('/report/aging/top', { teamId: store.teamId, mode: 'ar', limit: 5 }),
        api.get('/report/aging/top', { teamId: store.teamId, mode: 'ap', limit: 5 }),
      ]);
      if (disposed) return;
      arTop.value = tops[0].status === 'fulfilled' ? (tops[0].value.rows || []) : [];
      apTop.value = tops[1].status === 'fulfilled' ? (tops[1].value.rows || []) : [];
      await nextTick();
      if (disposed) return;
      // 渲染只对成功取到数据的区块进行；失败区块保持骨架/空态
      if (t) renderTrend();
      if (ar) donut(arEl.value, ar.totals, '元', '应收未结');
      if (ap) donut(apEl.value, ap.totals, '元', '应付未结');
      if (sa) donut(stockEl.value, sa.totals, '元', '库存货值');
      if (arTop.value.length) barRank(arTopEl.value, arTop.value.map((r) => ({ name: r.partnerName, amount: r.total })), '元');
      if (apTop.value.length) barRank(apTopEl.value, apTop.value.map((r) => ({ name: r.partnerName, amount: r.total })), '元');
      await loadAllRanks();
      if (disposed) return;
      window.addEventListener('resize', onResize);
      refreshTimer = setInterval(() => { if (!document.hidden) reloadAll(); }, 5 * 60 * 1000);
    });
    onBeforeUnmount(() => {
      disposed = true;
      window.removeEventListener('resize', onResize);
      if (refreshTimer) clearInterval(refreshTimer);
      for (const c of charts) c.dispose();
      charts.length = 0;
    });

    return {
      stats, sales, range, trend, recent, viewerId, kpis, lowStockItems, showGuide, dismissGuide,
      goPurchase: () => nav('#/doc/purchase?type=stockin&new=1'),
      arAging, apAging, stockAging, arTop, apTop,
      trendEl, arEl, apEl, stockEl, arTopEl, apTopEl,
      RANK_CARDS, rankData, rankRange, rankBy, rankRefs, loadAllRanks, loadRank,
      QUICK, quickEdit, removeQuick, restoreQuick, resetQuick,
      BUCKET_LABELS, BUCKET_COLORS, BUCKET_KEYS, hasAging,
      reloadAll, loadSales, loadDash, store,
      fmtMoney, prodLabel, partnerLabel, STATUS_TEXT, DOC_META, nav, whLabel,
    };
  },
  template: `
  <div>
    <!-- 团队标题条（对齐惠民云：白卡左上角团队名） -->
    <div class="team-bar">
      <span class="team-name">{{ store.team?.name || '当前账套' }}</span>
      <span class="team-sub">欢迎回来，祝您生意兴隆</span>
    </div>

    <!-- 常用功能（对齐惠民云工作台：右侧 添加/移除） -->
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
    <div v-if="showGuide" class="card" style="margin-bottom:14px;padding:18px 20px;border-left:4px solid var(--brand);position:relative">
      <span class="x" title="不再显示" style="position:absolute;top:10px;right:14px;cursor:pointer;color:var(--muted);font-size:16px" @click="dismissGuide">×</span>
      <div style="font-weight:600;font-size:15px;margin-bottom:8px">欢迎使用惠民云进销存 —— 3 步开账</div>
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
               :class="['ct-op', { on: range === r.k }]" @click="range = r.k; loadSales()">{{ r.t }}</a>
          </span>
        </div>
        <div class="kpi4" v-if="kpis.length">
          <div class="kpi" v-for="k in kpis" :key="k.label">
            <div class="kpi-label">{{ k.label }}</div>
            <div class="kpi-val" :class="{ 'kpi-amt': k.money }">
              <i class="kpi-cur" v-if="k.prefix">{{ k.prefix }}</i><count-up :value="k.num" :decimals="k.decimals"/><i class="kpi-unit" v-if="k.unit">{{ k.unit }}</i>
            </div>
            <div class="kpi-sub">{{ k.sub }}</div>
          </div>
        </div>
        <div class="kpi4" v-else>
          <div class="kpi" v-for="n in 4" :key="n">
            <div class="kpi-label sk sk-block" style="width:52%;margin:0 auto 10px"></div>
            <div class="sk sk-block" style="width:72%;height:24px;margin:0 auto"></div>
          </div>
        </div>
        <div class="dash-mini">
          <div class="dmi"><span>库存总量</span><b><count-up :value="Number(stats?.totalQty ?? 0)"/></b></div>
          <div class="dmi"><span>库存货值</span><b><count-up :value="Number(stats?.stockValue ?? 0) / 100" :decimals="2"/></b></div>
          <div class="dmi"><span>待处理草稿</span><b><count-up :value="Number(stats?.draftCount ?? 0)"/></b></div>
          <div class="dmi" :class="{ warn: (stats?.lowStockCount ?? 0) > 0 }"><span>低库存预警</span><b><count-up :value="Number(stats?.lowStockCount ?? 0)"/></b></div>
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

    <!-- 第 3 行：三张独立销售排行卡（对齐惠民云：订单/出库/收款各一格） -->
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
        <thead><tr><th>商品</th><th class="r">当前库存</th><th class="r">安全库存</th><th class="r">缺口</th><th class="c" style="width:96px">操作</th></tr></thead>
        <tbody>
          <tr v-for="r in lowStockItems" :key="r.productId">
            <td style="font-weight:500">{{ r.prodName }}</td>
            <td class="r" style="color:#f56c6c;font-weight:600">{{ r.qty }}</td>
            <td class="r">{{ r.lowQty }}</td>
            <td class="r">{{ Math.max(0, r.lowQty - r.qty) }}</td>
            <td class="c"><span class="link" @click="goPurchase">去进货</span></td>
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

