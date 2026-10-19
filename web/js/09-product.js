'use strict';
/* web/js/09-product.js —— 由 app.js 拆分（lines 939-1149） */
/* ================= 商品管理 ================= */
const ProductPage = {
  setup() {
    const kw = ref('');
    const list = ref([]);
    const editor = reactive({ open: false, id: null, form: {} });

    async function load() {
      list.value = await api.get('/product', { teamId: store.teamId, kw: kw.value });
    }
    onMounted(load);

    function openNew() {
      editor.id = null;
      editor.form = { name: '', barcode: '', unit: '件', spec: '', catId: null, salePrice: 0, retailPrice: 0, purchasePrice: 0, lowQty: 0, remark: '' };
      editor.open = true;
    }
    function openEdit(p) {
      editor.id = p.id;
      editor.form = {
        name: p.name, barcode: p.barcode || '', unit: p.unit || '件', spec: p.spec || '',
        catId: p.catId, salePrice: (p.salePrice || 0) / 100, retailPrice: (p.retailPrice || 0) / 100,
        purchasePrice: (p.purchasePrice || 0) / 100, lowQty: p.lowQty ?? 0, remark: p.remark || '',
      };
      editor.open = true;
    }
    async function save() {
      const f = editor.form;
      if (!String(f.name || '').trim()) return toast('请输入商品名称', 'error');
      const body = {
        teamId: store.teamId, name: f.name, barcode: f.barcode, unit: f.unit, spec: f.spec,
        catId: f.catId || null,
        salePrice: Math.round(Number(f.salePrice) * 100) || 0,
        retailPrice: Math.round(Number(f.retailPrice) * 100) || 0,
        purchasePrice: Math.round(Number(f.purchasePrice) * 100) || 0,
        lowQty: Number(f.lowQty) || 0,
        remark: f.remark,
      };
      try {
        if (editor.id) await api.put(`/product/${editor.id}`, body);
        else await api.post('/product', body);
        editor.open = false;
        toast('已保存');
        await loadBase();
        load();
      } catch (e) { toast(e.message, 'error'); }
    }
    async function del(p) {
      if (!(await confirmBox(`删除商品「${p.name}」？被单据引用或仍有库存的商品将被拒绝。`))) return;
      try { await api.del(`/product/${p.id}`, { teamId: store.teamId }); toast('已删除'); await loadBase(); load(); }
      catch (e) { toast(e.message, 'error'); }
    }

    /* ---- 批量导入 ---- */
    const imp = reactive({ open: false, text: '', result: null });
    const IMP_COLS = ['名称', '单位', '分类', '条码', '规格', '进价', '售价', '零售价', '批发价', '安全库存', '备注'];
    const IMP_MAP = { 名称: 'name', 单位: 'unit', 分类: 'catName', 条码: 'barcode', 规格: 'spec', 进价: 'purchasePrice', 售价: 'salePrice', 零售价: 'retailPrice', 批发价: 'wholePrice', 安全库存: 'lowQty', 备注: 'remark' };
    const impRows = computed(() => {
      const out = [];
      const lines = imp.text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      for (const [i, line] of lines.entries()) {
        const cells = (line.includes('\t') ? line.split('\t') : line.split(/[,，]/)).map((s) => s.trim());
        const r = {
          name: cells[0] || '', unit: cells[1] || '', catName: cells[2] || '', barcode: cells[3] || '',
          spec: cells[4] || '', purchasePrice: cells[5] || '', salePrice: cells[6] || '',
          retailPrice: cells[7] || '', wholePrice: cells[8] || '', lowQty: cells[9] || '', remark: cells[10] || '',
          _line: i + 1, _err: cells[0] ? '' : '名称为空',
        };
        out.push(r);
      }
      return out;
    });
    async function doImport() {
      const rows = impRows.value.map(({ _line, _err, ...r }) => r);
      if (!rows.length) return toast('请先粘贴数据', 'error');
      try {
        const r = await api.post('/product/import', { teamId: store.teamId, rows });
        imp.result = r;
        if (r.success > 0) { toast(`成功导入 ${r.success} 个商品`); await loadBase(); load(); }
        if (!r.errors.length) imp.open = false;
      } catch (e) { toast(e.message, 'error'); }
    }
        /** 商品单位候选：优先取单位档案，退化为内置常用单位 */
    const unitOpts = computed(() => {
      const fromStore = (store.units || []).map((u) => u.name).filter(Boolean);
      const builtin = ['个', '件', '箱', '瓶', '包', '袋', '公斤', '米', '台', '套'];
      return Array.from(new Set([...fromStore, ...builtin]));
    });

    return { kw, list, editor, load, openNew, openEdit, save, del, fmtMoney, catLabel, store, exportCsv, imp, IMP_COLS, IMP_MAP, impRows, doImport, unitOpts };
  },
  template: `
  <div>
    <div class="page-card">
      <div class="page-head">
        <span class="hd-title">商品</span>
        <span class="hd-sp"></span>
        <button class="btn" @click="exportCsv('商品列表.csv', list, [
          { key: 'name', label: '名称' }, { key: 'spec', label: '规格' },
          { key: 'barcode', label: '条码' }, { key: 'unit', label: '单位' },
          { key: 'purchasePrice', label: '进价(元)' }, { key: 'salePrice', label: '售价(元)' },
          { key: 'lowQty', label: '安全库存' }, { key: 'remark', label: '备注' },
        ])"><el-icon><Download/></el-icon> 导出</button>
        <button class="btn" @click="imp.open = true; imp.result = null"><el-icon><Upload/></el-icon> 批量导入</button>
        <button class="btn primary" @click="openNew">+ 新增商品</button>
      </div>
      <div class="filterbar">
        <input class="finp w-key" v-model="kw" placeholder="商品名称 / 条码 / 规格" @keyup.enter="load"/>
        <button class="btn" @click="load">查询</button>
        <span class="fb-gap"></span>
        <span class="muted">共 {{ list.length }} 条</span>
      </div>
      <table class="tbl">
        <thead><tr><th>名称</th><th>规格</th><th>分类</th><th>条码</th><th>单位</th><th class="r">进价</th><th class="r">售价</th><th class="r">批发价</th><th class="r">零售价</th><th class="r">安全库存</th><th>备注</th><th style="width:130px">操作</th></tr></thead>
        <tbody>
          <tr v-if="!list.length"><td colspan="12"><div class="empty">暂无商品</div></td></tr>
          <tr v-for="p in list" :key="p.id">
            <td style="font-weight:500">{{ p.name }}</td>
            <td>{{ p.spec || '—' }}</td>
            <td>{{ catLabel(p.catId) || '—' }}</td>
            <td class="muted">{{ p.barcode || '—' }}</td>
            <td>{{ p.unit }}</td>
            <td class="r money">{{ fmtMoney(p.purchasePrice) }}</td>
            <td class="r money">{{ fmtMoney(p.salePrice) }}</td>
            <td class="r money">{{ fmtMoney(p.wholePrice) }}</td>
            <td class="r money">{{ fmtMoney(p.retailPrice) }}</td>
            <td class="r">{{ p.lowQty ?? 0 }}</td>
            <td class="muted">{{ p.remark || '—' }}</td>
            <td>
              <button class="btn sm" @click="openEdit(p)">编辑</button>
              <button class="btn sm danger" style="margin-left:6px" @click="del(p)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="modal-mask" v-if="editor.open" @click.self="editor.open = false">
      <div class="modal mid">
        <div class="modal-head"><span class="mt">{{ editor.id ? '编辑商品' : '新建商品' }}</span><span class="x" @click="editor.open = false">×</span></div>
        <div class="modal-body fcols">
          <div class="fitem"><label>名称</label><input v-model="editor.form.name" placeholder="商品名称"/></div>
          <div class="fitem"><label>规格</label><input v-model="editor.form.spec" placeholder="如 500ml"/></div>
          <div class="fitem"><label>分类</label>
            <div class="fctrl"><el-select v-model="editor.form.catId" filterable clearable placeholder="选择分类">
              <el-option v-for="c in store.cats" :key="c.id" :label="c.name" :value="c.id"/>
            </el-select></div>
          </div>
          <div class="fitem"><label>条码</label><input v-model="editor.form.barcode"/></div>
          <div class="fitem"><label>单位</label>
            <el-select v-model="editor.form.unit" filterable allow-create default-first-option placeholder="件 / 瓶 / 箱" style="width:100%">
              <el-option v-for="u in unitOpts" :key="u" :label="u" :value="u"/>
            </el-select>
          </div>
          <div class="fitem"><label>进价(元)</label><input type="number" step="0.01" min="0" v-model.number="editor.form.purchasePrice"/></div>
          <div class="fitem"><label>售价(元)</label><input type="number" step="0.01" min="0" v-model.number="editor.form.salePrice"/></div>
          <div class="fitem"><label>零售价(元)</label><input type="number" step="0.01" min="0" v-model.number="editor.form.retailPrice"/></div>
        <div class="fitem"><label>批发价(元)</label><input type="number" step="0.01" min="0" v-model.number="editor.form.wholePrice" placeholder="客户等级=批发时使用"/></div>
          <div class="fitem"><label>安全库存</label><input type="number" step="any" min="0" v-model.number="editor.form.lowQty" placeholder="低于此数量预警"/></div>
          <div class="fitem span2"><label>备注</label><input v-model="editor.form.remark"/></div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="editor.open = false">取消</button>
          <button class="btn primary" @click="save">保存</button>
        </div>
      </div>
    </div>

    <!-- 批量导入弹窗 -->
    <div class="modal-mask" v-if="imp.open" @click.self="imp.open = false">
      <div class="modal">
        <div class="modal-head"><span class="mt">商品批量导入</span><span class="x" @click="imp.open = false">×</span></div>
        <div class="modal-body" v-if="!imp.result">
          <div style="background:#f8f9fb;border-radius:8px;padding:10px 14px;font-size:12.5px;color:var(--muted);line-height:1.8;margin-bottom:10px">
            每行一个商品，列顺序：<b>{{ IMP_COLS.join('、') }}</b>（制表符 Tab 或英文逗号分隔，从 Excel 直接复制粘贴即可）。<br/>
            名称必填；分类不存在会自动创建；价格支持「12.8」「￥12.8」「1,280」等写法；名称重复的行会被跳过并在结果中提示。
          <textarea v-model="imp.text" rows="8" style="width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:12.5px;font-family:Consolas,monospace" placeholder="可口可乐	件	饮料	6901234567890	500ml	1.50	3.00	3.50	2.80	24	畅销品&#10;农夫山泉	件	饮料	6909876543210	550ml	0.90	2.00	2.50	1.80	48	"></textarea>
          <table class="tbl" style="margin-top:10px" v-if="impRows.length">
            <thead><tr><th class="r">#</th><th v-for="c in IMP_COLS" :key="c">{{ c }}</th><th>校验</th></tr></thead>
            <tbody>
              <tr v-for="r in impRows" :key="r._line" :style="r._err ? { background: '#fff1f0' } : {}">
                <td class="r muted">{{ r._line }}</td>
                <td v-for="c in IMP_COLS" :key="c">{{ r[IMP_MAP[c]] || '—' }}</td>
                <td :style="r._err ? { color: '#f56c6c' } : { color: '#53a551' }">{{ r._err || 'OK' }}</td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>
        <div class="modal-body" v-else>
          <div style="font-size:14px;line-height:2">
            ⋯ <b>{{ imp.result.total }}</b> 行：成功导入 <b style="color:#53a551">{{ imp.result.success }}</b> 个，失败 <b style="color:#f56c6c">{{ imp.result.errors.length }}</b> 个。
          <table class="tbl" v-if="imp.result.errors.length" style="margin-top:8px">
            <thead><tr><th class="r" style="width:60px">行号</th><th>失败原因</th></tr></thead>
            <tbody>
              <tr v-for="e in imp.result.errors" :key="e.row"><td class="r">{{ e.row }}</td><td>{{ e.msg }}</td></tr>
            </tbody>
          </table>
          <div class="muted" style="font-size:12.5px;margin-top:10px">失败的行不会导入；可修正后重新粘贴导入（已成功的不会重复创建）。</div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="imp.open = false">关闭</button>
        <button v-if="!imp.result" class="btn primary" :disabled="!impRows.length" @click="doImport">导入 {{ impRows.length }} 行</button>
        <button v-else class="btn primary" @click="imp.result = null">继续导入</button>
      </div>
    </div>
  </div>
</div>`,
};

