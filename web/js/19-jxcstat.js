'use strict';
/* web/js/19-jxcstat.js —— 由 app.js 拆分（lines 2959-3079） */
/* ================= 进销存统计 ================= */
const JxcStatPage = {
  setup() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const range = reactive([`${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, today]);
    const loading = ref(false);
    const byType = ref([]);
    const rows = ref([]);
    const totals = ref({ inQty: 0, inAmount: 0, outQty: 0, outAmount: 0 });

    const TYPE_LABEL = {
      stockin: '采购入库', pin: '采购退货', stockout: '销售出库', sret: '销售退货',
      otherin: '其它入库', otherout: '其它出库', transfer: '转仓调拨', adjust: '库存调整',
      stocktake: '库存盘点', assembly: '生产组装', stockinit: '期初库存',
    };
    const IN_SET = new Set(['stockin', 'otherin', 'sret', 'stockinit']);
    const OUT_SET = new Set(['stockout', 'otherout', 'pin']);

    async function load() {
      if (!range[0] || !range[1]) return toast('请选择日期范围', 'error');
      loading.value = true;
      try {
        const r = await api.get('/report/jxc-stat', { teamId: store.teamId, from: range[0], to: range[1] });
        byType.value = (r.byType || []).map((b) => ({
          ...b,
          label: TYPE_LABEL[b.type] || b.type,
          dir: IN_SET.has(b.type) ? '入' : OUT_SET.has(b.type) ? '出' : '—',
        }));
        rows.value = r.rows || [];
        totals.value = r.totals || { inQty: 0, inAmount: 0, outQty: 0, outAmount: 0 };
      } catch (e) { toast(e.message, 'error'); }
      finally { loading.value = false; }
    }

    const cards = computed(() => [
      { label: '入库数量', val: totals.value.inQty, unit: '' },
      { label: '入库金额', val: fmtMoney(totals.value.inAmount), unit: '元' },
      { label: '出库数量', val: totals.value.outQty, unit: '' },
      { label: '出库金额', val: fmtMoney(totals.value.outAmount), unit: '元' },
    ]);

    function doExport() {
      exportCsv(`进销存统计_${range[0]}_${range[1]}.csv`,
        rows.value.map((r) => ({
          商品: r.prodName, 规格: r.spec || '', 单位: r.unit || '',
          入库数量: r.inQty, 入库金额: fmtMoney(r.inAmount),
          出库数量: r.outQty, 出库金额: fmtMoney(r.outAmount),
          结存数量: r.inQty - r.outQty,
        })), [
          { key: '商品', label: '商品' }, { key: '规格', label: '规格' }, { key: '单位', label: '单位' },
          { key: '入库数量', label: '入库数量' }, { key: '入库金额', label: '入库金额' },
          { key: '出库数量', label: '出库数量' }, { key: '出库金额', label: '出库金额' },
          { key: '结存数量', label: '结存数量' },
        ]);
    }

    onMounted(load);
    return { range, loading, byType, rows, totals, cards, load, doExport, fmtMoney };
  },
  template: `
  <div class="page-card">
    <div class="page-head">
      <div class="hd-title">进销存统计</div>
      <div class="hd-right">
        <button class="btn" @click="doExport"><el-icon><Download/></el-icon> 导出</button>
      </div>
    </div>
    <div class="filterbar">
      <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" style="width:260px" :clearable="false" @change="load"/>
      <button class="btn primary" :disabled="loading" @click="load">{{ loading ? '查询中…' : '查询' }}</button>
    </div>

    <div class="stat-grid">
      <div class="card stat" v-for="c in cards" :key="c.label">
        <div class="stat-label">{{ c.label }}</div>
        <div class="stat-val">{{ c.val }}<i class="kpi-unit" v-if="c.unit">{{ c.unit }}</i></div>
      </div>
    </div>

    <div class="card" style="margin:12px 0">
      <div class="card-title" style="margin-bottom:8px">按单据类型汇总</div>
      <table class="tbl">
        <thead><tr><th>单据类型</th><th class="r">方向</th><th class="r">单数</th><th class="r">数量</th><th class="r">金额</th></tr></thead>
        <tbody>
          <tr v-for="b in byType" :key="b.type">
            <td>{{ b.label }}</td>
            <td class="r"><span :class="['tag', b.dir === '入' ? 'ok' : b.dir === '出' ? 'warn' : '']">{{ b.dir }}</span></td>
            <td class="r">{{ b.count }}</td><td class="r">{{ b.qty }}</td><td class="r">{{ fmtMoney(b.amount) }}</td>
          </tr>
          <tr v-if="!byType.length"><td colspan="5" class="muted" style="text-align:center;padding:22px">该范围内没有已审核单据。</td></tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-title" style="margin-bottom:8px">按商品汇总（入 = 采购入库/其它入库/销售退货，出 = 销售出库/其它出库/采购退货）</div>
      <table class="tbl">
        <thead><tr><th class="r" style="width:52px">#</th><th>商品</th><th>规格</th><th>单位</th><th class="r">入库数量</th><th class="r">入库金额</th><th class="r">出库数量</th><th class="r">出库金额</th><th class="r">结存数量</th></tr></thead>
        <tbody>
          <tr v-for="(r, i) in rows" :key="r.productId">
            <td class="r muted">{{ i + 1 }}</td>
            <td>{{ r.prodName }}</td><td>{{ r.spec || '—' }}</td><td>{{ r.unit || '—' }}</td>
            <td class="r">{{ r.inQty }}</td><td class="r">{{ fmtMoney(r.inAmount) }}</td>
            <td class="r">{{ r.outQty }}</td><td class="r">{{ fmtMoney(r.outAmount) }}</td>
            <td class="r"><b>{{ r.inQty - r.outQty }}</b></td>
          </tr>
          <tr v-if="!rows.length"><td colspan="9" class="muted" style="text-align:center;padding:22px">该范围内没有出入库记录。</td></tr>
          <tr v-else style="background:#f7f9fb;font-weight:600">
            <td colspan="4" style="text-align:right">合计</td>
            <td class="r">{{ totals.inQty }}</td><td class="r">{{ fmtMoney(totals.inAmount) }}</td>
            <td class="r">{{ totals.outQty }}</td><td class="r">{{ fmtMoney(totals.outAmount) }}</td>
            <td class="r">{{ totals.inQty - totals.outQty }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>`,
};

