'use strict';
/* web/js/14-ledger.js —— 由 app.js 拆分（lines 2372-2423） */
/* ================= 库存流水 ================= */
const LedgerPage = {
  components: { DocViewer },
  setup() {
    const productId = ref(null);
    const list = ref([]);
    const loading = ref(true);
    const viewerId = ref(null);

    async function load() {
      loading.value = true;
      try {
        list.value = await api.get('/stock/ledger', { teamId: store.teamId, productId: productId.value });
      } catch (e) {
        toast('库存流水加载失败：' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    }
    onMounted(load);
    return { productId, list, loading, viewerId, load, store, fmtMoney };
  },
  template: `
  <div>
    <div class="page-card">
      <div class="page-head">
        <span class="hd-title">库存流水</span>
        <span class="hd-sp"></span>
      </div>
      <div class="filterbar">
        <div class="fctrl" style="width:260px"><el-select v-model="productId" filterable clearable placeholder="全部商品" @change="load">
          <el-option v-for="p in store.products" :key="p.id" :label="p.name + (p.spec ? '（' + p.spec + '）' : '')" :value="p.id"/>
        </el-select></div>
        <button class="btn" @click="load">查询</button>
        <span class="fb-gap"></span>
        <span class="muted">共 {{ list.length }} 条<template v-if="list.length >= 200">（仅显示最近 200 条）</template></span>
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
              <td><span class="link" @click="viewerId = l.refDocId">单据 #{{ l.refDocId }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <doc-viewer :doc-id="viewerId" @close="viewerId = null"/>
  </div>`,
};

