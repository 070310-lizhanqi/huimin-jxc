# AGENTS.md — 展惠进销存（zhanhui-jxc）工程指南

本文档沉淀仓库目录约定、编码规范、业务安全约束以及开发/测试/构建命令，供所有开发者与自动化智能体遵循。

---

## 1. 技术栈与运行环境

- **Runtime**: Node.js `>= 22.5`（当前开发/CI 基准 Node 24；使用内置 `node:sqlite` 与 `node:test`，零外部数据库依赖）
- **包管理器**: `pnpm`（`pnpm-workspace.yaml` 声明单包根工作区，兼容 pnpm 10 & 12）
- **后端**: TypeScript + Express 4（`server/src/` -> `dist/server/`）
- **前端**: 无构建 Vue 3.5 + Element Plus 2.9 + ECharts 5.6（`web/index.html` + `web/css/` + `web/js/` + `web/vendor/`）
- **桌面端**: Electron 45 + `electron-builder` 26（`electron/`）

---

## 2. 目录结构约定

```text
server/
  src/
    config/         # 环境变量解析、.env 加载与启动强校验（env.ts）
    shared/         # 跨模块领域常量与精度运算（money.ts 等）
    infra/          # 基础设施：日志、错误类型、Schema 校验、事务包装、审计日志、幂等、生命周期
    middleware/     # Express 中间件：安全头/Host/CORS/CSRF、RBAC 权限守卫
    services/       # 核心业务服务层（库存过账/FIFO、单据流转、导入等）
    routes/         # 按资源拆分的路由模块（健康检查、档案、审计日志等）
    *.ts            # 兼容既有模块入口（index.ts, db.ts, auth.ts, docs.ts, settings.ts 等）
  tests/            # Node 原生测试套件（unit / integration）
  tsconfig.json
web/
  index.html        # SPA 入口壳
  css/              # 样式表（app.css）
  js/               # 按数字前缀顺序加载的组件脚本（00-head.js .. 25-mount.js）
  vendor/           # 离线托管的第三方浏览器库
electron/           # Electron 主进程、托盘、自动更新、子进程管理、数据目录迁移
tools/              # 全量回归与运维脚本（regression.cjs, run-tests.cjs, db-*.cjs）
docs/               # 用户手册与部署运维指南
```

---

## 3. 核心业务与代码规范红线

### 3.1 业务域不可违背的不变量
1. **金额与数量精度**：
   - 所有金额在数据库与 API 传输中一律使用**整数分（INTEGER cents）**；禁止对金额直接做未经整数化处理的浮点乘法或累加后不舍入。
   - 数量最多保留 4 位小数（`QTY_DECIMALS = 4`），行金额统一调用 `lineAmountCents(qty, priceCents)`（`qty * 10000 * price / 10000` 并使用对称舍入 `roundHalfAwayFromZero`）。
2. **事务与并发一致性**：
   - 任何涉及库存（`stock` / `stock_ledger`）、往来余额（`partner_balance`）、资金账户（`account`）、单据状态机（`doc`）的多步写操作，必须包在 `withTransaction(db, ...)`（`BEGIN IMMEDIATE`）内，且在锁内重读状态，出库扣减必须保留 `WHERE qty >= ?` 原子条件。
   - 禁止在 `BEGIN IMMEDIATE` 事务内执行 `await` 异步操作（`node:sqlite` 为同步 API，异步挂起会长时间锁死写锁）。
3. **团队隔离与 RBAC**：
   - `requireAuth` 会强制把请求 `query.teamId` / `body.teamId` 覆写为令牌所属 `teamId`，严禁绕过该隔离或信任客户端传来的跨团队外键 ID。
   - 管理员敏感操作（系统设置修改、用户管理、备份/恢复、商品批量导入、审计日志查询、停机接口）必须使用统一 `requireRole('admin')` 中间件，全局注册配置必须使用 `requireOwnerAdmin`（`teamId === 1 && role === 'admin'`）。
4. **审计与留痕**：
   - 关键操作（认证、用户管理、设置修改、备份恢复、单据流转、收付款、导入）必须写入 `audit_log`；禁止泄露密码、令牌、密钥到日志或响应中。

### 3.2 代码质量红线
- **禁止** 新增 `any`（TypeScript strict）、`@ts-ignore`、`eslint-disable` 绕过检查。
- **禁止** 留下 `TODO`、`FIXME`、`NotImplemented`、空 `catch` 静默吞异常（确需兜底时必须记录日志或显式说明可恢复原因）。
- **禁止** 将真实密钥、密码、令牌硬编码在源码或文档中。
- **HTML/打印模板**：禁止未经 `escapeHtml` 拼接用户输入；前端禁止使用 `v-html` 渲染非纯静态 SVG/不可信内容。

---

## 4. 常用命令

```bash
# 安装依赖
pnpm install --frozen-lockfile

# 类型检查 / 代码规范 / 格式检查 / 编译
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run build

# 数据库迁移与幂等演示种子（默认数据目录 data/，可通过 ORANGE_DATA_DIR 指定）
pnpm run db:migrate
pnpm run db:seed

# 单元测试与集成测试（基于 node:test，离线独立运行）
pnpm run test:unit
pnpm run test:integration

# 启动服务
pnpm serve                # 等价于 node dist/server/index.js
pnpm dev:server           # ts-node 开发模式

# 全量回归（需服务已在 127.0.0.1:7741 运行）
node tools/run-tests.cjs --with-rounds

# 安全漏洞检查
pnpm audit --audit-level=high
```
