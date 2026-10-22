# 橙子云进销管理系统（orange-jxc）

面向小微批发/零售的进销存管理系统：商品档案、客户/供应商、采购入库、销售出库、调拨盘点、结算收付款、报表对账，一套完整的单据流 + 库存账。



> **v0.2.7（2026-10-22）**：第四轮全面审查，重点为「长期运行」与「数据入口」两类遗留问题。**① 数据正确性**：新增统一的业务日期校验（格式 + 真实日历 + 年份区间），单据/收付款/Excel 导入三处共用——此前收付款完全不校验日期（`2099-13-45` 可落库），单据只校验格式（`2026-02-30` 能过）；备份目录加保留策略（保留最近 30 份并清理更旧的及其 WAL 副产物）。**② 长期运行**：启动器日志超 2MB 轮转；前端全局错误捕获（不再静默白屏）；401 并发清理去抖；会话过期登录后回跳原页面。**③ 工程化**：902 行的单据页拆为列表/编辑器/导入三个组件（模板逐行等价校验）；新增 UI 业务流 E2E（在真实界面走完入库→审核→出库→审核→收款→报表，18 条断言，以数据库落库结果为准）；`dist:win` 出包后增加「静默安装 → 从安装产物起服务」冒烟自检，并可自动上传 Release。完整历史见 [CHANGELOG.md](CHANGELOG.md)。

## 更新日志

完整版本历史见 [CHANGELOG.md](CHANGELOG.md)。

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
  js/             Vue 组件（按依赖顺序加载，无构建步骤）
  vendor/         Vue / Element Plus / ECharts 离线库
tools/          测试脚本、演示数据重建、本地服务管理器
data/           本地 SQLite 数据库（gitignore，不入库）
```

## 测试

1. 启动服务：`pnpm build && node dist/server/index.js`
2. 一键回归：`pnpm test`（默认先执行 `tools/rebuild-clean.cjs` 重建干净账套，再顺序运行 `tools/regression.cjs` + 全部 `tools/test-*.cjs`，最后汇总退出码）

仅跑测试不重建账套：`node tools/run-tests.cjs --no-rebuild`。

测试覆盖：单据全类型与转化链路、单据流与过账、多价记忆、结算与改单、报表与对账、导入、权限与越权、审批流、账龄、作废冲回结算、Excel 单据导入（MVP/健壮性/安全三组）、业务日期校验与备份保留策略、UI 端到端（页面巡检 + 完整业务流，需 playwright）。

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
