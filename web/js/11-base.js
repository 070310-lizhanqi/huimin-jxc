'use strict';
/* web/js/11-base.js —— 由 app.js 拆分（lines 1265-1431） */
/* ================= 基础档案 ================= */
const BasePage = {
  setup() {
    const BASE_TABS = ['warehouse', 'reservoir', 'cat', 'unit', 'clerk', 'account'];
    const baseTabParam = route.q.tab;
    const tab = ref(BASE_TABS.includes(baseTabParam) ? baseTabParam : 'warehouse');
    watch(() => route.q.tab, (t) => { if (BASE_TABS.includes(t)) { tab.value = t; loadBase(); } });
    const tabs = [
      { key: 'warehouse', label: '仓库' },
      { key: 'reservoir', label: '库位' },
      { key: 'cat', label: '商品分类' },
      { key: 'unit', label: '商品单位' },
      { key: 'clerk', label: '业务员' },
      { key: 'account', label: '资金账户' },
    ];
    const editor = reactive({ open: false, kind: '', id: null, form: {} });

    const list = computed(() => {
      switch (tab.value) {
        case 'warehouse': return store.warehouses;
        case 'reservoir': return store.reservoirs;
        case 'cat': return store.cats;
        case 'clerk': return store.clerks;
        case 'account': return store.accounts;
        case 'unit': return store.units;
        default: return [];
      }
    });

    function openNew() {
      const k = tab.value;
      editor.kind = k; editor.id = null;
      editor.form = k === 'reservoir' ? { warehouseId: null, name: '' }
        : k === 'cat' ? { parentId: null, name: '' }
        : k === 'clerk' ? { name: '', mobile: '' }
        : k === 'account' ? { name: '', type: 'cash', balance: 0 }
        : { name: '', remark: '' };
      editor.open = true;
    }
    function openEdit(row) {
      const k = tab.value;
      editor.kind = k; editor.id = row.id;
      editor.form = k === 'reservoir' ? { warehouseId: row.warehouseId, name: row.name }
        : k === 'cat' ? { parentId: row.parentId, name: row.name }
        : k === 'clerk' ? { name: row.name, mobile: row.mobile || '' }
        : k === 'account' ? { name: row.name, type: row.type || 'cash', balance: (row.balance || 0) / 100 }
        : { name: row.name, remark: row.remark || '' };
      editor.open = true;
    }
    async function save() {
      const k = editor.kind;
      if (!String(editor.form.name || '').trim()) return toast('请输入名称', 'error');
      const body = { teamId: store.teamId, ...editor.form };
      if (k === 'account') body.balance = toCents(body.balance);
      try {
        if (editor.id) await api.put(`/${k}/${editor.id}`, body);
        else await api.post(`/${k}`, body);
        editor.open = false;
        toast('已保存');
        await loadBase();
      } catch (e) { toast(e.message, 'error'); }
    }
    async function del(row) {
      if (!(await confirmBox(`删除「${row.name}」？被引用的记录将被拒绝。`))) return;
      try { await api.del(`/${tab.value}/${row.id}`, { teamId: store.teamId }); toast('已删除'); await loadBase(); }
      catch (e) { toast(e.message, 'error'); }
    }
    const whName = (id) => byId(store.warehouses, id)?.name || `#${id}`;
    const catName = (id) => byId(store.cats, id)?.name || '';
    const typeText = { cash: '现金', bank: '银行', wechat: '微信', alipay: '支付宝' };
    return { tab, tabs, list, editor, openNew, openEdit, save, del, whName, catName, typeText, fmtMoney, store };
  },
  template: `
  <div>
    <div class="page-card">
      <div class="page-head">
        <span class="hd-title">基础档案</span>
        <div class="tabs">
          <span class="tb" v-for="t in tabs" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">{{ t.label }}</span>
        </div>
        <div class="hd-right"><button class="btn primary" @click="openNew">＋ 新增</button></div>
      </div>
      <div class="tbl-wrap">
        <table class="tbl" v-if="tab==='warehouse'">
        <thead><tr><th style="width:38%">仓库名称</th><th>备注</th><th style="width:130px">操作</th></tr></thead>
        <tbody>
          <tr v-if="!list.length"><td colspan="3"><div class="empty">暂无仓库</div></td></tr>
          <tr v-for="r in list" :key="r.id"><td style="font-weight:500">{{ r.name }}</td><td class="muted">{{ r.remark || '—' }}</td>
            <td><button class="btn sm" @click="openEdit(r)">编辑</button><button class="btn sm danger" style="margin-left:6px" @click="del(r)">删除</button></td></tr>
        </tbody>
      </table>
      <table class="tbl" v-else-if="tab==='reservoir'">
        <thead><tr><th style="width:38%">库位名称</th><th>所属仓库</th><th style="width:130px">操作</th></tr></thead>
        <tbody>
          <tr v-if="!list.length"><td colspan="3"><div class="empty">暂无库位</div></td></tr>
          <tr v-for="r in list" :key="r.id"><td style="font-weight:500">{{ r.name }}</td><td>{{ whName(r.warehouseId) }}</td>
            <td><button class="btn sm" @click="openEdit(r)">编辑</button><button class="btn sm danger" style="margin-left:6px" @click="del(r)">删除</button></td></tr>
        </tbody>
      </table>
      <table class="tbl" v-else-if="tab==='cat'">
        <thead><tr><th style="width:38%">分类名称</th><th>上级分类</th><th style="width:130px">操作</th></tr></thead>
        <tbody>
          <tr v-if="!list.length"><td colspan="3"><div class="empty">暂无分类</div></td></tr>
          <tr v-for="r in list" :key="r.id"><td style="font-weight:500">{{ r.name }}</td><td class="muted">{{ r.parentId ? catName(r.parentId) : '—' }}</td>
            <td><button class="btn sm" @click="openEdit(r)">编辑</button><button class="btn sm danger" style="margin-left:6px" @click="del(r)">删除</button></td></tr>
        </tbody>
      </table>
      <table class="tbl" v-else-if="tab==='clerk'">
        <thead><tr><th style="width:38%">姓名</th><th>手机</th><th style="width:130px">操作</th></tr></thead>
        <tbody>
          <tr v-if="!list.length"><td colspan="3"><div class="empty">暂无业务员</div></td></tr>
          <tr v-for="r in list" :key="r.id"><td style="font-weight:500">{{ r.name }}</td><td class="muted">{{ r.mobile || '—' }}</td>
            <td><button class="btn sm" @click="openEdit(r)">编辑</button><button class="btn sm danger" style="margin-left:6px" @click="del(r)">删除</button></td></tr>
        </tbody>
      </table>
      <table class="tbl" v-else-if="tab==='unit'">
        <thead><tr><th style="width:38%">单位名称</th><th>备注</th><th style="width:130px">操作</th></tr></thead>
        <tbody>
          <tr v-if="!list.length"><td colspan="3"><div class="empty">暂无单位</div></td></tr>
          <tr v-for="r in list" :key="r.id"><td style="font-weight:500">{{ r.name }}</td><td class="muted">{{ r.remark || '—' }}</td>
            <td><button class="btn sm" @click="openEdit(r)">编辑</button><button class="btn sm danger" style="margin-left:6px" @click="del(r)">删除</button></td></tr>
        </tbody>
      </table>
      <table class="tbl" v-else>
        <thead><tr><th style="width:38%">账户名称</th><th>类型</th><th class="r">余额</th><th style="width:130px">操作</th></tr></thead>
        <tbody>
          <tr v-if="!list.length"><td colspan="4"><div class="empty">暂无账户</div></td></tr>
          <tr v-for="r in list" :key="r.id"><td style="font-weight:500">{{ r.name }}</td><td>{{ typeText[r.type] || r.type }}</td><td class="r money">{{ fmtMoney(r.balance) }}</td>
            <td><button class="btn sm" @click="openEdit(r)">编辑</button><button class="btn sm danger" style="margin-left:6px" @click="del(r)">删除</button></td></tr>
        </tbody>
      </table>
      </div>
    </div>

    <div class="modal-mask" v-if="editor.open" @click.self="editor.open = false">
      <div class="modal narrow">
        <div class="modal-head"><span class="mt">编辑档案</span><span class="x" @click="editor.open = false">×</span></div>
        <div class="modal-body">
          <div class="fitem"><label>名称</label><input v-model="editor.form.name"/></div>
          <div class="fitem" v-if="editor.kind==='reservoir'"><label>所属仓库</label>
            <div class="fctrl"><el-select v-model="editor.form.warehouseId" placeholder="选择仓库">
              <el-option v-for="w in store.warehouses" :key="w.id" :label="w.name" :value="w.id"/>
            </el-select></div>
          </div>
          <div class="fitem" v-if="editor.kind==='cat'"><label>上级分类</label>
            <div class="fctrl"><el-select v-model="editor.form.parentId" clearable placeholder="无（顶级分类）">
              <el-option v-for="c in store.cats.filter(c => c.id !== editor.id)" :key="c.id" :label="c.name" :value="c.id"/>
            </el-select></div>
          </div>
          <div class="fitem" v-if="editor.kind==='clerk'"><label>手机</label><input v-model="editor.form.mobile"/></div>
          <div class="fitem" v-if="editor.kind==='account'"><label>类型</label>
            <div class="fctrl"><el-select v-model="editor.form.type">
              <el-option v-for="(v, k) in typeText" :key="k" :label="v" :value="k"/>
            </el-select></div>
          </div>
          <div class="fitem" v-if="editor.kind==='account'"><label>期初余额(元)</label><input type="number" step="0.01" v-model.number="editor.form.balance"/></div>
          <div class="fitem" v-if="editor.kind==='warehouse'"><label>备注</label><input v-model="editor.form.remark"/></div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="editor.open = false">取消</button>
          <button class="btn primary" @click="save">保存</button>
        </div>
      </div>
    </div>
  </div>`,
};

