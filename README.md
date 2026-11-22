# 展惠进销存（zhanhui-jxc）

[中文](README.md) | [English](README_EN.md)

面向小微批发 / 零售的进销存管理系统：商品档案、采购入库、销售出库、调拨盘点、结算收付款、报表对账——一套完整的单据流 + 库存账 + 往来账。

**v0.5.2** · **MIT License** · 零外部数据库 · 零构建前端 · 默认仅本机可用

---

## 截图演示

![工作台](docs/screenshots/01-dashboard.png)
*工作台：库存 / 资金总览、低库存预警、近 14 天出入库趋势*

![销售出库单](docs/screenshots/02-doc-sales.png)
*销售出库单列表：多张已审核出库单、收款状态与本页合计*

![库存查询](docs/screenshots/03-stock.png)
*库存查询：按仓库 + 商品查看库存，低库存标红*

![收付款](docs/screenshots/04-settlement.png)
*收付款：应收 / 应付合计、登记收款付款、往来余额*

![销售统计报表](docs/screenshots/05-report.png)
*销售统计报表：按日期统计金额、数量、单数与毛利估算*

![客户欠款账龄](docs/screenshots/06-aging.png)
*客户欠款账龄：按账龄区间分桶，定位拖久的欠款*

---

## 项目简介

展惠进销存为小微批发 / 零售商户提供一套开箱即用的账务工具：从建档、开单、审核过账，到库存、往来、报表，全流程都在一个应用里完成。

- **零外部数据库**：数据存于单个 SQLite 文件，复制文件即完成备份。
- **零构建前端**：Vue 3 + Element Plus + ECharts 全部本地托管，无 CDN、无打包步骤、断网可用。
- **单机自用**：默认只监听 `127.0.0.1`，不给公网暴露面；要对外开放须先配强随机密钥（见[安全说明](#安全说明)）。
- **账实一致**：单据只有审核过账后才影响库存与往来；已审核单据不可改，要调整必须作废冲回再重开，保证账目可追溯。

---

## 功能一览

| 模块 | 内容 |
| --- | --- |
| 工作台 | 库存 / 资金总览、低库存预警、近 14 天出入库趋势、经营 KPI、快捷开单入口 |
| 销售 | 报价单、销售订单、销售出库、销售退货 + 订单 / 出库 / 收款 / 毛利统计 + 客户对账单 + 客户欠款账龄 |
| 采购 | 采购订单、采购入库、采购退货 + 采购统计 + 供应商对账单 + 供应商欠款账龄 |
| 库存 | 期初库存、其它出入库、生产组装、转仓调拨、库存调整、库存盘点、出库申请、生产任务 + 库存查询、进销存明细 / 统计、库存账龄、库存预估 |
| 资料 | 客户、供应商、商品、商品单位、商品分类、客户价格（记忆价）、基础档案（仓库 / 库位 / 业务员 / 资金账户） |
| 设置 | 单据编号规则、打印抬头、用户与权限、邀请码注册、数据备份与恢复 |

**记账规则**：单据有草稿 / 待审核 / 已审核 / 已作废四种状态；只有审核过账才会影响库存与往来余额。出库类单据审核时校验库存，不足则拒绝；带批次的商品按先进先出（FIFO）扣减。支持扫码开单、客户记忆价（一客一价）、Excel / CSV 单据导入、商品批量导入。

---

## 快速上手

### 方式 A：开发运行（改代码 / 跑测试）

```bash
pnpm install
pnpm build              # tsc 编译到 dist/
node dist/server/index.js
# 或：pnpm serve        （等价于上一行）
```

浏览器打开 <http://127.0.0.1:7741>。运行环境要求 **Node.js ≥ 22.5**（`node:sqlite` 的引入版本）。

- 热编译后端：`pnpm dev:server`（ts-node 直接跑 TS，无需 build）。
- 数据目录默认是当前工作目录下的 `data/`；可用 `ORANGE_DATA_DIR` 指定。

### 方式 B：Windows 安装包（推荐给普通用户）

运行 `展惠进销存-Setup-<版本>.exe`（默认装到 `%LOCALAPPDATA%\HuiminYun`），安装完成后双击桌面「展惠进销存」图标即可，无需安装 Node.js，不会弹出黑色终端窗口。数据保存在 `%APPDATA%\huimin-yun`，重装 / 升级 / 卸载程序都不会删除数据。

### 方式 C：便携版（U 盘 / 免安装）

把 `installer/payload/` 整个目录拷走（内含自带 `node.exe`），双击目录里的「展惠进销存.exe」即可；数据落在程序目录下的 `data/`，随目录一起搬走。

### 首次使用

首次启动时数据库为空，打开页面后自动进入「创建账套」模式（首次运行时无需邀请码）：填写用户名、密码（至少 6 位）、账套名称，点击「创建账套」，创建成功后自动登录进入工作台。

**想直接用演示数据**：

```bash
node tools/rebuild-clean.cjs
```

重建一个干净账套（鲜果批发部）并写入演示档案：2 仓库 / 3 库位 / 3 资金账户 / 4 分类 / 5 单位 / 2 业务员 / 8 商品 / 5 客户 / 3 供应商。演示管理员：`admin / B2cost!9Xq`（**仅演示用途，正式使用请立即改密**）。

详细的操作步骤、记账规则与常见问题见 [使用手册](docs/使用手册.md)。

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 后端 | Node.js + Express 4 + `node:sqlite`（Node 内置，零原生依赖、零外部数据库） |
| 后端语言 | TypeScript（`server/src/`，18 个模块 + `schema.md`），`tsc` 编译到 `dist/` |
| 前端 | Vue 3.5.13 + Element Plus 2.9.3（完整版）+ Icons 2.3.1 + ECharts 5.6.0，全部放 `web/vendor/` 离线加载（31 个前端脚本，无构建步骤） |
| 测试 | Node 自研回归脚本（`tools/test-*.cjs`），UI 端到端用 Playwright |

第三方离线库版本与 SHA256 见 [web/vendor/VERSIONS.md](web/vendor/VERSIONS.md)。

---

## 测试状态

```bash
pnpm build                     # tsc 编译
node tools/rebuild-clean.cjs   # 重建干净账套（跑测试前建议先执行）
pnpm test                      # 一键回归：重建账套 + 跑全部测试脚本，末尾汇总退出码
node tools/run-tests.cjs --no-rebuild    # 不重建账套，直接跑
node tools/run-tests.cjs --with-rounds   # 额外纳入专项对抗测试
```

- **规模**：回归共 49 个脚本（`--with-rounds` 跑全部 49 个，默认跑 45 个，不含 4 个 `test-round*` 专项套件）。
- **最新结果**（v0.5.2 + 企业级优化 PR #3 合并后）：`tsc --noEmit` 0 报错；全量回归 **46/49 通过、跳过 3、失败 0**（跳过的是 3 个 UI E2E，沙箱无浏览器环境）。
- **覆盖**：单据全类型与转化、过账与作废冲回、结算与改单、报表与对账、导入（MVP / 健壮性 / 安全三组）、权限越权、审批流、账龄、业务日期校验、备份保留策略、UI 端到端。
- `pnpm test` 需要服务已在 `7741`（或 `port.txt` 记录的端口）运行；可自定义基址：`OC_BASE=http://127.0.0.1:7741/api`。

---

## 数据与备份

- **数据文件**：`<数据目录>/huimin-clone.db`（SQLite 单文件，另可能有同目录的 `-wal` / `-shm`）。
- **手动备份**：直接复制该 `.db` 文件即可。
- **应用内备份**（设置 → 数据备份，仅管理员）：「立即备份」在 WAL checkpoint 后复制整库快照到 `<数据目录>/backups/`，保留最近 30 份；「下载」把备份另存到本机别处；「恢复」需二次输入当前账号密码，确认后服务自动重启、数据回到该备份时点（不可撤销，恢复前建议先备份现状）。
- **升级不丢数据**：重装 / 升级只换程序文件，数据目录原样保留；卸载也会保留账套数据。
- **旧版本迁移**：v0.2.x 的数据在 `%APPDATA%\orange-jxc`（库文件 `orange-clone.db`），首次启动时自动迁移到 `%APPDATA%\huimin-yun`（库文件改名 `huimin-clone.db`），先合并 WAL → 复制 → 校验大小一致 → 再删旧目录，任何一步失败都保留旧目录并回退继续用。

---

## 安全说明

- **默认仅本机**：服务默认只监听 `127.0.0.1`；要把服务暴露到局域网 / 公网 / 隧道前，**必须先设置强随机 `ORANGE_JWT_SECRET`**，并建议同时设置 `ORANGE_REQUIRE_SECRET=1`（未设密钥时拒绝启动）。详细步骤见 [docs/deployment.md](docs/deployment.md)。
- **令牌**：登录令牌改由 httpOnly Cookie 下发（7 天有效期，SameSite=Lax），浏览器 JS 读不到；注销真正吊销令牌，改密后旧令牌立即失效。
- **Host 头白名单**：默认只接受 `127.0.0.1` / `localhost` / 回环 IP，防 DNS rebinding；隧道或反代域名需用 `ORANGE_ALLOW_HOSTS` 追加。
- **数据隔离**：请求里的 `teamId` 一律被覆写为令牌所属团队，跨账套调用不会泄漏数据。
- **密码**：scrypt 哈希 + 定长比较；登录 / 注册按 IP 失败限速。
- 以上面向**单机自用**场景，不构成公网级完整安全边界。

---

## 目录结构

```
server/src/     后端源码，按业务域拆分（18 个 .ts 模块 + schema.md）
  index.ts        入口、中间件（gzip / 安全头 / Host 白名单 / CORS）、监听与单实例锁
  db.ts           建表、轻量列迁移、业务日期校验、本地日期
  auth.ts         登录 / 注册 / 用户管理 / 邀请码 / 令牌
  docs.ts         单据（采购、销售、调拨、盘点…）与审核过账
  docimport.ts    Excel / CSV 单据智能导入
  stock.ts        库存查询与货值
  settlement.ts   收付款结算
  report.ts       报表与对账
  aging.ts        账龄
  jxc-report.ts   进销存统计 / 对账
  dashboard.ts    工作台聚合
  backup.ts       备份与恢复
  bill-no.ts      单据号生成（前缀配置、序号分配）
  crud.ts         通用 CRUD 工厂（档案表 list/create/update/delete）
  price.ts        客户价格记忆（一客一价自动带出）
  safe-handler.ts async 路由统一包装（通用 500 响应）
  settings.ts     功能设置（单据编号规则、打印抬头）
  xlsxlite.ts     零依赖 xlsx / CSV 读取器
web/            前端（无构建步骤）
  index.html      入口
  js/             Vue 组件（31 个脚本，按依赖顺序加载）
  vendor/         Vue / Element Plus / ECharts 离线库
tools/          测试脚本、演示数据重建、服务管理器、打包脚本
installer/      Inno Setup 脚本与打包产物（payload/out 不入库）
launcher.cjs    安装/便携版启动器
data/           本地 SQLite 数据库（gitignore，不入库）
```

---

## 更新日志

完整历史见 [CHANGELOG.md](CHANGELOG.md)。

- **v0.5.2（2026-10-24）**：紧急修复：双击桌面图标弹多个浏览器窗口——启动器加单实例锁（原子创建 + 存活复核）。
- **企业级优化（2026-11-21 至 2026-11-22，[PR #3](https://github.com/070310-lizhanqi/huimin-jxc/pull/3)）**：深度审查后分四批落地 63 项改动（A 档 27 项立即能改 + B 档 36 项先补测试再改；C 档 16 项按结论未动）。重点：body-parser 高危漏洞升级、默认 JWT 密钥部署检查、作废结算缺口封堵、令牌类型校验、注销吊销持久化、成本口径统一、备份恢复校验、导入 N+1 消除、档案索引（按名点查 657ms → 6ms）、服务端分页（库存列表 948KB → 10KB）、批量导出（1 万条 50 请求 1978ms → 1 请求 133ms）、令牌改 httpOnly Cookie、文档与版本口径写实。合并后全量回归 46/49 通过、失败 0。

---

## 来源声明

本项目「展惠」进销存系统的界面与业务流参考「惠民云」进销存产品，代码为独立原创实现，未获原产品授权。项目已更名「展惠」以避免商标混淆；旧品牌字符串仅保留在兼容性锚点中：`ORANGE_*` 环境变量名、旧数据目录迁移路径（如 `%APPDATA%\orange-jxc` / `orange-clone.db` → `%APPDATA%\huimin-yun` / `huimin-clone.db`）与安装标识 `AppId`。完整声明见 [NOTICE.md](NOTICE.md)。

本项目以 MIT 许可证发布（见 [LICENSE](LICENSE)）。
