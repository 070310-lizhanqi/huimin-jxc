'use strict';
/* web/js/09-product.js —— 由 app.js 拆分（lines 939-1149） */
/* ================= 商品管理 ================= */
const ProductPage = {
  setup() {
    const kw = ref('');
    const list = ref([]);
    const loading = ref(true);
    /* editor/busy/busyDel 由下方的 useCrudEditor（B-前6）提供 */
    /** B-前2 服务端分页：每页行数记 localStorage（与 13-doc.js 同款 pageSizeOf） */
    const page = ref(1);
    const rows = ref(pageSizeOf('product', 50));
    const total = ref(0);
    const pages = computed(() => Math.max(1, Math.ceil(total.value / rows.value)));
    const pageBtns = computed(() => {
      const n = pages.value,
        c = page.value,
        arr = [];
      for (let p = 1; p <= n; p++) if (p === 1 || p === n || Math.abs(p - c) <= 2) arr.push(p);
      return arr;
    });
    function onRowsChange(e) {
      rows.value = Number(e.target.value) || 50;
      pageSizeSave('product', rows.value);
      page.value = 1;
      load();
    }

    async function load() {
      loading.value = true;
      try {
        const r = await api.get('/product', { teamId: store.teamId, kw: kw.value, page: page.value, rows: rows.value });
        // 分页对象 { rows, total }；数组是旧服务端/异常回落
        if (Array.isArray(r)) {
          list.value = r;
          total.value = r.length;
        } else {
          list.value = r.rows || [];
          total.value = r.total ?? list.value.length;
        }
      } catch (e) {
        toast('商品列表加载失败：' + e.message, 'error');
      } finally {
        loading.value = false;
      }
    }
    /** 关键词查询从第 1 页开始（翻页时 load() 不重置页码） */
    function search() {
      page.value = 1;
      load();
    }
    onMounted(load);
    /** A-安3：商品批量导入仅管理员可用（后端 /product/import 同批加 requireAdmin 守卫） */
    const isAdmin = computed(() => auth.user?.role === 'admin');
    /** B-前6：CRUD 骨架走 useCrudEditor；特殊校验（四价与安全库存禁负）留在本页 validate */
    const crud = useCrudEditor({
      validate(f) {
        if (!String(f.name || '').trim()) return '请输入商品名称';
        // 四价与安全库存禁止负数：toCents 不再静默归零，必须显式拦截
        for (const k of ['salePrice', 'retailPrice', 'wholePrice', 'purchasePrice', 'lowQty']) {
          const n = Number(f[k]);
          if (!Number.isFinite(n) || n < 0) return '价格 / 安全库存不能为负数';
        }
        return null;
      },
      buildBody(f) {
        return {
          teamId: store.teamId,
          name: f.name,
          barcode: f.barcode,
          unit: f.unit,
          spec: f.spec,
          catId: f.catId || null,
          salePrice: toCents(f.salePrice) || 0,
          retailPrice: toCents(f.retailPrice) || 0,
          wholePrice: toCents(f.wholePrice) || 0,
          purchasePrice: toCents(f.purchasePrice) || 0,
          lowQty: Number(f.lowQty) || 0,
          remark: f.remark,
        };
      },
      url: (id) => (id ? `/product/${id}` : '/product'),
      confirmDelete: (p) => `删除商品「${p.name}」？被单据引用或仍有库存的商品将被拒绝。`,
      deleteRequest: (p) => api.del(`/product/${p.id}`, { teamId: store.teamId }),
      afterSave: async (isNew) => {
        // B-前1：只刷新被改的商品集合（旧 loadBase 重拉 9 个档案 + 打印设置 = 10 个请求）
        await refreshBase(['products']);
        await load();
        // 新建的商品按 id 排在末页：跳到末页让用户直接看到它
        if (isNew && page.value !== pages.value) {
          page.value = pages.value;
          await load();
        }
      },
      afterDelete: async () => {
        // B-前1：只刷新商品集合；删空当前页时退回上一页
        await refreshBase(['products']);
        await load();
        if (!list.value.length && page.value > 1) {
          page.value--;
          await load();
        }
      },
    });
    const editor = crud.editor;
    const busy = crud.busy;
    const busyDel = crud.busyDel;
    function openNew() {
      crud.openNew({
        name: '',
        barcode: '',
        unit: '件',
        spec: '',
        catId: null,
        salePrice: 0,
        retailPrice: 0,
        wholePrice: 0,
        purchasePrice: 0,
        lowQty: 0,
        remark: '',
      });
    }
    function openEdit(p) {
      crud.openEdit(p, (row) => ({
        name: row.name,
        barcode: row.barcode || '',
        unit: row.unit || '件',
        spec: row.spec || '',
        catId: row.catId,
        salePrice: (row.salePrice || 0) / 100,
        retailPrice: (row.retailPrice || 0) / 100,
        wholePrice: (row.wholePrice || 0) / 100,
        purchasePrice: (row.purchasePrice || 0) / 100,
        lowQty: row.lowQty ?? 0,
        remark: row.remark || '',
      }));
    }
    const save = crud.save;
    const del = crud.del;

    /* ---- 批量导入 ---- */
    const imp = reactive({ open: false, text: '', result: null, busy: false });
    const IMP_COLS = ['名称', '单位', '分类', '条码', '规格', '进价', '售价', '零售价', '批发价', '安全库存', '备注'];
    const IMP_MAP = {
      名称: 'name',
      单位: 'unit',
      分类: 'catName',
      条码: 'barcode',
      规格: 'spec',
      进价: 'purchasePrice',
      售价: 'salePrice',
      零售价: 'retailPrice',
      批发价: 'wholePrice',
      安全库存: 'lowQty',
      备注: 'remark',
    };
    /* 预览行数上限：粘贴 1 万行直接渲染 1 万个 tr 会冻结 UI；全量数据仍在导入时提交 */
    const IMP_PREVIEW_MAX = 200;
    const impRowsAll = computed(() => {
      const out = [];
      const lines = imp.text
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      for (const [i, line] of lines.entries()) {
        const cells = (line.includes('\t') ? line.split('\t') : line.split(/[,，]/)).map((s) => s.trim());
        const r = {
          name: cells[0] || '',
          unit: cells[1] || '',
          catName: cells[2] || '',
          barcode: cells[3] || '',
          spec: cells[4] || '',
          purchasePrice: cells[5] || '',
          salePrice: cells[6] || '',
          retailPrice: cells[7] || '',
          wholePrice: cells[8] || '',
          lowQty: cells[9] || '',
          remark: cells[10] || '',
          _line: i + 1,
          _err: cells[0] ? '' : '名称为空',
        };
        out.push(r);
      }
      return out;
    });
    const impRows = computed(() => impRowsAll.value.slice(0, IMP_PREVIEW_MAX));
    /* 下载导入模板：带表头 + 2 行示例，用 Excel 打开即填（不要改动第一行表头） */
    function downloadImpTemplate() {
      exportCsv(
        '商品导入模板.csv',
        [
          {
            名称: '可口可乐',
            单位: '件',
            分类: '饮料',
            条码: '6901234567890',
            规格: '500ml',
            进价: '1.50',
            售价: '3.00',
            零售价: '3.50',
            批发价: '2.80',
            安全库存: '24',
            备注: '示例行，可删除',
          },
          {
            名称: '农夫山泉',
            单位: '件',
            分类: '饮料',
            条码: '6909876543210',
            规格: '550ml',
            进价: '0.90',
            售价: '2.00',
            零售价: '2.50',
            批发价: '1.80',
            安全库存: '48',
            备注: '',
          },
        ],
        IMP_COLS.map((label) => ({ key: IMP_MAP[label], label })),
      );
    }
    async function doImport() {
      if (!isAdmin.value) return toast('仅管理员可批量导入商品', 'error');
      if (imp.busy) return;
      const rows = impRowsAll.value.map(({ _line, _err, ...r }) => r);
      if (!rows.length) return toast('请先粘贴数据', 'error');
      imp.busy = true;
      try {
        const r = await api.post('/product/import', { teamId: store.teamId, rows });
        imp.result = r;
        // B-前1：导入可能自动新建分类，刷新商品 + 分类两个集合；导入的商品在末页
        if (r.success > 0) {
          toast(`成功导入 ${r.success} 个商品`);
          await refreshBase(['products', 'cats']);
          await load();
          if (page.value !== pages.value) {
            page.value = pages.value;
            await load();
          }
        }
        if (!r.errors.length) imp.open = false;
      } catch (e) {
        toast(
          /403|Forbidden|仅管理员|权限不足/.test(e.message || '') ? '权限不足：仅管理员可批量导入商品' : e.message,
          'error',
        );
      } finally {
        imp.busy = false;
      }
    }
    /** B-前2：列表已分页，导出要拉全量（不带 page 参数走旧数组口径），否则只导出当前页 */
    async function doExport() {
      try {
        const all = await api.get('/product', { teamId: store.teamId, kw: kw.value });
        const rowsAll = Array.isArray(all) ? all : all.rows || [];
        if (!rowsAll.length) return toast('没有可导出的数据', 'warning');
        exportCsv(
          '商品列表.csv',
          rowsAll.map((p) =>
            moneyRow(
              { ...p, catName: catLabel(p.catId) },
              ['purchasePrice', 'salePrice', 'retailPrice', 'wholePrice'],
              false,
            ),
          ),
          [
            { key: 'name', label: '名称' },
            { key: 'catName', label: '分类' },
            { key: 'spec', label: '规格' },
            { key: 'barcode', label: '条码' },
            { key: 'unit', label: '单位' },
            { key: 'purchasePrice', label: '进价(元)' },
            { key: 'salePrice', label: '售价(元)' },
            { key: 'retailPrice', label: '零售价(元)' },
            { key: 'wholePrice', label: '批发价(元)' },
            { key: 'lowQty', label: '安全库存' },
            { key: 'remark', label: '备注' },
          ],
        );
      } catch (e) {
        toast('导出失败：' + e.message, 'error');
      }
    }
    /** 商品单位候选：优先取单位档案，退化为内置常用单位 */
    const unitOpts = computed(() => {
      const fromStore = (store.units || []).map((u) => u.name).filter(Boolean);
      const builtin = ['个', '件', '箱', '瓶', '包', '袋', '公斤', '米', '台', '套'];
      return Array.from(new Set([...fromStore, ...builtin]));
    });

    return {
      kw,
      list,
      loading,
      editor,
      load,
      search,
      openNew,
      openEdit,
      save,
      del,
      busy,
      busyDel,
      fmtMoney,
      catLabel,
      store,
      exportCsv,
      imp,
      IMP_COLS,
      IMP_MAP,
      impRows,
      impRowsAll,
      doImport,
      unitOpts,
      IMP_PREVIEW_MAX,
      downloadImpTemplate,
      isAdmin,
      page,
      rows,
      total,
      pages,
      pageBtns,
      onRowsChange,
      doExport,
    };
  },
  template: `
  <div>
    <div class="page-card">
      <div class="page-head">
        <span class="hd-title">商品</span>
        <span class="hd-sp"></span>
        <button class="btn" @click="doExport"><el-icon><Download/></el-icon> 导出</button>
        <button class="btn" v-if="isAdmin" @click="imp.open = true; imp.result = null"><el-icon><Upload/></el-icon> 批量导入</button>
        <button class="btn primary" @click="openNew">+ 新增商品</button>
      </div>
      <div class="filterbar">
        <input class="finp w-key" v-model="kw" placeholder="商品名称 / 条码 / 规格" @keyup.enter="search"/>
        <button class="btn" @click="search">查询</button>
        <span class="fb-gap"></span>
        <span class="muted">共 {{ total }} 条</span>
      </div>
      <sk-table v-if="loading && !list.length" :rows="8" :cols="12"/>
      <table class="tbl" v-else>
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
              <button class="btn sm danger" style="margin-left:6px" :disabled="busyDel === p.id" @click="del(p)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="pager" v-if="total > rows">
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

    <div class="modal-mask" v-if="editor.open" @click.self="editor.open = false">
      <div class="modal mid">
        <div class="modal-head"><span class="mt">{{ editor.id ? '编辑商品' : '新建商品' }}</span><span class="x" @click="editor.open = false">×</span></div>
        <div class="modal-body fcols">
          <div class="fitem"><label><span class="req">*</span>名称</label><input v-model="editor.form.name" placeholder="商品名称"/></div>
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
          <button class="btn primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <!-- 批量导入弹窗 -->
    <div class="modal-mask" v-if="imp.open" @click.self="imp.open = false">
      <div class="modal">
        <div class="modal-head"><span class="mt">商品批量导入</span>
          <a class="lnk" style="margin-left:12px;font-size:12.5px" @click="downloadImpTemplate">下载模板</a>
          <span class="x" @click="imp.open = false">×</span></div>
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
          <div class="muted" style="font-size:12px;margin-top:6px" v-if="impRowsAll.length > IMP_PREVIEW_MAX">
            仅预览前 {{ IMP_PREVIEW_MAX }} 行（共 {{ impRowsAll.length }} 行），全部行都会导入
          </div>
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
        <button v-if="!imp.result" class="btn primary" :disabled="!impRows.length || imp.busy" @click="doImport">{{ imp.busy ? '导入中…' : '导入 ' + impRowsAll.length + ' 行' }}</button>
        <button v-else class="btn primary" @click="imp.result = null">继续导入</button>
      </div>
    </div>
  </div>
</div>`,
};
