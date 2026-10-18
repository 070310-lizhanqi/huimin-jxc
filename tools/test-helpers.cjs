/**
 * 测试辅助：登录获取 token + 带 Authorization 的 API 助手。
 * 用法：const { login, api } = require('./test-helpers.cjs'); await login(); const r = await api('GET', '/warehouse');
 */
const BASE = process.env.OC_BASE || 'http://127.0.0.1:7741/api';
const USER = process.env.ORANGE_USER || 'admin';
const PASS = process.env.ORANGE_PASS || 'admin123456';

let token = null;

async function login() {
  if (token) return token;
  // 先探测是否已初始化：未初始化则注册首个账号
  const st = await fetch(BASE + '/auth/status').then((r) => r.json()).catch(() => ({}));
  if (st && st.initialized === false) {
    const r = await fetch(BASE + '/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USER, password: PASS, name: USER }),
    });
    const j = await r.json().catch(() => ({}));
    token = j.token;
    if (!token) throw new Error('注册失败: ' + JSON.stringify(j));
    return token;
  }
  const r = await fetch(BASE + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const j = await r.json().catch(() => ({}));
  token = j.token;
  if (!token) throw new Error('登录失败: ' + JSON.stringify(j));
  return token;
}

async function api(method, path, body) {
  const t = await login();
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { j = { error: 'non-json', raw: text.slice(0, 120) }; }
  return { status: res.status, body: j };
}

/** 返回 { Authorization: 'Bearer ...' }，供脚本自有 fetch 助手合并进 headers。 */
async function authHeader() {
  const t = await login();
  return { Authorization: 'Bearer ' + t };
}

module.exports = { BASE, USER, PASS, login, api, authHeader };
