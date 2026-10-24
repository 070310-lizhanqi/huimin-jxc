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
    /* 请求序守卫：快速切页签时旧响应不得覆盖新数据 */
    const guard = seqGuard();

    const BUCKET_LABELS = AGING_LABELS;
    const BUCKET_COLORS = AGING_COLORS;
    const BUCKET_KEYS = AGING_KEYS;

    watch(() => route.q.mode, (m) => {
      const next = m === 'ap' ? 'ap' : m === 'stock' ? 'stock' : 'ar';
      if (next !== mode.value) { mode.value = next; load(); }
    });

    async function load() {
      loading.value = true;
      const my = guard.begin();
      try {
        let r;
        if (mode.value === 'stock') {
          r = await api.get('/report/stock-aging', { teamId: store.teamId });
        } else {
          r = await api.get('/report/aging', { teamId: store.teamId, mode: mode.value });
        }
        if (!guard.isCurrent(my)) return;
        rows.value = r.rows || r.items || [];
        totals.value = r.totals || {};
        asOf.value = r.asOf;
        await nextTick();
        renderChart();
      } catch (e) {
        if (guard.isCurrent(my)) toast(e.message, 'error');
      } finally {
        if (guard.isCurrent(my)) loading.value = false;
      }
    }

    /* 本地筛选：关键词 + 点击扇区下钻到该账龄区间 */
    const kw = ref('');
    const drillBucket = ref('');
    function clearDrill() { drillBucket.value = ''; }
    const shown = computed(() => {
      let out = rows.value;
      if (kw.value.trim()) {
        const k = kw.value.trim().toLowerCase();
        out = out.filter((r) => String(r.partnerName || r.prodName || '').toLowerCase().includes(k));
      }
      if (drillBucket.value && mode.value !== 'stock') {
        out = out.filter((r) => Number(r[drillBucket.value] || 0) > 0);
      } else if (drillBucket.value && mode.value === 'stock') {
        out = out.filter((r) => r.bucket === drillBucket.value);
      }
      return out;
    });
    /* 合计列排序：默认按接口顺序（金额降序），点击表头切降→升 */
    const sortDir = ref('');
    const sorted = computed(() => {
      const out = [...shown.value];
      if (sortDir.value === 'desc') out.sort((a, b) => (b.total ?? b.amount ?? 0) - (a.total ?? a.amount ?? 0));
      else if (sortDir.value === 'asc') out.sort((a, b) => (a.total ?? a.amount ?? 0) - (b.total ?? b.amount ?? 0));
      return out;
    });
    function toggleSort() { sortDir.value = sortDir.value === 'desc' ? 'asc' : sortDir.value === 'asc' ? '' : 'desc'; }

    function renderChart() {
      if (!chartEl.value) return;
      // 切模式不销毁容器，但保险起见复用 getInstanceByDom 查重
      const existing = echarts.getInstanceByDom(chartEl.value);
      if (existing && existing !== chart) existing.dispose();
      if (!chart) chart = echarts.init(chartEl.value);
      const t = totals.value || {};
      // 扇区值保留原始分（tooltip 用 fmtMoney 精确到分）：取整到元会让大额账龄丢分
      const data = BUCKET_KEYS.map((k, i) => ({
        name: BUCKET_LABELS[i], value: t[k] || 0, itemStyle: { color: BUCKET_COLORS[i] },
      })).filter((d) => d.value > 0);
      chart.setOption({
        tooltip: { trigger: 'item', valueFormatter: (v) => fmtMoney(Number(v)) },
        legend: { right: 8, top: 'middle', orient: 'vertical', itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 12 } },
        series: [{
          type: 'pie', radius: ['48%', '68%'], center: ['32%', '50%'],
          label: { show: false }, labelLine: { show: false },
          // 占位扇区静默：悬停不出「¥1」假数据
          data: data.length ? data : [{ name: '暂无数据', value: 1, itemStyle: { color: '#eceff2' }, silent: true, tooltip: { show: false } }],
        }],
      }, true);
      // 点击扇区下钻：ECharts 事件必须用 chart.on 注册（option 里没有 onClick 字段，会被静默忽略）。
      // p.name 是档位标签（如「30天内」），要换算回行键（d30/d60/…）才能用于过滤
      chart.off('click');
      chart.on('click', (p) => {
        if (p.name === '暂无数据') return;
        const key = BUCKET_LABELS.indexOf(p.name) >= 0 ? BUCKET_KEYS[BUCKET_LABELS.indexOf(p.name)] : '';
        if (!key) return;
        drillBucket.value = drillBucket.value === key ? '' : key;
      });
    }

    const cards = computed(() => {
      const t = totals.value || {};
      if (mode.value === 'stock') {
        return [
          { label: '库存货值', val: fmtMoney(t.total) },
          { label: '库存数量', val: fmtQty(t.qty) },
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

    /* 账龄行跳对应单据列表：AR 看销售出库、AP 看采购入库（带往来单位预筛选） */
    function goDocs(r) {
      nav(`#/doc/${mode.value === 'ar' ? 'sale' : 'purchase'}?type=${mode.value === 'ar' ? 'stockout' : 'stockin'}&partnerId=${r.partnerId}`);
    }

    function doExport() {
      if (!rows.value.length) return toast('没有可导出的数据', 'warning');
      if (mode.value === 'stock') {
        exportCsv(`库存账龄_${asOf.value}.csv`,
          rows.value.map((r) => ({
            商品: r.prodName, 仓库: r.warehouseName || '', 批次: r.batchNo || '',
            数量: r.qty, 首次入库: r.firstDate || '', 库龄天数: r.days,
            账龄区间: BUCKET_LABELS[BUCKET_KEYS.indexOf(r.bucket)] || '', 金额: r.amount == null ? '' : (r.amount / 100).toFixed(2),
          })), [
            { key: '商品', label: '商品' }, { key: '仓库', label: '仓库' }, { key: '批次', label: '批次' },
            { key: '数量', label: '数量' }, { key: '首次入库', label: '首次入库' }, { key: '库龄天数', label: '库龄天数' },
            { key: '账龄区间', label: '账龄区间' }, { key: '金额', label: '金额' },
          ]);
        return;
      }
      // CSV 金额列输出纯数字（分→元 2 位），不带千分位/破折号，Excel 可直接求和
      exportCsv(`${mode.value === 'ar' ? '客户' : '供应商'}欠款账龄_${asOf.value}.csv`,
        rows.value.map((r) => {
          const o = { 往来单位: r.partnerName, 最早单据: r.oldestDate || '' };
          BUCKET_KEYS.forEach((k, i) => { o[BUCKET_LABELS[i]] = r[k] == null ? '' : (r[k] / 100).toFixed(2); });
          o['合计'] = r.total == null ? '' : (r.total / 100).toFixed(2);
          return o;
        }), [
          { key: '往来单位', label: '往来单位' }, { key: '最早单据', label: '最早单据' },
          ...BUCKET_LABELS.map((l) => ({ key: l, label: l })),
          { key: '合计', label: '合计' },
        ]);
    }

    function onResize() { if (chart) chart.resize(); }
    onMounted(() => {
      load();
      window.addEventListener('resize', onResize);
    });
    onBeforeUnmount(() => {
      window.removeEventListener('resize', onResize);
      if (chart) { chart.dispose(); chart = null; }
    });
    return {
      mode, loading, rows, shown, sorted, totals, asOf, cards, chartEl, load, doExport, fmtMoney, fmtQty,
      BUCKET_LABELS, BUCKET_KEYS, bucketLabel: (k) => BUCKET_LABELS[BUCKET_KEYS.indexOf(k)] || k,
      kw, drillBucket, clearDrill, sortDir, toggleSort, goDocs,
    };
  },
  template: `
  <div class="page-card">
    <div class="page-head">
      <div class="hd-title">{{ mode === 'ar' ? '客户欠款账龄' : mode === 'ap' ? '供应商欠款账龄' : '库存账龄' }}</div>
      <div class="tabs">
        <span class="tb" :class="{ on: mode === 'ar' }" @click="mode = 'ar'; load()">客户欠款账龄</span>
        <span class="tb" :class="{ on: mode === 'ap' }" @click="mode = 'ap'; load()">供应商欠款账龄</span>
        <span class="tb" :class="{ on: mode === 'stock' }" @click="mode = 'stock'; load()">库存账龄</span>
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
      <div class="card-title" style="margin-bottom:8px">
        账龄分布（元）
        <a v-if="drillBucket" class="lnk" style="margin-left:10px;font-size:12.5px" @click="clearDrill">已筛选：{{ bucketLabel(drillBucket) }} ×清除</a>
      </div>
      <div ref="chartEl" style="height:230px"></div>
    </div>

    <div class="card">
      <div class="filterbar">
        <input class="finp w-key" v-model="kw" :placeholder="mode === 'stock' ? '商品名称' : '往来单位名称'"/>
        <button class="btn" v-if="mode !== 'stock'" @click="toggleSort" title="按合计金额排序">
          合计排序 {{ sortDir === 'desc' ? '↓' : sortDir === 'asc' ? '↑' : '⇅' }}</button>
        <span class="fb-gap"></span>
        <span class="muted fb-count">{{ sorted.length }} / {{ rows.length }} 条</span>
      </div>
      <table class="tbl" v-if="mode !== 'stock'">
        <thead><tr>
          <th class="r" style="width:52px">#</th><th>往来单位</th><th>最早单据</th>
          <th v-for="l in BUCKET_LABELS" :key="l" class="r">{{ l }}</th><th class="r">合计</th><th style="width:78px"></th>
        </tr></thead>
        <tbody>
          <tr v-if="!sorted.length"><td :colspan="10"><div class="empty">{{ rows.length ? '没有匹配的往来单位' : '暂无未结' + (mode === 'ar' ? '应收' : '应付') }}</div></td></tr>
          <tr v-for="(r, i) in sorted" :key="r.partnerId">
            <td class="r muted">{{ i + 1 }}</td>
            <td>{{ r.partnerName }}</td><td class="muted">{{ r.oldestDate || '—' }}</td>
            <td v-for="k in BUCKET_KEYS" :key="k" class="r" :class="r[k] > 0 ? '' : 'muted'">{{ r[k] ? fmtMoney(r[k]) : '—' }}</td>
            <td class="r"><b>{{ fmtMoney(r.total) }}</b></td>
            <td class="c"><a class="lnk" @click="goDocs(r)" title="查看该往来单位的单据">看单据</a></td>
          </tr>
          <tr v-if="sorted.length" style="background:#f7f9fb;font-weight:600">
            <td colspan="3" style="text-align:right">合计</td>
            <td v-for="k in BUCKET_KEYS" :key="k" class="r">{{ totals[k] ? fmtMoney(totals[k]) : '—' }}</td>
            <td class="r">{{ fmtMoney(totals.total) }}</td><td></td>
          </tr>
        </tbody>
      </table>

      <table class="tbl" v-else>
        <thead><tr>
          <th class="r" style="width:52px">#</th><th>商品</th><th>仓库</th><th>批次</th>
          <th class="r">数量</th><th>首次入库</th><th class="r">库龄天数</th><th>账龄区间</th><th class="r">金额</th>
        </tr></thead>
        <tbody>
          <tr v-if="!sorted.length"><td colspan="9"><div class="empty">{{ rows.length ? '没有匹配的商品' : '没有库存记录' }}</div></td></tr>
          <tr v-for="(r, i) in sorted" :key="r.productId + '-' + r.warehouseId + '-' + (r.batchNo || '')">
            <td class="r muted">{{ i + 1 }}</td>
            <td>{{ r.prodName }}</td><td class="muted">{{ r.warehouseName || '—' }}</td>
            <td class="muted">{{ r.batchNo || '—' }}</td>
            <td class="r">{{ fmtQty(r.qty) }}</td><td class="muted">{{ r.firstDate || '—' }}</td>
            <td class="r" :class="r.days > 360 ? 'stock-low' : ''">{{ r.days }}</td>
            <td>{{ bucketLabel(r.bucket) }}</td><td class="r">{{ fmtMoney(r.amount) }}</td>
          </tr>
          <tr v-if="sorted.length" style="background:#f7f9fb;font-weight:600">
            <td colspan="4" style="text-align:right">合计</td>
            <td class="r">{{ fmtQty(totals.qty) }}</td><td colspan="3"></td>
            <td class="r">{{ fmtMoney(totals.total) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>`,
};

