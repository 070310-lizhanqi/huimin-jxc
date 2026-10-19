'use strict';
/* web/js/17-report.js —— 由 app.js 拆分（lines 2725-2900） */
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

