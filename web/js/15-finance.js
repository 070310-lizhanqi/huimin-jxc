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

    async function load() {
      const [s, b] = await Promise.all([
        api.get('/settlement/list', { teamId: store.teamId }),
        api.get('/partner/balance', { teamId: store.teamId }),
      ]);
      settlements.value = s;
      balances.value = b;
      loadDocNos();
    }
    onMounted(load);

    // 关联单据单号缓存：收付款记录里只有 refDocId，需要单独查
    const docNos = ref({});
    async function loadDocNos() {
      const ids = settlements.value.map((s) => s.refDocId).filter(Boolean);
      const uniq = [...new Set(ids)].filter((id) => !docNos.value[id]);
      if (!uniq.length) return;
      const next = { ...docNos.value };
      await Promise.all(uniq.map(async (id) => {
        try {
          const d = await api.get('/doc/info', { teamId: store.teamId, id });
          next[id] = d.doc?.billNo ?? ('#' + id);
        } catch { next[id] = '#' + id; }
      }));
      docNos.value = next;
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
        date: new Date().toISOString().slice(0, 10), remark: '',
      };
      editor.open = true;
    }
    const partnerOpts = computed(() => editor.form.partnerType === 'cus' ? store.customers : store.vendors);
    function partnerName(f) {
      const list = f.partnerType === 'cus' ? store.customers : store.vendors;
      return list.find((p) => p.id === f.partnerId)?.name ?? ('#' + f.partnerId);
    }
    async function save() {
      const f = editor.form;
      if (!f.partnerId) return toast('请选择往来单位', 'error');
      if (!(Number(f.amount) > 0)) return toast('金额必须大于 0', 'error');
      try {
        if (f.id) {
          await api.put('/settlement/' + f.id, {
            teamId: store.teamId, accountId: f.accountId || null,
            amount: Math.round(Number(f.amount) * 100), date: f.date, remark: f.remark,
          });
        } else {
          await api.post('/settlement/create', {
            teamId: store.teamId, type: f.type, partnerType: f.partnerType, partnerId: f.partnerId,
            accountId: f.accountId || null, amount: Math.round(Number(f.amount) * 100),
            date: f.date, remark: f.remark,
          });
        }
        editor.open = false;
        toast(f.id ? '已保存' : '已登记');
        load();
        loadBase();
      } catch (e) { toast(e.message, 'error'); }
    }

    function openEdit(s) {
      editor.form = {
        id: s.id, type: s.type, partnerType: s.partnerType, partnerId: s.partnerId,
        accountId: s.accountId, amount: s.amount / 100, date: s.date, remark: s.remark || '',
      };
      editor.open = true;
    }

    async function remove(s) {
      const ok = await confirmBox(
        `确定删除这笔${s.type === 'receipt' ? '收款' : '付款'}记录（${fmtMoney(s.amount)}）？删除后会冲回往来余额与账户余额。`,
        '删除确认',
      );
      if (!ok) return;
      try {
        await api.del('/settlement/' + s.id, { teamId: store.teamId });
        toast('已删除');
        load();
        loadBase();
      } catch (e) { toast(e.message, 'error'); }
    }
    return { settlements, tab, editor, viewerId, receivable, payable, balRows, openNew, openEdit, remove, save, partnerOpts, partnerName, docNoOf, gotoDoc, load, store, fmtMoney };
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
          <button class="btn" @click="openNew('payment')">+ 付款</button>
          <button class="btn primary" @click="openNew('receipt')">+ 收款</button>
        </div>
      </div>
      <div class="tbl-wrap" v-if="tab==='settle'">
        <table class="tbl">
          <thead><tr><th>日期</th><th>类型</th><th>往来单位</th><th>资金账户</th><th class="r">金额</th><th>关联单据</th><th>备注</th><th class="c" style="width:110px">操作</th></tr></thead>
          <tbody>
            <tr v-if="!settlements.length"><td colspan="8"><div class="empty">暂无收付款记录</div></td></tr>
            <tr v-for="s in settlements" :key="s.id">
              <td>{{ s.date }}</td>
              <td><span :class="'tag ' + (s.type === 'receipt' ? 'tag-audit' : 'tag-void')">{{ s.type === 'receipt' ? '收款' : '付款' }}</span></td>
              <td>{{ (s.partnerType === 'cus' ? store.customers.find(c => c.id === s.partnerId) : store.vendors.find(v => v.id === s.partnerId))?.name || '#' + s.partnerId }}</td>
              <td>{{ store.accounts.find(a => a.id === s.accountId)?.name || '—' }}</td>
              <td class="r money">{{ fmtMoney(s.amount) }}</td>
              <td>
                <a v-if="s.refDocId" class="lnk" @click="gotoDoc(s.refDocId)">{{ docNoOf(s.refDocId) }}</a>
                <span v-else class="muted">—</span>
              </td>
              <td class="muted">{{ s.remark || '—' }}</td>
              <td class="c">
                <a class="lnk" @click="openEdit(s)">编辑</a>
                <a class="lnk danger" @click="remove(s)">删除</a>
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
          <button class="btn primary" @click="save">保存</button>
        </div>
      </div>
    </div>

    <doc-viewer :doc-id="viewerId" @close="viewerId = null"/>
  </div>`,
};

