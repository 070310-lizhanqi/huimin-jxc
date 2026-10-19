# 橙子云进销管理系统（orange-jxc）

面向小微批发/零售的进销存管理系统：商品档案、客户/供应商、采购入库、销售出库、调拨盘点、结算收付款、报表对账，一套完整的单据流 + 库存账。

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

先启动服务，再逐个运行 `tools/test-*.cjs`。15 个脚本覆盖：单据全类型、单据流与过账、多价记忆、结算与改单、报表与对账、导入、权限与越权、审批流、账龄等。

测试脚本统一用 `tools/test-helpers.cjs`（自动登录 + 鉴权头）。

## 设计要点

- **单账套隔离**：令牌鉴权，请求里的 `teamId` 一律被覆写为令牌所属团队，跨账套调用不会泄漏数据
- **邀请码注册**：管理员在设置页开启后，他人可凭邀请码自助创建**完全独立**的新账套；登录/注册带按 IP 的失败限速
- **审核即过账**：单据审核时在同一事务内写库存流水与往来余额，保证账实一致
- **离线可用**：前端库与页面全部本地托管，无外网依赖

## 说明

本项目为个人自用的进销存实现，用于学习与内部使用。
