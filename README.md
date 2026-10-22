# 橙子云进销管理系统（orange-jxc）

面向小微批发/零售的进销存管理系统：商品档案、客户/供应商、采购入库、销售出库、调拨盘点、结算收付款、报表对账，一套完整的单据流 + 库存账。



> **v0.2.6（2026-10-22）**：自 v0.2.4 累积的三批改进，共 40+ 项，并修复一个会导致整页空白的前端缺陷。**① 性能与健壮性（26 项）**：零依赖 gzip 压缩（echarts 等静态资源传输体积约 1/3）；SQLite `synchronous=NORMAL` + 64MB 页缓存；报表/账龄/收付款新增 4 个热点索引；单据校验由逐行查询改为批量预取（500 行大单开单 4~7ms）；单号 upsert 合并为 `RETURNING` 单语句；批量提交预编译语句；列表分页上限保护；LIKE 通配符转义；xlsx 解压炸弹防护（单条目 80MB 上限 + ZIP 目录越界校验）；报表日期参数校验；起账期格式归一；商品/用户名并发重名唯一索引兜底。**② 业务正确性**：修「改单可换类型导致负数出库反向加库存」的错账漏洞；`qty:null`（JSON 化的 Infinity）绕过校验落库为 0 数量行——已改为强制有限数值；负折扣/负收款/负订金直接拒绝；单据复制补齐收件人/折扣/账户；开单人与审核人 userId 落库；收付款创建双击幂等；结算列表 `rows` 参数真正生效并支持 partnerId/日期/refDocId 过滤；档案列表支持条码/规格搜索；前端请求 30s 超时 + 登录页记住用户名；CORS 白名单跟随实际端口。**③ 应用化（可安装分发）**：数据目录外置 `ORANGE_DATA_DIR`（安装版 `%APPDATA%\orange-jxc`，便携版程序目录 data/）；默认仅监听 127.0.0.1（`ORANGE_BIND=0.0.0.0` 显式开局域网）；端口被占自动后移并写 `port.txt`；单实例文件锁；**数据备份与恢复**（管理员页签：WAL checkpoint 快照、同秒防冲突、下载到本机外、恢复需二次验密且由内置重启助手自动重启生效、文件名白名单防路径穿越）；Host 头白名单防 DNS rebinding；应用启动器 `launcher.cjs`（免参启动→探测就绪→自动开浏览器→进程退出自动拉起，含 launcher.pid）；Windows 安装包流水线 `pnpm run dist:win`（payload 内置 node.exe + 独立安装 express 运行时依赖 + **隔离目录产物自检**，缺依赖直接阻止交付）。**④ 缺陷修复**：修复 `DocPage` 模板多根片段与外层 `<transition mode="out-in">` 冲突导致的**单据子路由切换整页空白并级联污染后续路由**（如采购入库↔销售出库）；前端 JS/CSS/HTML 改为 `no-cache` 协商缓存，升级程序后不再复用旧前端；`.cmd` 改 CRLF 行尾。**⑤ 测试**：新增 UI 端到端测试（playwright，登录→15 页面巡检→备份页签→开单编辑态，带退出码）；移除只打印不判失败的旧菜单巡检脚本。

> **v0.2.1（2026-10-20）**：新增**单据 Excel/CSV 智能导入**——上传 `.xlsx`/`.csv` 自动识别表头（商品/品名、数量、单价、金额、日期、单号、客户/供应商、仓库、备注等）与单据方向（销售出库/采购入库/退货），按单号聚合多行一单；支持 dryRun 预览、未识别档案自动建档、外部单号幂等防重、GBK 编码回落；零第三方依赖（内置最小 xlsx 读取器）。导入结果为草稿，走正常审核过账流程。
>
> **v0.2（2026-10-20）**：修复两处账务/安全缺陷——①作废已审核单据时同步冲回「开单即收付」生成的结算记录、资金账户与往来余额（此前会导致账户余额虚高、客户余额翻转为预收）；②档案 PUT 更新对不存在/跨团队的 id 统一返回 404（此前响应可能泄漏其他账套的行数据）。新增 `tools/test-void-settle.cjs` 回归测试。

## 技术栈

- **后端**：Node.js + Express 4 + `node:sqlite`（零外部数据库依赖，单文件 SQLite）
- **前端**：Vue 3 + Element Plus + ECharts，单页应用；依赖库放在 `web/vendor/` 离线加载，不依赖 CDN
- **语言**：TypeScript（`server/src/`），`tsc` 编译到 `dist/`

## 快速开始

```bash
pnpm install
pnpm build
node dist/server/index.js
```

浏览器打开 <http://127.0.0.1:7741>，首次启动会自动建库并引导创建账套与管理员账号。

想直接用演示数据（2 仓库 / 8 商品 / 5 客户 / 3 供应商 + 默认管理员）：

```bash
node tools/rebuild-clean.cjs
```

演示管理员：`admin / admin123456`（**仅演示用途，正式使用请立即修改密码**）。

## 打包成 Windows 应用（给别人安装即用）

```bash
# 1) 把官方 node.exe 放到 .tools/node.exe（从 nodejs.org LTS zip 解压取出，~80MB）
# 2) 安装 Inno Setup（可选；未安装则产出便携版目录）
winget install JRSoftware.InnoSetup
# 3) 一键出包
pnpm run dist:win
```

产物：
- `installer/out/橙子进销存-Setup-<版本>.exe` —— 安装包（装到 `%LOCALAPPDATA%\OrangeJXC`，创建快捷方式，卸载保留数据）
- `installer/payload/` —— 便携版目录（自带 node.exe 时可整体压缩直接分发，双击「橙子进销存.cmd」使用）

用户侧体验：双击快捷方式 → 服务自动启动 → 浏览器自动打开系统页面；数据保存在 `%APPDATA%\orange-jxc`（便携版在程序目录 data/），重装/升级程序不影响数据。

## 目录结构

```
server/src/     后端源码，按业务域拆分
  index.ts        入口与静态资源托管
  db.ts           建表与轻量列迁移
  auth.ts         登录/注册/用户管理/邀请码注册
  docs.ts         单据（采购、销售、调拨、盘点）与审核过账
  stock.ts        库存查询与货值
  settlement.ts   收付款结算
  report.ts       报表与对账
  dashboard.ts    工作台聚合
  ...
web/            前端
  index.html      入口
  app.js          Vue 单文件组件（页面 + 路由）
  vendor/         Vue / Element Plus / ECharts 离线库
tools/          测试脚本、演示数据重建、本地服务管理器
data/           本地 SQLite 数据库（gitignore，不入库）
```

## 测试

1. 启动服务：`pnpm build && node dist/server/index.js`
2. 一键回归：`pnpm test`（默认先执行 `tools/rebuild-clean.cjs` 重建干净账套，再顺序运行 `tools/regression.cjs` + 全部 `tools/test-*.cjs`，最后汇总退出码）

仅跑测试不重建账套：`node tools/run-tests.cjs --no-rebuild`。

测试覆盖：单据全类型与转化链路、单据流与过账、多价记忆、结算与改单、报表与对账、导入、权限与越权、审批流、账龄、作废冲回结算、Excel 单据导入（MVP/健壮性/安全三组）等。

## 设计要点

- **单账套隔离**：令牌鉴权，请求里的 `teamId` 一律被覆写为令牌所属团队，跨账套调用不会泄漏数据
- **邀请码注册**：管理员在设置页开启后，他人可凭邀请码自助创建**完全独立**的新账套；登录/注册带按 IP 的失败限速
- **审核即过账**：单据审核时在同一事务内写库存流水与往来余额，保证账实一致
- **Excel 智能导入**：单据列表页一键上传 xlsx/CSV，自动识别列与单据方向，预览确认后生成草稿；外部单号防重复导入
- **离线可用**：前端库与页面全部本地托管，无外网依赖

## 安全说明

- **令牌签名密钥**：默认使用内置本地密钥，**仅限本机自用**。要把服务暴露到公网/内网/隧道时，必须先设置环境变量 `ORANGE_JWT_SECRET`（建议 32 位以上随机串）；也可开启 `ORANGE_REQUIRE_SECRET=1`，未设密钥时直接拒绝启动。
- **防护范围**：登录/注册按 IP 失败限速（内存态，重启清零）、密码 scrypt 哈希 + 定长比较、团队数据按令牌隔离。以上面向单机自用场景，不构成公网级完整安全边界。
- **基线安全头**：已启用 `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`。

## 说明

本项目为个人自用的进销存实现，仅用于本地学习与内部使用；界面与业务流参考「橙子云」进销存产品，**请勿用于任何公开运营或商业分发场景。**
