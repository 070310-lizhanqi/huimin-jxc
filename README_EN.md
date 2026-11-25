# Zhanhui JXC (展惠进销存)

[中文](README.md) | [English](README_EN.md) | [Architecture](ARCHITECTURE.md)

An enterprise-hardened inventory, purchasing, sales, stock, and cash-settlement management system for small wholesale and retail businesses: master data catalog, purchase receiving, sales shipping, transfers, stocktaking, FIFO batch costing, receipts/payments, reconciled reports, and audit logging.

**v0.5.3** · **MIT License** · SQLite WAL transactional consistency · Zero external database · Offline zero-build frontend · Docker & Electron ready

---

## Screenshots

![Dashboard](docs/01-dashboard.png)
*Dashboard: stock / cash overview, low-stock alerts, and 14-day in/out trend*

![Sales shipping document](docs/02-doc-sales.png)
*Sales shipment list: audited shipments, receipt status, and totals*

![Stock lookup](docs/03-stock.png)
*Stock lookup: real-time inventory by warehouse + product with low-stock indicators*

![Receipts and payments](docs/04-settlement.png)
*Receipts and payments: receivable/payable totals, settlements, and partner balances*

![Sales statistics report](docs/05-report.png)
*Sales statistics report: amounts, quantities, document counts, and gross profit*

![Customer aging](docs/06-aging.png)
*Customer aging: receivables bucketed by age to locate overdue balances*

---

## Highlights & Enterprise Hardening

- **Exact monetary & quantity math**: amounts stored as integer cents and quantities scaled to 4 decimal places (`QTY_SCALE = 10_000`) via `server/src/shared/money.ts`; document auditing, void reversals, transfers, stocktakes, and settlements run inside `BEGIN IMMEDIATE` transactions (`withImmediateTx`) with FIFO batch tracking to prevent overselling and float drift.
- **Structured errors & idempotency**: unified `AppError` hierarchy returning `{ error, code, requestId }`, malformed JSON normalization (`400 BAD_JSON`), and 24-hour persistent `Idempotency-Key` enforcement on document creation and settlements (`409` on payload mismatch).
- **Security & RBAC**: scrypt password hashing, HMAC-SHA256 tokens (`HttpOnly; SameSite=Lax` cookie + Bearer support), persistent token revocation, workspace `teamId` isolation, DNS-rebinding Host allowlist, CSRF Origin check for cookie-authenticated mutations, admin RBAC guards, and queryable `audit_log` (`GET /api/audit-logs`).
- **Versioned migrations & hot backups**: `schema_migrations` tracking (`V1`–`V3`), `db:migrate` / `db:seed` CLI tools, pre-restore SQLite integrity validation, and `VACUUM INTO` hot backups that preserve SQLite POSIX `fcntl` WAL locks.
- **Observability & deployment**: structured JSON/pretty logger with `AsyncLocalStorage` `requestId` correlation and recursive secret/token redaction, unauthenticated `/health` & `/ready` probes, multi-stage non-root `Dockerfile`, `docker-compose.yml`, and GitHub Actions CI.

---

## Requirements

- **Node.js >= 22.5** (Node 24 LTS recommended; uses built-in `node:sqlite`)
- **pnpm 10.x** (`lockfileVersion 9.0`)
- **Docker / Docker Compose** (optional, for containerized deployment)

---

## Environment Configuration

Copy `.env.example` to `.env` before customizing (`.env` is gitignored). Startup configuration is strictly validated by `server/src/config/env.ts` and fails fast on invalid values.

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `PORT` | `7741` | HTTP listening port (`1`–`65535`) |
| `ORANGE_BIND` | `127.0.0.1` | Bind address. Setting a non-loopback address (`0.0.0.0`) enforces a strong `ORANGE_JWT_SECRET` |
| `ORANGE_DATA_DIR` | `./data` | Directory holding `huimin-clone.db`, `backups/`, and local `.jwt-secret` |
| `ORANGE_DB_PATH` | `<ORANGE_DATA_DIR>/huimin-clone.db` | Optional explicit SQLite DB file path override |
| `ORANGE_JWT_SECRET` | Auto-persisted CSPRNG in loopback dev | Signing secret (>= 32 chars, high entropy). **Mandatory** when `NODE_ENV=production`, `ORANGE_REQUIRE_SECRET=1`, or `ORANGE_BIND` is non-loopback |
| `ORANGE_REQUIRE_SECRET` | `0` | Set `1` to forbid ephemeral/auto-persisted secret fallback |
| `ORANGE_ALLOW_HOSTS` | Empty | Comma-separated extra allowed `Host` domains for reverse proxies or tunnels |
| `ORANGE_COOKIE_SECURE` | `0` | Cookie `Secure` attribute: `0` \| `1` \| `auto` (`auto` follows `X-Forwarded-Proto=https`) |
| `ORANGE_TRUST_PROXY` | `0` | Set `1` behind TLS-terminating reverse proxies to trust `X-Forwarded-*` headers |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `LOG_FORMAT` | `pretty` (`json` in `production`) | `pretty` \| `json` |
| `BACKUP_KEEP_COUNT` | `30` | Retained rolling backup snapshots (`1`–`365`) |

Generate a strong secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Quick Start

### 1. Local Development & Source Run

```bash
pnpm install
cp .env.example .env

pnpm run build

# Optional: apply migrations and seed an initial workspace/admin user
pnpm run db:migrate
SEED_ADMIN_PASS='YourStrongPass!2026' pnpm run db:seed

pnpm run serve
# Or ts-node dev mode: pnpm run dev:server
```

Open <http://127.0.0.1:7741>. On an empty database, the app prompts you to initialize the first workspace and administrator account. For demo exploration, `node tools/rebuild-clean.cjs` populates sample fresh-fruit wholesale data with demo credentials `admin / B2cost!9Xq` (**demo only; never use in production**).

### 2. Docker Production Deployment

```bash
cat > .env << 'EOF'
ORANGE_JWT_SECRET=<32+ char hex secret>
ORANGE_ALLOW_HOSTS=localhost,127.0.0.1,jxc.example.com
ORANGE_COOKIE_SECURE=auto
ORANGE_TRUST_PROXY=1
LOG_FORMAT=json
LOG_LEVEL=info
EOF

docker compose up -d --build
curl -fsS http://127.0.0.1:7741/health
curl -fsS http://127.0.0.1:7741/ready
```

### 3. Electron Desktop Shell

```bash
pnpm run build && pnpm run dev:electron
```

See [`.github/workflows/release.yml`](.github/workflows/release.yml), [`docs/deployment.md`](docs/deployment.md), and [`ARCHITECTURE.md`](ARCHITECTURE.md) for Windows packaging and operational details.

---

## Verification & Test Commands

```bash
pnpm run lint                  # ESLint across server / electron / web/js
pnpm run typecheck             # TypeScript strict check (noEmit)
pnpm run format:check          # Prettier style verification
pnpm run build                 # Compile TypeScript backend to dist/
pnpm run test:unit             # Unit & characterization tests
pnpm run test:integration      # In-process HTTP integration suites
pnpm audit --audit-level=high  # Dependency vulnerability check

# Full 45-script API & Playwright E2E suite (expects server listening on 7741)
node tools/run-tests.cjs
node tools/run-tests.cjs --with-rounds   # Includes 4 adversarial round suites (49 total)
```

---

## Attribution & License

"Zhanhui JXC" references the "惠民云" inventory workflow with an independent original codebase. Legacy `ORANGE_*` environment variables and old data directory migration paths remain solely as upgrade compatibility anchors. See [NOTICE.md](NOTICE.md) and [LICENSE](LICENSE).
