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
const STATUS_TEXT = { draft: '草稿', pending: '待审核', audit: '已审核', void: '已作废' };

/* 异步动作防抖：返回包装函数，执行时置 flag 为 true，模板用 :disabled="flag" 禁用按钮 */
function busyFn(flagRef) {
  return (fn) => async (...args) => {
    if (flagRef.value) return;
    flagRef.value = true;
    try { return await fn(...args); }
    finally { flagRef.value = false; }
  };
}

/* CSV 导出：rows 为对象数组，headers 为 [{key,label}]；前端生成下载 */
function exportCsv(filename, rows, headers) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
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

