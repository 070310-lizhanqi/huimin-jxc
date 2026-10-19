'use strict';
/* web/js/16-help.js —— 由 app.js 拆分（lines 2631-2724） */
/* ================= 使用帮助 ================= */
const HelpPage = {
  setup() {
    const tab = ref('quick');
    const tabs = [
      { key: 'quick', label: '快速上手' },
      { key: 'flow', label: '单据与流转' },
      { key: 'pages', label: '各页面说明' },
      { key: 'faq', label: '常见问题' },
    ];
    return { tab, tabs, nav };
  },
  template: `
  <div>
    <div class="toolbar">
      <button class="btn" v-for="t in tabs" :key="t.key" :class="{primary: tab===t.key}" @click="tab=t.key">{{ t.label }}</button>
    </div>

    <div class="card" v-if="tab==='quick'" style="padding:20px 24px;max-width:860px">
      <h3 style="margin:0 0 6px">快速上手（5 分钟开始记账）</h3>
      <p class="muted" style="margin-top:0">按顺序完成前三步即可正常使用，后面按业务需要逐步使用。</p>
      <ol style="line-height:2.1;font-size:13.5px;padding-left:20px">
        <li><b>建仓库</b> —— 「档案设置 → 仓库」新建至少一个仓库（如「主仓」）。所有库存都挂在仓库下。</li>
        <li><b>建商品</b> —— 「商品管理 → + 新建商品」：名称、单位、进价、售价，建议填写<b>安全库存</b>（低于它工作台会预警）。</li>
        <li><b>建往来单位</b> —— 「往来单位」添加客户与供应商；开单时选择对方，应收应付自动累计。</li>
        <li><b>采购入库</b> —— 「采购管理 → 采购入库 → + 新建」：选供应商、商品、数量、单价，保存草稿后点<b>审核</b>，库存立即增加、若赊购则记应付。</li>
        <li><b>销售出库</b> —— 「销售管理 → 销售出库」：选客户开单审核，库存扣减、赊销记应收。</li>
        <li><b>收款付款</b> —— 「资金 → 收付款 → + 收款/+ 付款」：核销应收应付，可选资金账户记录余额。</li>
      </ol>
      <div style="background:#f8f9fb;border-radius:8px;padding:12px 16px;font-size:13px;color:var(--muted)">
        💡 单据分「草稿 / 已审核 / 已作废」三态：草稿可随意改删；<b>审核后才会影响库存和往来余额</b>；作废会反向冲回。      </div>
    </div>

    <div class="card" v-else-if="tab==='flow'" style="padding:20px 24px;max-width:860px">
      <h3 style="margin:0 0 12px">单据类型与流转规则</h3>
      <table class="tbl">
        <thead><tr><th>单据</th><th>对方</th><th>审核后对库存的影响</th><th>审核后对往来的影响</th></tr></thead>
        <tbody>
          <tr><td>采购订单</td><td>供应商</td><td class="muted">不影响（可一键转采购入库）</td><td class="muted">不影响</td></tr>
          <tr><td>采购入库</td><td>供应商</td><td>库存 +</td><td>应付 +</td></tr>
          <tr><td>采购退货</td><td>供应商</td><td>库存 −</td><td>应付 −</td></tr>
          <tr><td>销售订单</td><td>客户</td><td class="muted">不影响（可一键转销售出库）</td><td class="muted">不影响</td></tr>
          <tr><td>销售出库</td><td>客户</td><td>库存 −</td><td>应收 +</td></tr>
          <tr><td>销售退货</td><td>客户</td><td>库存 +</td><td>应收 −</td></tr>
          <tr><td>调拨单</td><td class="muted">—</td><td>仓库间移动（总数不变）</td><td class="muted">—</td></tr>
          <tr><td>库存调整</td><td class="muted">—</td><td>盘盈 + / 盘亏 −（数量可负）</td><td class="muted">—</td></tr>
          <tr><td>盘点单</td><td class="muted">—</td><td>按实盘数校准</td><td class="muted">—</td></tr>
          <tr><td>出库申请单</td><td>客户</td><td class="muted">不影响（审核后一键转销售出库）</td><td class="muted">不影响</td></tr>
          <tr><td>生产任务</td><td class="muted">—</td><td class="muted">不影响（审核后一键转生产组装）</td><td class="muted">不影响</td></tr>
        </tbody>
      </table>
      <div style="margin-top:14px;font-size:13.5px;line-height:1.9">
        <b>典型业务闭环：</b><br/>
        采购：采购订单（草稿→审核）→ 生成采购入库 → 审核（库存+、应付+）→ 收付款页登记付款（应付−）<br/>
        销售：销售订单（草稿→审核）→ 生成销售出库 → 审核（库存−、应收+）→ 收付款页登记收款（应收−）<br/>
        退货：采购退货直接审核即可冲回库存与应付；销售退货同理。      </div>
      <div style="background:#fff8e6;border-radius:8px;padding:12px 16px;font-size:13px;margin-top:12px">
        ⚠️ 出库类单据审核时会校验库存：库存不足会提示「可用 N，需要 M」并拒绝审核。批次出库按先进先出（FIFO）扣减。      </div>
    </div>

    <div class="card" v-else-if="tab==='pages'" style="padding:20px 24px;max-width:860px">
      <h3 style="margin:0 0 12px">各页面功能说明</h3>
      <table class="tbl">
        <thead><tr><th style="width:130px">页面</th><th>能做什么</th></tr></thead>
        <tbody>
          <tr><td>工作台</td><td>库存/资金总览、低库存预警、近 14 天出入库趋势、快捷开单入口、最新单据。</td></tr>
          <tr><td>采购管理</td><td>采购订单 / 采购入库 / 采购退货三类单据的查询、新建、审核、转化、导出、打印。</td></tr>
          <tr><td>销售管理</td><td>销售订单 / 销售出库 / 销售退货，同上。</td></tr>
          <tr><td>库存单据</td><td>调拨单（仓库间移库）、库存调整（盘盈亏）、盘点单。</td></tr>
          <tr><td>实时库存</td><td>按仓库+商品查即时库存，低库存标红，可导出 CSV。</td></tr>
          <tr><td>库存流水</td><td>每一笔出入库的时间线，可追溯来源单据。</td></tr>
          <tr><td>销售报表</td><td>按日期范围统计净销售额、毛利估算、商品销售排行（含加权成本）、客户排行，可导出 CSV。</td></tr>
          <tr><td>商品管理</td><td>商品档案：价格、规格、条码、安全库存，可导出；支持从 Excel 粘贴批量导入。</td></tr>
          <tr><td>往来单位</td><td>客户与供应商档案。</td></tr>
          <tr><td>档案设置</td><td>仓库 / 库位 / 商品分类 / 业务员 / 资金账户。</td></tr>
          <tr><td>收付款</td><td>登记收款付款、查看应收应付与每个往来单位的余额明细。</td></tr>
        </tbody>
      </table>
    </div>

    <div class="card" v-else style="padding:20px 24px;max-width:860px">
      <h3 style="margin:0 0 12px">常见问题</h3>
      <div style="font-size:13.5px;line-height:1.7">
        <p><b>Q：单据审核后还能改吗？</b><br/>A：不能。已审核单据只能「作废」（自动反向冲回库存与往来），然后重新开单。这是保证账目可追溯的设计。</p>
        <p><b>Q：删除商品/客户时提示被引用？</b><br/>A：被单据引用或仍有库存的档案不能删除，避免历史单据出现悬空引用。可以不处理，或先作废相关单据。</p>
        <p><b>Q：库存明明有货，审核出库却提示不足？</b><br/>A：库存按「仓库+库位+批次」维度分别记账。检查出库仓库是否选对；带批次的商品按批次分别扣减。</p>
        <p><b>Q：应收/应付什么时候产生？</b><br/>A：入库/出库单审核且选择了往来单位时产生。订单不产生；收付款用于冲减。客户余额为负表示预收款。</p>
        <p><b>Q：双击了保存会重复开单吗？</b><br/>A：不会。系统对完全相同的单据内容在 5 秒内自动去重，返回同一张单。</p>
        <p><b>Q：怎么备份数据？</b><br/>A：数据存于服务端 data/orange-clone.db（SQLite 单文件），复制该文件即完成备份。</p>
      </div>
    </div>
  </div>`,
};

