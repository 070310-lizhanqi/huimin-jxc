// 幂等验证：同一内容连续 POST 两次返回同一张单（防双击/重试重复建单）。
// 用法：node tools/test-idempot.cjs   （需服务器已在 7741 运行，且 data 为干净演示库或空库）
// 对齐当前 API：/auth/register 注册首个团队，业务接口带 Bearer 令牌。
const BASE = "http://127.0.0.1:7741/api";
let TOKEN = "";
async function call(method, path, body) {
  const headers = {};
  if (TOKEN) headers.authorization = "Bearer " + TOKEN;
  if (body) headers["content-type"] = "application/json";
  const r = await fetch(BASE + path, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
}
let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? "  " + extra : ""}`); }
}
async function main() {
  // 0. 探测是否已初始化；已初始化则登录（演示库），否则注册新团队
  const st = await call("GET", "/auth/status");
  const initialized = st.json && st.json.initialized;
  if (initialized) {
    const login = await call("POST", "/auth/login", { username: "admin", password: "admin123456" });
    if (login.status !== 200 || !login.json.token) {
      console.error("已初始化但登录失败，无法继续：", login.text);
      process.exit(2);
    }
    TOKEN = login.json.token;
    console.log("已登录演示账套");
  } else {
    const reg = await call("POST", "/auth/register", { username: "idemadmin", password: "idem123456", teamName: "幂等验证套" });
    if (reg.status !== 200 || !reg.json.token) {
      console.error("注册失败，无法继续：", reg.text);
      process.exit(2);
    }
    TOKEN = reg.json.token;
    console.log("已注册新团队");
  }
  const teamId = (await call("GET", "/auth/me")).json.user.teamId;
  console.log("teamId:", teamId);

  // 1. 建仓库+商品（幂等：按名字查后建）
  async function ensure(path, where, payload) {
    const list = await call("GET", path);
    const rows = list.json && (list.json.rows || list.json);
    const hit = (Array.isArray(rows) ? rows : []).find(where);
    if (hit) return hit;
    return (await call("POST", path, payload)).json;
  }
  const wh = await ensure("/warehouse", (x) => x.name === "幂等默认仓", { name: "幂等默认仓" });
  const catList = await call("GET", "/cat");
  const catRows = catList.json && (catList.json.rows || catList.json);
  const catId = (Array.isArray(catRows) ? catRows : [])[0] && (Array.isArray(catRows) ? catRows : [])[0].id;
  const prod = await ensure("/product", (x) => x.name === "幂等测试商品", {
    catId, name: "幂等测试商品", unit: "个", purchasePrice: 100, salePrice: 200, lowQty: 5,
  });
  ok("建仓库/商品", !!wh && !!wh.id && !!prod && !!prod.id, `wh=${wh && wh.id} prod=${prod && prod.id} lowQty=${prod && prod.lowQty}`);

  // 2. 幂等：同一内容并发 POST 两次（模拟双击）
  const docBody = { teamId, type: "stockin", date: "2026-10-20", warehouseId: wh.id, items: [{ productId: prod.id, qty: 10, price: 100 }] };
  const [r1, r2] = await Promise.all([
    call("POST", "/doc/create", docBody),
    call("POST", "/doc/create", docBody),
  ]);
  const d1 = r1.json, d2 = r2.json;
  ok("并发双击同一张单", d1 && d2 && d1.id === d2.id, `${d1 && d1.id} vs ${d2 && d2.id}`);

  // 3. 串行双击（间隔 100ms，仍在 5 秒窗口内）
  const docBody2 = { teamId, type: "stockin", date: "2026-10-20", warehouseId: wh.id, items: [{ productId: prod.id, qty: 3, price: 100 }] };
  const s1 = await call("POST", "/doc/create", docBody2);
  await new Promise((r) => setTimeout(r, 100));
  const s2 = await call("POST", "/doc/create", docBody2);
  ok("串行双击同一张单", s1.json && s2.json && s1.json.id === s2.json.id, `${s1.json && s1.json.id} vs ${s2.json && s2.json.id}`);

  // 4. 低库存字段读取（lowQty 应保存并可读回）
  const plist = await call("GET", "/product");
  const prows = plist.json && (plist.json.rows || plist.json);
  const myProd = (Array.isArray(prows) ? prows : []).find((x) => x.id === prod.id);
  ok("lowQty 保存并可读回", myProd && Number(myProd.lowQty) === 5, `lowQty=${myProd && myProd.lowQty}`);

  // 5. 不同内容不受幂等影响
  const docBody3 = { teamId, type: "stockin", date: "2026-10-20", warehouseId: wh.id, items: [{ productId: prod.id, qty: 99, price: 100 }] };
  const t1 = await call("POST", "/doc/create", docBody3);
  ok("不同内容建新单", t1.json && t1.json.id && t1.json.id !== d1.id && t1.json.id !== s1.json.id, `id=${t1.json && t1.json.id}`);

  console.log(`\n===== 结果：PASS ${pass} / FAIL ${fail} =====`);
  if (fail) process.exitCode = 1;
}
main().catch((e) => { console.error("CRASH:", e.message); process.exit(1); });
