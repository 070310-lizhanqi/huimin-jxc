# 部署指南（展惠进销存）

> 适用版本：v0.6.0 起（兼容 v0.5.3 升级，对齐 `server/src/config/env.ts` 企业级配置校验规范）。本文只讲部署与安全配置，业务操作请见 [使用手册](使用手册.md)，模块架构与故障排查见 [ARCHITECTURE.md](../ARCHITECTURE.md)。  
> 文中所有密钥均以占位符表示，**请勿把真实密钥写进文档、代码仓库、`.env.example`、聊天记录或工单**。

## 1. 先说结论：默认回环绑定与两档密钥策略

- 服务默认仅监听本机回环地址 `ORANGE_BIND=127.0.0.1`（`PORT=7741`），未显式修改绑定或架设反代时外网无法访问。
- 源码中**不存在任何硬编码默认密钥**（历史固定密钥、常见弱串、`your-secret` 等占位文本均被 `env.ts` 的 SHA-256 黑名单与熵校验直接拦截）。
- 签名密钥 `ORANGE_JWT_SECRET` 按运行模式分两档策略：
  1. **严格模式（必须显式提供强随机密钥，否则启动直接报错退出）**：满足以下任一条件即自动启用严格模式：
     - `NODE_ENV=production`（含容器 `Dockerfile` / `docker-compose.yml` 默认运行态）
     - `ORANGE_REQUIRE_SECRET=1`
     - `ORANGE_BIND` 为非本机回环地址（如 `0.0.0.0`、局域网 IP 等）
  2. **本机开发 / Electron 桌面零配置模式**（`NODE_ENV` 为 `development`/`test`、`ORANGE_REQUIRE_SECRET=0` 且绑定地址为回环地址）：
     - 若未设置 `ORANGE_JWT_SECRET`，服务端启动时自动使用 `crypto.randomBytes(32)` 生成 256 位随机密钥，以 `0600` 权限持久化到 `<ORANGE_DATA_DIR>/.jwt-secret` 并在重启间复用，同时在日志输出提示：`未设置 ORANGE_JWT_SECRET，已从本机密钥文件加载随机签名密钥（<dataDir>/.jwt-secret）；公网或生产部署请显式设置 ORANGE_JWT_SECRET。`

## 2. 生产 / 非本机部署前的必配项

### 2.1 生成并配置强随机 `ORANGE_JWT_SECRET`

生成 32 字节（64 位十六进制字符）的强随机密钥（每次运行都会生成不同密钥）：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

要求（由 `server/src/config/env.ts` 启动时强制校验）：

- 长度至少 **32 个字符**，包含至少 **6 种不同字符**（拒绝低熵重复串）；
- 禁止使用源码历史密钥、示例占位符（`your-secret` / `change-me` / `placeholder` / `example-secret`）；
- 每个部署环境独立生成，**只写入 `.env`（已被 `.gitignore` 忽略）或部署平台密钥管理**，不要提交到仓库。

配置方式（任选其一）：

```bash
# 方式 A：项目根目录 .env 文件（或通过 ORANGE_ENV_FILE 指定路径；进程已注入的环境变量优先级更高）
cat > .env << 'EOF'
NODE_ENV=production
ORANGE_BIND=0.0.0.0
ORANGE_JWT_SECRET=<替换为上述命令生成的 64 位随机十六进制串>
ORANGE_REQUIRE_SECRET=1
EOF
```

```powershell
# 方式 B：Windows PowerShell（当前会话有效）
$env:NODE_ENV="production"
$env:ORANGE_JWT_SECRET="<替换为生成的随机串>"
$env:ORANGE_REQUIRE_SECRET="1"
```

```bash
# 方式 C：Linux / macOS（当前会话有效）
export NODE_ENV=production
export ORANGE_JWT_SECRET="<替换为生成的随机串>"
export ORANGE_REQUIRE_SECRET=1
```

### 2.2 显式开启 `ORANGE_REQUIRE_SECRET=1`

虽然 `NODE_ENV=production` 与非回环 `ORANGE_BIND` 均已强制检查密钥，但仍建议在 `.env` 或编排配置中同时配置 `ORANGE_REQUIRE_SECRET=1`。这样即使在本地/测试脚本误用 `NODE_ENV=development` 跑起来时，也会因缺少 `ORANGE_JWT_SECRET` **立即快速失败**，不会悄悄生成或读取 `.jwt-secret`。

## 3. 公网 / 反向代理 / 内网穿透部署清单

按顺序核对全部条目后再开放访问：

1. **`ORANGE_JWT_SECRET` 与 `ORANGE_REQUIRE_SECRET=1` 已生效**：确认 `NODE_ENV=production` 或已配置强随机密钥（参考 `.env.example`）。
2. **绑定地址最小暴露**：
   - 若本机反代（Nginx / Caddy / Cloudflare Tunnel 与应用同机），保持 `ORANGE_BIND=127.0.0.1` 最安全；
   - 若容器部署或跨机反代，才设置为 `ORANGE_BIND=0.0.0.0` 并严格限制宿主机防火墙/安全组端口。
3. **Host 白名单（防 DNS Rebinding）**：设置 `ORANGE_ALLOW_HOSTS=jxc.example.com`（多域名逗号分隔），否则非回环 `Host` 请求将被拒绝返回 `421`。
4. **可信代理与 HTTPS Cookie**：
   - 若置于单层 HTTPS 反代（Nginx / Caddy）之后，设置 `ORANGE_TRUST_PROXY=1`（多级反代填实际跳数 `1..20`）和 `ORANGE_COOKIE_SECURE=auto`（全站强制 HTTPS 可设为 `1`）；
   - 未启用 `ORANGE_TRUST_PROXY` 时，服务端出于防伪造考虑会忽略 `X-Forwarded-For` 与 `X-Forwarded-Proto`。
5. **可观测性与备份**：
   - `NODE_ENV=production` 下默认 `LOG_FORMAT=json`（脱敏且携带 `requestId`），`LOG_LEVEL=info`；
   - 配置容器或监控平台探针检查 `GET /health`（存活性）与 `GET /ready`（数据库连通与迁移就绪）；
   - 配置宿主机定时任务将 `<ORANGE_DATA_DIR>/backups/` 下生成的备份同步至异地存储（`BACKUP_KEEP_COUNT` 默认 `30`，合法范围 `1–365`）。

启动后自查：

- 生产模式启动成功时，日志不会出现任何“加载本机 `.jwt-secret`”的提示；若缺失或弱密钥，进程会直接输出 `ConfigError` 并以退出码 `1` 终止。
- 执行 `curl -fsS http://127.0.0.1:7741/ready` 确认返回 `{"status":"ready",...}`。

## 4. 密钥轮换：旧令牌立即失效

- 会话令牌有效期为 7 天，签名密钥为 `ORANGE_JWT_SECRET`。
- **更换 `ORANGE_JWT_SECRET` 后，所有用旧密钥签发的令牌与 `oc_token` Cookie 立即失效**，全部已登录用户需重新登录。
- 适用场景：密钥疑似泄露、运维人员变动、或将开发期生成的 `.jwt-secret` 实例切换为正式生产配置。
- 操作步骤：停服务（或重启容器） → 更新为新随机密钥 → 启动服务 → 通知用户重新登录；如曾发生泄露，请同步检查设置页「操作审计」（`audit_log`）确认无异常写操作。

## 5. 端口与核心环境变量速查

- **端口**：优先读 `PORT`，未设置时兼容读取 `ORANGE_PORT`（默认 `7741`，合法整数 `1–65535`）。
- **数据库路径**：数据目录由 `ORANGE_DATA_DIR` 指定（默认 `./data`），主库默认 `<ORANGE_DATA_DIR>/huimin-clone.db`，也可由 `ORANGE_DB_PATH` 显式覆盖。
- 完整变量说明与默认值见仓库根目录 [`.env.example`](../.env.example) 与 [README.md](../README.md)。

## 6. 常见启动与代理故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 启动报错 `环境变量配置校验失败：当前为 production 环境，必须显式配置强随机 ORANGE_JWT_SECRET...` | 生产模式未设置 `ORANGE_JWT_SECRET`；按第 2.1 节生成 64 位随机串并写入环境 |
| 启动报错 `已启用 ORANGE_REQUIRE_SECRET=1，必须显式配置强随机 ORANGE_JWT_SECRET...` 或 `绑定地址为非本机回环地址...` | 严格校验模式或非回环绑定下缺少合法密钥；配置强密钥或恢复本机回环绑定 `127.0.0.1` |
| 启动报错 `ORANGE_JWT_SECRET 长度至少需要 32 个字符` / `不能使用源码示例或历史默认密钥` / `熵值过低` | 密钥未达到安全强度；使用 `crypto.randomBytes(32).toString('hex')` 重新生成 |
| 日志出现 `未设置 ORANGE_JWT_SECRET，已从本机密钥文件加载随机签名密钥` | 当前以非生产本机开发模式启动且未设环境变量；若为正式环境，请检查环境变量是否成功传入进程并设置 `NODE_ENV=production` |
| 反代/域名访问返回 `421` 或写操作报 `403 跨站写请求已被拒绝` | 访问域名未列入 `ORANGE_ALLOW_HOSTS`，或反代未透传 `Host` / `X-Forwarded-Proto`、未设 `ORANGE_TRUST_PROXY=1` |
| 换密钥后所有人被登出 | 预期安全行为（见第 4 节），通知用户重新登录即可 |
