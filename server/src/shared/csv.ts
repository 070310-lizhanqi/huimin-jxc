/**
 * CSV 导出安全转义与通用金额格式化（防止 Excel/WPS 公式注入）
 */

/** 批量 CSV 导出上限：单次最多 20,000 行 */
export const MAX_EXPORT_ROWS = 20000;

/** CSV 单元格转义：公式前缀 (= + - @ \t \r) 前置制表符，含特殊字符加双引号 */
export function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  const guarded = /^[=+\-@\t\r]/.test(s) ? '\t' + s : s;
  return /[",\n\t]/.test(guarded) ? '"' + guarded.replace(/"/g, '""') + '"' : guarded;
}

/** 分 -> 元字符串（两位小数） */
export function centsToYuan(v: unknown): string {
  if (v == null || v === '') return '';
  return (Number(v) / 100).toFixed(2);
}
