'use strict';
/* web/js/22-aging.js —— 由 app.js 拆分（lines 3317-3501） */
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

