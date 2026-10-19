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
  const r = await fetch(url, opt);
  let data = null;
  try { data = await r.json(); } catch { /* non-json */ }
  // 令牌失效：清空登录态并跳登录页（登录接口自身的 401 交给调用方提示）
  if (r.status === 401 && !path.startsWith('/auth/login')) {
    if (auth.token) { setToken(''); auth.user = null; auth.team = null; }
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
};

