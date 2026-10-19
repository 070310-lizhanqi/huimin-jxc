'use strict';
/* web/js/20-forecast.js —— 由 app.js 拆分（lines 3080-3168） */
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

