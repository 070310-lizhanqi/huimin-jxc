'use strict';
/* web/js/25-mount.js —— 由 app.js 拆分（lines 4401-4407） */
/* ================= 挂载 ================= */
const app = createApp(App);
app.use(ElementPlus, { locale: ElementPlusLocaleZhCn });
for (const [name, comp] of Object.entries(ElementPlusIconsVue)) app.component(name, comp);
app.component('doc-viewer', DocViewer);
app.component('login-page', LoginPage);
app.component('count-up', CountUp);
app.component('sk-table', SkTable);
app.component('sk-chart', SkChart);
app.mount('#app');
