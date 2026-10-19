'use strict';
/* web/js/24-login.js —— 由 app.js 拆分（lines 4157-4400） */
/* ================= 登录 / 注册 ================= */
const BRAND_SVG = `<svg viewBox="0 0 32 32" fill="none"><path d="M16 4c-1.2 0-2.2.6-3 1.6-.7-.5-1.6-.8-2.5-.8-2.4 0-4.3 1.9-4.3 4.3 0 .5.1 1 .3 1.5C5 11.6 4 13.2 4 15c0 1.6.8 3 2 3.9-.3.6-.5 1.3-.5 2 0 2.4 1.9 4.3 4.3 4.3.6 0 1.2-.1 1.7-.4.7 1.2 2 2 3.5 2s2.8-.8 3.5-2c.5.3 1.1.4 1.7.4 2.4 0 4.3-1.9 4.3-4.3 0-.7-.2-1.4-.5-2 1.2-.9 2-2.3 2-3.9 0-1.8-1-3.4-2.5-4.4.2-.5.3-1 .3-1.5 0-2.4-1.9-4.3-4.3-4.3-.9 0-1.8.3-2.5.8C18.2 4.6 17.2 4 16 4z" fill="#f26f21"/><path d="M11.5 13.5c0 1.4 1.1 2.5 2.5 2.5s2.5-1.1 2.5-2.5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>`;

const LoginPage = {
  setup() {
    const mode = ref('login'); // login | register
    const form = reactive({ username: '', password: '', password2: '', teamName: '', inviteCode: '' });
    const err = ref('');
    const busy = ref(false);
    const firstRun = ref(false); // 系统尚未初始化 → 默认注册并填账套名
    const initialized = ref(false); // 已有账套 → 注册需要邀请码

    onMounted(async () => {
      try {
        const s = await api.get('/auth/status');
        initialized.value = !!s.initialized;
        if (!s.initialized) { mode.value = 'register'; firstRun.value = true; }
      } catch { /* 探测失败就按登录处理 */ }
    });

    function switchMode() {
      err.value = '';
      mode.value = mode.value === 'login' ? 'register' : 'login';
    }

    async function submit() {
      err.value = '';
      if (!form.username.trim()) { err.value = '请输入用户名'; return; }
      if (!form.password) { err.value = '请输入密码'; return; }
      if (mode.value === 'register') {
        if (form.password.length < 6) { err.value = '密码至少 6 位'; return; }
        if (form.password !== form.password2) { err.value = '两次输入的密码不一致'; return; }
        if (initialized.value && !form.inviteCode.trim()) { err.value = '请输入管理员提供的邀请码'; return; }
      }
      busy.value = true;
      try {
        const path = mode.value === 'login' ? '/auth/login' : '/auth/register';
        const body = mode.value === 'login'
          ? { username: form.username.trim(), password: form.password }
          : {
              username: form.username.trim(),
              password: form.password,
              teamName: form.teamName.trim() || '我的账套',
              ...(initialized.value ? { inviteCode: form.inviteCode.trim() } : {}),
            };
        const r = await api.post(path, body);
        setToken(r.token);
        auth.user = r.user;
        auth.team = r.team || { id: r.teamId, name: r.teamName };
        toast(mode.value === 'login' ? '登录成功' : '账套创建成功');
        location.hash = '#/dashboard';
      } catch (e) {
        err.value = e.message;
      } finally {
        busy.value = false;
      }
    }

    return { mode, form, err, busy, firstRun, initialized, submit, switchMode, BRAND_SVG };
  },
  template: `
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-brand">
        <span v-html="BRAND_SVG"></span>
        <span class="t">橙子进销存</span>
      </div>
      <p class="login-sub">{{ mode === 'login' ? '登录你的账套，开始今天的经营' : (firstRun ? '首次使用，请创建管理员账号与账套' : '新建管理员账号') }}</p>
      <el-form @submit.prevent="submit" label-position="top">
        <el-form-item label="用户名">
          <el-input v-model="form.username" size="large" placeholder="请输入用户名" autocomplete="username" clearable/>
        </el-form-item>
        <el-form-item v-if="mode === 'register'" label="账套名称">
          <el-input v-model="form.teamName" size="large" placeholder="如：鲜果批发部" maxlength="30" clearable/>
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" size="large" placeholder="至少 6 位" show-password autocomplete="current-password" @keyup.enter="submit"/>
        </el-form-item>
        <el-form-item v-if="mode === 'register' && initialized" label="邀请码">
          <el-input v-model="form.inviteCode" size="large" placeholder="请向已有账套的管理员索取" clearable @keyup.enter="submit"/>
        </el-form-item>
        <el-form-item v-if="mode === 'register'" label="确认密码">
          <el-input v-model="form.password2" type="password" size="large" placeholder="再次输入密码" show-password autocomplete="new-password" @keyup.enter="submit"/>
        </el-form-item>
        <div class="login-err">{{ err }}</div>
        <el-button type="primary" class="login-btn" :loading="busy" @click="submit">
          {{ mode === 'login' ? '登 录' : '创建账套' }}
        </el-button>
      </el-form>
      <div class="login-foot">
        <template v-if="mode === 'login'">还没有账号？<a @click="switchMode">创建账套</a></template>
        <template v-else>已有账号？<a @click="switchMode">返回登录</a></template>
      </div>
    </div>
  </div>`,
};

const PAGES = {
  approval: ApprovalPage,
  settings: SettingsPage,
  dashboard: DashboardPage,
  product: ProductPage,
  partner: PartnerPage,
  base: BasePage,
  stock: StockPage,
  ledger: LedgerPage,
  finance: FinancePage,
  help: HelpPage,
  report: ReportPage,
  aging: AgingPage,
  price: PricePage,
  jxcstat: JxcStatPage,
  forecast: ForecastPage,
  statement: StatementPage,
  doc: DocPage,
};

const App = {
  setup() {
    const ready = ref(false);
    const booting = ref(true);
    const switchTo = ref(null);
    const openMenu = ref(-1);

    /* 顶栏激活项滑动指示条：测量 .nav-link.on 相对 .topnav 的位置并移动下划线 */
    const navInd = ref(null);
    function moveNavInd() {
      nextTick(() => requestAnimationFrame(() => {
        const bar = document.querySelector('.topnav');
        const el = bar && bar.querySelector('.nav-link.on');
        if (!bar || !el) { navInd.value = { opacity: 0 }; return; }
        const b = bar.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        navInd.value = { opacity: 1, width: r.width + 'px', transform: `translateX(${r.left - b.left}px)` };
      }));
    }

    async function boot() {
      if (!auth.token) {
        auth.ready = true;
        booting.value = false;
        ready.value = false;
        if (location.hash !== '#/login') location.hash = '#/login';
        return;
      }
      try {
        const me = await api.get('/auth/me');
        auth.user = me.user;
        auth.team = me.team;
        await ensureTeam();
        switchTo.value = store.teamId;
        ready.value = true;
      } catch (e) {
        // 令牌失效已在 req 中清理并跳登录
        if (auth.token) toast('登录状态校验失败：' + e.message, 'error');
        ready.value = false;
      } finally {
        auth.ready = true;
        booting.value = false;
      }
    }

    onMounted(boot);

    // 登录页登录成功后触发重新引导
    watch(() => auth.token, (t, old) => {
      if (t && !old) { ready.value = false; boot(); }
    });

    /* 当前页面标识（含 query 里的 type） */
    const curKey = computed(() => {
      const keys = Object.keys(route.q).sort();
      const qs = keys.length ? '?' + keys.map((k) => k + '=' + route.q[k]).join('&') : '';
      return route.page + (route.sub ? '/' + route.sub : '') + qs;
    });
    watch(curKey, moveNavInd);
    watch(ready, moveNavInd);

    const pageComp = computed(() => PAGES[route.page] || DashboardPage);
    const pageTitle = computed(() => {
      for (const g of MENU) {
        if (g.items) {
          for (const m of g.items) if (m.page === curKey.value) return m.label;
        }
      }
      return '工作台';
    });
    const pageKey = computed(() => `${store.teamId}:${route.page}:${route.sub}:${JSON.stringify(route.q)}`);

    function go(menuPage) {
      openMenu.value = -1;
      nav('#/' + menuPage);
    }
    function onNavClick(i, g) {
      if (g.page && !g.items) { nav('#/' + g.page); openMenu.value = -1; return; }
      openMenu.value = openMenu.value === i ? -1 : i;
    }
    function onDocClick(e) {
      if (!e.target.closest('.nav-item')) openMenu.value = -1;
    }
    onMounted(() => document.addEventListener('click', onDocClick));
    onBeforeUnmount(() => document.removeEventListener('click', onDocClick));
    onMounted(moveNavInd);
    window.addEventListener('resize', moveNavInd);
    onBeforeUnmount(() => window.removeEventListener('resize', moveNavInd));

    async function onSwitchTeam(id) {
      if (!id || id === store.teamId) return;
      await pickTeam(id);
      toast('已切换团队');
    }

    async function onLogout() {
      if (!(await confirmBox('确定退出登录？', '退出'))) return;
      logout();
      toast('已退出登录');
    }

    return { ready, booting, switchTo, store, route, pageComp, pageTitle, pageKey, curKey, onSwitchTeam, MENU, nav, go, openMenu, onNavClick, auth, onLogout, BRAND_SVG, navInd };
  },
  template: `
  <login-page v-if="auth.ready && !auth.token"/>
  <div class="shell" v-else-if="auth.token">
    <header class="topnav">
      <span class="nav-ind" :style="navInd"></span>
      <div class="brand" @click="nav('#/dashboard')">
        <span class="brand-mark" v-html="BRAND_SVG"></span>
        <span class="brand-txt">橙子进销存</span>
      </div>
      <div class="nav-item" v-for="(g, i) in MENU" :key="g.label">
        <div class="nav-link" :class="{ on: curKey.startsWith(g.page || '__none') || (g.items && g.items.some(m => m.page === curKey)) }" @click.stop="onNavClick(i, g)">
          {{ g.label }}<span class="caret" v-if="g.items">▾</span>
        </div>
        <div class="nav-menu" v-if="g.items && openMenu === i">
          <div class="mi" v-for="m in g.items" :key="m.label + m.page" :class="{ cur: m.page === curKey }" @click.stop="go(m.page)">{{ m.label }}</div>
        </div>
      </div>
      <div class="nav-right">
        <span class="nav-icon" title="使用帮助" @click="nav('#/help')"><el-icon><QuestionFilled/></el-icon></span>
        <el-select v-if="store.teams.length > 1" v-model="switchTo" size="small" style="width:150px;margin-left:6px" @change="onSwitchTeam">
          <el-option v-for="t in store.teams" :key="t.id" :label="t.name" :value="t.id"/>
        </el-select>
        <span class="nav-user" v-if="auth.user">
          <span class="nm">{{ auth.user.name }}</span>
          <span class="role" v-if="auth.user.role === 'admin'">管理员</span>
          <span class="role" v-else>员工</span>
        </span>
        <span class="nav-logout" title="退出登录" @click="onLogout"><el-icon><SwitchButton/></el-icon></span>
      </div>
    </header>
    <div class="tipbar">
      {{ auth.team ? auth.team.name : '当前账套' }} · 数据保存在本地 SQLite，账套之间完全隔离
    </div>
    <div class="body">
      <div class="content">
        <div v-if="!ready" style="padding:80px;text-align:center" class="muted">加载中…</div>
        <transition v-else name="page" mode="out-in">
          <component :is="pageComp" :key="pageKey" :group="route.sub"/>
        </transition>
      </div>
    </div>
  </div>
  <div v-else class="login-wrap"><div class="muted" style="color:#fff">正在进入…</div></div>`,
};

