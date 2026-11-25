# 展惠进销存系统架构设计（ARCHITECTURE.md）

本文档说明 `zhanhui-jxc`（展惠进销存）在企业级重构后的模块分层、核心业务数据流、安全边界、并发与数据可靠性设计，以及生产运维排障指南。

---

## 1. 系统边界与总体架构

本系统面向单团队/多用户自托管（本机桌面 Electron 托管或容器化/反向代理 HTTP 服务），坚持 **SQLite WAL 单机事务强一致性 + 零外部中间件 + 零构建前端** 的务实架构：

```text
+--------------------------+        HTTPS / HTTP        +----------------------------------------+
|  浏览器 / Electron 桌面  | -------------------------> | Express 4 + 异步 Gzip + 安全中间件链路  |
|  web/ (Vue3 + ElPlus)    |   Cookie (oc_token) /      |  1. requestIdMiddleware (ALS 上下文)    |
+--------------------------+   Bearer + X-Request-Id    |  2. requestLoggingMiddleware (脱敏日志) |
                                                        |  3. hostGuardMiddleware (防 DNS Rebind) |
                                                        |  4. corsMiddleware + securityHeaders    |
                                                        |  5. csrfOriginGuardMiddleware           |
                                                        +--------------------+-------------------+
                                                                             |
                    +--------------------------------------------------------+-----------------------------------+
                    | 公开探针 (/health, /ready, /api/health, /api/ready)     | /api/* (requireAuth + teamId 隔离) |
                    v                                                        v
          [routes/health.ts]                                  +------------------------------------+
          (存活 / DB 连通性 / 迁移版本)                       |       路由与控制器层 (routes/)      |
                                                              |  auth / docs / archives / audit /  |
                                                              |  settlement / stock / reports      |
                                                              +-----------------+------------------+
                                                                                | 调用强校验与业务服务
                                                                                v
                                                              +------------------------------------+
                                                              |         领域服务层 (services/)      |
                                                              |  doc-service / stock-service /     |
                                                              |  product-import-service /          |
                                                              |  shared/money (分/万分比精确运算)   |
                                                              +-----------------+------------------+
                                                                                | withImmediateTx / 幂等键 / 审计写入
                                                                                v
                                                              +------------------------------------+
                                                              |  基础设施与数据层 (infra/ + db.ts)  |
                                                              |  validate / errors / tx / logger / |
                                                              |  idempotency / audit-log / backup  |
                                                              +-----------------+------------------+
                                                                                |
                                                                                v
                                                              +------------------------------------+
                                                              |  SQLite (node:sqlite, WAL 模式)    |
                                                              |  <ORANGE_DATA_DIR>/huimin-clone.db |
                                                              +------------------------------------+
```

---

## 2. 后端分层职责 (`server/src/`)

| 层级 | 目录/文件 | 职责边界 |
| --- | --- | --- |
| 入口与装配 | `index.ts`, `app.ts` | 初始化校验配置 (`initConfig`)、挂载生命周期钩子（单实例锁 `server.lock`、`port.txt`、异步 `gzip`、`/api/admin/shutdown`、`SIGTERM`/`SIGINT` 优雅停机）；`createApp` 工厂与端口解耦以支持集成测试 |
| 配置与安全基线 | `config/env.ts` | 零依赖 `.env` 加载、全部环境变量严格校验并快速失败（`ConfigError`）；生产/非回环绑定/`ORANGE_REQUIRE_SECRET=1` 强制要求强随机 `ORANGE_JWT_SECRET`，拒绝弱口令或历史占位符 |
| 基础设施层 (`infra/`) | `errors.ts`, `validate.ts`, `tx.ts`, `logger.ts`, `audit-log.ts`, `idempotency.ts` | 标准 `AppError` 异常体系与 `{ error, code, requestId }` 统一出口；严格参数解析（正整数、业务日期、枚举、数量、整数分金额）；`withImmediateTx`（含 `SQLITE_BUSY` -> 503 与安全回滚）；结构化日志与递归脱敏 + `AsyncLocalStorage` 请求追踪；`audit_log` 持久化；24h 幂等键防重放 |
| 中间件 (`middleware/`) | `security.ts`, `rbac.ts` | `X-Request-Id` 与日志上下文绑定、Host 白名单守卫（位于 CORS 前拦截 DNS Rebinding）、Cookie 写操作 `CSRF Origin` 核验、基线安全响应头、RBAC `admin` 守卫 |
| 公共领域数学 (`shared/`) | `money.ts`, `csv.ts` | 数量统一按 4 位小数（`QTY_SCALE = 10_000`）整数化防浮点漂移；金额以整数**分**计算并采用四舍五入与按比例零误差整单折扣分摊；统一 CSV 安全转义防公式注入 |
| 领域服务 (`services/`) | `doc-service.ts`, `stock-service.ts`, `product-import-service.ts` | 单据建单/编辑/审核/作废/转换/批审状态机；库存原子扣减与 FIFO 批次消费、转仓、盘点差额与移动加权成本计算；商品批量导入预加载字典消除 N+1 |
| 路由层 (`routes/` 与域模块) | `routes/{health,docs,archives,audit}.ts`, `auth.ts`, `crud.ts`, `settlement.ts`, `docimport.ts`, `stock.ts`, `report.ts`, `aging.ts`, `jxc-report.ts`, `dashboard.ts`, `backup.ts`, `settings.ts`, `price.ts` | 请求解析、RBAC 权限校验、幂等键拦截、调用服务并返回 HTTP 响应；关键操作同步或异步落盘 `audit_log` |
| 持久化与迁移 | `db.ts`, `tools/db-migrate.cjs`, `tools/db-seed.cjs` | SQLite WAL 初始化、外键强制开启、版本化迁移表 `schema_migrations`（V1–V3）、独立 CLI 迁移与幂等种子脚本 |

---

## 3. 核心业务数据流

### 3.1 进销存单据状态机与原子过账

1. **草稿与待审**：`POST /api/doc/create` 支持 `Idempotency-Key`（24h 持久表 `idempotency_key` + canonical payload SHA-256 校验，载荷不一致返回 `409 CONFLICT`）及同内容防双击窗口保护；草稿 (`draft`) 与待审 (`pending`) **不修改库存表与往来余额**。
2. **原子审核 (`POST /api/doc/audit`)**：
   - 全部状态校验与过账动作包裹在 `BEGIN IMMEDIATE`（`withImmediateTx`）写锁事务内，杜绝并发双审、超卖竞态。
   - **出库类单据**先校验仓库总库存是否满足需求；对启用/存在批次的库存按入库时间先进先出（FIFO）扣减，并记录 `stock_ledger` 成本流水（报表按 `HIST_AVG_COST_SQL` 计算历史采购估算均价）；**盘点/调拨**原子更新源/目标仓库存并记录 `stock_ledger`。
   - 若单据附带现收/现付金额，事务内同步更新资金账户余额、生成自动关联 `settlement` 记录、计算客户/供应商 `partner_balance` 并刷新客户记忆价 `price_memory`。
3. **作废冲回 (`POST /api/doc/void`)**：
   - 锁内重读单据状态防止并发双作废。
   - 若原审核生成了自动结算且后续已被手工核销记录引用，或当前资金账户余额不足以冲回原自动收款，均拒绝作废并返回明确指引，避免出现负资金账户或孤立核销。
   - 对 FIFO 出库按 `stock_ledger` 原批次记录精准回滚，恢复盘点前库位、回退应收应付及账户余额，并记入 `audit_log`。

### 3.2 鉴权、多租户隔离与跨站防护

- **密码与口令**：使用 `node:crypto.scrypt`（随机盐 + 定长比较 `timingSafeEqual`）；新用户及改密强制密码复杂度检查；登录与注册按 IP + 账号维度施行失败冷却限速。
- **令牌与吊销**：HMAC-SHA256 签名载荷（`userId`、`teamId`、`role`、`ver`、`jti`、`exp`），通过 `HttpOnly; SameSite=Lax` Cookie (`oc_token`) 或显式 `Authorization: Bearer` 传递；注销持久化写入 `setting` 表（`teamId=0, key='auth.revoked'`）并重启恢复；改密递增 `ver` 使旧会话立即失效。
- **团队隔离**：`requireAuth` 解析令牌后强制覆盖 `req.query.teamId` 与 `req.body.teamId`，一切 SQL 查询均带 `teamId = ?` 条件。
- **CSRF 防护**：当请求使用 `oc_token` Cookie 鉴权、未携带 `Bearer` 且处于写方法（`POST`/`PUT`/`PATCH`/`DELETE`）时，`csrfOriginGuardMiddleware` 强制校验 `Origin` 必须匹配当前 Host 或 `ORANGE_ALLOW_HOSTS` 白名单。

### 3.3 SQLite WAL 在线热备份与 POSIX 锁保护

- 备份（`POST /api/backup/create`）与恢复前快照（`POST /api/backup/restore`）先执行 `PRAGMA wal_checkpoint(TRUNCATE)` 检查点并核验 `busy === 0 && checkpointed >= log`（忙则重试一次或拒绝备份，绝不静默备出缺帧文件）。
- **关键可靠性设计（Linux POSIX `fcntl` 锁保护）**：避免在运行期服务进程内对主库文件直接调用 `fs.copyFileSync(dbFilePath(), ...)`——在 Linux 上同进程打开并关闭主库任意 raw FD 会清除核内持有的 POSIX `fcntl` 字节范围锁，进而导致外部测试或工具连接在关闭时误判为“最后连接”而删除运行中服务的 `-wal`/`-shm` 引发读写分裂。本系统统一采用 SQLite 官方事务级在线快照语句 **`VACUUM INTO ?`** 生成独立紧凑单库文件。
- 恢复时先以只读临时副本运行 `PRAGMA integrity_check` 与关键业务表完整性检查，再写 `.restore-pending` 与 `pre-restore-*.db` 回滚备份，待进程优雅关库退出后由 `openDb()` 在启动阶段原子替换并支持自动失败回滚。

---

## 4. 数据库架构与版本化迁移 (`schema_migrations`)

迁移脚本由 `server/src/db.ts` 集中维护并在启动及 `pnpm run db:migrate` 时于 `BEGIN IMMEDIATE` 事务内幂等执行：

| 版本 | 迁移名 | 主要内容 |
| --- | --- | --- |
| `V1` | `001_baseline_schema` | 业务核心表（`team`, `user`, `cat`, `unit`, `warehouse`, `reservoir`, `account`, `clerk`, `product`, `customer`, `vendor`, `doc`, `doc_item`, `stock`, `stock_ledger`, `partner_balance`, `settlement`, `setting`, `bill_seq`）、列补齐及团队级唯一索引 |
| `V2` | `002_price_memory_schema` | 客户记忆价表 `price_memory(id, teamId, partnerId, productId, price, lastDate, times)` 与检索索引（从运行时建表迁入统一迁移链路） |
| `V3` | `003_audit_log_and_idempotency` | 操作审计日志表 `audit_log` 及 24 小时幂等缓存表 `idempotency_key` 与时间索引 |

---

## 5. 可观测性与健康检查

- **结构化日志 (`server/src/infra/logger.ts`)**：
  - 通过 `AsyncLocalStorage` 自动携带 `requestId`、`teamId`、`userId`；响应头与错误体均回传 `X-Request-Id`。
  - 通过 `LOG_LEVEL`（`debug`/`info`/`warn`/`error`）与 `LOG_FORMAT`（`pretty`/`json`）控制输出；生产环境默认 `json`。
  - 内置嵌套对象与字符串敏感字段脱敏（自动掩码 `password`/`token`/`secret`/`jwtSecret`/`authorization`/`cookie`/`inviteCode`/`apiKey` 及 `Bearer`、`oc_token=`）。
- **探针端点（无需鉴权）**：
  - `GET /health` 与 `GET /api/health`：进程存活性探针，返回版本号、PID、运行时长（`200 ok`）。
  - `GET /ready` 与 `GET /api/ready`：真实执行 `SELECT 1` 与 `getSchemaVersion(db)`，数据库就绪返回 `200 ready`，库关闭或不可用时返回 `503 SERVICE_UNAVAILABLE`（隐藏底层数据库异常明细）。

---

## 6. 常见运维与故障排查

| 现象 | 可能原因 | 排查与处理 |
| --- | --- | --- |
| 启动报 `ConfigError` 立刻退出 | `production` 环境 / 公网绑定 / `ORANGE_REQUIRE_SECRET=1` 下未设置强 `ORANGE_JWT_SECRET`，或端口/保留份数越界 | 按提示生成 ≥32 位高熵密钥并写入 `.env` 或容器环境变量；核对 `ORANGE_BIND`、`PORT`、`BACKUP_KEEP_COUNT` |
| 反向代理或域名访问返回 `421` | `Host` 头不在默认回环白名单内 | 将实际访问域名加入 `ORANGE_ALLOW_HOSTS`（逗号分隔）；若走 HTTPS 反代，同步设 `ORANGE_TRUST_PROXY=1` 与 `ORANGE_COOKIE_SECURE=auto` |
| 登录后刷新即掉线或写操作报 `403 跨站写请求已被拒绝` | HTTPS 反代但未开 `ORANGE_TRUST_PROXY=1`，或前端访问域名未加入 `ORANGE_ALLOW_HOSTS` | 确认反代透传 `Host` 与 `X-Forwarded-Proto`，并对齐 `ORANGE_ALLOW_HOSTS` |
| `/ready` 返回 `503` 或并发写入偶发 `503 SERVICE_UNAVAILABLE` | 数据库被占用或处于恢复退出流程 / 外部长连接锁定 WAL | 查看结构化日志 `requestId` 对应告警；若为恢复重启，等待重启助手完成替换即可自动恢复 |
| `备份已取消` (`WAL 检查点未完成`) | 外部进程持有长读或写事务导致 WAL 无法 truncate | 关闭外部直连 SQLite 工具（如 DB Browser）后重试备份 |
