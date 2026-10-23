'use strict';
/* web/js/14-ledger.js —— 由 app.js 拆分（lines 2372-2423） */
/* ================= 库存流水 ================= */
const LedgerPage = {
  components: { DocViewer },
  setup() {
    const productId = ref(null);
    const warehouseId = ref(null);
    const fRange = ref([]);
    const list = ref([]);
    const total = ref(0);
    const page = ref(1);
    const rows = ref(pageSizeOf('ledger', 50));
    const loading = ref(true);
    const viewerId = ref(null);
    // 关联单据单号：一次批量取，避免每条流水单独查（原实现直接显示 #id）
    const docNos = ref({});

    async function load() {
      loading.value = true;
      try {
        const q = { teamId: store.teamId, page: page.value, rows: rows.value };
        if (productId.value) q.productId = productId.value;
        if (warehouseId.value) q.warehouseId = warehouseId.value;
        if (fRange.value?.length === 2) { q.from = fRange.value[0]; q.to = fRange.value[1]; }
        const r = await api.get('/stock/ledger', q);
        // 兼容旧接口返回数组
        if (Array.isArray(r)) { list.value = r; total.value = r.length; }
        else { list.value = r.rows || []; total.value = r.total || 0; }
        loadDocNos();
      } catch (e) {
        toast('库存流水加载失败：' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    }

    async function loadDocNos() {
      const ids = [...new Set(list.value.map((l) => l.refDocId).filter(Boolean))]
        .filter((id) => !docNos.value[id]);
      if (!ids.length) return;
      try {
        const map = await api.get('/doc/bill-nos', { teamId: store.teamId, ids: ids.join(',') });
        const next = { ...docNos.value };
        for (const id of ids) next[id] = map?.[String(id)]?.billNo ?? ('#' + id);
        docNos.value = next;
      } catch { /* 单号只是展示信息，失败不影响流水本身 */ }
    }

    function resetFilter() {
      productId.value = null; warehouseId.value = null; fRange.value = [];
      page.value = 1; load();
    }
    function onPage(p) { page.value = p; load(); }
    function onSize(n) { rows.value = n; pageSizeSave('ledger', n); page.value = 1; load(); }
    function search() { page.value = 1; load(); }

    function doExport() {
      if (!list.value.length) return toast('没有可导出的流水', 'warning');
      const prodName = (id) => byId(store.products, id)?.name ?? '#' + id;
      const whName = (id) => byId(store.warehouses, id)?.name ?? '—';
      exportCsv(
        `库存流水_${todayStr()}.csv`,
        list.value.map((l) => ({
          createdAt: l.createdAt, prod: prodName(l.productId), wh: whName(l.warehouseId),
          batchNo: l.batchNo || '—', dir: l.direction === 'in' ? '入库' : '出库', qty: l.qty,
          cost: (l.unitCost / 100).toFixed(2), doc: docNos.value[l.refDocId] ?? ('#' + l.refDocId),
        })),
        [
          { key: 'createdAt', label: '时间' }, { key: 'prod', label: '商品' }, { key: 'wh', label: '仓库' },
          { key: 'batchNo', label: '批次' }, { key: 'dir', label: '方向' }, { key: 'qty', label: '数量' },
          { key: 'cost', label: '成本单价(元)' }, { key: 'doc', label: '关联单据' },
        ],
      );
    }

    onMounted(load);
    return {
      productId, warehouseId, fRange, list, total, page, rows, loading, viewerId, docNos,
      load, resetFilter, onPage, onSize, search, doExport, store, fmtMoney,
    };
  },
  template: `
  <div>
    <div class="page-card">
      <div class="page-head">
        <span class="hd-title">库存流水</span>
        <span class="hd-sp"></span>
        <div class="hd-right"><button class="btn" @click="doExport">导出</button></div>
      </div>
      <div class="filterbar">
        <div class="fctrl" style="width:240px"><el-select v-model="productId" filterable clearable placeholder="全部商品" @change="search">
          <el-option v-for="p in store.products" :key="p.id" :label="p.name + (p.spec ? '（' + p.spec + '）' : '')" :value="p.id"/>
        </el-select></div>
        <el-select v-model="warehouseId" clearable placeholder="全部仓库" style="width:150px" @change="search">
          <el-option v-for="w in store.warehouses" :key="w.id" :label="w.name" :value="w.id"/>
        </el-select>
        <el-date-picker v-model="fRange" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" class="finp" style="width:240px" @change="search"/>
        <button class="btn" @click="search">查询</button>
        <button class="btn icon-only" title="重置" @click="resetFilter"><el-icon><RefreshLeft/></el-icon></button>
        <span class="fb-gap"></span>
        <span class="muted fb-count">共 {{ total }} 条</span>
      </div>
      <div class="tbl-wrap">
        <sk-table v-if="loading && !list.length" :rows="8" :cols="8"/>
        <table class="tbl" v-else>
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
              <td><span class="link" @click="viewerId = l.refDocId">{{ docNos[l.refDocId] || ('#' + l.refDocId) }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="pager" v-if="total > rows">
        <el-pagination background layout="total, sizes, prev, pager, next" :total="total"
          :current-page="page" :page-size="rows" :page-sizes="[50, 100, 200]"
          @current-change="onPage" @size-change="onSize"/>
      </div>
    </div>
    <doc-viewer :doc-id="viewerId" @close="viewerId = null"/>
  </div>`,
};
