'use strict';
/* web/js/01-api.js —— 由 app.js 拆分（lines 6-57） */
/* ================= API ================= */
/* 登录态：令牌由服务端以 httpOnly Cookie 下发（B-前5），浏览器不再把 token 存
 * localStorage——任意 XSS 可直接读走 localStorage 里的令牌。同源 fetch 默认
 * credentials: 'same-origin'，cookie 会自动带上；收到 401 立即回登录页 */
const RETURN_KEY = 'oc_return_hash';
const auth = reactive({ user: null, team: null, ready: false });
async function logout() {
  // 服务端吊销当前令牌并清掉 Cookie：单清客户端状态只是「客户端忘记」，
  // 已导出的令牌在过期前仍可调用接口（共用电脑/令牌泄漏场景）。
  // 同源 fetch 默认带 cookie，无需再拼 Authorization 头。
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* 网络失败也要完成本地清理 */ }
  auth.user = null; auth.team = null;
  store.loaded = false;
  store.teamId = null; store.team = null; store.teams = [];
  // 打印抬头重置：换账号后新账套未设置打印时，不能沿用上一账号的抬头
  store.print = { company: '', address: '', phone: '', footer: '', showLogo: true };
  // 主动退出不保留回跳地址：下次登录回工作台，而非退出前那页
  sessionStorage.removeItem(RETURN_KEY);
  location.hash = '#/login';
}

/** 令牌失效的统一清理：Promise 单例模式替代 setTimeout 去抖锁。
 *  原实现：handling401=true 后 setTimeout(1000ms) 释放，1s 内多请求 401 都被吞掉、
 *  1s 后返回的 401 又会触发一次完整清理（多余的状态重置与闪烁）。
 *  改为：并发触发共用同一个 Promise，Promise 完成后才允许下一次清理。 */
let handling401Promise = null;
function handle401() {
  // B-前5：401 表示会话已失效（令牌过期/被吊销/被改密顶掉），清掉浏览器里的
  // 会话 Cookie，等价于旧逻辑里的 setToken('')（localStorage 时代的清令牌）。
  // document.cookie 写 Max-Age=0 可删掉 HttpOnly Cookie（HttpOnly 只禁读不禁删）。
  // 放去抖判断之前同步执行：req() 调 handle401() 时不 await，放在这里才能保证
  // 本次 401 返回前 Cookie 已清掉；无 Cookie 时是空操作。
  try { document.cookie = 'oc_token=; Path=/; Max-Age=0'; } catch { /* ignore */ }
  if (handling401Promise) return handling401Promise;
  handling401Promise = (async () => {
    // 记住当前页（排除登录页自身），登录成功后回到这里
    const cur = location.hash;
    if (cur && cur !== '#/login' && !cur.startsWith('#/login')) sessionStorage.setItem(RETURN_KEY, cur);
    if (auth.user || store.loaded) {
      auth.user = null; auth.team = null;
      store.loaded = false; store.teamId = null; store.team = null; store.teams = [];
    }
    if (location.hash !== '#/login') location.hash = '#/login';
    // 等渲染/路由切换完成后再释放单例，避免真实的下一次失效被吞掉
    await new Promise(r => setTimeout(r, 100));
    handling401Promise = null;
  })();
  return handling401Promise;
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
    if (e && e.name === 'AbortError') throw new Error('请求超时，请检查网络或稍后重试', { cause: e });
    throw new Error('网络异常，请检查服务是否可用', { cause: e });
  }
  clearTimeout(timer);
  let data = null;
  try { data = await r.json(); } catch { /* non-json */ }
  // 令牌失效：清空登录态（含缓存账套数据）并跳登录页（登录接口自身的 401 交给调用方提示）
  if (r.status === 401 && !path.startsWith('/auth/login')) handle401();
  if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  return data;
}
const api = {
  get: (p, params) => req('GET', p, undefined, params),
  post: (p, body) => req('POST', p, body ?? {}),
  put: (p, body) => req('PUT', p, body ?? {}),
  del: (p, params) => req('DELETE', p, undefined, params),
  /** 带鉴权的文件下载：fetch 取 blob 后触发浏览器另存（令牌不能走 URL，会进日志/历史）。
   *  同源 fetch 默认 credentials: 'same-origin'，httpOnly Cookie 自动带上，不再手动拼头。 */
  download: async (path, fallbackName) => {
    // 超时中止（与 req() 同款）：备份文件大，超时放宽到 120 秒；超时/断网抛与 req() 相同的中文错误
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 120000);
    let r;
    try {
      r = await fetch('/api' + path, { signal: ctl.signal });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('请求超时，请检查网络或稍后重试', { cause: e });
      throw new Error('网络异常，请检查服务是否可用', { cause: e });
    }
    if (!r.ok) {
      clearTimeout(timer);
      let data = null;
      try { data = await r.json(); } catch { /* non-json */ }
      throw new Error((data && data.error) || `HTTP ${r.status}`);
    }
    let blob;
    try {
      blob = await r.blob();
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('请求超时，请检查网络或稍后重试', { cause: e });
      throw new Error('网络异常，请检查服务是否可用', { cause: e });
    }
    clearTimeout(timer);
    const cd = r.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    const name = m ? decodeURIComponent(m[1].replace(/"/g, '')) : fallbackName;
    // Electron 桌面版：把文件名先告诉主进程——blob: 链接下载时主进程的
    // will-download 拿不到 <a download> 的名字（item.getFilename() 只会给 "download"），
    // 保存对话框需要这个名字做默认值。浏览器里没有 window.zhanhui，这行是空操作。
    if (window.zhanhui && typeof window.zhanhui.setDownloadFilename === 'function') {
      try { window.zhanhui.setDownloadFilename(name); } catch { /* ignore */ }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 立即 revoke：download 属性已把数据读走，4s 等待期会让连续点击创建多个 objectURL 占用内存
    // Firefox 旧版对立即 revoke 偶有兼容问题，用 requestAnimationFrame 延迟一帧足够
    requestAnimationFrame(() => URL.revokeObjectURL(url));
  },
};

