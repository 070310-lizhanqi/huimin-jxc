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
    /** 钻取时的临时过滤词：独立于用户搜索框，切回汇总后不残留 */
    const drillKw = ref('');

    // 请求序守卫：仓库/关键词/显示零库存连点时，慢的旧响应不得覆盖新结果
    const loadGuard = seqGuard();

    async function load() {
      const my = loadGuard.begin();
      loading.value = true;
      try {
        // 钻取词优先于用户搜索词，仅在明细钻取场景生效
        const effKw = view.value === 'detail' && drillKw.value ? drillKw.value : kw.value;
        const rows = await api.get('/stock/list', {
          teamId: store.teamId, kw: effKw,
          warehouseId: warehouseId.value,
          ifShowZero: ifShowZero.value ? '' : '0',
        });
        if (!loadGuard.isCurrent(my)) return;
        list.value = rows;
      } catch (e) {
        if (loadGuard.isCurrent(my)) toast('库存查询失败：' + e.message, 'error');
      } finally {
        if (loadGuard.isCurrent(my)) loading.value = false;
      }
    }
    onMounted(load);
    const totalQty = computed(() => list.value.reduce((s, r) => s + r.qty, 0));
    /** 安全库存优先用 /stock/list 带回的商品级 lowQty（一次请求齐全），回落到商品档案 */
    const lowQtyMap = computed(() => {
      const m = {};
      for (const r of list.value) if (r.lowQty > 0) m[r.productId] = r.lowQty;
      for (const p of store.products) if (p.lowQty > 0 && m[p.id] == null) m[p.id] = p.lowQty;
      return m;
    });
    /** 商品合计数量（跨仓）：明细视图判断低库存必须用商品总量，
     *  拿单仓行数量对比商品级阈值会把多仓商品每行都误标 */
    const prodTotalMap = computed(() => {
      const m = {};
      for (const r of list.value) m[r.productId] = (m[r.productId] || 0) + r.qty;
      return m;
    });
    /** 估价成本（最近一次采购入库单价），同商品各行相同 */
    const estCostMap = computed(() => {
      const m = {};
      for (const r of list.value) if (r.estUnitCost != null) m[r.productId] = r.estUnitCost;
      return m;
    });
    function isLow(r) {
      const low = lowQtyMap.value[r.productId];
      return low != null && (prodTotalMap.value[r.productId] ?? 0) <= low;
    }
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
            lowQty: r.lowQty, estUnitCost: r.estUnitCost ?? 0,
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
        .map((s) => ({ ...s, whs: [...s.whs].join('、'), value: Math.round(s.qty * s.estUnitCost) }))
        .filter((s) => ifShowZero.value || s.qty !== 0);
    });

    /** 汇总行是否低库存：安全库存是商品级阈值，故按汇总数量判断才对 */
    function isLowSum(s) { return lowQtyMap.value[s.productId] != null && s.qty <= lowQtyMap.value[s.productId]; }
    const lowCount = computed(() => summary.value.filter(isLowSum).length);
    /** 低库存筛选：点「N 项低库存」只看缺口商品，再点一次或点清除恢复 */
    const onlyLow = ref(false);
    const sortedSummary = computed(() => {
      let rows = [...summary.value];
      if (onlyLow.value) rows = rows.filter(isLowSum);
      if (sortKey.value === 'qtyAsc') rows.sort((a, b) => a.qty - b.qty);
      else if (sortKey.value === 'qtyDesc') rows.sort((a, b) => b.qty - a.qty);
      return rows;
    });
    const totalValue = computed(() => summary.value.reduce((s, r) => s + r.value, 0));

    /** 汇总排序：默认按商品建档顺序；点表头切 数量升序 → 降序 → 默认 */
    const sortKey = ref('default');
    function toggleSort() {
      sortKey.value = sortKey.value === 'default' ? 'qtyAsc' : sortKey.value === 'qtyAsc' ? 'qtyDesc' : 'default';
    }

    /** 汇总行点「N 条明细」→ 切到明细视图并按商品名过滤，需重新请求后端 */
    async function drillTo(s) {
      view.value = 'detail';
      drillKw.value = s.prodName;
      await load();
    }
    /** 切回汇总视图：清掉钻取词并按用户自己的筛选重查 */
    async function backToSummary() {
      view.value = 'prod';
      drillKw.value = '';
      await load();
    }

    function doExport() {
      if (view.value === 'prod') {
        exportCsv('库存汇总.csv', summary.value.map((s) => ({
          prodName: s.prodName, spec: s.spec || '', unit: s.unit,
          whs: s.whs, rows: s.rows, qty: s.qty, lowQty: lowQtyMap.value[s.productId] ?? '',
          value: (s.value / 100).toFixed(2),
        })), [
          { key: 'prodName', label: '商品' }, { key: 'spec', label: '规格' }, { key: 'unit', label: '单位' },
          { key: 'whs', label: '所在仓库' }, { key: 'rows', label: '库存行数' },
          { key: 'qty', label: '合计数量' }, { key: 'lowQty', label: '安全库存' }, { key: 'value', label: '库存货值(元)' },
        ]);
        return;
      }
      exportCsv('实时库存.csv', list.value.map((r) => ({
        prodName: r.prodName, spec: r.spec || '', unit: r.unit,
        warehouse: r.warehouseName || '', reservoir: resvName(r.reservoirId), batchNo: r.batchNo || '',
        qty: r.qty, lowQty: lowQtyMap.value[r.productId] ?? '',
      })), [
        { key: 'prodName', label: '商品' }, { key: 'spec', label: '规格' }, { key: 'unit', label: '单位' },
        { key: 'warehouse', label: '仓库' }, { key: 'reservoir', label: '库位' }, { key: 'batchNo', label: '批次' },
        { key: 'qty', label: '数量' }, { key: 'lowQty', label: '安全库存' },
      ]);
    }
    return {
      kw, warehouseId, ifShowZero, list, loading, load, totalQty, isLow, resvName, doExport, lowQtyMap, store,
      view, summary, sortedSummary, sortKey, toggleSort, isLowSum, lowCount, drillTo, backToSummary, drillKw,
      onlyLow, totalValue, fmtMoney,
    };
  },
  template: `
  <div>
    <div class="page-card">
      <div class="page-head">
        <span class="hd-title">库存查询</span>
        <div class="tabs" style="margin-left:14px">
          <span class="tb" :class="{ on: view === 'prod' }" @click="backToSummary()">按商品汇总</span>
          <span class="tb" :class="{ on: view === 'detail' }" @click="view = 'detail'; drillKw = ''; load()">按库位明细</span>
        </div>
        <span class="hd-sp"></span>
        <button class="btn" @click="doExport"><el-icon><Download/></el-icon> 导出</button>
      </div>
      <div class="filterbar">
        <div class="fctrl" style="width:200px"><el-select v-model="warehouseId" filterable clearable placeholder="全部仓库" @change="load">
          <el-option v-for="w in store.warehouses" :key="w.id" :label="w.name" :value="w.id"/>
        </el-select></div>
        <input class="finp w-key" v-model="kw" :disabled="!!drillKw" :placeholder="drillKw ? '钻取过滤：' + drillKw : '商品名称 / 条码'" @keyup.enter="load"/>
        <button class="btn" @click="load">查询</button>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)">
          <input type="checkbox" v-model="ifShowZero" @change="load"/>显示零库存</label>
        <span class="fb-gap"></span>
        <span class="muted">库存总量 <b style="color:var(--text)">{{ totalQty }}</b> ·
          货值约 <b style="color:var(--text)">{{ fmtMoney(totalValue) }}</b> 元 ·
          {{ view === 'prod' ? (onlyLow ? sortedSummary.length + '/' : '') + summary.length + ' 个商品' : list.length + ' 条记录' }}<template v-if="lowCount"> ·
          <a href="javascript:;" class="lnk" :style="onlyLow ? 'color:#b88230;font-weight:600' : ''" @click="onlyLow = !onlyLow"
             :title="onlyLow ? '点击取消低库存筛选' : '只看低于安全库存的商品'">{{ onlyLow ? '✓ ' : '' }}{{ lowCount }} 项低库存</a></template></span>
      </div>
      <div class="tbl-wrap">
        <sk-table v-if="loading && !list.length" :rows="8" :cols="8"/>
        <table class="tbl" v-else-if="view === 'prod'">
          <thead><tr>
            <th>商品</th><th>规格</th><th>单位</th><th>所在仓库</th><th class="r">库存行数</th>
            <th class="r">合计数量<span class="th-sort" :class="{ on: sortKey !== 'default' }" @click="toggleSort()"
              :title="sortKey === 'qtyAsc' ? '当前：数量从少到多（缺货排最前），再点切降序' : sortKey === 'qtyDesc' ? '当前：数量从多到少，再点恢复默认' : '点击按数量升序（缺货排最前）'">{{ sortKey === 'qtyDesc' ? '↓' : sortKey === 'qtyAsc' ? '↑' : '⇅' }}</span></th><th class="r">安全库存</th><th class="r">库存货值</th><th></th>
          </tr></thead>
          <tbody>
            <tr v-if="!sortedSummary.length"><td colspan="9">
              <div class="empty">{{ onlyLow && lowCount ? '' : '暂无库存数据' }}<template v-if="onlyLow && summary.length"><a href="javascript:;" class="lnk" @click="onlyLow = false">无低库存商品，清除筛选</a></template></div>
            </td></tr>
            <tr v-for="s in sortedSummary" :key="s.productId">
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
              <td class="r muted" :class="{ money: !!s.value }">{{ s.value ? fmtMoney(s.value) : '—' }}</td>
              <td style="width:78px">
                <span v-if="isLowSum(s)" class="tag" style="background:#fdf6ec;color:#b88230">低库存</span>
              </td>
            </tr>
          </tbody>
        </table>
        <table class="tbl" v-else>
          <thead><tr>
            <th colspan="9" v-if="drillKw" style="background:#f8f9fb;font-weight:400;font-size:12.5px;color:var(--muted)">
              <el-icon style="vertical-align:-2px"><Filter/></el-icon>
              钻取过滤「{{ drillKw }}」· <a href="javascript:;" class="lnk" @click="backToSummary()">返回汇总视图</a>
            </th>
          </tr><tr><th>商品</th><th>规格</th><th>单位</th><th>仓库</th><th>库位</th><th>批次</th><th class="r">数量</th><th class="r">安全库存</th><th></th></tr></thead>
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

