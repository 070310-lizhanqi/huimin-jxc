/* 橙子进销存 前端 SPA —— Vue3 全局构建 + Element Plus + echarts（无构建步骤） */
'use strict';
const { createApp, ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } = Vue;
const { ElMessage, ElMessageBox } = ElementPlus;

/* ================= 全局错误捕获 =================
 * Vue 运行时编译模板（global build + new Function），任何一处模板/渲染错误都只会在
 * 控制台留红字、页面则静默白屏，用户完全无从判断「是坏了还是没数据」。
 * 这里兜底把未捕获错误与未处理的 Promise 拒绝弹成 toast 并留 console 痕，
 * 让用户至少看到「出错了」而不是面对无声白屏。
 * 去抖：同一个错误在短时间内（如渲染循环反复失败）只提示一次，避免刷屏。
 */
(function installGlobalErrorGuards() {
  const seen = new Map();
  const DEDUP_MS = 5000;
  function report(kind, msg) {
    const text = String(msg || '未知错误');
    if (typeof console !== 'undefined' && console.error) {
      console.error(`[${kind}]`, msg);
    }
    if (typeof window === 'undefined' || typeof ElMessage !== 'function') return;
    const now = Date.now();
    const last = seen.get(text) || 0;
    if (now - last < DEDUP_MS) return;
    seen.set(text, now);
    if (seen.size > 50) {
      for (const [k, t] of seen) if (now - t > DEDUP_MS) seen.delete(k);
    }
    try {
      ElMessage({ message: '页面出错：' + text.slice(0, 160), type: 'error', duration: 5000, showClose: true });
    } catch { /* ElMessage 自身不可用时静默 */ }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('error', (e) => {
      // 资源加载失败（img/script）无 error 详情，用 target 信息兜底
      if (e && e.target && e.target !== window && e.target.tagName) {
        report('资源加载失败', `${e.target.tagName} ${e.target.src || e.target.href || ''}`);
      } else {
        report('页面错误', (e && (e.message || e.error)) || '');
      }
    }, true);
    window.addEventListener('unhandledrejection', (e) => {
      const r = e && e.reason;
      report('未处理的异步错误', (r && (r.message || r)) || '');
    });
  }
})();

