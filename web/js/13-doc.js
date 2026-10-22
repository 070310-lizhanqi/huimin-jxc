'use strict';
/* web/js/13-doc.js —— 单据页（列表 + 明细视图 + 操作分发）
 *
 * 由原 902 行的单体文件拆分而来（整页开单编辑器 → 13-doc-editor.js、
 * Excel 导入弹窗 → 13-doc-import.js）。本文件只保留「列表」职责：
 * 查询/筛选/分页、批量提交、行内动作（审核/作废/复制/转换/删除）与导出，
 * 编辑与导入通过子组件挂载，二者各自持有自己的状态。
 */
const DocPage = {
  components: { DocViewer, DocEditor, DocImport },
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
    /** 各状态单据数（服务端按当前筛选统计，不受状态页签与分页影响），用于状态页签徽标 */
    const statusCount = ref({ draft: 0, pending: 0, audit: 0, void: 0 });
    // 筛选条：日期区间 + 往来单位（对齐惠民云列表页密集筛选条）
    const filterFrom = ref('');
    const filterTo = ref('');
    const filterPartner = ref(null);
    const viewerId = ref(null);
    /** 开单编辑器：open 控制显隐，editId 为被编辑单据（0 = 新增） */
    const editorOpen = ref(false);
    const editorEditId = ref(0);
    const impOpen = ref(false);
    const busyId = ref(null);
    /** 列表/明细分页签（真实惠民云有这个二级切换，明细=展开商品行） */
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

    const meta = computed(() => DOC_META[activeType.value]);
    const partners = computed(() => meta.value.partner === 'ven' ? store.vendors : store.customers);
    const pages = computed(() => Math.max(1, Math.ceil(total.value / rows.value)));
    const pageBtns = computed(() => {
      const n = pages.value, c = page.value, arr = [];
      for (let p = 1; p <= n; p++) if (p === 1 || p === n || Math.abs(p - c) <= 2) arr.push(p);
      return arr;
    });
    function onRowsChange(e) { rows.value = Number(e.target.value) || 20; page.value = 1; load(); }

    /* 列表页底部合计 */
    const sumQty = computed(() => list.value.reduce((s, d) => s + (Number(d.totalQty) || 0), 0));
    const sumAmount = computed(() => list.value.reduce((s, d) => s + (Number(d.totalAmount) || 0), 0));
    const sumPaid = computed(() => list.value.reduce((s, d) => s + (Number(d.paidAmount) || 0) + (Number(d.deposit) || 0), 0));
    /** 表尾合计行的前置单元格数：单号+日期+商品摘要+备注 = 4，另加可选的往来单位/仓库列 */
    const sumCols = computed(() => 4 + (meta.value.partner ? 1 : 0) + (meta.value.warehouse ? 1 : 0) + (meta.value.toWarehouse ? 1 : 0));

    async function load() {
      try {
        const r = await api.get('/doc/list', {
          teamId: store.teamId, type: activeType.value, status: status.value,
          kw: kw.value, page: page.value, rows: rows.value,
          from: filterFrom.value || '', to: filterTo.value || '',
          partnerId: filterPartner.value || '',
        });
        list.value = r.rows; total.value = r.total;
        statusCount.value = r.statusCount || { draft: 0, pending: 0, audit: 0, void: 0 };
        // 翻页/筛选后清空复选：否则「已选 N 单」含已不可见的行
        selected.value = [];
        // 汇总视图停留在当前页时，明细需随筛选/翻页同步刷新
        if (viewTab.value === 'summary') loadFlatItems();
      } catch (e) {
        toast('单据列表加载失败：' + e.message, 'error');
      }
    }
    function resetFilter() {
      kw.value = ''; status.value = ''; filterFrom.value = ''; filterTo.value = '';
      filterPartner.value = null; page.value = 1; load();
    }

    watch(activeType, () => { page.value = 1; load(); });
    watch(() => route.q.type, (t) => {
      if (t && DOC_META[t] && grp.types.includes(t) && t !== activeType.value) activeType.value = t;
    });
    onMounted(() => {
      load();
      if (route.q.new) openEditor(null);
    });

    /** 打开整页开单编辑器：row 为空 = 新增 */
    function openEditor(row) {
      editorEditId.value = row ? row.id : 0;
      editorOpen.value = true;
    }
    function closeEditor() { editorOpen.value = false; load(); }

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
      if (busyId.value) return;
      const ids = list.value.filter((d) => d.status === 'draft').map((d) => d.id);
      if (!ids.length) return toast('当前页没有草稿', 'warning');
      if (!(await confirmBox(`将当前页 ${ids.length} 张草稿全部提交审核？`))) return;
      // confirmBox 是 async 弹窗，等待确认期间可再次点击 → 需要防重入
      busyId.value = 'batch';
      try {
        const r = await api.post('/doc/submit-batch', { teamId: store.teamId, ids });
        toast(`已提交 ${r.done} 张${r.skipped?.length ? `，跳过 ${r.skipped.length} 张` : ''}`);
        load();
      } catch (e) { toast(e.message, 'error'); }
      finally { busyId.value = null; }
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
    /** 明细视图数据：展开当前页所有单据的商品行（一次批量取，不再逐单请求） */
    const flatItems = ref([]);
    const flatLoading = ref(false);
    async function loadFlatItems() {
      if (!list.value.length) { flatItems.value = []; return; }
      flatLoading.value = true;
      try {
        const ids = list.value.map((d) => d.id);
        const map = await api.get('/doc/items', { teamId: store.teamId, ids: ids.join(',') });
        const rows = [];
        for (const d of list.value) {
          for (const it of (map?.[String(d.id)] || [])) {
            rows.push({
              docId: d.id, billNo: d.billNo, date: d.date, status: d.status,
              partnerName: partnerLabel(d),
              prodName: it.prodName || prodLabel(it.productId),
              spec: it.spec || specOf(it.productId), unit: it.unit || unitOf(it.productId),
              qty: it.qty, price: it.price, amount: it.amount,
            });
          }
        }
        flatItems.value = rows;
      } catch (e) {
        toast('明细加载失败：' + e.message, 'error');
        flatItems.value = [];
      } finally {
        flatLoading.value = false;
      }
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
        case 'edit': openEditor(row); break;
        case 'view': viewerId.value = row.id; break;
        case 'copy': copyDoc(row); break;
        case 'delete': delDoc(row); break;
        case 'void': voidDoc(row); break;
        default: break;
      }
    }
    function doExport() {
      const head = [
        { key: 'billNo', label: '单号' }, { key: 'date', label: '日期' },
        { key: 'partner', label: '往来单位' }, { key: 'warehouse', label: '仓库' },
        { key: 'totalQty', label: '合计数量' }, { key: 'totalAmount', label: '合计金额(元)' },
        { key: 'status', label: '状态' }, { key: 'remark', label: '备注' },
      ];
      const mapRow = (d) => ({
        billNo: d.billNo, date: (d.date || '').slice(0, 10),
        partner: partnerLabel(d) || '', warehouse: whLabel(d.warehouseId) || '',
        totalQty: d.totalQty, totalAmount: (Number(d.totalAmount) / 100).toFixed(2),
        status: STATUS_TEXT[d.status] || d.status, remark: d.remark || '',
      });
      // 分页时默认只导出当前页容易误解（财务对账要的是「这批筛选结果的全部」）：
      // 超过一页就询问，确认后按当前筛选条件把剩下的页也拉完再合并导出
      if (total.value > list.value.length) {
        confirmBox(
          `当前只显示了第 ${page.value} 页的 ${list.value.length} 条，共 ${total.value} 条。\n是否导出全部 ${total.value} 条（按当前筛选条件）？`,
          '导出范围',
        ).then(async (all) => {
          if (!all) return exportCsv(`${DOC_META[activeType.value].label}列表_第${page.value}页.csv`, list.value.map(mapRow), head);
          try {
            const merged = [];
            let p = 1;
            // 单页上限 200，最多 50 页（1 万条），防止误点导出把浏览器拖死
            while (p <= 50) {
              const r = await api.get('/doc/list', {
                teamId: store.teamId, type: activeType.value, status: status.value,
                kw: kw.value, page: p, rows: 200,
                from: filterFrom.value || '', to: filterTo.value || '',
                partnerId: filterPartner.value || '',
              });
              merged.push(...r.rows);
              if (merged.length >= r.total || !r.rows.length) break;
              p++;
            }
            exportCsv(`${DOC_META[activeType.value].label}列表_全部${merged.length}条.csv`, merged.map(mapRow), head);
          } catch (e) { toast('导出失败：' + e.message, 'error'); }
        });
        return;
      }
      exportCsv(`${DOC_META[activeType.value].label}列表.csv`, list.value.map(mapRow), head);
    }
    return {
      grp, activeType, status, statusCount, kw, page, rows, list, total, pages, pageBtns, viewerId,
      meta, partners, busyId,
      load, openEditor, closeEditor,
      viewTab, selected, selAll, toggleAll, toggleOne, flatItems, flatLoading, loadFlatItems,
      audit, submitDoc, rejectDoc, submitAllDrafts, voidDoc, delDoc, convert, copyDoc, doExport, onRowsChange, moreAction,
      filterFrom, filterTo, filterPartner, resetFilter, sumQty, sumAmount, sumPaid, sumCols,
      editorOpen, editorEditId, impOpen,
      fmtMoney, partnerLabel, whLabel, prodLabel, store, STATUS_TEXT, DOC_META, specOf, unitOf,
    };
  },
  // 模板必须单根：外层 <transition mode="out-in"> 要求组件只有一个根元素才能完成「离场→入场」，
  // 多根片段（fragment）会导致子路由切换时整页空白。用布局中性的 wrapper 收束为单根。
  template: `
  <div class="doc-page-root">
  <div class="page-card" v-if="!editorOpen">
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
      <el-select v-model="status" clearable placeholder="全部状态" style="width:130px" @change="page=1;load()">
        <el-option :label="'草稿 (' + (statusCount.draft || 0) + ')'" value="draft"/>
        <el-option :label="'待审核 (' + (statusCount.pending || 0) + ')'" value="pending"/>
        <el-option :label="'已审核 (' + (statusCount.audit || 0) + ')'" value="audit"/>
        <el-option :label="'已作废 (' + (statusCount.void || 0) + ')'" value="void"/>
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
      <button class="btn" @click="impOpen = true"><el-icon><Upload/></el-icon> Excel 导入</button>
      <button class="btn" @click="submitAllDrafts">批量提交</button>
      <button class="btn primary" @click="openEditor(null)">＋ 新增</button>
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
          <tr v-if="!flatItems.length"><td :colspan="meta.partner ? 10 : 9"><div class="empty">{{ flatLoading ? '明细加载中…' : '暂无明细' }}</div></td></tr>
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
                <button class="btn sm" @click="openEditor(d)">明细</button>
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

  <!-- ===== 整页开单态（对齐惠民云）：独立子组件，自持编辑状态 ===== -->
  <doc-editor v-else :type="activeType" :doc-id="editorEditId" @close="closeEditor"/>

  <!-- ===== Excel/CSV 智能导入弹窗：独立子组件 ===== -->
  <doc-import v-if="impOpen" @close="impOpen = false" @imported="load"/>

  <doc-viewer :doc-id="viewerId" @close="viewerId = null"/>
  </div>`,
};