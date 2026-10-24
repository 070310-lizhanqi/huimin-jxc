'use strict';
/* web/js/10-partner.js —— 由 app.js 拆分（lines 1150-1264） */
/* ================= 往来单位 ================= */
const PartnerPage = {
  setup() {
    const lockTab = route.q.tab === 'cus' || route.q.tab === 'ven' ? route.q.tab : '';
    const tab = ref(lockTab === 'ven' ? 'ven' : 'cus');
    watch(() => route.q.tab, (t) => { if (t === 'cus' || t === 'ven') { tab.value = t; kw.value = ''; } });
    const kw = ref('');
    const editor = reactive({ open: false, id: null, form: {} });

    const list = computed(() => {
      const src = tab.value === 'cus' ? store.customers : store.vendors;
      const k = kw.value.trim();
      // name 可能为 null（后端 CRUD 不强制非空）：includes 前先兜底
      return k ? src.filter(x => String(x.name || '').includes(k) || String(x.mobile || '').includes(k)) : src;
    });

    function openNew() {
      editor.id = null;
      editor.form = tab.value === 'cus'
        ? { name: '', mobile: '', address: '', remark: '', priceLevel: 'salePrice' }
        : { name: '', mobile: '', address: '', remark: '' };
      editor.open = true;
    }
    function openEdit(p) {
      editor.id = p.id;
      editor.form = tab.value === 'cus'
        ? { name: p.name, mobile: p.mobile || '', address: p.address || '', remark: p.remark || '', priceLevel: p.priceLevel || 'salePrice' }
        : { name: p.name, mobile: p.mobile || '', address: p.address || '', remark: p.remark || '' };
      editor.open = true;
    }
    const busy = ref(false);
    const busyDel = ref(0);
    async function save() {
      // 防双击：CRUD 无去重，重复提交会建出重复档案
      if (busy.value) return;
      if (!String(editor.form.name || '').trim()) return toast('请输入名称', 'error');
      const table = tab.value === 'cus' ? 'customer' : 'vendor';
      const body = { teamId: store.teamId, ...editor.form };
      busy.value = true;
      try {
        if (editor.id) await api.put(`/${table}/${editor.id}`, body);
        else await api.post(`/${table}`, body);
        editor.open = false;
        toast('已保存');
        await loadBase();
      } catch (e) { toast(e.message, 'error'); }
      finally { busy.value = false; }
    }
    async function del(p) {
      if (busyDel.value) return;
      if (!(await confirmBox(`删除「${p.name}」？被单据或收付款引用的将被拒绝。`))) return;
      const table = tab.value === 'cus' ? 'customer' : 'vendor';
      busyDel.value = p.id;
      try { await api.del(`/${table}/${p.id}`, { teamId: store.teamId }); toast('已删除'); await loadBase(); }
      catch (e) { toast(e.message, 'error'); }
      finally { busyDel.value = 0; }
    }
    const LEVEL = { salePrice: '标准售价', wholePrice: '批发价', retailPrice: '零售价' };
    /* 「查询」按钮已删：列表是 kw 前端即时过滤，点查询只会全量重拉 9 张档案表 */
    // 往来单位导出（此前只有商品/库存页有导出，客户供应商名单没法带走）
    function doExport() {
      if (!list.value.length) return toast('没有可导出的数据', 'warning');
      const isCus = tab.value === 'cus';
      exportCsv(
        `${isCus ? '客户' : '供应商'}_${todayStr()}.csv`,
        list.value.map((p) => ({
          name: p.name || '', mobile: p.mobile || '', address: p.address || '',
          level: isCus ? (LEVEL[p.priceLevel] || '标准售价') : '',
          remark: p.remark || '',
        })),
        [
          { key: 'name', label: '名称' }, { key: 'mobile', label: '手机' }, { key: 'address', label: '地址' },
          ...(isCus ? [{ key: 'level', label: '价格等级' }] : []),
          { key: 'remark', label: '备注' },
        ],
      );
    }
    return { tab, lockTab, kw, list, editor, openNew, openEdit, save, del, busy, busyDel, store, LEVEL, doExport };
  },
  template: `
  <div>
    <div class="page-card">
      <div class="page-head">
        <span class="hd-title">{{ tab === 'cus' ? '客户' : '供应商' }}</span>
        <span class="hd-sp"></span>
        <button class="btn primary" @click="openNew">+ 新增{{ tab === 'cus' ? '客户' : '供应商' }}</button>
      </div>
      <div class="filterbar">
        <span class="tabs-inline" v-if="!lockTab">
          <button class="btn sm" :class="{primary: tab==='cus'}" @click="tab='cus'; kw=''">客户</button>
          <button class="btn sm" :class="{primary: tab==='ven'}" @click="tab='ven'; kw=''">供应商</button>
        </span>
        <input class="finp w-key" v-model="kw" placeholder="即时筛选：名称 / 手机">
        <button class="btn" @click="doExport">导出</button>
        <span class="fb-gap"></span>
        <span class="muted">共 {{ list.length }} 条</span>
      </div>
      <table class="tbl">
        <thead><tr><th>名称</th><th>手机</th><th>地址</th><th v-if="tab === 'cus'">价格等级</th><th>备注</th><th style="width:130px">操作</th></tr></thead>
        <tbody>
          <tr v-if="!list.length"><td :colspan="tab === 'cus' ? 6 : 5"><div class="empty">暂无数据</div></td></tr>
          <tr v-for="p in list" :key="p.id">
            <td style="font-weight:500">{{ p.name }}</td>
            <td class="muted">{{ p.mobile || '—' }}</td>
            <td class="muted">{{ p.address || '—' }}</td>
            <td v-if="tab === 'cus'"><span class="tag" :class="p.priceLevel === 'wholePrice' ? 'ok' : p.priceLevel === 'retailPrice' ? 'warn' : ''">{{ LEVEL[p.priceLevel || 'salePrice'] || '标准售价' }}</span></td>
            <td class="muted">{{ p.remark || '—' }}</td>
            <td>
              <button class="btn sm" @click="openEdit(p)">编辑</button>
              <button class="btn sm danger" style="margin-left:6px" :disabled="busyDel === p.id" @click="del(p)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="modal-mask" v-if="editor.open" @click.self="editor.open = false">
      <div class="modal narrow">
        <div class="modal-head"><span class="mt">{{ editor.id ? '编辑' : '新建' }}{{ tab === 'cus' ? '客户' : '供应商' }}</span><span class="x" @click="editor.open = false">×</span></div>
        <div class="modal-body">
          <div class="fitem"><label><span class="req">*</span>名称</label><input v-model="editor.form.name"/></div>
          <div class="fitem"><label>手机</label><input v-model="editor.form.mobile"/></div>
          <div class="fitem" v-if="tab === 'cus'"><label>价格等级</label>
            <div class="fctrl"><el-select v-model="editor.form.priceLevel" style="width:100%">
              <el-option value="salePrice" label="标准售价（默认）"/>
              <el-option value="wholePrice" label="批发价"/>
              <el-option value="retailPrice" label="零售价"/>
            </el-select></div>
          </div>
          <div class="fitem"><label>地址</label><input v-model="editor.form.address"/></div>
          <div class="fitem span2"><label>备注</label><input v-model="editor.form.remark"/></div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="editor.open = false">取消</button>
          <button class="btn primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

  </div>`,
};

