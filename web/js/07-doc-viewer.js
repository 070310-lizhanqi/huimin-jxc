'use strict';
/* web/js/07-doc-viewer.js —— 由 app.js 拆分（lines 225-367） */
/* ================= 单据查看器（共享组件） ================= */
const DocViewer = {
  props: { docId: { type: Number, default: null } },
  emits: ['close'],
  setup(props, { emit }) {
    const data = ref(null);
    watch(() => props.docId, async (v) => {
      data.value = null;
      if (!v) return;
      try { data.value = await api.get('/doc/info', { id: v, teamId: store.teamId }); }
      catch (e) { toast(e.message, 'error'); emit('close'); }
    }, { immediate: true });
    const close = () => emit('close');
    function printDoc() {
      const d = data.value;
      if (!d) return;
      const w = window.open('', '_blank', 'width=820,height=900');
      if (!w) return toast('浏览器拦截了打印窗口，请允许弹出窗口', 'error');
      const items = d.items.map((it) => `<tr>
        <td>${escapeHtml(prodLabel(it.productId))}</td>
        <td style="text-align:right">${it.qty}</td>
        <td style="text-align:right">${fmtMoney(it.price)}</td>
        <td style="text-align:right">${fmtMoney(it.amount)}</td>
        <td>${escapeHtml(it.batchNo || '')}</td>
        <td>${it.toWarehouseId ? escapeHtml(whLabel(it.toWarehouseId) || '') : ''}</td>
        <td>${escapeHtml(it.remark || '')}</td>
      </tr>`).join('');
      const conf = store.print || {};
      const headHtml = (conf.company || conf.address || conf.phone)
        ? `<div class="head">
             ${conf.showLogo ? '<span class="logo">橙</span>' : ''}
             <div>
               ${conf.company ? `<div class="co">${escapeHtml(conf.company)}</div>` : ''}
               <div class="co-sub">${escapeHtml(conf.address || '')}${conf.phone ? (conf.address ? ' · ' : '') + escapeHtml(conf.phone) : ''}</div>
             </div>
           </div>`
        : '';
      w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(d.doc.billNo)}</title>
        <style>
          body { font-family: 'Microsoft YaHei', sans-serif; padding: 28px; color: #222; font-size: 13px; }
          .head { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid #e0e0e0; padding-bottom: 10px; margin-bottom: 14px; }
          .head .logo { width: 34px; height: 34px; border-radius: 50%; background: #f26f21; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; }
          .head .co { font-size: 15px; font-weight: 600; }
          .head .co-sub { color: #888; font-size: 12px; }
          h2 { text-align: center; margin: 0 0 4px; }
          .sub { text-align: center; color: #888; margin-bottom: 18px; font-size: 12px; }
          table.meta { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
          table.meta td { padding: 3px 6px; }
          table.items { width: 100%; border-collapse: collapse; }
          table.items th, table.items td { border: 1px solid #bbb; padding: 6px 8px; font-size: 12.5px; }
          table.items th { background: #f5f5f5; }
          .total { margin-top: 10px; text-align: right; font-size: 13px; }
          .foot { margin-top: 26px; display: flex; justify-content: space-between; }
        </style></head><body>
        ${headHtml}
        <h2>${escapeHtml(DOC_META[d.doc.type]?.label || d.doc.type)}</h2>
        <div class="sub">单号：${escapeHtml(d.doc.billNo)} 　日期：${escapeHtml((d.doc.date || '').slice(0, 10))}</div>
        <table class="meta"><tr>
          <td>往来单位：${escapeHtml(partnerLabel(d.doc) || '—')}</td>
          <td>仓库：${escapeHtml(whLabel(d.doc.warehouseId) || '—')}</td>
          <td>业务员：${escapeHtml(clerkLabel(d.doc.clerkId) || '—')}</td>
          <td>状态：${escapeHtml(STATUS_TEXT[d.doc.status] || d.doc.status)}</td>
        </tr></table>
        <table class="items"><thead><tr><th>商品</th><th>数量</th><th>单价</th><th>金额</th><th>批次</th><th>调往仓库</th><th>备注</th></tr></thead>
        <tbody>${items}</tbody></table>
        <div class="total">合计数量：${d.doc.totalQty}　合计金额：￥${fmtMoney(d.doc.totalAmount)}</div>
        ${d.doc.remark ? `<div style="margin-top:8px">备注：${escapeHtml(d.doc.remark)}</div>` : ''}
        ${conf.footer ? `<div style="margin-top:14px;text-align:center;color:#888;font-size:12px">${escapeHtml(conf.footer)}</div>` : ''}
        <div class="foot"><span>制单人：____________</span><span>审核人：____________</span><span>签收人：____________</span></div>
        <script>window.onload = () => window.print();<\/script>
      </body></html>`);
      w.document.close();
    }
    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }
    return { data, close, printDoc, fmtMoney, prodLabel, partnerLabel, whLabel, clerkLabel, STATUS_TEXT, DOC_META, accountLabel,
      oweOf: computed(() => {
        const d = data.value && data.value.doc;
        if (!d) return 0;
        return Math.max(0, (d.totalAmount || 0) - (d.paidAmount || 0) - (d.deposit || 0));
      }) };
  },
  template: `
  <div class="modal-mask" v-if="docId" @click.self="close">
    <div class="modal">
      <div class="modal-head">
        <span class="mt">{{ data ? (DOC_META[data.doc.type]?.label || data.doc.type) + ' ' + data.doc.billNo : '单据详情' }}</span>
        <span class="x" @click="close">×</span>
      </div>
      <div class="modal-body" v-if="data">
        <div class="form-grid">
          <div class="fitem"><label>单号</label><span class="billno">{{ data.doc.billNo }}</span></div>
          <div class="fitem"><label>日期</label><span>{{ (data.doc.date || '').slice(0, 10) }}</span></div>
          <div class="fitem" v-if="data.doc.partnerType"><label>{{ data.doc.partnerType === 'cus' ? '客户' : '供应商' }}</label><span>{{ partnerLabel(data.doc) || '#' + data.doc.partnerId }}</span></div>
          <div class="fitem"><label>仓库</label><span>{{ whLabel(data.doc.warehouseId) || '—' }}</span></div>
          <div class="fitem"><label>业务员</label><span>{{ clerkLabel(data.doc.clerkId) || '—' }}</span></div>
          <div class="fitem"><label>状态</label><span :class="'tag tag-' + data.doc.status">{{ STATUS_TEXT[data.doc.status] || data.doc.status }}</span></div>
          <div class="fitem" v-if="data.doc.refOrderId"><label>源订单</label><span class="muted">单据 #{{ data.doc.refOrderId }}</span></div>
          <div class="fitem" v-if="data.doc.receiverName"><label>收件人</label><span>{{ data.doc.receiverName }}</span></div>
          <div class="fitem" v-if="data.doc.receiverMobile"><label>收件手机</label><span>{{ data.doc.receiverMobile }}</span></div>
          <div class="fitem" v-if="data.doc.receiverAddress" style="grid-column:1/-1"><label>收件地址</label><span>{{ data.doc.receiverAddress }}</span></div>
          <div class="fitem" style="grid-column:1/-1"><label>备注</label><span>{{ data.doc.remark || '—' }}</span></div>
          <!-- 结算区（折扣/收付/账户/订金） -->
          <template v-if="(data.doc.discount||0) > 0 || (data.doc.paidAmount||0) > 0 || (data.doc.deposit||0) > 0 || data.doc.accountId">
            <div class="fitem"><label>整单折扣</label><span class="money">{{ fmtMoney(data.doc.discount || 0) }}</span></div>
            <div class="fitem"><label>本次收付</label><span class="money">{{ fmtMoney(data.doc.paidAmount || 0) }}</span></div>
            <div class="fitem"><label>抵扣订金</label><span class="money">{{ fmtMoney(data.doc.deposit || 0) }}</span></div>
            <div class="fitem"><label>收付账户</label><span>{{ accountLabel(data.doc.accountId) || '—' }}</span></div>
          </template>
        </div>
        <table class="tbl" style="margin-top:10px">
          <thead><tr><th>商品</th><th class="r">数量</th><th class="r">单价</th><th class="r">金额</th><th>批次</th><th>调往仓库</th><th>备注</th></tr></thead>
          <tbody>
            <tr v-for="it in data.items" :key="it.id">
              <td>{{ prodLabel(it.productId) }}</td>
              <td class="r">{{ it.qty }}</td>
              <td class="r money">{{ fmtMoney(it.price) }}</td>
              <td class="r money">{{ fmtMoney(it.amount) }}</td>
              <td>{{ it.batchNo || '—' }}</td>
              <td>{{ it.toWarehouseId ? (whLabel(it.toWarehouseId) || '') : '—' }}</td>
              <td>{{ it.remark || '—' }}</td>
            </tr>
          </tbody>
        </table>
        <div class="tfoot-bar">
          <span>合计数量 <b>{{ data.doc.totalQty }}</b></span>
          <span>商品金额 <b class="money">{{ fmtMoney((data.doc.totalAmount || 0) + (data.doc.discount || 0)) }}</b></span>
          <span v-if="(data.doc.discount||0) > 0">折扣 <b class="money">-{{ fmtMoney(data.doc.discount || 0) }}</b></span>
          <span>应收金额 <b class="money" style="color:var(--brand)">{{ fmtMoney(data.doc.totalAmount) }}</b></span>
          <span v-if="oweOf > 0">本次欠款 <b class="money" style="color:#f56c6c">{{ fmtMoney(oweOf) }}</b></span>
        </div>
      </div>
      <div class="modal-body" v-else style="text-align:center;padding:50px"><span class="muted">加载中…</span></div>
      <div class="modal-foot">
        <button class="btn" v-if="data" @click="printDoc"><el-icon><Printer/></el-icon> 打印</button>
        <span style="flex:1"></span>
        <button class="btn" @click="close">关闭</button>
      </div>
    </div>
  </div>`,
};

