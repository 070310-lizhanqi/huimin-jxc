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
    /** B-前2 服务端分页：每页行数记 localStorage（与 13-doc.js 同款 pageSizeOf） */
    const page = ref(1);
    const rows = ref(pageSizeOf('stock', 50));
    const total = ref(0);
    /** 服务端合计（全量过滤集上聚合，不是当前页），分页模式下才有 */
    const totals = ref(null);
    /** 当前 list 是否为服务端已汇总的商品行（prod 分页模式） */
    const serverAgg = ref(false);
    const pages = computed(() => Math.max(1, Math.ceil(total.value / rows.value)));
    const pageBtns = computed(() => {
      const n = pages.value,
        c = page.value,
        arr = [];
      for (let p = 1; p <= n; p++) if (p === 1 || p === n || Math.abs(p - c) <= 2) arr.push(p);
      return arr;
    });
    function onRowsChange(e) {
      rows.value = Number(e.target.value) || 50;
      pageSizeSave('stock', rows.value);
      page.value = 1;
      load();
    }

    // 请求序守卫：仓库/关键词/显示零库存连点时，慢的旧响应不得覆盖新结果
    const loadGuard = seqGuard();

    async function load() {
      const my = loadGuard.begin();
      loading.value = true;
      try {
        // 钻取词优先于用户搜索词，仅在明细钻取场景生效
        const effKw = view.value === 'detail' && drillKw.value ? drillKw.value : kw.value;
        // B-前2：分页 + 汇总视图走服务端 group=prod（行级分页会把同一商品拆到不同页，
        // 汇总视图无法正确分组）；低库存筛选与排序也交给服务端（分页后前端只剩当前页，
        // 再在前端算会漏掉其他页的低库存商品）
        const r = await api.get('/stock/list', {
          teamId: store.teamId,
          kw: effKw,
          warehouseId: warehouseId.value,
          ifShowZero: ifShowZero.value ? '' : '0',
          page: page.value,
          rows: rows.value,
          group: view.value === 'prod' ? 'prod' : undefined,
          onlyLow: onlyLow.value ? '1' : undefined,
          sort: sortKey.value !== 'default' ? sortKey.value : undefined,
        });
        if (!loadGuard.isCurrent(my)) return;
        if (Array.isArray(r)) {
          // 旧服务端回落：全量数组，前端仍按旧 computed 算
          list.value = r;
          total.value = r.length;
          totals.value = null;
          serverAgg.value = false;
        } else {
          list.value = r.rows || [];
          total.value = r.total ?? list.value.length;
          totals.value = r.totals || null;
          serverAgg.value = view.value === 'prod';
        }
      } catch (e) {
        if (loadGuard.isCurrent(my)) toast('库存查询失败：' + e.message, 'error');
      } finally {
        if (loadGuard.isCurrent(my)) loading.value = false;
      }
    }
    /** 筛选条件变化从第 1 页开始（翻页时 load() 不重置页码） */
    function search() {
      page.value = 1;
      load();
    }
    onMounted(load);
    /** B-前2：分页后合计行取服务端 totals（全量口径），回落时才前端算当前页 */
    const totalQty = computed(() => (totals.value ? totals.value.totalQty : list.value.reduce((s, r) => s + r.qty, 0)));
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
      // B-前2：分页模式下服务端已按商品总量打好 isLow（前端只剩当前页，拿页内和对比阈值会误标）；
      // 旧全量回落时仍按页内商品总量算
      if (r.isLow != null) return !!r.isLow;
      const low = lowQtyMap.value[r.productId];
      return low != null && (prodTotalMap.value[r.productId] ?? 0) <= low;
    }
    function resvName(id) {
      return id ? (byId(store.reservoirs, id)?.name ?? `#${id}`) : '—';
    }

    /**
     * 按商品汇总：同一商品可能散在多个仓库/库位，汇总视图把它们加总，
     * 并把占用的仓库名、库位数收在 whs / locs 里供表格展示。
     * B-前2：分页模式下服务端已汇总好（list 即商品行，whs 是逗号分隔的仓库名，
     * 去重后按 '、' 展示）；旧全量回落时仍在前端分组。
     */
    const summary = computed(() => {
      if (serverAgg.value) {
        return list.value.map((r) => ({
          productId: r.productId,
          prodName: r.prodName,
          spec: r.spec,
          unit: r.unit,
          code: r.code,
          qty: r.qty,
          whs: [
            ...new Set(
              String(r.whs || '')
                .split(',')
                .filter(Boolean),
            ),
          ].join('、'),
          locs: r.locs || 0,
          batchNo: r.batchNo || '',
          rows: r.rows || 0,
          lowQty: r.lowQty,
          estUnitCost: r.estUnitCost ?? 0,
          value: r.value ?? Math.round((r.qty || 0) * (r.estUnitCost || 0)),
          isLow: r.isLow === 1 || r.isLow === true,
        }));
      }
      const map = new Map();
      for (const r of list.value) {
        let s = map.get(r.productId);
        if (!s) {
          s = {
            productId: r.productId,
            prodName: r.prodName,
            spec: r.spec,
            unit: r.unit,
            code: r.code,
            qty: 0,
            whs: new Set(),
            locs: 0,
            batchNo: '',
            rows: 0,
            lowQty: r.lowQty,
            estUnitCost: r.estUnitCost ?? 0,
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
    function isLowSum(s) {
      if (s.isLow != null) return !!s.isLow;
      return lowQtyMap.value[s.productId] != null && s.qty <= lowQtyMap.value[s.productId];
    }
    /** B-前2：分页模式下低库存商品数取服务端 totals.lowCount（全量口径） */
    const lowCount = computed(() => (totals.value ? totals.value.lowCount : summary.value.filter(isLowSum).length));
    /** 低库存筛选：点「N 项低库存」只看缺口商品，再点一次或点清除恢复 */
    const onlyLow = ref(false);
    const sortedSummary = computed(() => {
      // B-前2：分页模式下筛选与排序已由服务端做（只剩当前页，前端再排会错），直接返回
      if (serverAgg.value) return summary.value;
      let rows = [...summary.value];
      if (onlyLow.value) rows = rows.filter(isLowSum);
      if (sortKey.value === 'qtyAsc') rows.sort((a, b) => a.qty - b.qty);
      else if (sortKey.value === 'qtyDesc') rows.sort((a, b) => b.qty - a.qty);
      return rows;
    });
    /** B-前2：分页模式下货值合计取服务端 totals.totalValue（全量口径） */
    const totalValue = computed(() =>
      totals.value ? totals.value.totalValue : summary.value.reduce((s, r) => s + r.value, 0),
    );

    /** 汇总排序：默认按商品建档顺序；点表头切 数量升序 → 降序 → 默认 */
    const sortKey = ref('default');
    function toggleSort() {
      sortKey.value = sortKey.value === 'default' ? 'qtyAsc' : sortKey.value === 'qtyAsc' ? 'qtyDesc' : 'default';
    }
    // B-前2：低库存筛选与排序在服务端做，切换时从第 1 页重查（回落的全量模式下
    // 前端 computed 同样会再算一次，结果一致）
    watch([onlyLow, sortKey], () => {
      page.value = 1;
      load();
    });

    /** 汇总行点「N 条明细」→ 切到明细视图并按商品名过滤，需重新请求后端 */
    async function drillTo(s) {
      view.value = 'detail';
      drillKw.value = s.prodName;
      page.value = 1;
      await load();
    }
    /** 切回汇总视图：清掉钻取词并按用户自己的筛选重查 */
    async function backToSummary() {
      view.value = 'prod';
      drillKw.value = '';
      page.value = 1;
      await load();
    }
    /** 切到明细视图（顶部页签）：清掉钻取词，从第 1 页重查 */
    function toDetail() {
      view.value = 'detail';
      drillKw.value = '';
      page.value = 1;
      load();
    }

    async function doExport() {
      // B-前2：列表已分页，导出要拉全量（不带 page 参数走旧数组口径），否则只导出当前页；
      // 低库存筛选与排序条件一并带上，导出的就是屏幕上筛出来的集合
      try {
        const effKw = view.value === 'detail' && drillKw.value ? drillKw.value : kw.value;
        const q = {
          teamId: store.teamId,
          kw: effKw,
          warehouseId: warehouseId.value,
          ifShowZero: ifShowZero.value ? '' : '0',
          onlyLow: onlyLow.value ? '1' : undefined,
          sort: sortKey.value !== 'default' ? sortKey.value : undefined,
        };
        if (view.value === 'prod') {
          const r = await api.get('/stock/list', { ...q, group: 'prod' });
          const rowsAll = Array.isArray(r) ? r : r.rows || [];
          if (!rowsAll.length) return toast('没有可导出的数据', 'warning');
          exportCsv(
            '库存汇总.csv',
            rowsAll.map((s) => ({
              prodName: s.prodName,
              spec: s.spec || '',
              unit: s.unit,
              whs: [
                ...new Set(
                  String(s.whs || '')
                    .split(',')
                    .filter(Boolean),
                ),
              ].join('、'),
              rows: s.rows,
              qty: s.qty,
              lowQty: s.lowQty ?? '',
              value: ((s.value ?? Math.round((s.qty || 0) * (s.estUnitCost || 0))) / 100).toFixed(2),
            })),
            [
              { key: 'prodName', label: '商品' },
              { key: 'spec', label: '规格' },
              { key: 'unit', label: '单位' },
              { key: 'whs', label: '所在仓库' },
              { key: 'rows', label: '库存行数' },
              { key: 'qty', label: '合计数量' },
              { key: 'lowQty', label: '安全库存' },
              { key: 'value', label: '库存货值(元)' },
            ],
          );
          return;
        }
        const r = await api.get('/stock/list', q);
        const rowsAll = Array.isArray(r) ? r : r.rows || [];
        if (!rowsAll.length) return toast('没有可导出的数据', 'warning');
        exportCsv(
          '实时库存.csv',
          rowsAll.map((r) => ({
            prodName: r.prodName,
            spec: r.spec || '',
            unit: r.unit,
            warehouse: r.warehouseName || '',
            reservoir: resvName(r.reservoirId),
            batchNo: r.batchNo || '',
            qty: r.qty,
            lowQty: r.lowQty ?? '',
          })),
          [
            { key: 'prodName', label: '商品' },
            { key: 'spec', label: '规格' },
            { key: 'unit', label: '单位' },
            { key: 'warehouse', label: '仓库' },
            { key: 'reservoir', label: '库位' },
            { key: 'batchNo', label: '批次' },
            { key: 'qty', label: '数量' },
            { key: 'lowQty', label: '安全库存' },
          ],
        );
      } catch (e) {
        toast('导出失败：' + e.message, 'error');
      }
    }
    return {
      kw,
      warehouseId,
      ifShowZero,
      list,
      loading,
      load,
      search,
      totalQty,
      isLow,
      resvName,
      doExport,
      lowQtyMap,
      store,
      view,
      summary,
      sortedSummary,
      sortKey,
      toggleSort,
      isLowSum,
      lowCount,
      drillTo,
      backToSummary,
      toDetail,
      drillKw,
      onlyLow,
      totalValue,
      fmtMoney,
      page,
      rows,
      total,
      pages,
      pageBtns,
      onRowsChange,
    };
  },
  template: `
  <div>
    <div class="page-card">
      <div class="page-head">
        <span class="hd-title">库存查询</span>
        <div class="tabs" style="margin-left:14px">
          <span class="tb" :class="{ on: view === 'prod' }" @click="backToSummary()">按商品汇总</span>
          <span class="tb" :class="{ on: view === 'detail' }" @click="toDetail()">按库位明细</span>
        </div>
        <span class="hd-sp"></span>
        <button class="btn" @click="doExport"><el-icon><Download/></el-icon> 导出</button>
      </div>
      <div class="filterbar">
        <div class="fctrl" style="width:200px"><el-select v-model="warehouseId" filterable clearable placeholder="全部仓库" @change="search">
          <el-option v-for="w in store.warehouses" :key="w.id" :label="w.name" :value="w.id"/>
        </el-select></div>
        <input class="finp w-key" v-model="kw" :disabled="!!drillKw" :placeholder="drillKw ? '钻取过滤：' + drillKw : '商品名称 / 条码'" @keyup.enter="search"/>
        <button class="btn" @click="search">查询</button>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)">
          <input type="checkbox" v-model="ifShowZero" @change="search"/>显示零库存</label>
        <span class="fb-gap"></span>
        <span class="muted">库存总量 <b style="color:var(--text)">{{ totalQty }}</b> ·
          货值约 <b style="color:var(--text)">{{ fmtMoney(totalValue) }}</b> 元 ·
          {{ view === 'prod' ? total + ' 个商品' : total + ' 条记录' }}<template v-if="lowCount"> ·
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
      <div class="pager" v-if="total > rows">
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
  </div>`,
};
