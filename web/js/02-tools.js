'use strict';
/* web/js/02-tools.js —— 由 app.js 拆分（lines 58-104） */
/* ================= 工具 ================= */
function toast(msg, type = 'success') {
  ElMessage({ message: msg, type, duration: 2400, showClose: false });
}
async function confirmBox(msg, tip = '提示') {
  try {
    await ElMessageBox.confirm(msg, tip, {
      type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消',
    });
    return true;
  } catch { return false; }
}
function fmtMoney(cents) {
  if (cents == null) return '—';
  return (Number(cents) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/* 行金额（分）整数路径：qty 转「万分」→ × 单价分 → ÷ 10000 取整。
   与后端 lineAmount、编辑器 lineCents 同口径；浮点直接 qty*price 会有 0.1*3333 类 ±1 分误差 */
function lineAmountCents(qty, priceCents) {
  const qtyScaled = Math.round((Number(qty) || 0) * 10000);
  const price = Math.round(Number(priceCents) || 0);
  return Math.round((qtyScaled * price) / 10000);
}
const STATUS_TEXT = { draft: '草稿', pending: '待审核', audit: '已审核', void: '已作废' };

/* 分页每页条数记忆：习惯看 100 条的用户不必每次进页面都重调 */
function pageSizeOf(pageKey, fallback = 20) {
  const n = Number(localStorage.getItem('oc.rows.' + pageKey));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function pageSizeSave(pageKey, n) {
  try { localStorage.setItem('oc.rows.' + pageKey, String(n)); } catch { /* ignore */ }
}

/* 请求序守卫：连点筛选/页签时，先发的慢响应不得覆盖新选择。
   用法：const g = seqGuard(); g.begin(); const my = g.begin(); …响应回来 if (!g.isCurrent(my)) return; */
function seqGuard() {
  let seq = 0;
  return {
    begin() { return ++seq; },
    isCurrent(my) { return my === seq; },
  };
}

/* 数量千分位（与 fmtMoney 同风格，用于数量/计数列） */
function fmtQty(n, decimals = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('zh-CN', { minimumFractionDigits: decimals, maximumFractionDigits: 4 });
}

/* 异步动作防抖：返回包装函数，执行时置 flag 为 true，模板用 :disabled="flag" 禁用按钮 */
function busyFn(flagRef) {
  return (fn) => async (...args) => {
    if (flagRef.value) return;
    flagRef.value = true;
    try { return await fn(...args); }
    finally { flagRef.value = false; }
  };
}

/* 分 → 中文金额大写（打印凭证用）：零壹贰叁肆伍陆柒捌玖 + 拾佰仟万亿，支持到千亿 */
function rmbUpper(cents) {
  const n = Math.round(Number(cents) || 0);
  if (n === 0) return '零元整';
  const NEG = n < 0;
  let v = Math.abs(n);
  const DIGITS = '零壹贰叁肆伍陆柒捌玖';
  const UNITS = ['', '拾', '佰', '仟'];
  const GROUPS = ['', '万', '亿', '万亿'];
  // 分 → 角分两位
  const fen = v % 10;
  const jiao = Math.floor(v / 10) % 10;
  const yuanPart = Math.floor(v / 100);
  // 整数部分按 4 位一组从低位到高位
  const groups = [];
  let rest = yuanPart;
  while (rest > 0) { groups.push(rest % 10000); rest = Math.floor(rest / 10000); }
  let out = '';
  for (let g = groups.length - 1; g >= 0; g--) {
    const num = groups[g];
    if (num === 0) { // 整组为 0：补「零」仅当后面还有非零组
      if (g > 0 && out && !out.endsWith('零')) out += '零';
      continue;
    }
    let gs = '';
    let z = num;
    let unitPos = 0;
    let lastZero = false;
    for (let p = 3; p >= 0; p--) {
      const d = Math.floor(z / (10 ** p)) % 10;
      if (d === 0) {
        if (gs && !lastZero) gs += '零';
        lastZero = true;
      } else {
        gs += DIGITS[d] + UNITS[p];
        lastZero = false;
      }
      void unitPos;
    }
    gs = gs.replace(/零+$/, '');
    out += gs + GROUPS[g];
    // 组后补零衔接（如 100000100 → 壹亿零壹佰）
    if (g > 0 && groups[g - 1] > 0 && groups[g - 1] < 1000 && !out.endsWith('零')) out += '零';
  }
  out = out.replace(/零+/g, '零').replace(/零$/, '') || '零';
  out += '元';
  if (jiao === 0 && fen === 0) out += '整';
  else {
    if (jiao > 0) out += DIGITS[jiao] + '角';
    else if (fen > 0) out += '零';
    if (fen > 0) out += DIGITS[fen] + '分';
  }
  return (NEG ? '负' : '') + out;
}

/* CSV 导出：rows 为对象数组，headers 为 [{key,label}]；前端生成下载。
   防御：历史上三处调用把「表头字符串数组/二维数组」按 (filename, head, rowsOfArrays) 传入，
   导出全空 CSV 还提示成功——检测到该形态时自动对调，杜绝再犯 */
function exportCsv(filename, rows, headers) {
  if (Array.isArray(rows) && rows.length && (typeof rows[0] === 'string' || Array.isArray(rows[0]))) {
    console.warn('[exportCsv] 参数顺序错误（rows/headers 颠倒），已自动纠正：' + filename);
    const t = rows; rows = headers; headers = t;
  }
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    // CSV 公式注入防护：= + - @ 开头的单元格会被 Excel/WPS 当公式执行
    // （如备注被录入 "=HYPERLINK(...)" 时导出即触发）。前置制表符使其按文本处理。
    const guarded = /^[=+\-@\t\r]/.test(s) ? '\t' + s : s;
    return /[",\n\t]/.test(guarded) ? '"' + guarded.replace(/"/g, '""') + '"' : guarded;
  };
  const lines = [headers.map((h) => esc(h.label)).join(',')];
  for (const r of rows) lines.push(headers.map((h) => esc(r[h.key])).join(','));
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
  toast('已导出 ' + filename);
}

/* ================= 通用展示组件（无外部依赖，纯 rAF / 占位） ================= */

/* 数字滚动：从旧值 easing 动画到新值；尊重 prefers-reduced-motion */
const CountUp = {
  props: {
    value: { type: [Number, String], default: 0 },
    decimals: { type: Number, default: 0 },
    duration: { type: Number, default: 900 },
  },
  setup(props) {
    const disp = ref(0);
    let raf = 0, from = 0, startTs = 0;
    const reduce = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const target = () => Number(props.value || 0);
    const fmt = (n) => Number(n || 0).toLocaleString('zh-CN', { minimumFractionDigits: props.decimals, maximumFractionDigits: props.decimals });
    function step(ts) {
      if (!startTs) startTs = ts;
      const p = Math.min(1, (ts - startTs) / Math.max(1, props.duration));
      const e = 1 - Math.pow(1 - p, 3); // easeOutCubic
      disp.value = from + (target() - from) * e;
      if (p < 1) raf = requestAnimationFrame(step);
      else { disp.value = target(); raf = 0; }
    }
    function run() {
      from = disp.value;
      if (raf) { cancelAnimationFrame(raf); raf = 0; startTs = 0; }
      if (reduce || props.duration <= 0) { disp.value = target(); return; }
      raf = requestAnimationFrame(step);
    }
    watch(() => props.value, run);
    onMounted(run);
    onBeforeUnmount(() => { if (raf) cancelAnimationFrame(raf); });
    return { disp, fmt };
  },
  template: '<span>{{ fmt(disp) }}</span>',
};

/* 骨架表格：rows 行 × cols 列，首列宽、末列窄，接近真实表格节奏 */
const SkTable = {
  props: {
    rows: { type: Number, default: 8 },
    cols: { type: Number, default: 6 },
  },
  setup(props) {
    const rows = computed(() => Array.from({ length: Math.max(1, props.rows) }, (_, i) => i));
    const cols = computed(() => Array.from({ length: Math.max(1, props.cols) }, (_, i) => i));
    return { rows, cols };
  },
  template: `
    <div class="sk-table">
      <div class="sk-row" v-for="r in rows" :key="r">
        <div class="sk sk-cell" v-for="c in cols" :key="c"
             :style="c === 0 ? { flex: '2.2 1 0' } : (c === cols.length - 1 ? { flex: '0.7 1 0' } : {})"></div>
      </div>
    </div>`,
};

/* 骨架图：图表卡加载占位 */
const SkChart = {
  props: { height: { type: String, default: '186px' } },
  template: `<div class="sk sk-chart" :style="{ height: height }"></div>`,
};

