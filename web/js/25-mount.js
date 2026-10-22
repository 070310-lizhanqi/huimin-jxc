'use strict';
/* web/js/25-mount.js —— 由 app.js 拆分（lines 4401-4407） */
/* ================= 挂载 ================= */
const app = createApp(App);
app.use(ElementPlus, { locale: ElementPlusLocaleZhCn });
// 组件渲染/生命周期内的异常会被 Vue 捕获，不会冒泡到 window.onerror。
// 这里统一记录并提示，避免组件内一处报错导致该区域静默留白。
app.config.errorHandler = (err, _instance, info) => {
  console.error('[vue]', info, err);
  try {
    ElMessage({ message: '页面出错：' + String((err && err.message) || err).slice(0, 160), type: 'error', duration: 5000, showClose: true });
  } catch { /* ignore */ }
};
for (const [name, comp] of Object.entries(ElementPlusIconsVue)) app.component(name, comp);
app.component('doc-viewer', DocViewer);
app.component('login-page', LoginPage);
app.component('count-up', CountUp);
app.component('sk-table', SkTable);
app.component('sk-chart', SkChart);
app.mount('#app');
