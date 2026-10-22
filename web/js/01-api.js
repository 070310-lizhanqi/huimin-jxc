'use strict';
/* web/js/01-api.js —— 由 app.js 拆分（lines 6-57） */
/* ================= API ================= */
/* 登录态：令牌存 localStorage，所有请求自动携带；收到 401 立即回登录页 */
const TOKEN_KEY = 'oc_token';
const auth = reactive({ token: localStorage.getItem(TOKEN_KEY) || '', user: null, team: null, ready: false });

function setToken(t) {
  auth.token = t || '';
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}
function logout() {
  setToken('');
  auth.user = null; auth.team = null;
  store.loaded = false;
  store.teamId = null; store.team = null; store.teams = [];
  // 打印抬头重置：换账号后新账套未设置打印时，不能沿用上一账号的抬头
  store.print = { company: '', address: '', phone: '', footer: '', showLogo: true };
  location.hash = '#/login';
}

async function req(method, path, body, params) {
  let url = '/api' + path;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += '?' + s;
  }
  const opt = { method, headers: {} };
  if (auth.token) opt.headers.authorization = 'Bearer ' + auth.token;
  if (body !== undefined) {
    opt.headers['content-type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  // 超时中止：服务卡死/网络断开时 30s 后必须失败并给出明确文案，
  // 否则 fetch 永远 pending，按钮一直转圈没有报错
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  opt.signal = ctl.signal;
  let r;
  try {
    r = await fetch(url, opt);
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new Error('请求超时，请检查网络或稍后重试');
    throw new Error('网络异常，请检查服务是否可用');
  }
  clearTimeout(timer);
  let data = null;
  try { data = await r.json(); } catch { /* non-json */ }
  // 令牌失效：清空登录态（含缓存账套数据）并跳登录页（登录接口自身的 401 交给调用方提示）
  if (r.status === 401 && !path.startsWith('/auth/login')) {
    if (auth.token || auth.user || store.loaded) { setToken(''); auth.user = null; auth.team = null; store.loaded = false; store.teamId = null; store.team = null; store.teams = []; }
    if (location.hash !== '#/login') location.hash = '#/login';
  }
  if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  return data;
}
const api = {
  get: (p, params) => req('GET', p, undefined, params),
  post: (p, body) => req('POST', p, body ?? {}),
  put: (p, body) => req('PUT', p, body ?? {}),
  del: (p, params) => req('DELETE', p, undefined, params),
  /** 带鉴权的文件下载：fetch 取 blob 后触发浏览器另存（令牌不能走 URL，会进日志/历史） */
  download: async (path, fallbackName) => {
    const r = await fetch('/api' + path, { headers: auth.token ? { authorization: 'Bearer ' + auth.token } : {} });
    if (!r.ok) {
      let data = null;
      try { data = await r.json(); } catch { /* non-json */ }
      throw new Error((data && data.error) || `HTTP ${r.status}`);
    }
    const blob = await r.blob();
    const cd = r.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    const name = m ? decodeURIComponent(m[1].replace(/"/g, '')) : fallbackName;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  },
};

