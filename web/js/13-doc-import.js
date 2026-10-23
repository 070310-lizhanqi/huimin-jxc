'use strict';
/* web/js/13-doc-import.js —— Excel/CSV 单据智能导入弹窗（从 13-doc.js 拆出）
 *
 * 职责：选文件 → 识别预览（dryRun）→ 确认导入；导入完成后通知父组件刷新列表。
 * 自持全部弹窗状态，父组件只需 v-if + @close + @imported。
 */
const DocImport = {
  emits: ['close', 'imported'],
  setup(_, { emit }) {
    const imp = reactive({ file: null, autoCreate: false, busy: false, result: null, done: null });
    // 前端单文件上限：与后端 limit 对齐（12MB），xlsx 二进制会 base64 读进 arrayBuffer，
    // 更大文件会让页面瞬间 OOM。
    const MAX_FILE_BYTES = 12 * 1024 * 1024;
    const ALLOW_EXT = /\.(xlsx|csv)$/i;
    function onImpFile(ev) {
      const f = ev.target.files && ev.target.files[0] || null;
      // 同一文件连续选：input change 只在 value 变化时触发，选完清空才能再选同一文件
      ev.target.value = '';
      if (!f) { imp.file = null; return; }
      if (!ALLOW_EXT.test(f.name || '')) {
        imp.file = null;
        toast('只支持 .xlsx 或 .csv 文件', 'error');
        return;
      }
      if (f.size > MAX_FILE_BYTES) {
        imp.file = null;
        toast(`文件过大（${(f.size / 1024 / 1024).toFixed(1)}MB），单文件最大 12MB`, 'error');
        return;
      }
      imp.file = f;
      imp.result = null; imp.done = null;
    }
    async function impUpload(dryRun) {
      if (!imp.file) return toast('请先选择 .xlsx 或 .csv 文件', 'error');
      imp.busy = true;
      try {
        const buf = await imp.file.arrayBuffer();
        const qs = new URLSearchParams({ dryRun: dryRun ? '1' : '0', autoCreate: imp.autoCreate ? '1' : '0' });
        const r = await fetch('/api/doc/import?' + qs, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + auth.token, 'content-type': 'application/octet-stream' },
          body: buf,
        });
        const data = await r.json().catch(() => ({}));
        if (r.status === 401) { logout(); return; }
        if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
        if (dryRun) { imp.result = data; toast('识别完成，请确认后导入'); }
        else {
          imp.done = data;
          toast(`已导入 ${data.summary.imported} 张草稿单据`);
          emit('imported');
        }
      } catch (e) { toast(e.message, 'error'); }
      finally { imp.busy = false; }
    }
    function close() {
      // 释放 File 对象引用：弹窗关闭后 imp.file 还持有二进制，长会话内存累积
      imp.file = null; imp.result = null; imp.done = null;
      emit('close');
    }
    const impTypeName = (t) => (DOC_META[t] ? DOC_META[t].label : t);
    /* 下载单据导入模板：通用列 + 一行示例，识别按列名智能匹配 */
    function downloadTemplate() {
      exportCsv('单据导入模板.csv', [
        { 单号: 'SO-001', 类型: '销售出库', 日期: '2026-10-24', 客户: '示例客户', 供应商: '', 仓库: '主仓库', 商品: '示例商品', 数量: '10', 单价: '12.80', 备注: '示例行，可删除' },
      ], [
        { key: '单号', label: '单号' }, { key: '类型', label: '类型' }, { key: '日期', label: '日期' },
        { key: '客户', label: '客户' }, { key: '供应商', label: '供应商' }, { key: '仓库', label: '仓库' },
        { key: '商品', label: '商品' }, { key: '数量', label: '数量' }, { key: '单价', label: '单价' }, { key: '备注', label: '备注' },
      ]);
    }
    return { imp, onImpFile, impUpload, close, impTypeName, fmtMoney, downloadTemplate };
  },
  template: `
  <div class="modal-mask" @click.self="close">
    <div class="modal mid">
      <div class="modal-head"><span class="mt">Excel 导入单据</span>
        <a class="lnk" style="margin-left:12px;font-size:12.5px" @click="downloadTemplate">下载模板</a>
        <span class="x" @click="close">×</span></div>
      <div class="modal-body">
        <div class="fitem" style="margin-bottom:10px"><label>选择文件</label>
          <div class="fctrl"><input type="file" accept=".xlsx,.csv" @change="onImpFile"/></div>
        </div>
        <div class="fitem" style="margin-bottom:10px"><label>自动建档</label>
          <div class="fctrl" style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" id="imp-auto-create" v-model="imp.autoCreate"/>
            <label for="imp-auto-create" style="margin:0">未识别的商品 / 客户 / 供应商自动创建档案</label>
          </div>
        </div>
        <div class="muted" style="font-size:12.5px;margin-bottom:10px">
          自动识别表头（商品/品名、数量、单价、日期、单号、客户/供应商等）与单据方向；导入结果为<b>草稿</b>，需手动审核过账。有「单号」列时按单号分单，重复导入自动跳过。
        </div>

        <!-- 识别预览 -->
        <template v-if="imp.result">
          <div style="border-top:1px solid #eee;padding-top:10px">
            <b>识别结果</b>：{{ imp.result.file.kind.toUpperCase() }} · 工作表「{{ imp.result.file.sheet }}」 ·
            识别 {{ imp.result.summary.billCount }} 张单 / {{ imp.result.summary.itemCount }} 行明细
            <span v-if="imp.result.summary.errorCount" style="color:#f56c6c">，{{ imp.result.summary.errorCount }} 行错误</span>
            <span v-if="imp.result.summary.skipCount" style="color:#e6a23c">，{{ imp.result.summary.skipCount }} 张跳过</span>
          </div>
          <table class="tbl" style="max-height:220px;overflow:auto">
            <thead><tr><th>类型</th><th>日期</th><th>往来单位</th><th>仓库</th><th>明细数</th><th>金额</th><th>提示</th></tr></thead>
            <tbody>
              <tr v-for="(b, i) in imp.result.bills" :key="i">
                <td>{{ impTypeName(b.type) }}</td>
                <td>{{ b.date }}</td>
                <td>{{ b.partnerName }}</td>
                <td>{{ b.warehouseName }}</td>
                <td>{{ b.items.length }}</td>
                <td class="r money">{{ fmtMoney(b.items.reduce((s, it) => s + lineAmountCents(it.qty, it.price), 0)) }}</td>
                <td class="muted" style="max-width:220px;font-size:12px">{{ (b.warnings || []).join('；') || '—' }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="imp.result.rowErrors.length" style="color:#f56c6c;font-size:12.5px">
            错误行：{{ imp.result.rowErrors.slice(0, 5).map(e => '第' + e.row + '行 ' + e.msg).join('；') }}{{ imp.result.rowErrors.length > 5 ? ' …' : '' }}
          </div>
          <div v-if="imp.result.skipped.length" style="color:#e6a23c;font-size:12.5px">
            跳过：{{ imp.result.skipped.slice(0, 5).map(s => (s.srcBillNo || '') + ' ' + s.reason).join('；') }}{{ imp.result.skipped.length > 5 ? ' …' : '' }}
          </div>
        </template>

        <!-- 导入完成 -->
        <template v-if="imp.done">
          <div style="border-top:1px solid #eee;padding-top:10px;color:#53a551">
            <b>导入完成</b>：新建 {{ imp.done.summary.imported }} 张草稿
            <span v-if="imp.done.summary.skipCount" style="color:#e6a23c">，跳过 {{ imp.done.summary.skipCount }} 张</span>
            <span v-if="imp.done.summary.errorCount" style="color:#f56c6c">，{{ imp.done.summary.errorCount }} 行错误</span>
          </div>
          <div class="muted" style="font-size:12.5px">
            单号：{{ imp.done.created.map(c => c.billNo).join('、') }}
          </div>
        </template>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="close">关闭</button>
        <button v-if="!imp.done" class="btn" :disabled="!imp.file || imp.busy" @click="impUpload(true)">{{ imp.busy ? '处理中…' : '识别预览' }}</button>
        <button v-if="imp.result && !imp.done" class="btn primary" :disabled="imp.busy || !imp.result.summary.billCount" @click="impUpload(false)">
          {{ imp.busy ? '导入中…' : '确认导入 ' + imp.result.summary.billCount + ' 张' }}
        </button>
      </div>
    </div>
  </div>`,
};