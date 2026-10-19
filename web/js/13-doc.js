'use strict';
/* web/js/13-doc.js —— 由 app.js 拆分（lines 1602-2371） */
/* ================= 单据页（列表 + 整页开单，对齐橙子云布局） ================= */
const DocPage = {
  components: { DocViewer },
  props: { group: { type: String, default: 'purchase' } },
  setup(props) {
    const grp = DOC_GROUPS[props.group] || DOC_GROUPS.purchase;
    const activeType = ref(grp.types.includes(route.q.type) ? route.q.type : grp.types[0]);
    const status = ref('');
    const kw = ref('');
    const page = ref(1);
    const rows = ref(20);
    const list = ref([]);
    const total = ref(0);
    // 筛选条：日期区间 + 往来单位（对齐橙子云列表页密集筛选条）
    const filterFrom = ref('');
    const filterTo = ref('');
    const filterPartner = ref(null);
    const viewerId = ref(null);
    const editor = reactive({ open: false, id: null, billNo: '', type: grp.types[0], form: null, status: '', ro: false });
    const saving = ref(false);
    const busyId = ref(null);
    /** 列表/明细分页签（真实橙子云有这个二级切换，明细=展开商品行） */
    const viewTab = ref('list');
    /** 复选框选中的单据 id（批量操作/批量提交用） */
    const selected = ref([]);
    const selAll = computed(() => list.value.length > 0 && list.value.every((d) => selected.value.includes(d.id)));

    function toggleAll(ev) {
      selected.value = ev.target.checked ? list.value.map((d) => d.id) : [];
    }
    function toggleOne(id, ev) {
      const set = new Set(selected.value);
      if (ev.target.checked) set.add(id); else set.delete(id);
      selected.value = [...set];
    }
    /* 当前仓库的库存快照：productId -> 可用数量（用于明细表「库存数量」列） */
    const stockMap = ref({});
    // 客户价格记忆：选中客户后批量取回，选商品时优先使用
    const priceMem = ref({});
    async function loadPriceMem(pid) {
      if (!pid) { priceMem.value = {}; return; }
      try {
        const r = await api.get('/price/memory', { teamId: store.teamId, partnerId: pid });
        const m = {};
        for (const it of r.list || []) m[it.productId] = it.price;
        priceMem.value = m;
      } catch { priceMem.value = {}; }
    }

    const meta = computed(() => DOC_META[activeType.value]);
    const partners = computed(() => meta.value.partner === 'ven' ? store.vendors : store.customers);
    const pages = computed(() => Math.max(1, Math.ceil(total.value / rows.value)));
    const pageBtns = computed(() => {
      const n = pages.value, c = page.value, arr = [];
      for (let p = 1; p <= n; p++) if (p === 1 || p === n || Math.abs(p - c) <= 2) arr.push(p);
      return arr;
    });
    function onRowsChange(e) { rows.value = Number(e.target.value) || 20; page.value = 1; load(); }

    /* 编辑态合计 */
    const grossAmt = computed(() => editor.form
      ? editor.form.items.reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0) : 0);
    const totalQty = computed(() => editor.form ? editor.form.items.reduce((s, it) => s + (Number(it.qty) || 0), 0) : 0);
    const totalAmt = computed(() => Math.max(0, grossAmt.value - (Number(editor.form?.discount) || 0)));
    const oweAmt = computed(() => Math.max(0, totalAmt.value - (Number(editor.form?.paidAmount) || 0) - (Number(editor.form?.deposit) || 0)));
    const emeta = computed(() => DOC_META[editor.type] || {});
    const epartners = computed(() => emeta.value.partner === 'ven' ? store.vendors : store.customers);
    /* 列表页底部合计 */
    const sumQty = computed(() => list.value.reduce((s, d) => s + (Number(d.totalQty) || 0), 0));
    const sumAmount = computed(() => list.value.reduce((s, d) => s + (Number(d.totalAmount) || 0), 0));
    const sumPaid = computed(() => list.value.reduce((s, d) => s + (Number(d.paidAmount) || 0) + (Number(d.deposit) || 0), 0));
    /** 表尾合计行的前置单元格数：单号+日期+商品摘要+备注 = 4，另加可选的往来单位/仓库列 */
    const sumCols = computed(() => 4 + (meta.value.partner ? 1 : 0) + (meta.value.warehouse ? 1 : 0) + (meta.value.toWarehouse ? 1 : 0));

    async function load() {
      const r = await api.get('/doc/list', {
        teamId: store.teamId, type: activeType.value, status: status.value,
        kw: kw.value, page: page.value, rows: rows.value,
        from: filterFrom.value || '', to: filterTo.value || '',
        partnerId: filterPartner.value || '',
      });
      list.value = r.rows; total.value = r.total;
    }
    function resetFilter() {
      kw.value = ''; status.value = ''; filterFrom.value = ''; filterTo.value = '';
      filterPartner.value = null; page.value = 1; load();
    }
    async function loadStock(warehouseId) {
      if (!warehouseId) { stockMap.value = {}; return; }
      const rows2 = await api.get('/stock/list', { teamId: store.teamId, warehouseId, ifShowZero: '' });
      const m = {};
      for (const r of rows2) m[r.productId] = (m[r.productId] || 0) + r.qty;
      stockMap.value = m;
    }
    watch(activeType, () => { page.value = 1; load(); });
    watch(() => route.q.type, (t) => {
      if (t && DOC_META[t] && grp.types.includes(t) && t !== activeType.value) activeType.value = t;
    });
    watch(() => editor.form && editor.form.warehouseId, (w) => { if (editor.open && emeta.value.warehouse) loadStock(w); });
    // 换客户：重新拉该客户的价格记忆，并把「未手改过」的行价刷成记忆价
    watch(() => editor.form && editor.form.partnerId, async (pid, old) => {
      if (!editor.open || !emeta.value.partner) return;
      await loadPriceMem(pid);
      const f = emeta.value.priceField;
      if (!f || old === undefined) return;
      for (const it of editor.form.items) {
        if (!it.productId) continue;
        const mem = priceMem.value[it.productId];
        if (mem != null) it.price = mem / 100;
      }
    });
    onMounted(() => {
      load();
      if (route.q.new) openEditor(null, activeType.value);
    });

    function blankItem() {
      return { productId: null, qty: 1, price: 0, batchNo: '', toWarehouseId: null, remark: '' };
    }
    function blankForm() {
      return {
        date: todayStr(),
        partnerId: null, clerkId: null,
        warehouseId: store.warehouses[0]?.id ?? null,
        remark: '',
        receiverName: '', receiverMobile: '', receiverAddress: '',
        discount: 0, paidAmount: 0, accountId: null, deposit: 0,
        items: [blankItem()],
      };
    }
    function onPick(it) {
      const p = byId(store.products, it.productId);
      if (!p) return;
      let f = emeta.value.priceField;
      if (!f || Number(it.price)) return;
      // 客户价格等级（批发价/零售价）优先，再退到单据默认价格字段
      if (emeta.value.partner === 'cus' && editor.form.partnerId) {
        const cus = byId(store.customers, editor.form.partnerId);
        if (cus && cus.priceLevel && cus.priceLevel in p) f = cus.priceLevel;
      }
      // 客户价格记忆优先于商品标准价（一客一价是批发场景的常态）
      const mem = priceMem.value[it.productId];
      it.price = (mem != null ? mem : (p[f] || 0)) / 100;
    }
    function openEditor(row, type) {
      editor.type = type || activeType.value;
      if (row) {
        api.get('/doc/info', { id: row.id, teamId: store.teamId }).then(({ doc, items }) => {
          editor.id = doc.id; editor.billNo = doc.billNo;
          /*
           * 只读态：已审核 / 已作废 / 待审核 的单据不允许再改内容。
           * 之前完全没有这个判断，导致「查看明细」进去后能改数量单价再点「保存草稿」，
           * 把已过账单据的库存与结算依据擅自改掉。
           */
          editor.status = doc.status;
          editor.ro = doc.status !== 'draft';
          editor.form = {
            date: (doc.date || '').slice(0, 10),
            partnerId: doc.partnerId, clerkId: doc.clerkId,
            warehouseId: doc.warehouseId || store.warehouses[0]?.id || null,
            remark: doc.remark || '',
            receiverName: doc.receiverName || '', receiverMobile: doc.receiverMobile || '',
            receiverAddress: doc.receiverAddress || '',
            discount: (doc.discount || 0) / 100, paidAmount: (doc.paidAmount || 0) / 100,
            accountId: doc.accountId || null, deposit: (doc.deposit || 0) / 100,
            items: items.map(it => ({
              productId: it.productId, qty: it.qty, price: (it.price || 0) / 100,
              batchNo: it.batchNo || '', toWarehouseId: it.toWarehouseId, remark: it.remark || '',
            })),
          };
          if (!editor.form.items.length) editor.form.items.push(blankItem());
          editor.open = true;
          if (emeta.value.warehouse) loadStock(editor.form.warehouseId);
          loadPriceMem(editor.form.partnerId);
        }).catch(e => toast(e.message, 'error'));
      } else {
        editor.id = null; editor.billNo = '';
        editor.status = 'draft'; editor.ro = false;
        editor.form = blankForm();
        editor.open = true;
        if (emeta.value.warehouse) loadStock(editor.form.warehouseId);
      }
    }
    function backToList() { editor.open = false; load(); }
    function addItem() { editor.form.items.push(blankItem()); }
    function removeItem(idx) {
      if (editor.form.items.length <= 1) return toast('至少保留一行明细', 'error');
      editor.form.items.splice(idx, 1);
    }
    /* 扫码开单：按条码（或商品名精确匹配）找到商品 → 已有行则数量+1，否则新增行 */
    function scanBarcode(code) {
      const s = String(code || '').trim();
      if (!s || !editor.form) return;
      const p = store.products.find((x) => (x.barcode || '').trim() === s);
      if (!p) return toast(`未找到条码 ${s} 对应的商品`, 'warning');
      const hit = editor.form.items.find((it) => it.productId === p.id);
      if (hit) { hit.qty = (Number(hit.qty) || 0) + 1; return toast(`${p.name} 数量 +1`); }
      // 复用末尾空行
      const empty = editor.form.items.find((it) => !it.productId);
      const row = empty || blankItem();
      row.productId = p.id;
      row.qty = 1;
      row.price = 0;
      onPick(row);
      if (!empty) editor.form.items.push(row);
      toast(`已加入 ${p.name}`);
    }
    const scanCode = ref('');
    function doScan() {
      scanBarcode(scanCode.value);
      scanCode.value = '';
    }
    function lineAmt(it) { return ((Number(it.qty) || 0) * (Number(it.price) || 0)).toFixed(2); }
    function stockOf(pid) { return stockMap.value[pid] ?? 0; }
    function setFullPaid() {
      if (!editor.form) return;
      editor.form.paidAmount = Number(totalAmt.value.toFixed(2));
    }
    function fullDiscount() {
      if (!editor.form) return;
      editor.form.discount = Number(grossAmt.value.toFixed(2));
    }

    async function persist() {
      const m = emeta.value;
      const f = editor.form;
      if (m.warehouse && !f.warehouseId) throw new Error('请选择仓库');
      if (!f.items.length) throw new Error('至少一条明细');
      for (const [i, it] of f.items.entries()) {
        if (!it.productId) throw new Error(`第 ${i + 1} 行未选商品`);
        if (!Number(it.qty)) throw new Error(`第 ${i + 1} 行数量不能为 0`);
        if (!m.negative && Number(it.qty) < 0) throw new Error(`第 ${i + 1} 行数量不能为负`);
        if (Number(it.price) < 0) throw new Error(`第 ${i + 1} 行单价不能为负`);
      }
      if (Number(f.discount) > grossAmt.value) throw new Error('整单折扣不能超过单据金额');
      if (Number(f.paidAmount) + Number(f.deposit) > totalAmt.value) {
        throw new Error('本次收款 + 抵扣订金不能超过应收金额');
      }
      const body = {
        teamId: store.teamId, type: editor.type, date: f.date,
        partnerType: m.partner || null, partnerId: f.partnerId || null,
        clerkId: f.clerkId || null,
        warehouseId: m.warehouse ? f.warehouseId : null,
        remark: f.remark || null,
        receiverName: f.receiverName || null,
        receiverMobile: f.receiverMobile || null,
        receiverAddress: f.receiverAddress || null,
        discount: Math.round((Number(f.discount) || 0) * 100),
        paidAmount: Math.round((Number(f.paidAmount) || 0) * 100),
        accountId: f.accountId || null,
        deposit: Math.round((Number(f.deposit) || 0) * 100),
        items: f.items.map(it => ({
          productId: it.productId, qty: Number(it.qty), price: Math.round(Number(it.price) * 100),
          batchNo: it.batchNo || null, toWarehouseId: it.toWarehouseId || null, remark: it.remark || null,
        })),
      };
      if (editor.id) {
        await api.put('/doc/edit', { id: editor.id, ...body });
        return editor.id;
      }
      const r = await api.post('/doc/create', body);
      editor.id = r.id; editor.billNo = r.billNo;
      return r.id;
    }

    async function save() {
      if (saving.value) return;
      saving.value = true;
      try {
        await persist();
        toast('已保存');
        editor.open = false;
        load();
      } catch (e) { toast(e.message, 'error'); }
      finally { saving.value = false; }
    }

    async function saveAndAudit() {
      if (saving.value) return;
      saving.value = true;
      try {
        const id = await persist();
        await api.post('/doc/audit', { teamId: store.teamId, id });
        toast('已保存并审核');
        editor.open = false;
        load();
      } catch (e) { toast(e.message, 'error'); }
      finally { saving.value = false; }
    }

    async function audit(row) {
      if (busyId.value) return;
      if (!(await confirmBox(`审核后「${row.billNo}」将过账写入库存与往来余额，确认审核？`))) return;
      busyId.value = row.id;
      try { await api.post('/doc/audit', { teamId: store.teamId, id: row.id, auditBy: store.team?.name || '管理员' }); toast('已审核'); load(); }
      catch (e) { toast(e.message, 'error'); }
      finally { busyId.value = null; }
    }
    /** 提交审核：草稿 -> 待审核 */
    async function submitDoc(row) {
      if (busyId.value) return;
      busyId.value = row.id;
      try { await api.post('/doc/submit', { teamId: store.teamId, id: row.id }); toast('已提交审核'); load(); }
      catch (e) { toast(e.message, 'error'); }
      finally { busyId.value = null; }
    }
    /** 驳回：待审核 -> 草稿（需填原因） */
    async function rejectDoc(row) {
      if (busyId.value) return;
      let reason = '';
      try {
        const r = await ElMessageBox.prompt('请输入驳回原因（可留空）', `驳回 ${row.billNo}`, {
          confirmButtonText: '确认驳回', cancelButtonText: '取消',
          inputPlaceholder: '如：价格录错，请核对后重新提交', inputValue: '',
        });
        reason = (r.value || '').trim();
      } catch { return; }
      busyId.value = row.id;
      try { await api.post('/doc/reject', { teamId: store.teamId, id: row.id, reason }); toast('已驳回，单据回到草稿'); load(); }
      catch (e) { toast(e.message, 'error'); }
      finally { busyId.value = null; }
    }
    /** 批量提交当前页草稿 */
    async function submitAllDrafts() {
      const ids = list.value.filter((d) => d.status === 'draft').map((d) => d.id);
      if (!ids.length) return toast('当前页没有草稿', 'warning');
      if (!(await confirmBox(`将当前页 ${ids.length} 张草稿全部提交审核？`))) return;
      try {
        const r = await api.post('/doc/submit-batch', { teamId: store.teamId, ids });
        toast(`已提交 ${r.done} 张${r.skipped?.length ? `，跳过 ${r.skipped.length} 张` : ''}`);
        load();
      } catch (e) { toast(e.message, 'error'); }
    }
    async function voidDoc(row) {
      if (busyId.value) return;
      if (!(await confirmBox(`作废「${row.billNo}」将反向冲回库存与往来余额，确认作废？`))) return;
      busyId.value = row.id;
      try { await api.post('/doc/void', { teamId: store.teamId, id: row.id }); toast('已作废'); load(); }
      catch (e) { toast(e.message, 'error'); }
      finally { busyId.value = null; }
    }
    async function delDoc(row) {
      if (busyId.value) return;
      if (!(await confirmBox(`删除草稿「${row.billNo}」？删除后不可恢复。`))) return;
      busyId.value = row.id;
      try { await api.del(`/doc/${row.id}`, { teamId: store.teamId }); toast('已删除'); load(); }
      catch (e) { toast(e.message, 'error'); }
      finally { busyId.value = null; }
    }
    async function convert(row) {
      if (busyId.value) return;
      const m = DOC_META[row.type];
      if (!(await confirmBox(`将订单「${row.billNo}」转化为${DOC_META[m.convertTo].label}草稿？`))) return;
      busyId.value = row.id;
      try {
        const r = await api.post('/doc/convert', { teamId: store.teamId, id: row.id });
        toast(`已生成 ${r.billNo}`);
        activeType.value = m.convertTo;
      } catch (e) { toast(e.message, 'error'); }
      finally { busyId.value = null; }
    }
    /** 明细视图数据：展开当前页所有单据的商品行 */
    const flatItems = ref([]);
    async function loadFlatItems() {
      const rows = [];
      for (const d of list.value) {
        try {
          const info = await api.get('/doc/info', { teamId: store.teamId, id: d.id });
          for (const it of (info.items || [])) {
            rows.push({
              docId: d.id, billNo: d.billNo, date: d.date, status: d.status,
              partnerName: partnerLabel(d),
              prodName: it.prodName || prodLabel(it.productId),
              spec: it.spec || specOf(it.productId), unit: it.unit || unitOf(it.productId),
              qty: it.qty, price: it.price, amount: it.amount,
            });
          }
        } catch { /* 单张失败不影响整体 */ }
      }
      flatItems.value = rows;
    }
    watch(viewTab, (v) => { if (v === 'summary') loadFlatItems(); });

    async function copyDoc(row) {
      if (busyId.value) return;
      busyId.value = row.id;
      try {
        const r = await api.post('/doc/copy', { teamId: store.teamId, id: row.id });
        toast(`已复制为草稿 ${r.billNo}（批次/库位未复制，请编辑确认后审核）`);
        load();
      } catch (e) { toast(e.message, 'error'); }
      finally { busyId.value = null; }
    }
    /** 操作列「更多」下拉的统一分发：按 command 调对应动作 */
    function moreAction(cmd, row) {
      switch (cmd) {
        case 'audit': audit(row); break;
        case 'edit': openEditor(row, activeType.value); break;
        case 'view': viewerId.value = row.id; break;
        case 'copy': copyDoc(row); break;
        case 'delete': delDoc(row); break;
        case 'void': voidDoc(row); break;
        default: break;
      }
    }
    function doExport() {
      exportCsv(`${DOC_META[activeType.value].label}列表.csv`, list.value.map((d) => ({
        billNo: d.billNo, date: (d.date || '').slice(0, 10),
        partner: partnerLabel(d) || '', warehouse: whLabel(d.warehouseId) || '',
        totalQty: d.totalQty, totalAmount: (Number(d.totalAmount) / 100).toFixed(2),
        status: STATUS_TEXT[d.status] || d.status, remark: d.remark || '',
      })), [
        { key: 'billNo', label: '单号' }, { key: 'date', label: '日期' },
        { key: 'partner', label: '往来单位' }, { key: 'warehouse', label: '仓库' },
        { key: 'totalQty', label: '合计数量' }, { key: 'totalAmount', label: '合计金额(元)' },
        { key: 'status', label: '状态' }, { key: 'remark', label: '备注' },
      ]);
    }
    return {
      grp, activeType, status, kw, page, rows, list, total, pages, pageBtns, viewerId, editor,
      meta, emeta, partners, epartners, stockMap, grossAmt, totalQty, totalAmt, oweAmt, saving, busyId,
      load, openEditor, backToList, addItem, removeItem, onPick, lineAmt, stockOf, priceMem, loadPriceMem, setFullPaid, fullDiscount,
      scanCode, doScan, scanBarcode, viewTab, selected, selAll, toggleAll, toggleOne, flatItems, loadFlatItems,
      save, saveAndAudit, audit, submitDoc, rejectDoc, submitAllDrafts, voidDoc, delDoc, convert, copyDoc, doExport, onRowsChange, moreAction,
      filterFrom, filterTo, filterPartner, resetFilter, sumQty, sumAmount, sumPaid, sumCols,
      fmtMoney, partnerLabel, whLabel, prodLabel, store, STATUS_TEXT, DOC_META, specOf, unitOf,
    };
  },
  template: `
  <!-- ===== 列表态 ===== -->
  <div class="page-card" v-if="!editor.open">
    <div class="page-head">
      <span class="page-title">{{ DOC_META[activeType].label }}</span>
      <div class="tabs">
        <span class="tb" :class="{ on: viewTab === 'list' }" @click="viewTab = 'list'">列表</span>
        <span class="tb" :class="{ on: viewTab === 'summary' }" @click="viewTab = 'summary'">明细</span>
      </div>
    </div>
    <!-- 单据类型页签（列表/明细之下） -->
    <div class="typebar">
      <span class="tbt" v-for="t in grp.types" :key="t" :class="{ on: t === activeType }" @click="activeType = t">{{ DOC_META[t].label }}</span>
    </div>
    <div class="filterbar">
      <el-date-picker v-model="filterFrom" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" class="finp w-date" @change="page=1;load()"/>
      <span class="muted">至</span>
      <el-date-picker v-model="filterTo" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" class="finp w-date" @change="page=1;load()"/>
      <el-select v-model="status" clearable placeholder="全部状态" style="width:110px" @change="page=1;load()">
        <el-option label="草稿" value="draft"/><el-option label="待审核" value="pending"/><el-option label="已审核" value="audit"/><el-option label="已作废" value="void"/>
      </el-select>
      <el-select v-if="meta.partner" v-model="filterPartner" clearable filterable placeholder="全部往来单位" style="width:170px" @change="page=1;load()">
        <el-option v-for="c in partners" :key="c.id" :label="c.name" :value="c.id"/>
      </el-select>
      <input class="finp w-key" v-model="kw" placeholder="单号 / 备注 模糊" @keyup.enter="page=1;load()"/>
      <button class="btn" @click="page=1;load()">查询</button>
      <button class="btn icon-only" title="重置" @click="resetFilter"><el-icon><RefreshLeft/></el-icon></button>
      <button class="btn icon-only" title="刷新" @click="load()"><el-icon><Refresh/></el-icon></button>
      <span class="fb-gap"></span>
      <span class="muted fb-count">共 {{ total }} 条</span>
      <button class="btn" @click="submitAllDrafts">批量提交</button>
      <button class="btn primary" @click="openEditor(null, activeType)">＋ 新增</button>
    </div>
    <div class="tbl-wrap">
      <!-- ===== 明细视图（把单据行展开成商品明细） ===== -->
      <table class="tbl tbl-list" v-if="viewTab === 'summary'">
        <thead><tr>
          <th style="width:15%">单号</th><th style="width:96px">日期</th>
          <th style="width:19%">商品</th><th style="width:80px">规格</th>
          <th style="width:56px">单位</th>
          <th class="r" style="width:70px">数量</th><th class="r" style="width:70px">单价</th>
          <th class="r" style="width:88px">金额</th>
          <th v-if="meta.partner" style="width:12%">{{ meta.partner === 'ven' ? '供应商' : '客户' }}</th>
          <th style="width:70px">状态</th>
        </tr></thead>
        <tbody>
          <tr v-for="(r, i) in flatItems" :key="i">
            <td><span class="billno link" @click="viewerId = r.docId">{{ r.billNo }}</span></td>
            <td nowrap style="width:96px">{{ (r.date || '').slice(0, 10) }}</td>
            <td><span class="ellip d-ib" :title="r.prodName">{{ r.prodName || '—' }}</span></td>
            <td><span class="ellip d-ib" :title="r.spec">{{ r.spec || '—' }}</span></td>
            <td>{{ r.unit || '—' }}</td>
            <td class="r">{{ r.qty }}</td>
            <td class="r money">{{ fmtMoney(r.price) }}</td>
            <td class="r money">{{ fmtMoney(r.amount) }}</td>
            <td v-if="meta.partner"><span class="ellip d-ib" :title="r.partnerName">{{ r.partnerName || '—' }}</span></td>
            <td><span class="tag" :class="'st-' + r.status">{{ STATUS_TEXT[r.status] || r.status }}</span></td>
          </tr>
          <tr v-if="!flatItems.length"><td :colspan="meta.partner ? 10 : 9"><div class="empty">暂无明细</div></td></tr>
        </tbody>
      </table>

      <!-- ===== 列表视图 ===== -->
      <table class="tbl tbl-list" v-if="viewTab === 'list'">
        <thead><tr>
          <th style="width:34px" class="ck"><input type="checkbox" :checked="selAll" @change="toggleAll($event)"/></th>
          <th style="width:13%">单号</th><th style="width:96px">日期</th>
          <th v-if="meta.partner" style="width:11%">{{ meta.partner === 'ven' ? '供应商' : '客户' }}</th>
          <th v-if="meta.warehouse" style="width:8%">仓库</th>
          <th v-if="meta.toWarehouse" style="width:9%">调往</th>
          <th style="width:19%">商品摘要</th><th style="width:10%">备注</th>
          <th class="r" style="width:50px">数量</th><th class="r" style="width:9%">金额</th>
          <th style="width:62px">状态</th><th style="width:238px">操作</th>
        </tr></thead>
        <tbody>
          <tr v-if="!list.length"><td :colspan="meta.toWarehouse ? 12 : 11"><div class="empty">暂无单据</div></td></tr>
          <tr v-for="d in list" :key="d.id">
            <td class="ck"><input type="checkbox" :checked="selected.includes(d.id)" @change="toggleOne(d.id, $event)"/></td>
            <td><span class="billno link" @click="viewerId = d.id">{{ d.billNo }}</span><div v-if="d.refOrderId" class="muted" style="font-size:11px">源单 #{{ d.refOrderId }}</div></td>
            <td nowrap style="width:96px">{{ (d.date || '').slice(0, 10) }}</td>
            <td v-if="meta.partner"><span class="ellip d-ib" :title="partnerLabel(d) || ''">{{ partnerLabel(d) || '—' }}</span></td>
            <td v-if="meta.warehouse"><span class="ellip d-ib" :title="whLabel(d.warehouseId) || ''">{{ whLabel(d.warehouseId) || '—' }}</span></td>
            <td v-if="meta.toWarehouse"><span class="ellip d-ib" :title="d.toWarehouseNames || ''">{{ d.toWarehouseNames || '—' }}</span></td>
            <td class="muted ellip" :title="d.summary || ''">
              {{ d.summary || '—' }}<template v-if="d.itemCount > 3"> 等 {{ d.itemCount }} 项</template>
            </td>
            <td class="muted ellip" :title="d.remark || ''">{{ d.remark || '—' }}</td>
            <td class="r" nowrap>{{ d.totalQty }}</td>
            <td class="r money" nowrap>{{ fmtMoney(d.totalAmount) }}</td>
            <td><span :class="'tag tag-' + d.status">{{ STATUS_TEXT[d.status] }}</span></td>
            <td>
              <!--
                操作列：只保留 1–2 个高频按钮，其余收进「更多」下拉。
                原因：草稿态原有 6 个按钮，把操作列挤到 238px 仍换行，右侧留白又被表格吃掉。
              -->
              <div class="row-actions" v-if="d.status === 'draft'">
                <button class="btn sm primary" :disabled="busyId === d.id" @click="submitDoc(d)">提交</button>
                <button class="btn sm" @click="viewerId = d.id">查看</button>
                <el-dropdown trigger="click" placement="bottom-end" @command="(c) => moreAction(c, d)">
                  <button class="btn sm more-btn">更多<el-icon class="more-ic"><ArrowDown/></el-icon></button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="audit" :disabled="busyId === d.id">直接审核</el-dropdown-item>
                      <el-dropdown-item command="edit">编辑单据</el-dropdown-item>
                      <el-dropdown-item command="copy">复制单据</el-dropdown-item>
                      <el-dropdown-item command="delete" divided>删除草稿</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
              <div class="row-actions" v-else-if="d.status === 'pending'">
                <button class="btn sm primary" :disabled="busyId === d.id" @click="audit(d)">{{ busyId === d.id ? '审核中…' : '审核' }}</button>
                <button class="btn sm" :disabled="busyId === d.id" @click="rejectDoc(d)">驳回</button>
                <el-dropdown trigger="click" placement="bottom-end" @command="(c) => moreAction(c, d)">
                  <button class="btn sm more-btn">更多<el-icon class="more-ic"><ArrowDown/></el-icon></button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="view">查看单据</el-dropdown-item>
                      <el-dropdown-item command="edit">查看明细</el-dropdown-item>
                      <el-dropdown-item command="copy">复制单据</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
              <div class="row-actions" v-else-if="d.status === 'audit'">
                <button v-if="DOC_META[d.type]?.order" class="btn sm primary" :disabled="busyId === d.id" @click="convert(d)">{{ DOC_META[d.type].convertLabel }}</button>
                <button class="btn sm" @click="viewerId = d.id">查看</button>
                <el-dropdown trigger="click" placement="bottom-end" @command="(c) => moreAction(c, d)">
                  <button class="btn sm more-btn">更多<el-icon class="more-ic"><ArrowDown/></el-icon></button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="copy">复制单据</el-dropdown-item>
                      <el-dropdown-item command="edit">查看明细</el-dropdown-item>
                      <el-dropdown-item command="void" divided>作废单据</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
              <div class="row-actions" v-else>
                <button class="btn sm" @click="viewerId = d.id">查看</button>
                <button class="btn sm" @click="openEditor(d, activeType)">明细</button>
              </div>
            </td>
          </tr>
        </tbody>
        <tfoot v-if="list.length">
          <tr class="sum-row">
            <td></td>
            <td :colspan="sumCols">本页合计</td>
            <td class="r">{{ sumQty }}</td>
            <td class="r money">{{ fmtMoney(sumAmount) }}</td>
            <td></td><td></td>
          </tr>
        </tfoot>
      </table>
    </div>
    <div class="pager">
      <button class="btn" @click="doExport"><el-icon><Download/></el-icon> 导出</button>
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

  <!-- ===== 整页开单态（对齐橙子云） ===== -->
  <div class="page-card doc-editor" v-else>
    <div class="de-head">
      <span class="de-title">{{ DOC_META[editor.type].label }}</span>
      <span class="billno" v-if="editor.billNo">{{ editor.billNo }}</span>
      <span v-else class="muted" style="font-size:12px">保存后自动生成单号</span>
      <span v-if="editor.ro" class="ro-badge">
        <el-icon><Lock/></el-icon>
        {{ STATUS_TEXT[editor.status] }} · 只读
      </span>
      <span class="de-sp"></span>
      <button class="btn" @click="backToList">返回列表</button>
      <template v-if="!editor.ro">
        <button class="btn" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存草稿' }}</button>
        <button class="btn primary" :disabled="saving" @click="saveAndAudit">保存并审核</button>
      </template>
    </div>
    <div class="ro-tip" v-if="editor.ro">
      该单据已{{ STATUS_TEXT[editor.status] }}，内容不可修改。如需调整请先作废并重新开单。
    </div>

    <div class="de-body" :class="{ ro: editor.ro }">
      <!-- 表头字段区：四列密集布局 -->
      <div class="de-grid">
        <div class="fi">
          <label>单号</label>
          <div class="fc"><input :value="editor.billNo || '保存后自动生成'" disabled/></div>
        </div>
        <div class="fi">
          <label><span class="req">*</span>日期</label>
          <div class="fc"><el-date-picker v-model="editor.form.date" type="date" value-format="YYYY-MM-DD" style="width:100%" :disabled="editor.ro"/></div>
        </div>
        <div class="fi" v-if="emeta.partner">
          <label><span class="req">*</span>{{ emeta.partner === 'ven' ? '供应商' : '客户' }}</label>
          <div class="fc">
            <el-select v-model="editor.form.partnerId" filterable clearable placeholder="搜索名称/拼音/手机" style="width:100%" :disabled="editor.ro">
              <el-option v-for="p in epartners" :key="p.id" :label="p.name" :value="p.id">
                <span>{{ p.name }}</span><span class="opt-sub">{{ p.mobile || '' }}</span>
              </el-option>
            </el-select>
          </div>
        </div>
        <div class="fi" v-if="emeta.warehouse">
          <label><span class="req">*</span>仓库</label>
          <div class="fc">
            <el-select v-model="editor.form.warehouseId" placeholder="选择仓库" style="width:100%" :disabled="editor.ro">
              <el-option v-for="w in store.warehouses" :key="w.id" :label="w.name" :value="w.id"/>
            </el-select>
          </div>
        </div>

        <div class="fi">
          <label>业务员</label>
          <div class="fc">
            <el-select v-model="editor.form.clerkId" filterable clearable placeholder="选择" style="width:100%" :disabled="editor.ro">
              <el-option v-for="c in store.clerks" :key="c.id" :label="c.name" :value="c.id"/>
            </el-select>
          </div>
        </div>

        <template v-if="emeta.partner === 'cus'">
          <div class="fi"><label>收件人</label><div class="fc"><input v-model="editor.form.receiverName" placeholder="收件人姓名" :disabled="editor.ro"/></div></div>
          <div class="fi"><label>收件手机</label><div class="fc"><input v-model="editor.form.receiverMobile" placeholder="联系电话" :disabled="editor.ro"/></div></div>
          <div class="fi"><label>收件地址</label><div class="fc"><input v-model="editor.form.receiverAddress" placeholder="详细地址" :disabled="editor.ro"/></div></div>
        </template>

        <div class="fi span-all"><label>备注</label><div class="fc"><input v-model="editor.form.remark" placeholder="整单备注" :disabled="editor.ro"/></div></div>
      </div>

      <!-- 明细表 -->
      <table class="item-edit">
        <thead><tr>
          <th style="min-width:240px">商品名称</th>
          <th style="width:90px">规格</th>
          <th style="width:60px">单位</th>
          <th style="width:80px" class="r">{{ emeta.stocktake ? '账面数量' : '库存数量' }}</th>
          <th style="width:90px" class="r">{{ emeta.stocktake ? '实盘数量' : '数量' }}</th>
          <th style="width:100px" class="r">单价(元)</th>
          <th style="width:100px" class="r">金额</th>
          <th v-if="emeta.batch" style="width:110px">批次</th>
          <th v-if="emeta.toWarehouse" style="width:130px">调往仓库</th>
          <th>行备注</th>
          <th style="width:46px"></th>
        </tr></thead>
        <tbody>
          <tr v-for="(it, idx) in editor.form.items" :key="idx">
            <td>
              <el-select v-model="it.productId" filterable placeholder="选择商品 / 输入编码" size="small" :disabled="editor.ro" @change="onPick(it)">
                <el-option v-for="p in store.products" :key="p.id" :label="p.name + (p.spec ? '（' + p.spec + '）' : '')" :value="p.id"/>
              </el-select>
            </td>
            <td class="muted">{{ specOf(it.productId) }}</td>
            <td class="muted">{{ unitOf(it.productId) }}</td>
            <td class="r" :class="{ 'stock-low': stockOf(it.productId) <= 0 && it.productId }">{{ stockOf(it.productId) }}</td>
            <td class="r"><input type="number" step="any" class="num" v-model.number="it.qty" :disabled="editor.ro"/></td>
            <td class="r">
              <input type="number" step="0.01" min="0" class="num" v-model.number="it.price" :disabled="editor.ro"/>
              <div v-if="priceMem[it.productId] != null" class="mem-price"
                :class="{ used: Math.round(it.price * 100) === priceMem[it.productId] }">
                记忆价 {{ fmtMoney(priceMem[it.productId]) }}
              </div>
            </td>
            <td class="r money-amt">{{ lineAmt(it) }}</td>
            <td v-if="emeta.batch"><input v-model="it.batchNo" placeholder="留空自动 FIFO" :disabled="editor.ro"/></td>
            <td v-if="emeta.toWarehouse">
              <select v-model="it.toWarehouseId" :disabled="editor.ro">
                <option :value="null">请选择</option>
                <option v-for="w in store.warehouses" :key="w.id" :value="w.id">{{ w.name }}</option>
              </select>
            </td>
            <td><input v-model="it.remark" :disabled="editor.ro"/></td>
            <td style="text-align:center" v-if="!editor.ro"><button class="btn sm danger" @click="removeItem(idx)">删</button></td>
          </tr>
        </tbody>
      </table>
      <div class="de-add">
        <button class="btn sm" @click="addItem">＋ 添加一行</button>
        <span class="scan-box">
          <el-icon><Aim/></el-icon>
          <input v-model="scanCode" placeholder="扫码开单：扫描或输入条码后回车" @keyup.enter="doScan"/>
        </span>
        <span v-if="emeta.stocktake" class="muted">填写实盘数量，审核时按与账面差额自动盈亏</span>
        <span v-else-if="emeta.assemblyNote" class="muted">提示：{{ emeta.assemblyNote }}</span>
        <span v-else-if="emeta.negative" class="muted">提示：数量可为负数（盘亏 / 冲减）</span>
        <span class="fb-gap"></span>
        <span>合计数量 <b>{{ totalQty }}</b></span>
      </div>

      <!-- 底部结算区（仅涉及往来结算的单据显示） -->
      <div class="de-settle" v-if="emeta.partner">
        <div class="ds-head">结算信息</div>
        <div class="ds-row">
          <div class="fi"><label>减整单折扣</label>
            <div class="fc"><input type="number" step="0.01" min="0" class="num" v-model.number="editor.form.discount" :disabled="editor.ro"/>
              <span class="lnk" title="把折扣设为全部商品金额（整单全免）" @click="fullDiscount">全额减</span></div>
          </div>
          <div class="fi"><label>{{ emeta.payLabel || '减本次收款' }}</label>
            <div class="fc"><input type="number" step="0.01" min="0" class="num" v-model.number="editor.form.paidAmount" :disabled="editor.ro"/>
              <span class="lnk" title="本次收款 = 应收金额" @click="setFullPaid">设为全收</span></div>
          </div>
          <div class="fi"><label>{{ emeta.payLabel ? '付款账户' : '收款账户' }}</label>
            <div class="fc">
              <el-select v-model="editor.form.accountId" clearable placeholder="选择账户" style="width:100%" :disabled="editor.ro">
                <el-option v-for="a in store.accounts" :key="a.id" :label="a.name" :value="a.id"/>
              </el-select>
            </div>
          </div>
          <div class="fi"><label>抵扣订金</label>
            <div class="fc"><input type="number" step="0.01" min="0" class="num" v-model.number="editor.form.deposit" :disabled="editor.ro"/></div>
          </div>
        </div>
        <div class="ds-total">
          <div class="ds-item">商品金额 <b class="money">{{ grossAmt.toFixed(2) }}</b></div>
          <div class="ds-item">折扣 <b class="money">-{{ (Number(editor.form.discount)||0).toFixed(2) }}</b></div>
          <div class="ds-item big">{{ emeta.recvLabel || '应收金额' }} <b class="money">{{ totalAmt.toFixed(2) }}</b></div>
          <div v-if="oweAmt > 0.005" class="ds-item">本次欠款 <b class="money owe">{{ oweAmt.toFixed(2) }}</b></div>
          <div v-else class="ds-item settled">✓ 已结清 <b class="money">0.00</b></div>
        </div>
      </div>
      <!-- 非结算类单据：只显示金额小结 -->
      <div class="de-settle" v-else>
        <div class="ds-total plain">
          <div class="ds-item">合计数量 <b>{{ totalQty }}</b></div>
          <div class="ds-item big">合计金额 <b class="money">{{ totalAmt.toFixed(2) }}</b></div>
        </div>
      </div>
    </div>
  </div>

  <doc-viewer :doc-id="viewerId" @close="viewerId = null"/>`,
};

