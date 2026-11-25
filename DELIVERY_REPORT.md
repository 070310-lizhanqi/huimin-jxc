# 展惠进销存（huimin-jxc / zhanhui-jxc）企业级升级交付报告（DELIVERY_REPORT.md）

> **目标仓库**：`https://github.com/070310-lizhanqi/huimin-jxc`  
> **交付分支**：`feat/enterprise-upgrade`（基于默认主分支 `master` `e5983be`，严禁直推 `main`/`master`）  
> **版本基线**：`v0.5.3` · **交付日期**：2026-11-25

---

## 1. 升级前后架构与工程能力对比

| 维度 | 升级前 (`master` `e5983be`) | 升级后 (`feat/enterprise-upgrade`) |
| --- | --- | --- |
| **代码规范与质量门禁** | 仅有 `tsc`，无 ESLint、无 Prettier、无 `.editorconfig` | 落地 `eslint.config.mjs`（覆盖 `server/`、`electron/`、`web/js/`，禁止显式 `any` / `no-eval`）、`.prettierrc.json`、`.editorconfig` 与完整 `lint` / `typecheck` / `format:check`（覆盖 `server/`、`electron/`、`web/js/`、`web/css/`）脚本 |
| **配置与密钥安全** | 存在硬编码默认 JWT 密钥常量；缺环境变量模板与启动校验 | 移除源码明文密钥，新建 `server/src/config/env.ts` 校验全部配置与弱密钥并快速失败；提供完整 `.env.example`；仅本机回环开发模式自动生成并持久化 `0o600` `.jwt-secret` |
| **后端架构分层** | `docs.ts` 单文件 >2000 行混杂 HTTP 路由、库存/FIFO/单据业务、SQL 与共享计算；`index.ts` 与中间件耦合 | 拆分装配层 (`app.ts`)、路由层 (`routes/{docs,archives,audit,health}.ts`)、服务层 (`services/{doc-service,stock-service,product-import-service}.ts`)、基础设施层 (`infra/`)、中间件 (`middleware/`) 与公共数学 (`shared/{money,csv}.ts`) |
| **精度、并发与幂等** | 局部浮点运算分散、缺少统一立即写事务封装；部分写接口无请求幂等键 | `shared/money.ts` 统一数量 `10_000` 倍整型缩放与整单分摊守恒；`withImmediateTx` 统一 `BEGIN IMMEDIATE` 与 `SQLITE_BUSY -> 503`；`doc/create` 与 `settlement/create` 支持 24h `Idempotency-Key` 持久化与载荷冲突 `409` |
| **错误处理与输入校验** | 错误结构分散，畸形 JSON 落入 Express 默认异常，部分路由缺参数边界校验 | `AppError` 标准错误码与 `{ error, code, requestId }` 统一出口；`BAD_JSON` (400)、`validate.ts` 严格参数解析、外键团队归属及枚举校验；零未受控错误栈外泄 |
| **审计、RBAC 与 CSRF** | 缺乏可查询审计日志；Cookie 会话缺写操作 Origin 核验 | 新增 `audit_log` 表与 `GET /api/audit-logs`（仅 `admin`）及前端「操作审计」页签；增强 `csrfOriginGuardMiddleware` 与 `requireAdmin` RBAC 守卫；`/api/admin/shutdown` 补齐 `admin` 鉴权 |
| **数据库迁移与备份可靠性** | 无版本化迁移表；`price_memory` 在路由初始化时建表；在线备份使用 `fs.copyFileSync(dbPath)` 导致 Linux POSIX `fcntl` 锁被清空、引发 WAL 分裂 | 新增 `schema_migrations`（`V1`–`V3`）与 `db:migrate` / `db:seed` CLI（无硬编码密码）；`backup.ts` 改用 SQLite 原生事务快照 **`VACUUM INTO ?`** 彻底根治运行期 `-wal/-shm` 孤立与读写分裂 |
| **前端工程化与可访问性** | `web/index.html` 内联 740+ 行 CSS；登录页使用 `v-html` 渲染 SVG；缺少全局错误码/追踪 ID 透传与弹窗 Esc 关闭 | CSS 抽离至 `web/css/app.css`；移除 `v-html` 静态化内联 SVG；`01-api.js` 自动注入 `X-Request-Id`；补充 `:focus-visible`、`aria-label`、弹窗 `Escape` 关闭与非管理员改密可见性修复 |
| **可观测性与探针** | 30 余处零散 `console.log`/`console.error`，无脱敏与请求链路追踪，无健康检查端点 | 新增 `infra/logger.ts`（`AsyncLocalStorage` 透传 `requestId/teamId/userId`、支持 `LOG_LEVEL`/`LOG_FORMAT=json|pretty`、递归敏感字段脱敏），替换全部服务端 `console.*`；新增 `/health`、`/ready`（及 `/api/*`）探针 |
| **交付与 CI/CD** | 无容器化交付配置，仅有 Windows Release 流程 | 新增多阶段非 root `Dockerfile`、`.dockerignore`、`docker-compose.yml`、`.github/workflows/ci.yml`；重写 `README.md`、`README_EN.md` 并新增 `ARCHITECTURE.md` |
| **自动化测试覆盖** | 仅手工驱动回归脚本（`tools/`），无单元测试或进程内集成测试 | 新增 `node:test` 单元测试 `22/22` + 进程内集成测试 `13/13`，且原有 `tools/run-tests.cjs` 在 `NODE_ENV=production` 下全量回归 `45/45` 与 `test-round1..4` 全部通过（含 Playwright UI E2E） |

---

## 2. 各 Phase 改动摘要与关键架构决策

### Phase 0 & Phase 1：仓库体检与升级规划 (`9a4866b`)
- 确认基于 `master` 切出独立工作分支 `feat/enterprise-upgrade`，全仓扫描 `server/`、`web/`、`electron/` 与 `tools/` 测试契约，核实基线 `regression.cjs` (`92/92`)。
- 产出 [`UPGRADE_PLAN.md`](UPGRADE_PLAN.md) 与 [`AGENTS.md`](AGENTS.md)，识别出进销存域关键硬指标（整型分/4 位小数精度、`BEGIN IMMEDIATE` 防超卖与作废重入、RBAC + 审计日志、`V1–V3` 版本迁移、消除硬编码密钥）。

### Phase 2：工程安全网、配置校验与基线测试 (`326cd79`)
- **核心改动**：引入 ESLint v10 Flat Config (`eslint.config.mjs`)、Prettier、`.editorconfig`、`server/src/config/env.ts`、`.env.example`、`server/tsconfig.test.json` 及 `server/tests/baseline.test.ts` (`10` 个特征测试)。
- **关键决策与默认假设**：
  - *假设 1*：项目面向单机桌面（Electron）与小微自托管双形态，因此仅当 `NODE_ENV=production`、`ORANGE_REQUIRE_SECRET=1` 或 `ORANGE_BIND` 为非回环地址时拒绝缺失密钥并快速失败；本机回环开发/桌面版自动生成 256-bit 随机密钥并 `0o600` 持久化至 `<ORANGE_DATA_DIR>/.jwt-secret`，避免“桌面双击即用”与“公网默认空密钥”之间的矛盾。
  - *假设 2*：源码中不存放任何历史明文默认密钥，仅用 `SHA-256` 摘要集合拦截弱口令与示例占位串。

### Phase 3：核心架构重构与企业级加固 (`228d9c8`)
- **核心改动**：
  - 拆分 `docs.ts` 为 `routes/docs.ts`、`services/doc-service.ts`、`services/stock-service.ts`（保留 `docs.ts` 兼容门面）；抽离 `routes/archives.ts` 与 `services/product-import-service.ts`；抽出 `app.ts` 工厂以解耦 HTTP 路由与进程/端口生命周期。
  - 新增 `shared/{money,csv}.ts`、`infra/{errors,validate,tx,audit-log,idempotency}.ts`、`middleware/{rbac,security}.ts`、`routes/audit.ts`。
  - 实现 `schema_migrations` (`V1..V3`)、CLI `tools/db-migrate.cjs` 与 `tools/db-seed.cjs`（默认生成一次性高熵密码，或由 `SEED_ADMIN_PASS` 传入，不硬编码口令）。
  - 完成前端 `web/css/app.css` 抽离、`v-html` 清理、`X-Request-Id` 透传、操作审计管理面板与无障碍基础增强。
  - 新增 `enterprise-hardening.unit.test.ts` (`7` 项) 与 `enterprise-api.test.ts` (`6` 套端到端集成校验)。
- **关键决策与重大隐患修复**：
  - *决策（务实不拆分）*：保持单体 Express + SQLite WAL，不引入 ORM 或外部队列/缓存中间件，避免破坏单文件便携性与 `node:sqlite` 零原生依赖优势。
  - *决策（兼容已有契约）*：保留 `auth.ts` 的 `safeHandler` 导入规范、保留 `index.ts` 内 `!res.getHeader('content-encoding')` 字面守卫、保留 `settings.ts` 导出 `BILL_NO_PREFIXES` 与 `price_memory` 旧表结构，确保与存量客户端及 Electron 托管兼容。
  - **重大底层缺陷根治（POSIX `fcntl` 锁丢失引发 WAL 读写分裂）**：在 Phase 3 全量 `tools/run-tests.cjs` 验证中发现，`backup.ts` 原先在运行中进程内执行 `fs.copyFileSync(dbFilePath(), ...)` 打开并关闭主库原始文件描述符；在 Linux 上 `close(fd)` 会清空当前 PID 对该 inode 持有的全部 POSIX `fcntl` 字节范围锁，导致外部进程在 `db.close()` 时误判自己为最后一个连接而删除运行中服务的 `-wal`/`-shm` 文件，引发后续导入/分页/报表测试读写分裂。将 `backup.ts` 的备份与恢复前快照全部改为 SQLite 原生在线事务语句 **`db.prepare('VACUUM INTO ?').run(...)`** 后，POSIX 锁保持完整，`tools/run-tests.cjs` 从 `39/45` 跃升至 **`45/45` 全部通过**。

### Phase 4：可观测性、容器化、CI/CD 与文档 (`c07f89b`)
- **核心改动**：
  - 新建 `server/src/infra/logger.ts`，利用 `AsyncLocalStorage` 透传 `requestId` / `teamId` / `userId`，按 `LOG_LEVEL` 与 `LOG_FORMAT` 输出结构化日志，对 `password`/`token`/`secret`/`jwtSecret`/`cookie`/`authorization`/`inviteCode`/`apiKey` 及 Bearer/Cookie 字符串做递归脱敏，并清理全部服务端 `console.*` 调用。
  - 新建 `server/src/routes/health.ts`，暴露无鉴权 `/health`、`/api/health`（进程存活）与 `/ready`、`/api/ready`（实测 `SELECT 1` + 迁移版本，异常时返回脱敏的 `503 SERVICE_UNAVAILABLE`）。
  - 新增 `observability.unit.test.ts` (`3` 项) 与 `health-observability.test.ts` (`2` 项)。
  - 交付多阶段非 root `Dockerfile`、`.dockerignore`、`docker-compose.yml`、`.github/workflows/ci.yml`、`ARCHITECTURE.md`，并同步更新 `README.md` 与 `README_EN.md`。

### Phase 5：独立红队终审、缺陷复核修复与全量回归
- 以苛刻外部审计视角对 `master..HEAD` 执行多轮全量静态、边界与对抗审查，彻底修复了包括第二轮红队复审（`[H-1]`、`[M-1]`–`[M-10]`、`[L-1]`–`[L-4]`）在内的全部核心问题：
  - **批量导入原子事务与防重 (`[H-1]`)**：`docimport.ts` 为 `autoCreate=1` 补齐 `admin` RBAC 拦截（`403`）；将 `autoCreate` 建档、单据落库与审计日志整体包裹进 `withImmediateTx` 单事务并检查 `MAX_TOTAL_AMOUNT_CENTS`，任意失败全量回滚无孤儿档案；补齐 `prodByBarcode` 同批更新，并在 `db.ts` 增加部分唯一索引 `idx_doc_team_type_src_billno_uniq` 兜底并发防重。
  - **盘点精准单元格与零差额作废 (`[M-1]`, `[M-2]`)**：`stock-service.ts` 对盘点单启用 `exactCell = true`，使 `batchNo IS NULL`/`reservoirId IS NULL` 精准扣减空单元格而不误伤已有批次库存（保留非盘点单按空筛选通配语义）；允许已审核零差额盘点单（`COALESCE(postQty, 0) = 0`）正常作废冲回。
  - **往来单据配对校验与串账隔离 (`[M-3]`)**：`doc-service.ts`、`stock-service.ts` 与 `tools/regression.cjs` 统一严格校验单据 `type <-> partnerType`（如 `outapply`/`sret` 仅 `'cus'`，`pin` 仅 `'ven'`）；`jxc-report.ts`（`/report/statement`）与 `aging.ts`（`/report/aging`）查询 `doc` 补充 `AND partnerType = ?`，杜绝 `customer.id === vendor.id` 撞号串账。
  - **档案枚举与前端兼容归一 (`[M-4]`, `[M-5]`)**：修正 `tools/rebuild-clean.cjs` 使用 `'wechat'`/`'wholePrice'`/`'retailPrice'`；`db.ts` 在 `migrate()` 幂等归一历史 `'wx'`/`'whole'`/`'retail'`；前端 `10-partner.js`/`11-base.js`/`13-doc-editor.js` 同步兼容兜底展示、编辑与客户批发价自动带价。
  - **类型严格校验与数值/查询边界 (`[M-6]`, `[L-1]`, `[L-2]`, `[L-4]`)**：`doc-service.ts` 与 `settlement.ts` 拦截布尔值、非整数分单价/金额及非整数 `partnerId`/`refDocId` 查询参数；`routes/docs.ts` 修复同商品多行订单的 `/doc/info` 与 `/doc/convert` 顺序核销及 `/doc/copy` 浮点尾差；`settlement.ts` 将关联方/关联单据存在性校验移入 `withImmediateTx`；`report.ts` 与 `dashboard.ts` 对齐 `roundQty`/`roundHalfAwayFromZero`；`backup.ts` 抽离 `resolveSafeBackupPath` 并在 `download`/`restore`/`delete` 全路径禁止软链接。
  - **代理防伪造、`format:check` 与构建/CLI 稳健 (`[M-7]`–`[M-10]`, `[L-3]`)**：`env.ts`/`app.ts`/`audit-log.ts`/`auth.ts` 将 `ORANGE_TRUST_PROXY` 升级为跳数配置 `0..20`（默认 `0`、`docker-compose.yml` 默认 `0`），按 `req.ip` 右起计数防 `X-Forwarded-For` 伪造，未启用可信代理时不轻信 `X-Forwarded-Proto`；扩充 `package.json` `format`/`format:check` 覆盖 `electron/`、`web/js/`、`web/css/`；`web/js/13-doc-import.js` 补齐 `X-Request-Id` 与 `handle401()`；`tools/db-migrate.cjs` 与 `tools/db-seed.cjs` 通过 `resolveStoragePaths` 脱离 `ORANGE_JWT_SECRET` 约束（并校验 `checkPasswordStrength`、修正 `startPeriod` 为 `YYYYMM`、补种 `默认分类`）；`Dockerfile` 与 `.github/workflows/ci.yml` 安装补充 `--ignore-scripts`。
- 按新版 `README.md` 从零执行依赖漏洞审计、Lint、严格类型检查、全仓 Prettier 检查、构建、单元与集成测试、独立库 `production` 迁移/幂等种子脚本、以及隔离 `production` 服务全量 `45/45` 业务/UI 端到端回归、`test-round1..4`、Playwright 客户/账户/自动定价 UI 验真与结构化 JSON 日志校验（本地工作分支 `feat/enterprise-upgrade` 待推送前终审后推远端）。

---

## 3. 真实执行过的验证命令与最终结果

以下全部命令均在最终代码修改完成后真实执行并记录实际输出（未跳过或削弱任何现有测试断言）：

| 验证项 | 执行命令 | 真实结果 |
| --- | --- | --- |
| 依赖安全审计 | `npx pnpm audit --audit-level=high` | `No known vulnerabilities found` (exit 0) |
| 代码规范检查 | `npx pnpm run lint` (`eslint server electron web/js`) | 0 errors, 0 warnings (exit 0) |
| 严格类型检查 | `npx pnpm run typecheck` (`tsc --noEmit -p server/tsconfig.json`) | 0 errors (exit 0) |
| 全仓代码风格检查 | `npx pnpm run format:check` | `All matched files use Prettier code style!` (exit 0) |
| 后端生产编译 | `npx pnpm run build` | 编译成功至 `dist/server/` (exit 0) |
| 单元测试套件 | `npx pnpm run test:unit` | **`22 / 22` PASS**（`baseline` 10 + `enterprise-hardening` 9 + `observability` 3） |
| HTTP 集成测试 | `npx pnpm run test:integration` | **`13 / 13` PASS**（`enterprise-api` 11 + `health-observability` 2） |
| Dockerfile 拷贝集安装校验 | 独立临时目录仅复制 `package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc` 执行 `npx pnpm install --frozen-lockfile --offline --ignore-scripts` | `Done in 209ms using pnpm v12.23.0` (exit 0) |
| 生产模式迁移与幂等种子 CLI | `NODE_ENV=production ORANGE_DATA_DIR=<tmp>`（无 `ORANGE_JWT_SECRET`）执行 `node tools/db-migrate.cjs` + 弱口令拦截校验 + `node tools/db-seed.cjs` (2 次) | `V1..V3` 迁移完成；弱口令被拒（exit 1）；首次写入 `teamId=1`、`startPeriod=202611`、`默认分类`，未生成 `.jwt-secret`；第二次幂等跳过 |
| 全量业务与 Playwright UI 回归 | 启动隔离服务 `NODE_ENV=production PORT=7749 LOG_FORMAT=json node dist/server/index.js`，执行 `NODE_ENV=production OC_BASE=http://127.0.0.1:7749/api node tools/run-tests.cjs` | **`聚合结果：通过 45 / 45，全部通过`**（注：`test-doc-import-robust.cjs` 因 Linux 沙箱无 PowerShell 且无 `.tools/import-test/real.xlsx` 内部跳过 2 项并输出 `通过 19 / 19，跳过 2`；GBK CSV 已在 `test-xlsx-limit-batch3` 与 `test-round2` 实测通过） |
| 对抗与端到端专项测试集 | 在同一 `production` 隔离服务上 `node tools/rebuild-clean.cjs` 后依次执行 `test-round1..4` | `test-round1` **`25 / 25`**、`test-round2` **`26 / 26`**、`test-round3` **`39 / 39`**、`test-round4` **`24 / 24`** (全部 exit 0) |
| Playwright 重点页面与结构化 JSON 日志校验 | Playwright 验证客户标签/编辑、账户类型兜底展示、`wholePrice` 自动带价 (`98`) 与零报错；检查生产服务端 `LOG_FORMAT=json` 日志 | `consoleErrors: 0, pageErrors: 0, failedResponses: 0`；`total_json=1987, with_requestId=1986, with_team_user=1838, secret_leaks=0` |
| `master..HEAD` 静态审计 | 扫描全部变更/新增文件的 `TODO/FIXME/NotImplemented/@ts-ignore/eslint-disable`、`any`、`Math.random` | 仅文档规范描述与前端 `01-api.js` 浏览器兼容 fallback 命中，服务端业务代码 0 违规 |

### 未能在本环境实测的项目（如实披露）
1. **Docker 镜像构建与 Compose 启动 (`Dockerfile` / `docker-compose.yml`)**：当前执行环境中未安装 Docker CLI / 守护进程（`no-docker`），仅在本地离线沙箱实测了 `Dockerfile` `COPY` 文件清单与 `pnpm install --frozen-lockfile --offline --ignore-scripts` 安装流程，尚未执行 `docker build` / `docker compose up`，需在具备 Docker 引擎的主机执行一次 `docker compose up -d --build` 并核验 `/health` 与 `/ready`。
2. **GitHub Actions CI (`ci.yml`) 远端 Runner**：已在本地完整跑通全部 CI 步骤命令，尚未在 GitHub Actions `ubuntu-latest` 上实际触发。
3. **Electron 桌面 GUI 托盘与 Windows 安装包构建**：当前为无桌面图形界面的 Linux 沙箱且无 Windows NSIS 工具链，未实测 `pnpm run dev:electron` 托盘交互及 `pnpm run dist:electron`。

---

## 4. 需要您人工补充与切换的配置清单

1. **配置生产高强签名密钥**：在生产 `.env` 或容器编排变量中显式配置 `ORANGE_JWT_SECRET`（至少 32 位高随机度字符串，可用 `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` 生成），严禁复用演示或占位密钥。
2. **反向代理与 HTTPS 安全参数**：若部署在 Nginx / Caddy / Cloudflare Tunnel 等反向代理后，务必设置：
   - `ORANGE_ALLOW_HOSTS=<你的域名>`（防止触发 `421` Host 拦截与跨站 `403`）
   - `ORANGE_TRUST_PROXY=1`
   - `ORANGE_COOKIE_SECURE=auto`（全站强制 HTTPS 时建议设为 `1`）
3. **容器宿主机部署验证**：在您的 Docker 主机拉取 `feat/enterprise-upgrade` 后，配置 `.env` 并执行 `docker compose up -d --build`，确认 `curl -fsS http://127.0.0.1:7741/ready` 返回 `status: "ready"`。
4. **异地离线备份调度**：应用内「立即备份」默认保留最近 30 份于数据卷 `<ORANGE_DATA_DIR>/backups/`（可通过 `BACKUP_KEEP_COUNT` 调整，1–365）。生产环境请增加宿主机定时任务将卷中最新 `backup-*.db` 同步到异地对象存储或离线磁盘。
5. **（仅 Electron 桌面分发时）**：如后续需要消除 Windows SmartScreen 警告，请在 GitHub Secrets 中补充企业代码签名证书配置并更新 `.github/workflows/release.yml`；演示环境预设管理员 `admin / B2cost!9Xq` 仅用于本地测试，正式账套切勿使用。
