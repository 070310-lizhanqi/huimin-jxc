'use strict';
/* web/js/15-finance.js —— 由 app.js 拆分（lines 2424-2630） */
/* ================= 收付款（资金） ================= */
const FinancePage = {
  setup() {
    const settlements = ref([]);
    const balances = ref([]);
    const tab = ref('settle');
    const editor = reactive({ open: false, form: {} });
    const viewerId = ref(null);

    // 筛选条条件（服务端本来就支持 type/partnerId/from/to，前端此前没把条件传上去）
    const fType = ref('');          // '' 全部 / receipt / payment
    const fPartnerType = ref('');   // '' 全部 / cus / ven
    const fPartnerId = ref(null);
    const fRange = ref([]);         // [from, to]
    function resetFilter() {
      fType.value = ''; fPartnerType.value = ''; fPartnerId.value = null; fRange.value = [];
      load();
    }
    const partnerFilterOpts = computed(() => {
      if (fPartnerType.value === 'cus') return store.customers;
      if (fPartnerType.value === 'ven') return store.vendors;
      // 未选类型时客户+供应商一起给（加类型标记，避免同名混淆）
      return [
        ...store.customers.map((c) => ({ ...c, _pt: 'cus' })),
        ...store.vendors.map((v) => ({ ...v, _pt: 'ven' })),
      ];
    });

    const loading = ref(false);
    async function load() {
      const q = { teamId: store.teamId };
      if (fType.value) q.type = fType.value;
      if (fRange.value?.length === 2) { q.from = fRange.value[0]; q.to = fRange.value[1]; }
      if (fPartnerId.value) {
        // 往来单位 id 在客户/供应商表里各自自增，会撞号：必须带 partnerType 才能唯一定位
        const pt = fPartnerType.value || partnerFilterOpts.value.find((p) => p.id === fPartnerId.value)?._pt;
        if (pt) q.partnerType = pt;
        q.partnerId = fPartnerId.value;
      }
      loading.value = true;
      try {
        // 余额与结算筛选无关：只在页签切到「往来余额」时才需要，避免每次筛选都多打一枪
        const needBal = tab.value === 'bal';
        const [s, b] = await Promise.all([
          api.get('/settlement/list', q),
          needBal ? api.get('/partner/balance', { teamId: store.teamId }) : Promise.resolve(null),
        ]);
        settlements.value = s;
        if (b) balances.value = b;
        loadDocNos();
      } catch (e) {
        toast('收付款记录加载失败：' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    }
    onMounted(load);
    // 页签切到往来余额时补拉一次余额（load 里按需跳过了它）
    watch(tab, (t) => { if (t === 'bal' && !balances.value.length) api.get('/partner/balance', { teamId: store.teamId }).then((b) => { balances.value = b; }).catch(() => {}); });

    // 关联单据单号缓存：收付款记录里只有 refDocId，批量接口一次查完（原实现逐条请求，N+1）
    const docNos = ref({});
    async function loadDocNos() {
      const ids = settlements.value.map((s) => s.refDocId).filter(Boolean);
      const uniq = [...new Set(ids)].filter((id) => !docNos.value[id]);
      if (!uniq.length) return;
      try {
        const map = await api.get('/doc/bill-nos', { teamId: store.teamId, ids: uniq.join(',') });
        const next = { ...docNos.value };
        for (const id of uniq) next[id] = map?.[String(id)]?.billNo ?? ('#' + id);
        docNos.value = next;
      } catch {
        // 批量接口失败时不要卡住列表：只影响单号显示，回落到 #id
      }
    }
    function docNoOf(id) { return docNos.value[id] ?? ('#' + id); }
    function gotoDoc(id) { viewerId.value = id; }

    const receivable = computed(() => balances.value.filter(b => b.partnerType === 'cus' && b.balance > 0).reduce((s, b) => s + b.balance, 0));
    const payable = computed(() => balances.value.filter(b => b.partnerType === 'ven' && b.balance > 0).reduce((s, b) => s + b.balance, 0));
    const balRows = computed(() => balances.value.map(b => ({
      ...b,
      name: b.partnerType === 'cus' ? (byId(store.customers, b.partnerId)?.name ?? `#${b.partnerId}`) : (byId(store.vendors, b.partnerId)?.name ?? `#${b.partnerId}`),
    })));

    function openNew(type) {
      editor.form = {
        type, partnerType: type === 'receipt' ? 'cus' : 'ven', partnerId: null,
        accountId: store.accounts[0]?.id ?? null, amount: 0,
        date: todayStr(), remark: '',
      };
      editor.open = true;
    }
    const partnerOpts = computed(() => editor.form.partnerType === 'cus' ? store.customers : store.vendors);
    function partnerName(f) {
      const list = f.partnerType === 'cus' ? store.customers : store.vendors;
      return list.find((p) => p.id === f.partnerId)?.name ?? ('#' + f.partnerId);
    }
    const busy = ref(false);
    async function save() {
      // 防双击：收付款是资金操作，后端无幂等去重，重复提交会双重冲抵往来余额
      if (busy.value) return;
      const f = editor.form;
      if (!f.partnerId) return toast('请选择往来单位', 'error');
      if (!(Number(f.amount) > 0)) return toast('金额必须大于 0', 'error');
      busy.value = true;
      try {
        if (f.id) {
          await api.put('/settlement/' + f.id, {
            teamId: store.teamId, accountId: f.accountId || null,
            amount: toCents(f.amount), date: f.date, remark: f.remark,
          });
        } else {
          await api.post('/settlement/create', {
            teamId: store.teamId, type: f.type, partnerType: f.partnerType, partnerId: f.partnerId,
            accountId: f.accountId || null, amount: toCents(f.amount),
            date: f.date, remark: f.remark,
          });
        }
        editor.open = false;
        toast(f.id ? '已保存' : '已登记');
        load();
        loadBase();
      } catch (e) { toast(e.message, 'error'); }
      finally { busy.value = false; }
    }

    function openEdit(s) {
      editor.form = {
        id: s.id, type: s.type, partnerType: s.partnerType, partnerId: s.partnerId,
        accountId: s.accountId, amount: s.amount / 100, date: s.date, remark: s.remark || '',
      };
      editor.open = true;
    }

    function watch1() {
      // 切换往来单位时清掉已选的 id，避免类型不匹配
      if (fPartnerType.value && fPartnerId.value) {
        const pt = partnerFilterOpts.value.find((p) => p.id === fPartnerId.value)?._pt ?? fPartnerType.value;
        if (pt !== fPartnerType.value) fPartnerId.value = null;
      }
      load();
    }
    watch(fPartnerType, watch1);

    const delBusy = ref(null);
    async function remove(s) {
      if (delBusy.value === s.id) return;
      const ok = await confirmBox(
        `确定删除这笔${s.type === 'receipt' ? '收款' : '付款'}记录（${fmtMoney(s.amount)}）？删除后会冲回往来余额与账户余额。`,
        '删除确认',
      );
      if (!ok) return;
      delBusy.value = s.id;
      try {
        await api.del('/settlement/' + s.id, { teamId: store.teamId });
        toast('已删除');
        load();
        loadBase();
      } catch (e) { toast(e.message, 'error'); }
      finally { delBusy.value = null; }
    }
    const filteredSum = computed(() => settlements.value.reduce((a, s) => a + (s.amount || 0), 0));

    // 往来余额导出（此前只有表格，没法带给会计/老板看）
    function exportBal() {
      if (!balRows.value.length) return toast('没有可导出的往来余额', 'warning');
      exportCsv(
        `往来余额_${todayStr()}.csv`,
        balRows.value.map((b) => ({
          name: b.name,
          ptype: b.partnerType === 'cus' ? '客户' : '供应商',
          balance: (b.balance / 100).toFixed(2),
          note: b.partnerType === 'cus'
            ? (b.balance > 0 ? '客户欠款（应收）' : b.balance < 0 ? '客户预付（预收）' : '已结清')
            : (b.balance > 0 ? '欠供应商（应付）' : b.balance < 0 ? '供应商预付冲抵' : '已结清'),
        })),
        [
          { key: 'name', label: '往来单位' }, { key: 'ptype', label: '类型' },
          { key: 'balance', label: '余额(元)' }, { key: 'note', label: '说明' },
        ],
      );
    }
    return {
      settlements, tab, editor, viewerId, receivable, payable, balRows, openNew, openEdit, remove, save, busy,
      partnerOpts, partnerName, docNoOf, gotoDoc, load, store, fmtMoney, exportBal, loading, byId,
      fType, fPartnerType, fPartnerId, fRange, partnerFilterOpts, resetFilter, delBusy, filteredSum,
    };
  },
  template: `
  <div>
    <div class="stat-grid" style="grid-template-columns:repeat(auto-fit,minmax(240px,1fr))">
      <div class="stat">
        <div class="ico" style="background:#e6fffb;color:#13c2c2"><el-icon><Wallet/></el-icon></div>
        <div><div class="num money">{{ fmtMoney(receivable) }}</div><div class="lbl">应收金额合计（客户欠款）</div></div>
      </div>
      <div class="stat">
        <div class="ico" style="background:#fff1f0;color:#f5222d"><el-icon><CreditCard/></el-icon></div>
        <div><div class="num money">{{ fmtMoney(payable) }}</div><div class="lbl">应付金额合计（供应商欠款）</div></div>
      </div>
    </div>
    <div class="page-card" style="margin-top:14px">
      <div class="page-head">
        <span class="hd-title">收付款</span>
        <div class="tabs">
          <span class="tb" :class="{ on: tab === 'settle' }" @click="tab = 'settle'">收付款记录</span>
          <span class="tb" :class="{ on: tab === 'bal' }" @click="tab = 'bal'">往来余额</span>
        </div>
        <div class="hd-right">
          <button class="btn" v-if="tab==='bal'" @click="exportBal">导出</button>
          <button class="btn" @click="openNew('payment')">+ 付款</button>
          <button class="btn primary" @click="openNew('receipt')">+ 收款</button>
        </div>
      </div>
      <div class="filterbar" v-if="tab==='settle'">
        <el-select v-model="fType" clearable placeholder="全部类型" style="width:110px" @change="load">
          <el-option label="收款" value="receipt"/><el-option label="付款" value="payment"/>
        </el-select>
        <el-select v-model="fPartnerType" clearable placeholder="全部往来类型" style="width:130px">
          <el-option label="客户" value="cus"/><el-option label="供应商" value="ven"/>
        </el-select>
        <el-select v-model="fPartnerId" filterable clearable placeholder="全部往来单位" style="width:170px" @change="load">
          <el-option v-for="p in partnerFilterOpts" :key="(p._pt || fPartnerType || 'x') + '_' + p.id" :label="p.name" :value="p.id"/>
        </el-select>
        <el-date-picker v-model="fRange" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" class="finp" style="width:240px" @change="load"/>
        <button class="btn icon-only" title="重置" @click="resetFilter"><el-icon><RefreshLeft/></el-icon></button>
        <span class="fb-gap"></span>
        <span class="muted fb-count">共 {{ settlements.length }} 笔，合计 <b class="money">{{ fmtMoney(filteredSum) }}</b></span>
      </div>
      <div class="tbl-wrap" v-if="tab==='settle'">
        <sk-table v-if="loading && !settlements.length" :rows="8" :cols="8"/>
        <table class="tbl" v-else>
          <thead><tr><th>日期</th><th>类型</th><th>往来单位</th><th>资金账户</th><th class="r">金额</th><th>关联单据</th><th>备注</th><th class="c" style="width:110px">操作</th></tr></thead>
          <tbody>
            <tr v-if="!settlements.length"><td colspan="8"><div class="empty">暂无收付款记录</div></td></tr>
            <tr v-for="s in settlements" :key="s.id">
              <td>{{ s.date }}</td>
              <td><span :class="'tag ' + (s.type === 'receipt' ? 'tag-in' : 'tag-out')">{{ s.type === 'receipt' ? '收款' : '付款' }}</span></td>
              <td>{{ byId(s.partnerType === 'cus' ? store.customers : store.vendors, s.partnerId)?.name || '#' + s.partnerId }}</td>
              <td>{{ byId(store.accounts, s.accountId)?.name || '—' }}</td>
              <td class="r money">{{ fmtMoney(s.amount) }}</td>
              <td>
                <a v-if="s.refDocId" class="lnk" @click="gotoDoc(s.refDocId)">{{ docNoOf(s.refDocId) }}</a>
                <span v-else class="muted">—</span>
              </td>
              <td class="muted">{{ s.remark || '—' }}</td>
              <td class="c">
                <button class="btn sm" @click="openEdit(s)">编辑</button>
                <button class="btn sm danger" :disabled="delBusy === s.id" @click="remove(s)">{{ delBusy === s.id ? '删除中…' : '删除' }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="tbl-wrap" v-else>
        <table class="tbl">
          <thead><tr><th>往来单位</th><th>类型</th><th class="r">余额</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-if="!balRows.length"><td colspan="4"><div class="empty">暂无往来余额</div></td></tr>
            <tr v-for="b in balRows" :key="b.partnerType + b.partnerId">
              <td style="font-weight:500">{{ b.name }}</td>
              <td>{{ b.partnerType === 'cus' ? '客户' : '供应商' }}</td>
              <td class="r money" :style="{ color: b.balance > 0 ? '' : '#53a551' }">{{ fmtMoney(b.balance) }}</td>
              <td class="muted">{{ b.partnerType === 'cus' ? (b.balance > 0 ? '客户欠款（应收）' : b.balance < 0 ? '客户预付（预收）' : '已结清') : (b.balance > 0 ? '欠供应商（应付）' : b.balance < 0 ? '供应商预付冲抵' : '已结清') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="modal-mask" v-if="editor.open" @click.self="editor.open = false">
      <div class="modal narrow">
        <div class="modal-head"><span class="mt">{{ editor.form.id ? '修改' : '登记' }}{{ editor.form.type === 'receipt' ? '收款' : '付款' }}</span><span class="x" @click="editor.open = false">×</span></div>
        <div class="modal-body">
          <div class="fitem"><label>往来单位</label>
            <div class="fctrl">
              <template v-if="editor.form.id">
                <div class="ro-field">{{ partnerName(editor.form) }}</div>
              </template>
              <template v-else>
                <el-select v-model="editor.form.partnerId" filterable placeholder="选择往来单位">
                  <el-option v-for="p in partnerOpts" :key="p.id" :label="p.name" :value="p.id"/>
                </el-select>
              </template>
            </div>
          </div>
          <div class="fitem"><label>资金账户</label>
            <div class="fctrl"><el-select v-model="editor.form.accountId" clearable placeholder="选择账户（可空）">
              <el-option v-for="a in store.accounts" :key="a.id" :label="a.name" :value="a.id"/>
            </el-select></div>
          </div>
          <div class="fitem"><label>金额(元)</label><input type="number" step="0.01" min="0.01" v-model.number="editor.form.amount"/></div>
          <div class="fitem"><label>日期</label>
            <div class="fctrl"><el-date-picker v-model="editor.form.date" type="date" value-format="YYYY-MM-DD"/></div>
          </div>
          <div class="fitem span2"><label>备注</label><input v-model="editor.form.remark"/></div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="editor.open = false">取消</button>
          <button class="btn primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <doc-viewer :doc-id="viewerId" @close="viewerId = null"/>
  </div>`,
};

