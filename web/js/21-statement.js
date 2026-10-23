'use strict';
/* web/js/21-statement.js —— 由 app.js 拆分（lines 3169-3316） */
/* ================= 往来对账单 ================= */
const StatementPage = {
  setup() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const range = reactive([`${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`, today]);
    const mode = ref(route.q.mode === 'ap' ? 'ap' : 'ar');
    const partnerId = ref(null);
    const loading = ref(false);
    const data = ref(null);

    /* 从菜单进入时按 query.mode 切换（客户/供应商两个入口共用本页） */
    watch(() => route.q.mode, (m) => {
      const next = m === 'ap' ? 'ap' : 'ar';
      if (next !== mode.value) { mode.value = next; partnerId.value = null; data.value = null; }
    });

    const partners = computed(() => (mode.value === 'ar' ? store.customers : store.vendors));
    const guard = seqGuard();

    async function load() {
      if (!partnerId.value) return toast('请选择往来单位', 'error');
      if (!range[0] || !range[1]) return toast('请选择日期范围', 'error');
      loading.value = true;
      const my = guard.begin();
      try {
        const r = await api.get('/report/statement', {
          teamId: store.teamId, mode: mode.value, partnerId: partnerId.value,
          from: range[0], to: range[1],
        });
        if (!guard.isCurrent(my)) return;
        data.value = r;
      } catch (e) {
        if (guard.isCurrent(my)) { toast(e.message, 'error'); data.value = null; }
      } finally { if (guard.isCurrent(my)) loading.value = false; }
    }
    function switchMode() { partnerId.value = null; data.value = null; }

    function doExport() {
      if (!data.value) return toast('请先查询', 'error');
      const isAr = mode.value === 'ar';
      exportCsv(`对账单_${data.value.partner.name}_${range[0]}_${range[1]}.csv`,
        data.value.lines.map((l) => ({
          日期: l.date, 单据号: l.billNo, 类型: l.label,
          [isAr ? '应收' : '应付']: l.debit ? (l.debit / 100).toFixed(2) : '',
          [isAr ? '收款' : '付款']: l.credit ? (l.credit / 100).toFixed(2) : '',
          余额: (l.balance / 100).toFixed(2), 备注: l.remark || '',
        })), [
          { key: '日期', label: '日期' }, { key: '单据号', label: '单据号' }, { key: '类型', label: '类型' },
          { key: isAr ? '应收' : '应付', label: isAr ? '应收' : '应付' },
          { key: isAr ? '收款' : '付款', label: isAr ? '收款' : '付款' },
          { key: '余额', label: '余额' }, { key: '备注', label: '备注' },
        ]);
    }

    function doPrint() {
      if (!data.value) return toast('请先查询', 'error');
      const d = data.value;
      const isAr = d.mode === 'ar';
      // 打印抬头里的公司名（功能设置 → 打印抬头），对账单给对方看，抬头必须有
      const company = (store.print?.company || '').trim();
      const rowsHtml = d.lines.map((l) => `<tr>
        <td>${l.date}</td><td>${escapeHtml(l.billNo)}</td><td>${escapeHtml(l.label)}</td>
        <td class="r">${l.debit ? fmtMoney(l.debit) : ''}</td>
        <td class="r">${l.credit ? fmtMoney(l.credit) : ''}</td>
        <td class="r">${fmtMoney(l.balance)}</td><td>${escapeHtml(l.remark || '')}</td></tr>`).join('');
      // 日期 from/to 来自服务端 safeRange，理论上合法 YYYY-MM-DD；此处仍显式转义兜底（防后端被注入异常值）
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>对账单</title>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src 'none'; connect-src 'none'; font-src 'none'">
      <style>
        body{font-family:"Microsoft YaHei",sans-serif;font-size:12px;color:#333;padding:18px}
        h2{text-align:center;font-size:17px;margin:0 0 4px}
        .co{text-align:center;font-size:13px;font-weight:600;margin-bottom:2px}
        .sub{text-align:center;color:#888;font-size:11px;margin-bottom:12px}
        table{width:100%;border-collapse:collapse}
        th,td{border:1px solid #ccc;padding:5px 7px;text-align:left}
        th{background:#f7f9fb}
        .r{text-align:right}.sum{margin-top:10px;text-align:right;font-size:13px}
        .foot{margin-top:18px;display:flex;justify-content:space-between;font-size:11px;color:#666}
      </style></head><body>
      ${company ? `<div class="co">${escapeHtml(company)}</div>` : ''}
      <h2>${isAr ? '客户对账单' : '供应商对账单'}</h2>
      <div class="sub">${escapeHtml(d.partner.name)} ｜ 期间 ${escapeHtml(d.from)} 至 ${escapeHtml(d.to)}</div>
      <table><thead><tr><th>日期</th><th>单据号</th><th>类型</th><th class="r">${isAr ? '应收' : '应付'}</th>
      <th class="r">${isAr ? '收款' : '付款'}</th><th class="r">余额</th><th>备注</th></tr></thead>
      <tbody>
      <tr><td colspan="5"><b>期初余额</b></td><td class="r"><b>${fmtMoney(d.opening)}</b></td><td></td></tr>
      ${rowsHtml}
      </tbody></table>
      <div class="sum">期间发生 ${fmtMoney(d.periodDebit)} ／ 已${isAr ? '收' : '付'} ${fmtMoney(d.periodCredit)}　
        期末余额 <b>${fmtMoney(d.closing)}</b> 元</div>
      <div class="foot"><span>对账日期：${escapeHtml(today)}</span><span>双方签字确认：__________________</span></div>
      </body></html>`;
      const w = window.open('', '_blank');
      if (!w) return toast('打印窗口被浏览器拦截，请允许本站弹出窗口后重试', 'error');
      w.document.write(html);
      w.document.close();
      w.print();
    }

    return { range, mode, partnerId, partners, loading, data, load, switchMode, doExport, doPrint, fmtMoney };
  },
  template: `
  <div class="page-card">
    <div class="page-head">
      <div class="hd-title">{{ mode === 'ar' ? '客户对账单' : '供应商对账单' }}</div>
      <div class="tabs">
        <span class="tb" :class="{ on: mode === 'ar' }" @click="mode = 'ar'; switchMode()">客户对账单</span>
        <span class="tb" :class="{ on: mode === 'ap' }" @click="mode = 'ap'; switchMode()">供应商对账单</span>
      </div>
      <div class="hd-right">
        <button class="btn" @click="doPrint" :disabled="!data"><el-icon><Printer/></el-icon> 打印</button>
        <button class="btn" @click="doExport" :disabled="!data"><el-icon><Download/></el-icon> 导出</button>
      </div>
    </div>
    <div class="filterbar">
      <el-select v-model="partnerId" filterable placeholder="选择往来单位" style="width:200px">
        <el-option v-for="p in partners" :key="p.id" :value="p.id" :label="p.name"/>
      </el-select>
      <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" style="width:260px" :clearable="false"/>
      <button class="btn primary" :disabled="loading" @click="load">{{ loading ? '查询中…' : '查询' }}</button>
    </div>

    <div v-if="data" class="card">
      <div class="card-title" style="margin-bottom:6px">
        {{ data.partner.name }} ｜ {{ data.from }} 至 {{ data.to }}
        <span class="muted" style="font-size:12.5px;font-weight:400;margin-left:8px" v-if="data.partner.mobile">{{ data.partner.mobile }}</span>
      </div>
      <div class="stat-grid" style="margin:10px 0 4px">
        <div class="card stat"><div class="stat-label">期初余额</div>
          <div class="stat-val" :style="data.opening < 0 ? 'color:#3a7bd5' : ''">{{ fmtMoney(data.opening) }}
            <i v-if="data.opening < 0" class="kpi-unit">{{ mode === 'ar' ? '预收' : '预付' }}</i></div></div>
        <div class="card stat"><div class="stat-label">期间{{ mode === 'ar' ? '应收' : '应付' }}</div><div class="stat-val">{{ fmtMoney(data.periodDebit) }}</div></div>
        <div class="card stat"><div class="stat-label">期间已{{ mode === 'ar' ? '收' : '付' }}</div><div class="stat-val">{{ fmtMoney(data.periodCredit) }}</div></div>
        <div class="card stat"><div class="stat-label">期末余额</div>
          <div class="stat-val" :style="data.closing < 0 ? 'color:#3a7bd5' : 'color:var(--brand)'">{{ fmtMoney(data.closing) }}
            <i v-if="data.closing < 0" class="kpi-unit">{{ mode === 'ar' ? '预收' : '预付' }}</i></div></div>
      </div>

      <table class="tbl" style="margin-top:8px">
        <thead><tr><th>日期</th><th>单据号</th><th>类型</th>
          <th class="r">{{ mode === 'ar' ? '应收' : '应付' }}</th>
          <th class="r">{{ mode === 'ar' ? '收款' : '付款' }}</th>
          <th class="r">余额</th><th>备注</th></tr></thead>
        <tbody>
          <tr style="background:#f7f9fb"><td colspan="5"><b>期初余额</b></td><td class="r"><b>{{ fmtMoney(data.opening) }}</b></td><td></td></tr>
          <tr v-for="(l, i) in data.lines" :key="i">
            <td>{{ l.date }}</td><td>{{ l.billNo }}</td><td>{{ l.label }}</td>
            <td class="r">{{ l.debit ? fmtMoney(l.debit) : '' }}</td>
            <td class="r">{{ l.credit ? fmtMoney(l.credit) : '' }}</td>
            <td class="r">{{ fmtMoney(l.balance) }}</td>
            <td class="muted">{{ l.remark || '' }}</td>
          </tr>
          <tr v-if="!data.lines.length"><td colspan="7"><div class="empty">该期间没有发生额</div></td></tr>
          <tr style="background:#f7f9fb;font-weight:600">
            <td colspan="5" style="text-align:right">期末余额</td>
            <td class="r">{{ fmtMoney(data.closing) }}</td><td></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else class="card" style="text-align:center;padding:44px 0;color:#98a2ad">
      选择往来单位与日期范围后点击「查询」，可查看期初余额、期间流水与期末余额。
    </div>
  </div>`,
};

