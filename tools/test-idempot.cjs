const BASE = "http://127.0.0.1:7741/api";
async function main() {
  // 1. 建新团队
  const b = await fetch(BASE + "/bootstrap", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "幂等验证套" }) }).then(r => r.json());
  const teamId = b.teamId;
  console.log("teamId:", teamId);

  // 建仓库+商品
  const wh = await fetch(BASE + "/warehouse", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teamId, name: "默认仓" }) }).then(r => r.json());
  const prod = await fetch(BASE + "/product", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ teamId, catId: b.catId, name: "幂等测试商品", unit: "个", purchasePrice: 100, salePrice: 200, lowQty: 5 }) }).then(r => r.json());
  console.log("warehouse:", wh.id, "product:", prod.id, "lowQty saved:", prod.lowQty);

  // 2. 幂等：同一内容连续 POST 两次（模拟双击）
  const docBody = JSON.stringify({ teamId, type: "stockin", date: "2026-10-20", warehouseId: wh.id, items: [{ productId: prod.id, qty: 10, price: 100 }] });
  const [r1, r2] = await Promise.all([
    fetch(BASE + "/doc/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: docBody }),
    fetch(BASE + "/doc/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: docBody }),
  ]);
  const d1 = await r1.json(), d2 = await r2.json();
  console.log("并发双击:", d1.id, d2.id, d1.id === d2.id ? "PASS (同一张单)" : "FAIL");

  // 3. 串行双击（间隔 100ms，仍在 5 秒窗口内）
  const docBody2 = JSON.stringify({ teamId, type: "stockin", date: "2026-10-20", warehouseId: wh.id, items: [{ productId: prod.id, qty: 3, price: 100 }] });
  const s1 = await fetch(BASE + "/doc/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: docBody2 }).then(r => r.json());
  await new Promise(r => setTimeout(r, 100));
  const s2 = await fetch(BASE + "/doc/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: docBody2 }).then(r => r.json());
  console.log("串行双击:", s1.id, s2.id, s1.id === s2.id ? "PASS (同一张单)" : "FAIL");

  // 4. 低库存字段读取
  const plist = await fetch(BASE + "/product?teamId=" + teamId).then(r => r.json());
  console.log("lowQty in list:", plist.rows?.[0]?.lowQty, plist.rows?.[0]?.lowQty === 5 ? "PASS" : "FAIL");

  // 5. 不同内容不受幂等影响
  const docBody3 = JSON.stringify({ teamId, type: "stockin", date: "2026-10-20", warehouseId: wh.id, items: [{ productId: prod.id, qty: 99, price: 100 }] });
  const t1 = await fetch(BASE + "/doc/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: docBody3 }).then(r => r.json());
  console.log("不同内容:", t1.id, t1.id !== d1.id && t1.id !== s1.id ? "PASS (新单)" : "FAIL");
}
main().catch(e => { console.error("CRASH:", e.message); process.exit(1); });
