'use strict';
/* web/js/23-price.js —— 由 app.js 拆分（lines 3502-4156） */
/* ================= 客户价格记忆 ================= */
const PricePage = {
  setup() {
    const kw = ref('');
    const partnerId = ref(null);
    const rows = ref([]);
    const loading = ref(false);
    const editor = reactive({ open: false, row: null, price: 0 });

    async function load() {
      loading.value = true;
      try {
        const r = await api.get('/price/list', {
          teamId: store.teamId,
          partnerId: partnerId.value || '',
          kw: kw.value.trim(),
        });
        rows.value = r.rows || [];
      } catch (e) { toast(e.message, 'error'); }
      finally { loading.value = false; }
    }

    function openEdit(row) {
      editor.row = row;
      editor.price = row.price / 100;
      editor.open = true;
    }

    async function save() {
      const cents = toCents(editor.price);
      if (!(cents >= 0)) return toast('价格不能为负', 'error');
      try {
        await api.post('/price/set', {
          teamId: store.teamId,
          partnerId: editor.row.partnerId,
          productId: editor.row.productId,
          price: cents,
        });
        toast('已更新');
        editor.open = false;
        load();
      } catch (e) { toast(e.message, 'error'); }
    }

    async function del(row) {
      const ok = await confirmBox(`删除「${row.cusName || '客户'} - ${row.prodName}」的价格记忆？`);
      if (!ok) return;
      try {
        await api.del(`/price/${row.id}?teamId=${store.teamId}`);
        toast('已删除');
        load();
      } catch (e) { toast(e.message, 'error'); }
    }

    function diffOf(row) {
      if (!row.salePrice) return '';
      const d = row.price - row.salePrice;
      if (d === 0) return '平价';
      return d > 0 ? `高于标准价 ${fmtMoney(d)}` : `低于标准价 ${fmtMoney(-d)}`;
    }

    onMounted(load);
    // 排序：默认按最近成交日期，也可按成交次数/与标准售价的偏差看
    const sortBy = ref('default');
    const sorted = computed(() => {
      const arr = [...rows.value];
      if (sortBy.value === 'times') {
        arr.sort((a, b) => (b.times ?? 0) - (a.times ?? 0));
      } else if (sortBy.value === 'diffAsc') {
        // 低于标准售价最多（对客户最优惠）排前
        arr.sort((a, b) => (a.price - (a.salePrice ?? 0)) - (b.price - (b.salePrice ?? 0)));
      } else if (sortBy.value === 'diffDesc') {
        arr.sort((a, b) => (b.price - (b.salePrice ?? 0)) - (a.price - (a.salePrice ?? 0)));
      } else if (sortBy.value === 'lastDate') {
        arr.sort((a, b) => String(b.lastDate || '').localeCompare(String(a.lastDate || '')));
      }
      return arr;
    });
    return { kw, partnerId, rows, sorted, sortBy, loading, editor, load, openEdit, save, del, diffOf, store, fmtMoney };
  },
  template: `
  <div>
    <div class="page-card">
      <div class="page-head">
        <span class="page-title">客户价格记忆</span>
        <div class="hd-right">
          <button class="btn" @click="load"><el-icon><Refresh/></el-icon> 刷新</button>
        </div>
      </div>

      <div class="filterbar">
        <input class="finp" style="width:150px" v-model="kw" placeholder="商品名称" @keyup.enter="load"/>
        <el-select v-model="partnerId" filterable clearable placeholder="全部客户" style="width:170px" @change="load">
          <el-option v-for="c in store.customers" :key="c.id" :label="c.name" :value="c.id"/>
        </el-select>
        <button class="btn" @click="load">查询</button>
        <el-select v-model="sortBy" style="width:170px" placeholder="排序">
          <el-option label="最近成交优先" value="default"/>
          <el-option label="成交次数高→低" value="times"/>
          <el-option label="低于标准价最多" value="diffAsc"/>
          <el-option label="高于标准价最多" value="diffDesc"/>
        </el-select>
        <span class="muted" style="font-size:12.5px;margin-left:6px">共 {{ rows.length }} 条</span>
      </div>

      <sk-table v-if="loading && !rows.length" :rows="8" :cols="11"/>
      <table class="tbl" v-else>
        <thead><tr>
          <th style="width:52px" class="r">#</th>
          <th>客户</th><th>商品</th><th>规格</th><th>单位</th>
          <th class="r">记忆成交价</th><th class="r">商品标准售价</th><th>对比</th>
          <th>最后一次成交</th><th class="r">成交次数</th><th style="width:130px">操作</th>
        </tr></thead>
        <tbody>
          <tr v-if="!rows.length"><td colspan="11"><div class="empty">暂无价格记忆。销售类单据审核后，系统会自动记住每个客户的成交价。</div></td></tr>
          <tr v-for="(r, i) in sorted" :key="r.id">
            <td class="r muted">{{ i + 1 }}</td>
            <td>{{ r.cusName || '—' }}</td>
            <td style="font-weight:500">{{ r.prodName }}</td>
            <td class="muted">{{ r.spec || '—' }}</td>
            <td class="muted">{{ r.unit || '—' }}</td>
            <td class="r money"><b>{{ fmtMoney(r.price) }}</b></td>
            <td class="r money muted">{{ fmtMoney(r.salePrice) }}</td>
            <td :class="r.price > r.salePrice ? 'txt-warn' : (r.price < r.salePrice ? 'txt-ok' : 'muted')">{{ diffOf(r) }}</td>
            <td class="muted">{{ r.lastDate || '—' }}</td>
            <td class="r">{{ r.times }}</td>
            <td>
              <button class="btn sm" @click="openEdit(r)">改价</button>
              <button class="btn sm danger" style="margin-left:6px" @click="del(r)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="modal-mask" v-if="editor.open" @click.self="editor.open = false">
      <div class="modal narrow">
        <div class="modal-head"><span class="mt">修改价格记忆</span><span class="x" @click="editor.open = false">×</span></div>
        <div class="modal-body">
          <div class="fitem"><label>客户</label><div>{{ editor.row.cusName }}</div></div>
          <div class="fitem"><label>商品</label><div>{{ editor.row.prodName }}（标准价 {{ fmtMoney(editor.row.salePrice) }}）</div></div>
          <div class="fitem"><label>记忆成交价(元)</label><input type="number" step="0.01" min="0" v-model.number="editor.price"/></div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="editor.open = false">取消</button>
          <button class="btn primary" @click="save">保存</button>
        </div>
      </div>
    </div>
  </div>`,
};

/* 功能设置页（单据编号 / 打印抬头）——由 inject-settings.js 注入 app.js */
const SettingsPage = {
  setup() {
    const tab = ref('prefix');
    const loading = ref(false);
    const saving = ref(false);
    const prefix = reactive({});
    const noMode = ref('day');
    const print = reactive({ company: '', address: '', phone: '', footer: '', showLogo: true });
    const defaults = ref({});
    const DOC_LABELS = {
      stockin: '采购入库', stockout: '销售出库', transfer: '转仓调拨', adjust: '库存调整', stocktake: '库存盘点',
      porder: '采购订单', sorder: '销售订单', pin: '采购退货', sret: '销售退货',
      otherin: '其它入库', otherout: '其它出库', assembly: '生产组装', stockinit: '期初库存', quo: '报价单',
      outapply: '出库申请单', prodtask: '生产任务',
    };
    const ORDER = ['stockin', 'stockout', 'porder', 'sorder', 'pin', 'sret',
      'transfer', 'adjust', 'stocktake', 'otherin', 'otherout', 'assembly', 'stockinit', 'quo',
      'outapply', 'prodtask'];

    async function load() {
      loading.value = true;
      try {
        const r = await api.get('/setting/get', { teamId: store.teamId });
        Object.keys(prefix).forEach((k) => delete prefix[k]);
        Object.assign(prefix, r.prefix || {});
        defaults.value = r.defaults || {};
        noMode.value = r.noMode || 'day';
        Object.assign(print, r.print || {});
      } catch (e) { toast(e.message, 'error'); }
      finally { loading.value = false; }
    }

    async function savePrefix() {
      saving.value = true;
      try {
        const r = await api.post('/setting/prefix', { teamId: store.teamId, prefix: { ...prefix } });
        Object.assign(prefix, r.prefix || {});
        toast('单据编号已保存');
      } catch (e) { toast(e.message, 'error'); }
      finally { saving.value = false; }
    }

    async function saveNoMode() {
      saving.value = true;
      try {
        await api.post('/setting/no-mode', { teamId: store.teamId, noMode: noMode.value });
        toast('编号重置方式已保存');
      } catch (e) { toast(e.message, 'error'); }
      finally { saving.value = false; }
    }

    async function savePrint() {
      saving.value = true;
      try {
        await api.post('/setting/print', { teamId: store.teamId, print: { ...print } });
        toast('打印抬头已保存');
      } catch (e) { toast(e.message, 'error'); }
      finally { saving.value = false; }
    }

    async function reset(scope) {
      try {
        const r = await api.post('/setting/reset', { teamId: store.teamId, scope });
        Object.keys(prefix).forEach((k) => delete prefix[k]);
        Object.assign(prefix, r.prefix || {});
        noMode.value = r.noMode || 'day';
        Object.assign(print, r.print || {});
        toast('已恢复默认');
      } catch (e) { toast(e.message, 'error'); }
    }

    /** 预览编号样例 */
    function sample(type) {
      const p = prefix[type] || defaults.value[type] || 'NO';
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const ymd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
      const ym = ymd.slice(0, 6);
      const datePart = noMode.value === 'none' ? '' : noMode.value === 'month' ? ym : ymd;
      return `${p}${datePart}0001`;
    }

    const rows = computed(() => {
      const seen = new Set();
      const out = [];
      for (const t of ORDER) {
        if (seen.has(t) || !defaults.value[t]) continue;
        seen.add(t);
        out.push({ type: t, label: DOC_LABELS[t] || t });
      }
      return out;
    });

    /* ---- 用户与权限 ---- */
    const users = ref([]);
    const userLoading = ref(false);
    const userBusy = ref(false);
    const userDialog = ref(false);
    const userForm = reactive({ username: '', password: '', role: 'clerk' });
    const pwdDialog = ref(false);
    const pwdForm = reactive({ oldPassword: '', newPassword: '', newPassword2: '' });

    async function loadUsers() {
      if (!auth.user) return;
      userLoading.value = true;
      try {
        users.value = await api.get('/auth/users');
      } catch (e) { toast(e.message, 'error'); }
      finally { userLoading.value = false; }
    }

    function openUserDialog() {
      userForm.username = '';
      userForm.password = '';
      userForm.role = 'clerk';
      userDialog.value = true;
    }

    async function saveUser() {
      if (!userForm.username.trim()) { toast('请输入用户名', 'error'); return; }
      if (userForm.password.length < 6) { toast('密码至少 6 位', 'error'); return; }
      userBusy.value = true;
      try {
        await api.post('/auth/users', {
          username: userForm.username.trim(),
          password: userForm.password,
          role: userForm.role,
        });
        toast('已添加用户');
        userDialog.value = false;
        await loadUsers();
      } catch (e) { toast(e.message, 'error'); }
      finally { userBusy.value = false; }
    }

    async function removeUser(row) {
      if (!(await confirmBox(`确定删除用户「${row.name}」？该账号将无法再登录。`, '删除用户'))) return;
      try {
        await api.del(`/auth/users/${row.id}`);
        toast('已删除');
        await loadUsers();
      } catch (e) { toast(e.message, 'error'); }
    }

    function openPwdDialog() {
      pwdForm.oldPassword = '';
      pwdForm.newPassword = '';
      pwdForm.newPassword2 = '';
      pwdDialog.value = true;
    }

    async function savePassword() {
      if (pwdForm.newPassword.length < 6) { toast('新密码至少 6 位', 'error'); return; }
      if (pwdForm.newPassword !== pwdForm.newPassword2) { toast('两次输入的新密码不一致', 'error'); return; }
      userBusy.value = true;
      try {
        const r = await api.post('/auth/password', { oldPassword: pwdForm.oldPassword, newPassword: pwdForm.newPassword });
        if (r && r.token) setToken(r.token); // 改密会吊销旧令牌，接住服务端为当前会话重签的新令牌
        toast('密码已修改');
        pwdDialog.value = false;
      } catch (e) { toast(e.message, 'error'); }
      finally { userBusy.value = false; }
    }

    const isAdmin = computed(() => auth.user?.role === 'admin');
    /** 系统所有者 = 首个账套（teamId 1）；全局注册配置只有它可管理，与服务端 OWNER_TEAM 对应 */
    const isOwner = computed(() => auth.user?.teamId === 1);

    /* ---- 开放注册（邀请码）管理 ---- */
    const regConf = reactive({ enabled: false, inviteCode: '' });
    const regLoading = ref(false);
    const regBusy = ref(false);

    async function loadRegConf() {
      if (!isOwner.value) return;
      regLoading.value = true;
      try {
        const r = await api.get('/auth/register-conf');
        regConf.enabled = !!r.enabled;
        regConf.inviteCode = r.inviteCode || '';
      } catch (e) { toast(e.message, 'error'); }
      finally { regLoading.value = false; }
    }

    async function saveRegConf() {
      if (regConf.enabled && !/^[A-Za-z0-9-]{6,32}$/.test(regConf.inviteCode.trim())) {
        toast('邀请码需 6-32 位（字母/数字/短横线）', 'error');
        return;
      }
      regBusy.value = true;
      try {
        const r = await api.post('/auth/register-conf', { enabled: regConf.enabled, inviteCode: regConf.inviteCode.trim() });
        regConf.enabled = r.enabled;
        regConf.inviteCode = r.inviteCode || '';
        toast(regConf.enabled ? '已开放注册，请把邀请码发给需要开账套的人' : '已关闭注册');
      } catch (e) { toast(e.message, 'error'); }
      finally { regBusy.value = false; }
    }

    /* ---- 数据备份与恢复 ---- */
    const backups = ref([]);
    const backupDir = ref('');
    const backupLoading = ref(false);
    const backupBusy = ref(false);

    const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB');
    const fmtBackupName = (f) => {
      const m = f.match(/^backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-[a-z0-9]{4})?\.db$/);
      return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : f;
    };

    async function loadBackups() {
      backupLoading.value = true;
      try {
        const r = await api.get('/backup/list');
        backups.value = r.rows || [];
        backupDir.value = r.dir || '';
      } catch (e) { toast(e.message, 'error'); }
      finally { backupLoading.value = false; }
    }

    async function createBackup() {
      backupBusy.value = true;
      try {
        await api.post('/backup/create');
        toast('备份完成');
        await loadBackups();
      } catch (e) { toast(e.message, 'error'); }
      finally { backupBusy.value = false; }
    }

    function downloadBackup(row) {
      api.download(`/backup/download?file=${encodeURIComponent(row.file)}`, row.file)
        .then(() => toast('已开始下载'))
        .catch((e) => toast(e.message, 'error'));
    }

    async function restoreBackup(row) {
      const label = fmtBackupName(row.file);
      if (!(await confirmBox(
        `确定恢复到备份「${label}」吗？当前数据将被该备份完全覆盖，服务会自动重启。建议先点一次「立即备份」保留现状。`,
        '恢复备份',
      ))) return;
      // 二次验密：恢复不可逆，要求再输一次当前账号密码（服务端同样强校验）
      let password = '';
      try {
        const r = await ElMessageBox.prompt('恢复会整体覆盖当前数据且不可撤销，请输入你的登录密码以确认：', '安全确认', {
          confirmButtonText: '确认恢复', cancelButtonText: '取消',
          inputType: 'password', inputPlaceholder: '当前账号密码',
        });
        password = (r.value || '').trim();
      } catch { return; }
      if (!password) return toast('未输入密码，已取消恢复', 'warning');
      backupBusy.value = true;
      try {
        await api.post('/backup/restore', { file: row.file, password });
        toast('恢复已排队，服务正在重启……页面稍后自动重连');
        // 服务重启期间请求会失败，轮询等它回来后刷新页面拿新状态
        setTimeout(function poll(retries) {
          api.get('/auth/status')
            .then(() => { location.reload(); })
            .catch(() => { if (retries > 0) setTimeout(() => poll(retries - 1), 2000); });
        }, 3000, 30);
      } catch (e) {
        toast(e.message, 'error');
        backupBusy.value = false;
      }
    }

    async function deleteBackup(row) {
      if (!(await confirmBox(`删除备份「${fmtBackupName(row.file)}」？删除后不可找回。`, '删除备份'))) return;
      try {
        await api.del(`/backup/${encodeURIComponent(row.file)}`);
        toast('已删除');
        await loadBackups();
      } catch (e) { toast(e.message, 'error'); }
    }

    onMounted(load);
    return {
      tab, loading, saving, prefix, noMode, print, defaults, rows, sample,
      savePrefix, saveNoMode, savePrint, reset, store,
      auth, isAdmin, isOwner, users, userLoading, userBusy, userDialog, userForm,
      pwdDialog, pwdForm, loadUsers, openUserDialog, saveUser, removeUser, openPwdDialog, savePassword,
      regConf, regLoading, regBusy, loadRegConf, saveRegConf,
      backups, backupDir, backupLoading, backupBusy, loadBackups, createBackup, downloadBackup, restoreBackup, deleteBackup,
      fmtSize, fmtBackupName,
    };
  },
  template: `
  <div class="page-card">
    <div class="page-head">
      <div class="hd-title">功能设置</div>
      <div class="tabs">
        <span class="tb" :class="{ on: tab === 'prefix' }" @click="tab = 'prefix'">单据编号</span>
        <span class="tb" :class="{ on: tab === 'print' }" @click="tab = 'print'">打印抬头</span>
        <span class="tb" :class="{ on: tab === 'user' }" @click="tab = 'user'; loadUsers(); loadRegConf()">用户与权限</span>
        <span v-if="isAdmin" class="tb" :class="{ on: tab === 'backup' }" @click="tab = 'backup'; loadBackups()">数据备份</span>
      </div>
      <div class="hd-right">
        <button class="btn" @click="reset('all')">恢复默认</button>
      </div>
    </div>

    <!-- 单据编号 -->
    <div v-if="tab === 'prefix'" class="card">
      <div class="card-title" style="margin-bottom:10px">单据编号规则</div>
      <div class="filterbar" style="border:none;padding:0 0 8px">
        <span class="muted" style="font-size:12.5px">流水号重置：</span>
        <el-select v-model="noMode" style="width:150px" @change="saveNoMode">
          <el-option value="day" label="按日重置"/>
          <el-option value="month" label="按月重置"/>
          <el-option value="none" label="永不清零"/>
        </el-select>
        <span class="muted" style="font-size:12px">例：{{ sample('stockout') }}</span>
      </div>

      <table class="tbl">
        <thead><tr><th>单据类型</th><th style="width:160px">前缀</th><th style="width:160px">默认</th><th>编号样例</th></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.type">
            <td>{{ r.label }}</td>
            <td><input class="finp" v-model="prefix[r.type]" maxlength="4" style="width:100%;text-transform:uppercase" :placeholder="defaults[r.type]"/></td>
            <td class="muted">{{ defaults[r.type] }}</td>
            <td class="muted" style="font-family:Consolas,monospace">{{ sample(r.type) }}</td>
          </tr>
          <tr v-if="!rows.length"><td colspan="4"><div class="empty">加载中…</div></td></tr>
        </tbody>
      </table>
      <div class="de-add" style="margin-top:12px">
        <span class="muted" style="font-size:12.5px">前缀支持 1-4 位字母或数字；留空则用默认值。</span>
        <span class="fb-gap"></span>
        <button class="btn primary" :disabled="saving" @click="savePrefix">{{ saving ? '保存中…' : '保存编号规则' }}</button>
      </div>
    </div>

    <!-- 打印抬头 -->
    <div v-else-if="tab === 'print'" class="card">
      <div class="card-title" style="margin-bottom:10px">打印抬头（显示在单据打印页顶部）</div>
      <div class="de-grid">
        <div class="fi"><label>公司名称</label><div class="fc"><input v-model="print.company" placeholder="如：深圳市橙子商贸有限公司" maxlength="60"/></div></div>
        <div class="fi"><label>联系电话</label><div class="fc"><input v-model="print.phone" placeholder="如：0755-12345678" maxlength="40"/></div></div>
        <div class="fi span-all"><label>公司地址</label><div class="fc"><input v-model="print.address" placeholder="如：深圳市南山区科技园" maxlength="120"/></div></div>
        <div class="fi span-all"><label>页脚备注</label><div class="fc"><input v-model="print.footer" placeholder="如：本单为业务往来凭证，如有疑问请及时联系。" maxlength="200"/></div></div>
        <div class="fi"><label>显示 Logo</label><div class="fc"><el-switch v-model="print.showLogo"/></div></div>
      </div>
      <div class="de-add" style="margin-top:12px">
        <span class="muted" style="font-size:12.5px">打印页会读取这些信息；未填写则不显示。</span>
        <span class="fb-gap"></span>
        <button class="btn primary" :disabled="saving" @click="savePrint">{{ saving ? '保存中…' : '保存打印抬头' }}</button>
      </div>

      <!-- 打印预览 -->
      <div class="card-title" style="margin:20px 0 10px">效果预览</div>
      <div style="border:1px solid var(--border);border-radius:6px;padding:20px;background:#fff;max-width:720px">
        <div style="display:flex;align-items:center;gap:10px;border-bottom:1px solid #e8eaed;padding-bottom:10px;margin-bottom:10px">
          <span v-if="print.showLogo" style="width:34px;height:34px;border-radius:50%;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700">橙</span>
          <div>
            <div style="font-size:15px;font-weight:600">{{ print.company || '（未填写公司名称）' }}</div>
            <div class="muted" style="font-size:12px">{{ print.address || '（未填写地址）' }}<template v-if="print.phone"> · {{ print.phone }}</template></div>
          </div>
        </div>
        <div style="text-align:center;font-size:16px;font-weight:600;margin:10px 0 4px">销售出库单</div>
        <div style="text-align:center;color:#98a2ad;font-size:12px;margin-bottom:12px">单号：{{ sample('stockout') }} 　日期：2026-10-17</div>
        <table class="tbl" style="border:1px solid #e8eaed">
          <thead><tr><th>商品</th><th class="r">数量</th><th class="r">单价</th><th class="r">金额</th></tr></thead>
          <tbody>
            <tr><td>示例商品</td><td class="r">10</td><td class="r">¥80.00</td><td class="r">¥800.00</td></tr>
          </tbody>
        </table>
        <div class="muted" style="font-size:12px;margin-top:10px;text-align:center">{{ print.footer || '（未填写页脚）' }}</div>
      </div>
    </div>

    <!-- 用户与权限 -->
    <div v-else-if="tab === 'user'" class="card">
      <div class="card-title" style="margin-bottom:4px">团队用户</div>
      <div class="muted" style="font-size:12.5px;margin-bottom:12px">
        当前账套「{{ auth.team ? auth.team.name : '—' }}」的成员。管理员可添加/删除用户；员工只能使用业务功能，不能管理用户。
      </div>
      <table class="tbl">
        <thead><tr><th style="width:70px">ID</th><th>用户名</th><th style="width:110px">角色</th><th style="width:180px">创建时间</th><th style="width:120px">操作</th></tr></thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td class="muted">{{ u.id }}</td>
            <td>{{ u.name }}<span v-if="auth.user && u.id === auth.user.userId" class="muted" style="margin-left:6px">（我）</span></td>
            <td>
              <span class="role-tag" :class="u.role === 'admin' ? 'admin' : 'clerk'">{{ u.role === 'admin' ? '管理员' : '员工' }}</span>
            </td>
            <td class="muted">{{ (u.createdAt || '').replace('T', ' ').slice(0, 19) || '—' }}</td>
            <td>
              <button class="btn sm danger" v-if="isAdmin && auth.user && u.id !== auth.user.userId" @click="removeUser(u)">删除</button>
              <span v-else class="muted" style="font-size:12px">—</span>
            </td>
          </tr>
          <tr v-if="userLoading"><td colspan="5"><div class="empty">加载中…</div></td></tr>
          <tr v-else-if="!users.length"><td colspan="5"><div class="empty">暂无用户</div></td></tr>
        </tbody>
      </table>
      <div class="de-add" style="margin-top:12px">
        <template v-if="isAdmin">
          <button class="btn primary" @click="openUserDialog">+ 添加用户</button>
          <button class="btn" @click="openPwdDialog">修改我的密码</button>
        </template>
        <span v-else class="muted" style="font-size:12.5px">仅管理员可管理用户</span>
      </div>

      <!-- 开放注册（邀请码）：系统所有者允许其他人自建独立账套 -->
      <template v-if="isOwner">
        <div class="card-title" style="margin:24px 0 4px">开放注册（邀请码）</div>
        <div class="muted" style="font-size:12.5px;margin-bottom:12px">
          开启后，登录页「创建账套」将开放：对方凭你的邀请码即可自建一个<b>完全独立的新账套</b>（数据互不相通）。
          适合把服务暴露到公网（内网穿透）后给朋友用；不开启时外人无法注册。
        </div>
        <div class="de-grid" style="grid-template-columns:auto 1fr;align-items:center;column-gap:12px;row-gap:8px">
          <label style="font-weight:500">开放注册</label>
          <div><el-switch v-model="regConf.enabled" @change="regConf.enabled ? null : saveRegConf()"/></div>
          <label style="font-weight:500">邀请码</label>
          <div style="display:flex;gap:8px;max-width:420px">
            <input v-model="regConf.inviteCode" class="finp" style="flex:1;text-transform:none"
                   placeholder="6-32 位（字母/数字/短横线）" maxlength="32" :disabled="!regConf.enabled"/>
            <button class="btn primary" :disabled="regBusy || !regConf.enabled" @click="saveRegConf">{{ regBusy ? '保存中…' : '保存' }}</button>
          </div>
        </div>
        <div class="muted" style="font-size:12px;margin-top:6px">
          关闭注册会立即生效并清除已保存的邀请码；再次开启需重新设置邀请码。仅系统所有者（首个账套）可管理此项。
        </div>
      </template>
    </div>

    <!-- 数据备份与恢复 -->
    <div v-else-if="tab === 'backup'" class="card">
      <div class="card-title" style="margin-bottom:4px">数据备份</div>
      <div class="muted" style="font-size:12.5px;margin-bottom:12px">
        全部业务数据存放在一个 SQLite 文件里（<span class="billno">{{ backupDir || '数据目录' }}</span>）。
        备份是整个数据库的完整快照，建议每次重要操作后或每周固定备份一次，并定期把备份文件复制到 U 盘/网盘等机器之外的位置。
      </div>
      <div class="de-add" style="padding:0 0 12px">
        <button class="btn primary" :disabled="backupBusy" @click="createBackup">{{ backupBusy ? '处理中…' : '⬇ 立即备份' }}</button>
        <button class="btn" @click="loadBackups">刷新</button>
        <span class="muted" style="font-size:12.5px">恢复会让服务重启一次（约几秒），重启完成前请勿操作。</span>
      </div>
      <table class="tbl">
        <thead><tr><th>备份时间</th><th style="width:110px" class="r">大小</th><th style="width:250px">操作</th></tr></thead>
        <tbody>
          <tr v-for="b in backups" :key="b.file">
            <td class="nowrap">{{ fmtBackupName(b.file) }}</td>
            <td class="r muted">{{ fmtSize(b.size) }}</td>
            <td>
              <div class="row-actions">
                <button class="btn sm" @click="downloadBackup(b)">下载</button>
                <button class="btn sm" :disabled="backupBusy" @click="restoreBackup(b)">恢复到此</button>
                <button class="btn sm danger" @click="deleteBackup(b)">删除</button>
              </div>
            </td>
          </tr>
          <tr v-if="backupLoading"><td colspan="3"><div class="empty">加载中…</div></td></tr>
          <tr v-else-if="!backups.length"><td colspan="3"><div class="empty">还没有备份，点上方「立即备份」创建第一份</div></td></tr>
        </tbody>
      </table>
      <div class="muted" style="font-size:12px;margin-top:10px">
        「下载」把备份文件存到你想放的地方（建议同时保存到本机以外）；「恢复到此」用所选备份覆盖当前全部数据，不可撤销。
      </div>
    </div>

    <!-- 添加用户弹窗 -->
    <el-dialog v-model="userDialog" title="添加用户" width="420px" append-to-body>
      <div class="de-grid" style="grid-template-columns:1fr">
        <div class="fi"><label>用户名</label><div class="fc"><input v-model="userForm.username" placeholder="至少 2 个字符" maxlength="30" autocomplete="off"/></div></div>
        <div class="fi"><label>初始密码</label><div class="fc"><input v-model="userForm.password" type="password" placeholder="至少 6 位" maxlength="40" autocomplete="new-password"/></div></div>
        <div class="fi"><label>角色</label><div class="fc">
          <el-select v-model="userForm.role" style="width:100%">
            <el-option value="clerk" label="员工（仅业务操作）"/>
            <el-option value="admin" label="管理员（含用户管理）"/>
          </el-select>
        </div></div>
      </div>
      <template #footer>
        <button class="btn" @click="userDialog = false">取消</button>
        <button class="btn primary" :disabled="userBusy" @click="saveUser">{{ userBusy ? '保存中…' : '确定添加' }}</button>
      </template>
    </el-dialog>

    <!-- 修改密码弹窗 -->
    <el-dialog v-model="pwdDialog" title="修改我的密码" width="420px" append-to-body>
      <div class="de-grid" style="grid-template-columns:1fr">
        <div class="fi"><label>原密码</label><div class="fc"><input v-model="pwdForm.oldPassword" type="password" maxlength="40"/></div></div>
        <div class="fi"><label>新密码</label><div class="fc"><input v-model="pwdForm.newPassword" type="password" placeholder="至少 6 位" maxlength="40"/></div></div>
        <div class="fi"><label>确认新密码</label><div class="fc"><input v-model="pwdForm.newPassword2" type="password" maxlength="40"/></div></div>
      </div>
      <template #footer>
        <button class="btn" @click="pwdDialog = false">取消</button>
        <button class="btn primary" :disabled="userBusy" @click="savePassword">{{ userBusy ? '保存中…' : '确定修改' }}</button>
      </template>
    </el-dialog>
  </div>`,
};


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
      stockin: '采购入库', stockout: '销售出库', transfer: '转仓调拨', adjust: '库存调整', stocktake: '库存盘点',
      porder: '采购订单', sorder: '销售订单', pin: '采购退货', sret: '销售退货',
      otherin: '其它入库', otherout: '其它出库', assembly: '生产组装', stockinit: '期初库存', quo: '报价单',
      outapply: '出库申请单', prodtask: '生产任务',
    };
    const TYPE_COLOR = {
      stockin: '#52a552', stockout: '#f26f21', transfer: '#5b8ff9', adjust: '#e6a23c',
      stocktake: '#8fd16a', porder: '#9b8afb', sorder: '#f56c6c', pin: '#6dc8ec',
      sret: '#5ad8a6', otherin: '#4dabf7', otherout: '#ffa94d', assembly: '#cc5de8',
      stockinit: '#20c997', quo: '#868e96', outapply: '#f783ac', prodtask: '#e8b339',
    };

    /** 当前筛选下要显示的行：不筛选 = 全部待审；按类型 = 该类型 */
    const shown = computed(() => (filterType.value ? allRows.value.filter((d) => d.type === filterType.value) : allRows.value));

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
        byType.value = [...map.entries()].map(([type, rs]) => ({
          type, label: TYPE_LABEL[type] || type, count: rs.length,
          amount: rs.reduce((s, x) => s + (x.totalAmount || 0), 0),
        })).sort((a, b) => b.count - a.count);
        allRows.value = rows;
        list.value = byType.value;
      } catch (e) { toast(e.message, 'error'); }
      finally { loading.value = false; }
    }

    async function doAudit(row) {
      if (busyId.value) return;
      if (!(await confirmBox(`审核「${row.billNo}」将过账写入库存与往来余额，确认？`))) return;
      busyId.value = row.id;
      try { await api.post('/doc/audit', { teamId: store.teamId, id: row.id, auditBy: store.team?.name || '管理员' }); toast('已审核'); load(); }
      catch (e) { toast(e.message, 'error'); }
      finally { busyId.value = null; }
    }

    async function doReject(row) {
      if (busyId.value) return;
      let reason = '';
      try {
        const r = await ElMessageBox.prompt('请输入驳回原因', `驳回 ${row.billNo}`, {
          confirmButtonText: '确认驳回', cancelButtonText: '取消',
          inputPlaceholder: '如：价格录错，请核对后重新提交', inputValue: '',
        });
        reason = (r.value || '').trim();
      } catch { return; }
      busyId.value = row.id;
      try { await api.post('/doc/reject', { teamId: store.teamId, id: row.id, reason }); toast('已驳回'); load(); }
      catch (e) { toast(e.message, 'error'); }
      finally { busyId.value = null; }
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
        } catch (e) { errs.push(`${r.billNo || '#' + r.id}：${e.message}`); }
      }
      auditProgress.value = '';
      toast(`审核成功 ${okCount} 张${errs.length ? `，失败 ${errs.length} 张` : ''}`, errs.length ? 'warning' : 'success');
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
    return { list, allRows, byType, filterType, shown, loading, busyId, viewerId, load, doAudit, doReject, auditAll, auditProgress, TYPE_LABEL, TYPE_COLOR, store, fmtMoney, partnerLabel, whLabel, STATUS_TEXT };
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


