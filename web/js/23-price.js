'use strict';
/* web/js/23-price.js —— 由 app.js 拆分（lines 3502-4156） */
/* ================= 客户价格记忆 ================= */
const PricePage = {
  setup() {
    const kw = ref('');
    const partnerId = ref(null);
    const rows = ref([]);
    const total = ref(0);
    const loading = ref(false);
    const editor = reactive({ open: false, row: null, price: 0 });
    const guard = seqGuard();

    async function load() {
      loading.value = true;
      const my = guard.begin();
      try {
        const r = await api.get('/price/list', {
          teamId: store.teamId,
          partnerId: partnerId.value || '',
          kw: kw.value.trim(),
        });
        if (!guard.isCurrent(my)) return;
        rows.value = r.rows || [];
        total.value = r.total ?? (r.rows || []).length;
      } catch (e) {
        if (guard.isCurrent(my)) toast(e.message, 'error');
      } finally {
        if (guard.isCurrent(my)) loading.value = false;
      }
    }

    function openEdit(row) {
      editor.row = row;
      editor.price = row.price / 100;
      editor.open = true;
    }

    async function save() {
      // 先验原始输入：toCents 会把负数/NaN 静默转 0，导致「价格不能为负」守卫永不触发、
      // 用户输 -5 实际存成 0 元
      const n = Number(editor.price);
      if (!Number.isFinite(n) || n < 0) return toast('请输入不小于 0 的价格', 'error');
      const cents = toCents(n);
      try {
        await api.post('/price/set', {
          teamId: store.teamId,
          partnerId: editor.row.partnerId,
          productId: editor.row.productId,
          price: cents,
        });
        toast('已更新');
        editor.open = false;
        load();
      } catch (e) {
        toast(e.message, 'error');
      }
    }

    /* B-前6：删除走 confirmDeleteRow（确认/提示骨架共用；本页 editor 是 { open, row, price } 形态，不合 useCrudEditor） */
    function del(row) {
      return confirmDeleteRow(
        `删除「${row.cusName || '客户'} - ${row.prodName}」的价格记忆？`,
        () => api.del(`/price/${row.id}?teamId=${store.teamId}`),
        load,
      );
    }

    function diffOf(row) {
      if (!row.salePrice) return '';
      const d = row.price - row.salePrice;
      if (d === 0) return '平价';
      return d > 0 ? `高于标准价 ${fmtMoney(d)}` : `低于标准价 ${fmtMoney(-d)}`;
    }

    /* 导出当前筛选的价格记忆（业务员外出报价常用资料） */
    function doExport() {
      if (!sorted.value.length) return toast('没有可导出的数据', 'warning');
      exportCsv(
        `客户价格_${todayStr()}.csv`,
        sorted.value.map((r) =>
          moneyRow(
            {
              客户: r.cusName || '',
              商品: r.prodName,
              规格: r.spec || '',
              单位: r.unit || '',
              记忆价: r.price,
              标准售价: r.salePrice || '',
              对比: diffOf(r),
              最近成交: r.lastDate || '',
              成交次数: r.times ?? 0,
            },
            ['记忆价', '标准售价'],
          ),
        ),
        [
          { key: '客户', label: '客户' },
          { key: '商品', label: '商品' },
          { key: '规格', label: '规格' },
          { key: '单位', label: '单位' },
          { key: '记忆价', label: '记忆价(元)' },
          { key: '标准售价', label: '标准售价(元)' },
          { key: '对比', label: '对比' },
          { key: '最近成交', label: '最近成交' },
          { key: '成交次数', label: '成交次数' },
        ],
      );
    }

    onMounted(load);
    // 排序：默认按最近成交日期，也可按成交次数/与标准售价的偏差看
    const sortBy = ref('default');
    const sorted = computed(() => {
      const arr = [...rows.value];
      if (sortBy.value === 'times') {
        arr.sort((a, b) => (b.times ?? 0) - (a.times ?? 0));
      } else if (sortBy.value === 'diffAsc') {
        // 低于标准售价最多（对客户最优惠）排前
        arr.sort((a, b) => a.price - (a.salePrice ?? 0) - (b.price - (b.salePrice ?? 0)));
      } else if (sortBy.value === 'diffDesc') {
        arr.sort((a, b) => b.price - (b.salePrice ?? 0) - (a.price - (a.salePrice ?? 0)));
      } else if (sortBy.value === 'lastDate') {
        arr.sort((a, b) => String(b.lastDate || '').localeCompare(String(a.lastDate || '')));
      }
      return arr;
    });
    return {
      kw,
      partnerId,
      rows,
      total,
      sorted,
      sortBy,
      loading,
      editor,
      load,
      openEdit,
      save,
      del,
      diffOf,
      store,
      fmtMoney,
      doExport,
    };
  },
  template: `
  <div>
    <div class="page-card">
      <div class="page-head">
        <span class="page-title">客户价格记忆</span>
        <div class="hd-right">
          <button class="btn" @click="doExport"><el-icon><Download/></el-icon> 导出</button>
          <button class="btn" @click="load"><el-icon><Refresh/></el-icon> 刷新</button>
        </div>
      </div>

      <div class="filterbar">
        <input class="finp" style="width:150px" v-model="kw" placeholder="商品名称" @keyup.enter="load"/>
        <el-select v-model="partnerId" filterable clearable placeholder="全部客户" style="width:170px" @change="load">
          <el-option v-for="c in store.customers" :key="c.id" :label="c.name" :value="c.id"/>
        </el-select>
        <button class="btn" @click="load">查询</button>
        <el-select v-model="sortBy" style="width:170px" placeholder="排序">
          <el-option label="最近成交优先" value="default"/>
          <el-option label="成交次数高→低" value="times"/>
          <el-option label="低于标准价最多" value="diffAsc"/>
          <el-option label="高于标准价最多" value="diffDesc"/>
        </el-select>
        <span class="muted" style="font-size:12.5px;margin-left:6px">共 {{ rows.length }} 条<template v-if="total > rows.length">（共 {{ total }} 条，仅显示最近 500 条，请按客户筛选）</template></span>
      </div>

      <sk-table v-if="loading && !rows.length" :rows="8" :cols="11"/>
      <table class="tbl" v-else>
        <thead><tr>
          <th style="width:52px" class="r">#</th>
          <th>客户</th><th>商品</th><th>规格</th><th>单位</th>
          <th class="r">记忆成交价</th><th class="r">商品标准售价</th><th>对比</th>
          <th>最后一次成交</th><th class="r">成交次数</th><th style="width:130px">操作</th>
        </tr></thead>
        <tbody>
          <tr v-if="!rows.length"><td colspan="11"><div class="empty">暂无价格记忆。销售类单据审核后，系统会自动记住每个客户的成交价。</div></td></tr>
          <tr v-for="(r, i) in sorted" :key="r.id">
            <td class="r muted">{{ i + 1 }}</td>
            <td>{{ r.cusName || '—' }}</td>
            <td style="font-weight:500">{{ r.prodName }}</td>
            <td class="muted">{{ r.spec || '—' }}</td>
            <td class="muted">{{ r.unit || '—' }}</td>
            <td class="r money"><b>{{ fmtMoney(r.price) }}</b></td>
            <td class="r money muted">{{ fmtMoney(r.salePrice) }}</td>
            <td :class="r.price > r.salePrice ? 'txt-warn' : (r.price < r.salePrice ? 'txt-ok' : 'muted')">{{ diffOf(r) }}</td>
            <td class="muted">{{ r.lastDate || '—' }}</td>
            <td class="r">{{ r.times }}</td>
            <td>
              <button class="btn sm" @click="openEdit(r)">改价</button>
              <button class="btn sm danger" style="margin-left:6px" @click="del(r)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="modal-mask" v-if="editor.open" @click.self="editor.open = false">
      <div class="modal narrow">
        <div class="modal-head"><span class="mt">修改价格记忆</span><span class="x" @click="editor.open = false">×</span></div>
        <div class="modal-body">
          <div class="fitem"><label>客户</label><div>{{ editor.row.cusName }}</div></div>
          <div class="fitem"><label>商品</label><div>{{ editor.row.prodName }}（标准价 {{ fmtMoney(editor.row.salePrice) }}）</div></div>
          <div class="fitem"><label>记忆成交价(元)</label><input type="number" step="0.01" min="0" v-model.number="editor.price"/></div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="editor.open = false">取消</button>
          <button class="btn primary" @click="save">保存</button>
        </div>
      </div>
    </div>
  </div>`,
};
