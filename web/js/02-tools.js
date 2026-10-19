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

