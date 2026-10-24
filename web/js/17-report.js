'use strict';
/* web/js/17-report.js —— 由 app.js 拆分（lines 2725-2900） */
/* ================= 报表 ================= */
const ReportPage = {
  setup() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const range = reactive([`${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, today]);
    const REPORT_TABS = ['day', 'product', 'cus', 'order', 'out', 'receipt'];
    const repTabParam = route.q.tab;
    // 「客户排行」的 key 是 cus：修掉此前对象键写成 customer 导致路由 tab=cus 进入时不高的 bug
    const TAB_LABELS = { day: '按日明细', product: '商品排行', cus: '客户排行', order: '订单统计', out: '出库统计', receipt: '收款统计' };
    const tab = ref(REPORT_TABS.includes(repTabParam) ? repTabParam : 'day');
    watch(() => route.q.tab, (t) => {
      if (!REPORT_TABS.includes(t)) return;
      tab.value = t;
      if (t in RANK_DIMS) loadRank(); else load();
    });
    const loading = ref(false);
    const sales = ref({ days: [], totals: { saleAmount: 0, retAmount: 0, saleQty: 0, retQty: 0, orderCount: 0 } });
    const products = ref([]);
    const customers = ref([]);
    const chartEl = ref(null);
    let chart = null;

    const fmtD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    // 排行 tab 三个共用 /report/sale-rank：dimension 决定统计口径，rankBy 决定分组维度
    const RANK_DIMS = { order: '订单排行', out: '出库排行', receipt: '收款排行' };
    const RANK_BY = [{ key: 'cus', label: '按客户' }, { key: 'clerk', label: '按业务员' }, { key: 'prod', label: '按商品' }];
    const rankBy = ref('cus');
    const rankRows = ref([]);
    // 请求序守卫：排行页签/日期区间连点时，慢的旧响应不得覆盖新结果
    const rankGuard = seqGuard();
    const loadGuard = seqGuard();
    async function loadRank() {
      if (!(tab.value in RANK_DIMS)) return;
      const my = rankGuard.begin();
      loading.value = true;
      try {
        // 收款结算单没有业务员维度，后端会强制按客户归组
        const by = tab.value === 'receipt' ? 'cus' : rankBy.value;
        const r = await api.get('/report/sale-rank', {
          teamId: store.teamId, dimension: tab.value, by, range: 'year', limit: 50,
        });
        if (!rankGuard.isCurrent(my)) return;
        rankRows.value = r.rows || [];
      } catch (e) { if (rankGuard.isCurrent(my)) toast(e.message, 'error'); }
      finally { if (rankGuard.isCurrent(my)) loading.value = false; }
    }
    async function load() {
      if (!range[0] || !range[1]) return toast('请选择日期范围', 'error');
      const my = loadGuard.begin();
      loading.value = true;
      try {
        const params = { teamId: store.teamId, from: range[0], to: range[1] };
        const [s, p, c] = await Promise.all([
          api.get('/report/sales', params),
          api.get('/report/product', params),
          api.get('/report/customer', params),
        ]);
        if (!loadGuard.isCurrent(my)) return;
        sales.value = s;
        products.value = p.rows || [];
        customers.value = c.rows || [];
        nextTick(renderChart);
      } catch (e) { if (loadGuard.isCurrent(my)) toast(e.message, 'error'); }
      finally { if (loadGuard.isCurrent(my)) loading.value = false; }
    }

    function renderChart() {
      if (!chartEl.value) return;
      // 切到排行页签时图表容器被 v-if 销毁，旧实例仍挂在已脱离文档的 DOM 上；
      // 切回后 chartEl 是新节点，必须重建实例，否则 setOption 渲染进死节点、趋势图永久空白
      if (chart && chart.getDom() !== chartEl.value) { chart.dispose(); chart = null; }
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
    onMounted(() => { if (tab.value in RANK_DIMS) loadRank(); else load(); });
    onBeforeUnmount(() => { if (chart) { chart.dispose(); chart = null; } });

    /** 排行 tab 的统计卡（口径与工作台排行卡一致） */
    const rankCards = computed(() => {
      const no = { order: '订单', out: '出库', receipt: '收款' }[tab.value] || '';
      const amt = rankRows.value.reduce((a, r) => a + (r.amount || 0), 0);
      const cnt = rankRows.value.reduce((a, r) => a + (r.count || 0), 0);
      return [
        { label: `${no}总额`, val: fmtMoney(amt), icon: 'Money' },
        { label: `${no}单数`, val: cnt, icon: 'Tickets' },
        { label: '上榜条数', val: rankRows.value.length, icon: 'List' },
        { label: '榜首', val: rankRows.value[0]?.name || '—', icon: 'Trophy' },
      ];
    });

    const cards = computed(() => {
      if (tab.value in RANK_DIMS) return rankCards.value;
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
      } else if (tab.value in RANK_DIMS) {
        // 排行 tab 按 sale-rank 口径导出（本年区间，与页面统计卡一致）
        const dim = RANK_DIMS[tab.value];
        const byLabel = { cus: '客户', clerk: '业务员', prod: '商品' }[tab.value === 'receipt' ? 'cus' : rankBy.value] || '客户';
        exportCsv(`${dim}_${now.getFullYear()}年.csv`,
          rankRows.value.map((r, i) => ({
            排名: i + 1, 名称: r.name || '（未指定）', 金额: fmtMoney(r.amount),
            数量: r.qty, 单数: r.count,
          })), [
            { key: '排名', label: '排名' }, { key: '名称', label: byLabel }, { key: '金额', label: '金额' },
            { key: '数量', label: '数量' }, { key: '单数', label: '单数' },
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

    /**
     * 快捷日期区间：报表最常用的就是「今天/本周/本月/上月/今年」，
     * 每次都手点两次日历太费劲。一律按本地时区算（与 localDate 口径一致）。
     */
    const QUICK_RANGES = [
      { k: 'today', label: '今天' },
      { k: 'week', label: '本周' },
      { k: 'month', label: '本月' },
      { k: 'lastMonth', label: '上月' },
      { k: 'year', label: '今年' },
    ];
    const quickRange = ref('month');
    function applyQuick(k) {
      quickRange.value = k;
      const n = new Date();
      const start = new Date(n.getFullYear(), n.getMonth(), n.getDate());
      let from = new Date(start);
      let to = new Date(start);
      if (k === 'week') {
        // 周一为一周开端
        const dow = (start.getDay() + 6) % 7;
        from = new Date(start.getFullYear(), start.getMonth(), start.getDate() - dow);
      } else if (k === 'month') {
        from = new Date(n.getFullYear(), n.getMonth(), 1);
      } else if (k === 'lastMonth') {
        from = new Date(n.getFullYear(), n.getMonth() - 1, 1);
        to = new Date(n.getFullYear(), n.getMonth(), 0);
      } else if (k === 'year') {
        from = new Date(n.getFullYear(), 0, 1);
      }
      range[0] = fmtD(from); range[1] = fmtD(to);
      load();
    }
    // 手点日历后把选中态清掉，避免快捷按钮亮着但实际区间已变
    function onRangeChange() { quickRange.value = ''; load(); }
    return { range, tab, loading, sales, products, customers, chartEl, cards, load, doExport, fmtMoney, TAB_LABELS, RANK_DIMS, RANK_BY, rankBy, rankRows, loadRank, QUICK_RANGES, quickRange, applyQuick, onRangeChange, STATUS_TEXT: { draft: '草稿', pending: '待审核', audit: '已审核', void: '已作废' } };
  },
  template: `
  <div class="page-card">
    <div class="page-head">
      <div class="hd-title">销售报表</div>
      <div class="tabs">
        <span v-for="(label, k) in TAB_LABELS" :key="k" class="tb" :class="{ on: tab === k }" @click="tab = k; (k in RANK_DIMS) ? loadRank() : load()">{{ label }}</span>
      </div>
      <div class="hd-right">
        <button class="btn" @click="doExport"><el-icon><Download/></el-icon> 导出</button>
      </div>
    </div>
    <div class="filterbar" v-if="!(tab in RANK_DIMS)">
      <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" style="width:260px" :clearable="false" @change="onRangeChange"/>
      <span class="tb" v-for="q in QUICK_RANGES" :key="q.k" :class="{ on: quickRange === q.k }"
            style="cursor:pointer;padding:4px 10px;border-radius:14px;font-size:12.5px"
            @click="applyQuick(q.k)">{{ q.label }}</span>
      <button class="btn primary" :disabled="loading" @click="load">{{ loading ? '查询中…' : '查询' }}</button>
      <span class="muted" style="font-size:12.5px" v-if="tab === 'product'">成本按已审核采购入库的加权平均价估算</span>
    </div>
    <div class="filterbar" v-else>
      <span class="muted" style="font-size:12.5px">统计区间：本年度 1 月 1 日至今天</span>
      <span class="tb" v-for="b in RANK_BY" :key="b.key" v-show="tab !== 'receipt'"
            :class="{ on: rankBy === b.key }" style="cursor:pointer;padding:4px 10px;border-radius:14px;font-size:12.5px"
            @click="rankBy = b.key; loadRank()">{{ b.label }}</span>
      <span class="muted" style="font-size:12.5px" v-if="tab === 'receipt'">收款单没有业务员维度，固定按客户归组</span>
    </div>

    <div class="stat-grid">
      <div class="card stat" v-for="c in cards" :key="c.label">
        <div class="stat-label"><el-icon><component :is="c.icon"/></el-icon> {{ c.label }}</div>
        <div class="stat-val">{{ c.val }}</div>
      </div>
    </div>

    <div class="card" style="margin:0 0 12px" v-if="!(tab in RANK_DIMS)">
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

      <table class="tbl" v-else-if="tab in RANK_DIMS">
        <thead><tr><th class="r" style="width:52px">#</th><th>{{ tab === 'receipt' ? '客户' : (rankBy === 'clerk' ? '业务员' : rankBy === 'prod' ? '商品' : '客户') }}</th><th class="r">金额</th><th class="r">数量</th><th class="r">单数</th></tr></thead>
        <tbody>
          <tr v-for="(r, i) in rankRows" :key="r.key ?? 'none'">
            <td class="r muted">{{ i + 1 }}</td>
            <td>{{ r.name || '（未指定）' }}</td>
            <td class="r"><b>{{ fmtMoney(r.amount) }}</b></td>
            <td class="r">{{ r.qty }}</td>
            <td class="r">{{ r.count }}</td>
          </tr>
          <tr v-if="!rankRows.length"><td colspan="5" class="muted" style="text-align:center;padding:22px">本年度还没有{{ RANK_DIMS[tab] }}数据。</td></tr>
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

