'use strict';
/* web/js/12-stock.js —— 由 app.js 拆分（lines 1432-1601） */
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
    const loading = ref(true);
    /** detail=按库位明细（原始行）；prod=按商品汇总（同商品多仓多库位合并） */
    const view = ref('prod');

    async function load() {
      loading.value = true;
      try {
        list.value = await api.get('/stock/list', {
          teamId: store.teamId, kw: kw.value,
          warehouseId: warehouseId.value,
          ifShowZero: ifShowZero.value ? '' : '0',
        });
      } finally {
        loading.value = false;
      }
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
      kw, warehouseId, ifShowZero, list, loading, load, totalQty, isLow, resvName, doExport, lowQtyMap, store,
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
        <sk-table v-if="loading && !list.length" :rows="8" :cols="8"/>
        <table class="tbl" v-else-if="view === 'prod'">
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

