# 企业级工程升级路线图（UPGRADE_PLAN.md）

> 基准分支：`master` (`e5983be`, v0.5.3)  
> 工作分支：`feat/enterprise-upgrade`  
> 目标：在不破坏存量业务功能与客户端/测试契约的前提下，将 **展惠进销存（zhanhui-jxc）** 一次性升级为结构清晰、安全可靠、可观测、易部署的企业级工程。

---

## 一、现状体检与关键问题清单

通过全量扫描改造前仓库 `server/src/`（18 个 TS 模块，升级后拆分为 37 个模块 + `schema.md`）、`web/`（`index.html` + 31 个前端脚本）、`electron/`（7 个桌面进程模块）、`tools/`（49 个测试与运维脚本）及构建/流水线配置，识别出以下核心工程与业务域风险：

### 1.1 架构与可维护性问题
| 问题文件 | 现状问题 | 改造目标 |
| --- | --- | --- |
| `server/src/docs.ts` (2057 行) | HTTP 路由、参数校验、库存过账/FIFO 扣减、盘点快照、单据自动结算、CSV 导出全部混在单文件；`/stock/ledger/export` 错放在 `docs.ts` | 拆分为 `services/stock-service.ts`、`services/doc-service.ts`、`shared/money.ts`，`docs.ts` 仅保留路由适配与导出 |
| `server/src/index.ts` (750 行) | 杂糅启动校验、安全头、CORS、gzip 中间件、9 张档案 CRUD 挂载、`/product/import` 业务实现、单实例锁、端口监听与优雅停机；`/admin/shutdown` 在 IIFE 中注册且缺管理员角色校验 | 抽离 `app.ts`、`config/env.ts`、`middleware/security.ts`、`routes/archives.ts`、`services/product-import-service.ts`，`/admin/shutdown` 补齐 `admin` RBAC |
| `server/src/auth.ts` (932 行) | 加解密、令牌签发/吊销、限速器、邀请码迁移、认证路由、用户管理路由耦合；硬编码默认密钥 `'huimin-clone-local-secret-v1'` | 抽离 `middleware/rbac.ts`、复用 `db.ts` `createWindowLimiter` 限速器；消除源码硬编码密钥 |
| `server/src/db.ts` & `price.ts` | `price_memory` 建表 DDL 散落在 `price.ts`；`migrate()` 无版本记录表 `schema_migrations`；`settlement.ts` 自建 `dbtransaction()` 而 `docs.ts`/`index.ts` 手写 `BEGIN/ROLLBACK`（部分 `catch` 缺安全回滚保护） | 统一 `schema_migrations` 版本化迁移；统一 `infra/tx.ts` 事务封装 |
| `web/index.html` (792 行) & `web/js/*` | 约 740 行 CSS 内联在 HTML；`?v=0.5.2` 版本号滞后于 `0.5.3`；`07-doc-viewer.js` 重复定义 `escapeHtml`；`23-settings.js` 非管理员无法点击「修改我的密码」；`24-login.js` 使用 `v-html`；缺少前端请求追踪 ID 与操作审计界面 | 抽离 `web/css/app.css`；统一版本号与工具函数；修复员工改密入口；移除 `v-html`；补齐请求 `X-Request-Id` 与审计日志查看页 |

### 1.2 进销存业务域企业级硬指标
1. **金额与数量精度安全**：
   - 将散落在 `docs.ts`、`report.ts`、`docimport.ts`、`crud.ts`、`settlement.ts` 中的整数分运算、对称舍入 `roundHalfAwayFromZero`、4 位小数 `roundQty` 与 `allocateDocDiscounts` 统一收敛到 `server/src/shared/money.ts`，并修复 `report.ts`/`jxc-report.ts`/`aging.ts` 数量累加浮点尾差。
   - 统一 `HIST_AVG_COST_SQL` 成本估算口径，消除 4 处 SQL 复制漂移。
2. **事务一致性、并发防超卖与幂等保护**：
   - 所有核心写操作统一走 `BEGIN IMMEDIATE` + 锁内状态复核 + 原子库存扣减 `WHERE qty >= ?`（`infra/tx.ts`）。
   - 在保留现有 5s/3s 请求体指纹防重的基础上，新增持久化 `idempotency_key` 表与 HTTP `Idempotency-Key` 请求头支持（覆盖 `POST /doc/create`、`POST /doc/audit`、`POST /doc/void`、`POST /settlement/create`）。
3. **RBAC、鉴权安全与审计日志**：
   - 消除源码硬编码 JWT 密钥：生产/非本机/强密钥模式下缺失或弱密钥启动即快速失败；本机桌面零配置模式下首次启动生成 CSPRNG 256 位随机密钥并持久化到 `<dataDir>/.jwt-secret`（`0600` 权限）。
   - 统一 RBAC 中间件（`requireRole('admin')`、`requireOwnerAdmin`），修复 `/admin/shutdown` 仅要求登录不要求 `admin` 的越权漏洞。
   - 新增持久化 `audit_log` 表与 `GET /api/audit-logs`（仅 `admin` 可查），完整记录登录/失败/改密/用户管理/系统设置/备份恢复/单据提交驳回审核作废删除/收付款变更/批量导入等关键操作（含操作人、IP、`requestId`、详情摘要，自动脱敏密码与令牌）。
4. **严格数据校验、防误删与主外键/状态机完整性**：
   - 新增类型安全的 Schema 校验层（`infra/validate.ts`），对所有路由的 `id`、分页参数、日期区间、枚举、枚举上下限做显式校验，避免 `NaN` 绑定或空 `NOT NULL` 误报「名称可能已存在」。
   - 补齐 `mountCrud` 缺失的归属与必填校验：`product` 必填名与 `catId` 团队归属、`reservoir` 必填名与 `warehouseId` 团队归属、`account.type` 与 `customer.priceLevel` 枚举校验、`settlement.create` 的 `refDocId` 归属校验（保持存量测试契约）。

### 1.3 工程安全网、可观测性与交付缺失
- 缺少统一的代码规范与静态检查（ESLint + Prettier + `.editorconfig` + 更严格的 `tsconfig.json`）。
- 缺少 `.env.example` 与启动时环境变量 Schema 校验。
- `pnpm audit` 存在 `minimatch`（moderate）传递依赖告警；`pnpm-workspace.yaml` 在 pnpm 12 下因 `electron-winstaller` 构建脚本策略报错 `ERR_PNPM_IGNORED_BUILDS`。
- 缺少结构化日志（含 `requestId`、级别控制与敏感信息脱敏）、`/health` 与 `/ready` 健康/就绪探针。
- 缺少 `Dockerfile`、`docker-compose.yml`、Push/PR 自动化 `ci.yml` 及 `ARCHITECTURE.md`。

---

## 二、分阶段升级计划与验收标准

### Phase 1：架构体检与路线图落盘（当前阶段）
- **交付物**：`UPGRADE_PLAN.md`、`AGENTS.md`、`PROGRESS.md`
- **提交**：`docs: add enterprise upgrade plan and project guidelines`

### Phase 2：建立工程安全网与测试基线
- **改造内容**：
  1. 新增 `.editorconfig`、`.prettierrc.json`、`.prettierignore`、`eslint.config.mjs`；更新 `.gitignore`（保留 `!.env.example`）、`pnpm-workspace.yaml`（兼容 pnpm 10/12）、`server/tsconfig.json`（开启 `noUnusedLocals`、`noUnusedParameters`、`noImplicitReturns`、`noFallthroughCasesInSwitch`、`forceConsistentCasingInFileNames`）。
  2. 新增 `server/src/config/env.ts` 与 `.env.example`，实现零依赖 `.env` 加载、启动参数校验与强密钥安全守卫，彻底移除源码硬编码密钥 `'huimin-clone-local-secret-v1'`。
  3. 检查并修复 `pnpm audit` 依赖漏洞。
  4. 新增 `server/tests/baseline.test.ts`（`node:test`），覆盖配置校验、金额数量精度、鉴权、单据/库存/结算核心链路、表格解析安全限制。
- **验收命令**：
  ```bash
  pnpm run typecheck
  pnpm run lint
  pnpm run format:check
  pnpm run build
  pnpm run test:unit
  pnpm audit --audit-level=high
  ```
- **提交**：`chore: establish code quality gates, env validation, and baseline tests`

### Phase 3：核心架构重构与企业级加固
- **改造内容**：
  1. 后端分层重构（保持 `dist/server/index.js`、`db.js`、`auth.js`、`settings.js`、`safe-handler.js` 兼容所有存量测试与 Electron 启动器）：
     - `server/src/app.ts`
     - `server/src/shared/money.ts`、`shared/csv.ts`
     - `server/src/infra/errors.ts`、`infra/validate.ts`、`infra/tx.ts`、`infra/audit-log.ts`、`infra/idempotency.ts`
     - `server/src/middleware/rbac.ts`、`middleware/security.ts`
     - `server/src/services/stock-service.ts`、`services/doc-service.ts`、`services/product-import-service.ts`
     - `server/src/routes/docs.ts`、`routes/archives.ts`、`routes/audit.ts`
  2. 统一全局异常捕获与错误码 `{ error, code, requestId }`（兼容前端与既有测试 `error` 字段），修正 JSON 解析 400 错误、CSRF Origin 检查、Cookie `Secure` 代理感知配置。
  3. 完善 `db.ts` 版本化迁移表 `schema_migrations` 与 CLI 工具 `tools/db-migrate.cjs`、`tools/db-seed.cjs`。
  4. 前端工程化改造：`web/css/app.css` 抽离、`01-api.js` 请求追踪与错误处理、移除 `v-html`、员工自助改密入口修复、管理端操作审计日志页签、基础键盘可访问性与 `aria-label`。
  5. 新增单元与集成测试（并发超卖、幂等键、RBAC 越权、审计日志、Schema 迁移幂等、输入校验边界），并执行端到端与 UI E2E（若 Chromium 可用）冒烟验证。
- **验收命令**：
  ```bash
  pnpm run lint && pnpm run typecheck && pnpm run build
  pnpm run test:unit && pnpm run test:integration
  # 启动服务后运行全量回归
  node tools/run-tests.cjs --with-rounds
  ```
- **提交**：`refactor: harden architecture, validation, security, and core business reliability`

### Phase 4：可观测性、CI/CD 与生产交付
- **改造内容**：
  1. 新增 `server/src/infra/logger.ts`（结构化 JSON/可读日志、`AsyncLocalStorage` 请求上下文追踪、敏感字段自动脱敏），替换 `server/src/` 中散落的 `console.*`。
  2. 新增 `server/src/routes/health.ts`：提供 `/health`、`/ready`、`/api/health`、`/api/ready` 探针。
  3. 新增多阶段非 root `Dockerfile`、`.dockerignore`、`docker-compose.yml`。
  4. 新增 `.github/workflows/ci.yml`（Push/PR 自动安装、Lint、Typecheck、Format Check、Build、Unit/Integration Tests、Audit）。
  5. 重写 `README.md`（同步更新 `README_EN.md`），新增 `ARCHITECTURE.md`。
- **验收命令**：
  ```bash
  pnpm run lint && pnpm run typecheck && pnpm run format:check && pnpm run build
  pnpm run test:unit && pnpm run test:integration
  # 实测 /health、/ready 与核心业务冒烟
  ```
- **提交**：`ops: add structured logging, health checks, docker, ci workflow, and docs`

### Phase 5：独立终审、全量回归与交付报告
- **改造内容**：
  1. 以外部安全与质量审计员视角审查 `git diff master..HEAD` 全量改动（无 `TODO`/`FIXME`/调试残留/敏感泄露/`any`/`@ts-ignore`/`eslint-disable`/被吞异常）。
  2. 按新 `README.md` 步骤从零执行完整构建、单测、集成测试、全量回归及真实运行态冒烟。
  3. 输出 `DELIVERY_REPORT.md`。
- **提交**：`docs: add final enterprise upgrade delivery report`

---

## 三、兼容性约束（不可破坏的现有契约）

1. **编译产物入口**：`dist/server/index.js`、`dist/server/db.js`、`dist/server/auth.js`、`dist/server/settings.js`、`dist/server/safe-handler.js` 路径与核心导出签名不变（Electron `server-runner.js`、`.github/workflows/release.yml` 与既有测试脚本直接依赖）。
2. **环境变量锚点**：继续兼容 `ORANGE_DATA_DIR`、`ORANGE_DB_PATH`、`ORANGE_JWT_SECRET`、`ORANGE_REQUIRE_SECRET`、`ORANGE_BIND`、`ORANGE_ALLOW_HOSTS`、`ORANGE_PORT`、`PORT`。
3. **API 返回契约**：错误响应保留 `{ error: string }` 同时附加 `code` 与 `requestId`；分页列表与非分页调用兼容现有前端与 `tools/test-*.cjs` 全部测试。
4. **Electron 桌面端**：保持零配置双击即用语义，本地未配 `ORANGE_JWT_SECRET` 时自动在数据目录持久化 CSPRNG 密钥。
