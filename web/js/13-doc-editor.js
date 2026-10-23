'use strict';
/* web/js/13-doc-editor.js —— 整页开单编辑器（从 13-doc.js 拆出）
 *
 * 职责：单据的表头字段 / 明细行 / 结算区编辑，以及保存、保存并审核。
 * 自持状态：本组件独立拉取单据详情、当前仓库库存快照、客户价格记忆，
 * 列表页只负责「打开编辑器」与「保存后刷新列表」两件事（v-if + @close）。
 * 注意：必须加载在 13-doc.js 之前（DocPage 在定义时即引用本组件）。
 */
const DocEditor = {
  props: {
    type: { type: String, required: true },
    docId: { type: Number, default: 0 },
  },
  emits: ['close'],
  setup(props, { emit }) {
    const editor = reactive({ id: null, billNo: '', form: null, status: '', ro: false });
    const saving = ref(false);
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

    const emeta = computed(() => DOC_META[props.type] || {});
    const epartners = computed(() => emeta.value.partner === 'ven' ? store.vendors : store.customers);

    /* 编辑态合计：全程整数分路径消除浮点误差。
     *  0.1 + 0.2 = 0.30000000000000004 这类浮点噪声在数量大时会直接体现在应收金额上。
     *  口径与后端 lineAmount 一致：qty 转"万分"整数 → × 单价分 → ÷ 10000 取整。 */
    const lineCents = (it) => {
      const qtyScaled = Math.round((Number(it.qty) || 0) * 10000);
      const priceCents = Math.round((Number(it.price) || 0) * 100);
      return Math.round((qtyScaled * priceCents) / 10000);
    };
    const grossCents = computed(() => editor.form
      ? editor.form.items.reduce((s, it) => s + lineCents(it), 0) : 0);
    const grossAmt = computed(() => grossCents.value / 100);
    const totalQty = computed(() => editor.form ? editor.form.items.reduce((s, it) => s + (Number(it.qty) || 0), 0) : 0);
    const totalCents = computed(() => Math.max(0, grossCents.value - Math.round((Number(editor.form?.discount) || 0) * 100)));
    const totalAmt = computed(() => totalCents.value / 100);
    const oweCents = computed(() => Math.max(0,
      totalCents.value - Math.round((Number(editor.form?.paidAmount) || 0) * 100) - Math.round((Number(editor.form?.deposit) || 0) * 100)));
    const oweAmt = computed(() => oweCents.value / 100);

    async function loadStock(warehouseId) {
      if (!warehouseId) { stockMap.value = {}; return; }
      const rows2 = await api.get('/stock/list', { teamId: store.teamId, warehouseId, ifShowZero: '' });
      const m = {};
      for (const r of rows2) m[r.productId] = (m[r.productId] || 0) + r.qty;
      stockMap.value = m;
    }

    watch(() => editor.form && editor.form.warehouseId, (w) => { if (emeta.value.warehouse) loadStock(w); });
    // 换客户：重新拉该客户的价格记忆，并把「未手改过」的行价刷成记忆价
    watch(() => editor.form && editor.form.partnerId, async (pid, old) => {
      if (!emeta.value.partner) return;
      await loadPriceMem(pid);
      const f = emeta.value.priceField;
      // old === null 是 watcher 的初始基线（editor.form 初始为 null）。
      // 打开已有单据时表单整体赋值会触发 (pid=单据客户, old=null)：
      // 此时行价来自服务器单据本身，必须跳过刷新，否则被价格记忆静默改写。
      if (!f || old === null || editor.id) return;
      for (const it of editor.form.items) {
        if (!it.productId) continue;
        if (it._priceDirty) continue; // 用户已手改过单价的行不刷新
        const mem = priceMem.value[it.productId];
        if (mem != null) it.price = mem / 100;
      }
    });

    /* 行唯一 id：v-for :key 不能用数组下标——删除中间行会让 Vue 就地复用
       行内下拉的展开态/聚焦态到错误的行上 */
    let uidSeq = 0;
    function blankItem() {
      return { _uid: ++uidSeq, productId: null, qty: 1, price: 0, batchNo: '', toWarehouseId: null, remark: '' };
    }
    /** 上次开单用的仓库/业务员/账户：多仓团队每次开单都要重选同一仓库，记住它 */
    const LAST_KEY = 'oc_last_doc_';
    function rememberLast(f) {
      try {
        localStorage.setItem(LAST_KEY + props.type, JSON.stringify({
          warehouseId: f.warehouseId || null, clerkId: f.clerkId || null, accountId: f.accountId || null,
        }));
      } catch { /* 隐私模式等场景忽略 */ }
    }
    function lastDefaults() {
      try { return JSON.parse(localStorage.getItem(LAST_KEY + props.type) || '{}'); } catch { return {}; }
    }
    function blankForm() {
      const last = lastDefaults();
      // 记住的档案可能已被删除：不存在则回落默认，避免出现空选择
      const has = (list, id) => (id != null && list.some((x) => x.id === id) ? id : null);
      return {
        date: todayStr(),
        partnerId: null,
        clerkId: has(store.clerks, last.clerkId),
        warehouseId: has(store.warehouses, last.warehouseId) ?? store.warehouses[0]?.id ?? null,
        remark: '',
        receiverName: '', receiverMobile: '', receiverAddress: '',
        discount: 0, paidAmount: 0, accountId: has(store.accounts, last.accountId), deposit: 0,
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

    function init() {
      if (props.docId) {
        api.get('/doc/info', { id: props.docId, teamId: store.teamId }).then(({ doc, items }) => {
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
          // 库存快照与价格记忆由 watch(warehouseId/partnerId) 在表单赋值时统一加载，
          // 此处不再显式调用（此前双发两个请求）
        }).catch(e => toast(e.message, 'error'));
      } else {
        editor.id = null; editor.billNo = '';
        editor.status = 'draft'; editor.ro = false;
        editor.form = blankForm();
      }
      snap();
    }
    onMounted(init);

    /* Ctrl+S / Cmd+S 保存草稿：批量录单时手不用离开键盘 */
    function onKeydown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!editor.ro && !saving.value) save();
      }
    }
    onMounted(() => window.addEventListener('keydown', onKeydown));
    onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

    /**
     * 未保存提醒：开单时手一抖点「返回列表」/浏览器后退，
     * 填了半天的单据直接蒸发。这里记住「进入时的表单快照」，
     * 返回前比对是否改过，改过就二次确认。
     */
    const snapshot = ref('');
    function snap() {
      try { snapshot.value = JSON.stringify(editor.form || null); } catch { snapshot.value = ''; }
    }
    const isDirty = computed(() => {
      if (editor.ro || !editor.form) return false;
      try { return JSON.stringify(editor.form) !== snapshot.value; } catch { return false; }
    });
    async function backToList() {
      if (isDirty.value) {
        const ok = await confirmBox('当前单据有未保存的修改，确定返回列表？修改将丢失。', '离开确认');
        if (!ok) return;
      }
      emit('close');
    }
    function addItem() { editor.form.items.push(blankItem()); }
    function removeItem(idx) {
      if (editor.form.items.length <= 1) return toast('至少保留一行明细', 'error');
      editor.form.items.splice(idx, 1);
    }
    /* 扫码开单：按条码（或商品名精确匹配）找到商品 → 已有行则数量+1，否则新增行 */
    function scanBarcode(code) {
      const s = String(code || '').trim();
      if (!s || !editor.form) return;
      const p = store.products.find((x) => (x.barcode || '').trim() === s)
        || store.products.find((x) => x.name === s);
      if (!p) return toast(`未找到条码或同名商品「${s}」`, 'warning');
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
    function lineAmt(it) { return (lineCents(it) / 100).toFixed(2); }
    function stockOf(pid) { return stockMap.value[pid] ?? 0; }

    /* 下拉选项过滤：名称/手机/条码/规格任一命中，且单次最多渲染 50 条——
       此前每行渲染全量 el-option（20 行 × 1000 商品 = 2 万个选项组件），商品多的账套明显卡顿。
       拼音首字母匹配需要内嵌码表，暂不支持（placeholder 已如实改为名称/编码） */
    const rowKw = reactive({});
    function filterRow(it, field, q) { rowKw[field + it._uid] = String(q || ''); }
    function rowOpts(it, field, list, fields) {
      const kw = String(rowKw[field + it._uid] || '').trim().toLowerCase();
      let out = list;
      if (kw) {
        out = list.filter((p) => fields.some((f) => String(p[f] || '').toLowerCase().includes(kw)));
      }
      return out.slice(0, 50);
    }
    function prodOpts(it) {
      return rowOpts(it, 'p', store.products, ['name', 'barcode', 'spec']);
    }
    /* 往来单位下拉是单实例，用固定 key */
    function partnerFilter(q) { rowKw.pt0 = String(q || ''); }
    function partnerOptsFixed() {
      const kw = String(rowKw.pt0 || '').trim().toLowerCase();
      let out = epartners.value;
      if (kw) out = out.filter((p) => String(p.name || '').toLowerCase().includes(kw)
        || String(p.mobile || '').toLowerCase().includes(kw));
      return out.slice(0, 50);
    }
    function setFullPaid() {
      if (!editor.form) return;
      // 直接用整数分换算回元，避免 totalAmt.value.toFixed(2) 二次浮点
      editor.form.paidAmount = totalCents.value / 100;
    }
    function fullDiscount() {
      if (!editor.form) return;
      editor.form.discount = grossCents.value / 100;
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
        // 调拨单必须指定调往仓库：后端不校验必填，空值过账会变成「源仓出又入源仓」的无效调拨
        if (m.toWarehouse && !it.toWarehouseId) throw new Error(`第 ${i + 1} 行未选择调往仓库`);
      }
      if (Math.round(Number(f.discount) * 100) > grossCents.value) throw new Error('整单折扣不能超过单据金额');
      if (Math.round(Number(f.paidAmount) * 100) + Math.round(Number(f.deposit) * 100) > totalCents.value) {
        throw new Error('本次收款 + 抵扣订金不能超过应收金额');
      }
      const body = {
        teamId: store.teamId, type: props.type, date: f.date,
        partnerType: m.partner || null, partnerId: f.partnerId || null,
        clerkId: f.clerkId || null,
        warehouseId: m.warehouse ? f.warehouseId : null,
        remark: f.remark || null,
        receiverName: f.receiverName || null,
        receiverMobile: f.receiverMobile || null,
        receiverAddress: f.receiverAddress || null,
        discount: toCents(f.discount),
        paidAmount: toCents(f.paidAmount),
        accountId: f.accountId || null,
        deposit: toCents(f.deposit),
        items: f.items.map(it => ({
          productId: it.productId, qty: Number(it.qty), price: toCents(it.price),
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
        rememberLast(editor.form);
        toast('已保存');
        emit('close');
      } catch (e) { toast(e.message, 'error'); }
      finally { saving.value = false; }
    }

    async function saveAndAudit() {
      if (saving.value) return;
      saving.value = true;
      try {
        const id = await persist();
        rememberLast(editor.form);
        await api.post('/doc/audit', { teamId: store.teamId, id });
        toast('已保存并审核');
        emit('close');
      } catch (e) { toast(e.message, 'error'); }
      finally { saving.value = false; }
    }

    return {
      type: props.type, editor, saving, emeta, epartners, grossAmt, totalQty, totalAmt, oweAmt, SETTLE_TYPES,
      stockMap, priceMem, loadPriceMem, addItem, removeItem, onPick, lineAmt, stockOf,
      scanCode, doScan, scanBarcode, setFullPaid, fullDiscount, save, saveAndAudit, backToList, isDirty,
      rowKw, filterRow, prodOpts, partnerFilter, partnerOptsFixed,
      fmtMoney, store, STATUS_TEXT, DOC_META, specOf, unitOf,
    };
  },
  template: `
  <div class="page-card doc-editor">
    <div class="de-head">
      <span class="de-title">{{ DOC_META[type].label }}</span>
      <span class="billno" v-if="editor.billNo">{{ editor.billNo }}</span>
      <span v-else class="muted" style="font-size:12px">保存后自动生成单号</span>
      <span v-if="editor.ro" class="ro-badge">
        <el-icon><Lock/></el-icon>
        {{ STATUS_TEXT[editor.status] }} · 只读
      </span>
      <span class="de-sp"></span>
      <button class="btn" @click="backToList">返回列表{{ isDirty ? ' *' : '' }}</button>
      <template v-if="!editor.ro">
        <button class="btn" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存草稿' }}</button>
        <button class="btn primary" :disabled="saving" @click="saveAndAudit">保存并审核</button>
      </template>
    </div>
    <div class="ro-tip" v-if="editor.ro">
      该单据已{{ STATUS_TEXT[editor.status] }}，内容不可修改。如需调整请先作废并重新开单。
    </div>

    <!-- editor.form 为 null 时（新增单首帧 / 已有单详情异步返回前）不渲染表单区，
         否则模板解引用 editor.form.date 会抛错 -->
    <div class="de-body" :class="{ ro: editor.ro }" v-if="editor.form">
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
            <el-select v-model="editor.form.partnerId" filterable clearable placeholder="搜索名称 / 手机号" style="width:100%" :disabled="editor.ro"
              :filter-method="partnerFilter" @visible-change="(v) => { if (v) rowKw.pt0 = ''; }">
              <el-option v-for="p in partnerOptsFixed()" :key="p.id" :label="p.name" :value="p.id">
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
          <tr v-for="(it, idx) in editor.form.items" :key="it._uid ?? idx">
            <td>
              <el-select v-model="it.productId" filterable placeholder="选择商品 / 输入编码" size="small" :disabled="editor.ro" @change="onPick(it)"
                :filter-method="(q) => filterRow(it, 'p', q)" @visible-change="(v) => { if (v) rowKw['p' + it._uid] = ''; }">
                <el-option v-for="p in prodOpts(it)" :key="p.id" :label="p.name + (p.spec ? '（' + p.spec + '）' : '')" :value="p.id"/>
              </el-select>
            </td>
            <td class="muted">{{ specOf(it.productId) }}</td>
            <td class="muted">{{ unitOf(it.productId) }}</td>
            <td class="r" :class="{ 'stock-low': stockOf(it.productId) <= 0 && it.productId }">{{ stockOf(it.productId) }}</td>
            <td class="r">
              <!-- 超卖预警：仅提示不阻断（负库存单据类型除外），审核时后端仍会兜底拦截 -->
              <input type="number" step="any" class="num" v-model.number="it.qty" :disabled="editor.ro"
                :class="{ 'qty-over': !emeta.negative && it.productId && Number(it.qty) > stockOf(it.productId) }"
                :title="!emeta.negative && it.productId && Number(it.qty) > stockOf(it.productId) ? '数量超过当前仓库可用库存 ' + stockOf(it.productId) : ''"/>
            </td>
            <td class="r">
              <input type="number" step="0.01" min="0" class="num" v-model.number="it.price" :disabled="editor.ro" @input="it._priceDirty = true"/>
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
        <span class="scan-box" v-if="!editor.ro">
          <el-icon><Aim/></el-icon>
          <input v-model="scanCode" placeholder="扫码开单：扫描或输入条码后回车" @keyup.enter="doScan"/>
        </span>
        <span v-if="emeta.stocktake" class="muted">填写实盘数量，审核时按与账面差额自动盈亏</span>
        <span v-else-if="emeta.assemblyNote" class="muted">提示：{{ emeta.assemblyNote }}</span>
        <span v-else-if="emeta.negative" class="muted">提示：数量可为负数（盘亏 / 冲减）</span>
        <span class="fb-gap"></span>
        <span>合计数量 <b>{{ totalQty }}</b></span>
      </div>

      <!-- 底部结算区：折扣对所有往来单据有效；收付款/账户/订金仅后端真正落结算的四类单据显示
           （报价/订单/申请类无收付语义，后端审核会跳过） -->
      <div class="de-settle" v-if="emeta.partner">
        <div class="ds-head">{{ SETTLE_TYPES.has(type) ? '结算信息' : '价格小结' }}</div>
        <div class="ds-row">
          <div class="fi"><label>减整单折扣</label>
            <div class="fc"><input type="number" step="0.01" min="0" class="num" v-model.number="editor.form.discount" :disabled="editor.ro"/>
              <span class="lnk" title="把折扣设为全部商品金额（整单全免）" @click="fullDiscount">全额减</span></div>
          </div>
          <template v-if="SETTLE_TYPES.has(type)">
          <div class="fi"><label>{{ emeta.payLabel || '减本次收款' }}</label>
            <div class="fc"><input type="number" step="0.01" min="0" class="num" v-model.number="editor.form.paidAmount" :disabled="editor.ro"/>
              <span class="lnk" :title="emeta.payLabel ? '本次付款 = 应付金额' : '本次收款 = 应收金额'" @click="setFullPaid">设为全收</span></div>
            <div class="fi-tip muted" v-if="(emeta.payLabel ? type === 'pin' : type === 'sret')" style="font-size:11.5px;width:100%">
              退货单此栏是「退现金」：欠款客户退货请留空（货款自动冲减欠款），仅预收客户退款时填写
            </div>
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
          </template>
        </div>
        <div class="ds-total">
          <div class="ds-item">商品金额 <b class="money">{{ grossAmt.toFixed(2) }}</b></div>
          <div class="ds-item">折扣 <b class="money">{{ ((Number(editor.form.discount)||0) > 0 ? '-' : '') + (Number(editor.form.discount)||0).toFixed(2) }}</b></div>
          <div class="ds-item big">{{ SETTLE_TYPES.has(type) ? (emeta.recvLabel || '应收金额') : '合计金额' }} <b class="money">{{ totalAmt.toFixed(2) }}</b></div>
          <template v-if="SETTLE_TYPES.has(type)">
            <div v-if="oweAmt > 0.005" class="ds-item">本次欠款 <b class="money owe">{{ oweAmt.toFixed(2) }}</b></div>
            <div v-else class="ds-item settled">✓ 已结清 <b class="money">0.00</b></div>
          </template>
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
  </div>`,
};