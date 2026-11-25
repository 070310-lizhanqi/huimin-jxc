'use strict';
/* web/js/23-approval.js —— 待审核工作台（从 23-price.js 拆出）
 * 拆分本身不改行为：原 23-price.js 内 ApprovalPage 整段平移至此。
 * 依赖 DocViewer（07-doc-viewer.js）与全局量（store/api/toast/confirmBox/partnerLabel/whLabel/STATUS_TEXT 等），
 * 无跨 23-price/23-settings 的文件内共享量。
 * 注意：必须加载在 24-login.js 之前（登录页路由引用 ApprovalPage）。 */
/* 待审核工作台：集中处理所有待审核单据——由 inject-approval.js 注入 app.js */
const ApprovalPage = {
  components: { DocViewer },
  setup() {
    const list = ref([]);
    const allRows = ref([]);
    const byType = ref([]);
    const filterType = ref('');
    const loading = ref(false);
    const busyId = ref(null);
    const viewerId = ref(null);

    const TYPE_LABEL = {
      stockin: '采购入库',
      stockout: '销售出库',
      transfer: '转仓调拨',
      adjust: '库存调整',
      stocktake: '库存盘点',
      porder: '采购订单',
      sorder: '销售订单',
      pin: '采购退货',
      sret: '销售退货',
      otherin: '其它入库',
      otherout: '其它出库',
      assembly: '生产组装',
      stockinit: '期初库存',
      quo: '报价单',
      outapply: '出库申请单',
      prodtask: '生产任务',
    };
    const TYPE_COLOR = {
      stockin: '#52a552',
      stockout: '#f26f21',
      transfer: '#5b8ff9',
      adjust: '#e6a23c',
      stocktake: '#8fd16a',
      porder: '#9b8afb',
      sorder: '#f56c6c',
      pin: '#6dc8ec',
      sret: '#5ad8a6',
      otherin: '#4dabf7',
      otherout: '#ffa94d',
      assembly: '#cc5de8',
      stockinit: '#20c997',
      quo: '#868e96',
      outapply: '#f783ac',
      prodtask: '#e8b339',
    };

    /** 当前筛选下要显示的行：不筛选 = 全部待审；按类型 = 该类型 */
    const shown = computed(() =>
      filterType.value ? allRows.value.filter((d) => d.type === filterType.value) : allRows.value,
    );

    async function load() {
      loading.value = true;
      try {
        const r = await api.get('/doc/pending', { teamId: store.teamId });
        const rows = r.rows || [];
        // 按类型分组（页签用）
        const map = new Map();
        for (const d of rows) {
          if (!map.has(d.type)) map.set(d.type, []);
          map.get(d.type).push(d);
        }
        byType.value = [...map.entries()]
          .map(([type, rs]) => ({
            type,
            label: TYPE_LABEL[type] || type,
            count: rs.length,
            amount: rs.reduce((s, x) => s + (x.totalAmount || 0), 0),
          }))
          .sort((a, b) => b.count - a.count);
        allRows.value = rows;
        list.value = byType.value;
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        loading.value = false;
      }
    }

    async function doAudit(row) {
      if (busyId.value) return;
      if (!(await confirmBox(`审核「${row.billNo}」将过账写入库存与往来余额，确认？`))) return;
      busyId.value = row.id;
      try {
        await api.post('/doc/audit', { teamId: store.teamId, id: row.id, auditBy: store.team?.name || '管理员' });
        toast('已审核');
        load();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busyId.value = null;
      }
    }

    async function doReject(row) {
      if (busyId.value) return;
      let reason;
      try {
        const r = await ElMessageBox.prompt('请输入驳回原因', `驳回 ${row.billNo}`, {
          confirmButtonText: '确认驳回',
          cancelButtonText: '取消',
          inputPlaceholder: '如：价格录错，请核对后重新提交',
          inputValue: '',
        });
        reason = (r.value || '').trim();
      } catch {
        return;
      }
      busyId.value = row.id;
      try {
        await api.post('/doc/reject', { teamId: store.teamId, id: row.id, reason });
        toast('已驳回');
        load();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        busyId.value = null;
      }
    }

    /** 一键审核当前筛选下的全部 */
    const auditProgress = ref('');
    async function auditAll() {
      const rows = shown.value;
      if (!rows.length) return toast('没有待审核单据', 'warning');
      if (!(await confirmBox(`将审核 ${rows.length} 张单据，审核后不可撤销（可作废），确认？`))) return;
      let okCount = 0;
      const errs = [];
      for (const [i, r] of rows.entries()) {
        // 串行审核较慢，逐张回显进度，避免用户以为卡死
        auditProgress.value = `审核中 ${i + 1}/${rows.length}`;
        try {
          await api.post('/doc/audit', { teamId: store.teamId, id: r.id, auditBy: store.team?.name || '管理员' });
          okCount++;
        } catch (e) {
          errs.push(`${r.billNo || '#' + r.id}：${e.message}`);
        }
      }
      auditProgress.value = '';
      toast(
        `审核成功 ${okCount} 张${errs.length ? `，失败 ${errs.length} 张` : ''}`,
        errs.length ? 'warning' : 'success',
      );
      // 失败明细此前只打 console，用户根本看不到：这里弹窗列出，方便逐张处理
      if (errs.length) {
        const body = errs.slice(0, 20).join('\n') + (errs.length > 20 ? `\n…其余 ${errs.length - 20} 张` : '');
        ElMessageBox.alert(body, `审核失败 ${errs.length} 张`, {
          type: 'warning',
          confirmButtonText: '知道了',
          customStyle: { whiteSpace: 'pre-line', maxWidth: '520px' },
        }).catch(() => {});
      }
      load();
    }

    onMounted(load);
    return {
      list,
      allRows,
      byType,
      filterType,
      shown,
      loading,
      busyId,
      viewerId,
      load,
      doAudit,
      doReject,
      auditAll,
      auditProgress,
      TYPE_LABEL,
      TYPE_COLOR,
      store,
      fmtMoney,
      partnerLabel,
      whLabel,
      STATUS_TEXT,
    };
  },
  template: `
  <div class="page-card">
    <div class="page-head">
      <div class="hd-title">待审核</div>
      <div class="tabs">
        <span :class="['tb', { on: !filterType }]" @click="filterType = ''">全部 ({{ list.reduce((s,x)=>s+x.count,0) }})</span>
        <span v-for="g in byType" :key="g.type" :class="['tb', { on: filterType === g.type }]" @click="filterType = g.type">
          {{ g.label }} ({{ g.count }})
        </span>
      </div>
      <div class="hd-right">
        <button class="btn" @click="load">刷新</button>
        <button class="btn primary" :disabled="loading || auditProgress || !shown.length" @click="auditAll"><el-icon><Select/></el-icon> {{ auditProgress || ('一键审核' + (filterType ? '本类' : '全部')) }}</button>
      </div>
    </div>

    <div v-if="!shown.length" class="empty" style="padding:60px 0">
      <el-icon style="font-size:38px;color:#d0d5dc"><CircleCheck/></el-icon>
      <div style="margin-top:10px">暂无待审核单据</div>
      <div class="muted" style="font-size:12.5px;margin-top:4px">业务员在单据列表点「提交」后会出现在这里</div>
    </div>

    <div v-else class="tbl-wrap">
      <table class="tbl">
        <thead><tr>
          <th style="width:130px">单据类型</th><th>单号</th><th>提交时间</th>
          <th>往来单位</th><th>商品摘要</th><th class="r">金额</th><th style="width:230px">操作</th>
        </tr></thead>
        <tbody>
          <tr v-for="d in shown" :key="d.id">
            <td><span class="tag" :style="{ background: (TYPE_COLOR[d.type]||'#909399') + '1a', color: TYPE_COLOR[d.type]||'#909399' }">{{ TYPE_LABEL[d.type] || d.type }}</span></td>
            <td><span class="billno link" @click="viewerId = d.id">{{ d.billNo }}</span></td>
            <td class="muted">{{ d.submitAt || d.date }}</td>
            <td>{{ partnerLabel(d) || '—' }}</td>
            <td class="muted ellip" :title="d.summary || ''">{{ d.summary || '—' }}</td>
            <td class="r money" nowrap>{{ fmtMoney(d.totalAmount) }}</td>
            <td>
              <div class="row-actions">
                <button class="btn sm primary" :disabled="busyId === d.id" @click="doAudit(d)">{{ busyId === d.id ? '…' : '审核' }}</button>
                <button class="btn sm" :disabled="busyId === d.id" @click="doReject(d)">驳回</button>
                <button class="btn sm" @click="viewerId = d.id">查看</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <doc-viewer :doc-id="viewerId" @close="viewerId = null"/>
  </div>`,
};
