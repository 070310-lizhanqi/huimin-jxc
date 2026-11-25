import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { hashPassword, issueToken, mountAuth, requireAuth, verifyPassword, verifyToken } from '../src/auth';
import { nextBillNo } from '../src/bill-no';
import {
  ConfigError,
  initConfig,
  loadDotEnv,
  parseDotEnv,
  resetConfigForTest,
  validateConfig,
} from '../src/config/env';
import { mountCrud } from '../src/crud';
import { localDate, migrate, openDb, tryCheckpoint, validBizDate } from '../src/db';
import { mountDocs } from '../src/docs';
import { mountPriceMemory } from '../src/price';
import { mountSettlements } from '../src/settlement';
import { mountStockQueries } from '../src/stock';
import { excelSerialToDate, readCsv, readSpreadsheet } from '../src/xlsxlite';

const LEGACY_LOCAL_SECRET = ['huimin', 'clone', 'local', 'secret', 'v1'].join('-');

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('Phase 2 Baseline Characterization Suite', () => {
  const savedEnv = { ...process.env };
  const tempDirs: string[] = [];

  before(() => {
    process.env.ORANGE_ENV_FILE = '';
    process.env.ORANGE_JWT_SECRET = crypto.randomBytes(32).toString('hex');
    resetConfigForTest();
    initConfig({ persistSecret: false });
  });

  after(() => {
    resetConfigForTest();
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, val] of Object.entries(savedEnv)) {
      process.env[key] = val;
    }
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('config/env validation', () => {
    it('loads valid development defaults with ephemeral secret when persistSecret=false', () => {
      const tmp = createTempDir('jxc-env-');
      tempDirs.push(tmp);
      const cfg = validateConfig({ NODE_ENV: 'development', ORANGE_DATA_DIR: tmp }, { persistSecret: false });
      assert.equal(cfg.nodeEnv, 'development');
      assert.equal(cfg.port, 7741);
      assert.equal(cfg.bindHost, '127.0.0.1');
      assert.equal(cfg.isLoopbackBind, true);
      assert.equal(cfg.dataDir, path.resolve(tmp));
      assert.equal(cfg.dbPath, path.join(path.resolve(tmp), 'huimin-clone.db'));
      assert.equal(cfg.jwtSecretSource, 'ephemeral');
      assert.ok(cfg.jwtSecret.length >= 64);
    });

    it('persists and reuses local .jwt-secret in loopback dev mode', () => {
      const tmp = createTempDir('jxc-secret-');
      tempDirs.push(tmp);
      const warnings: string[] = [];
      const cfg1 = validateConfig({ ORANGE_DATA_DIR: tmp }, { persistSecret: true, warn: (m) => warnings.push(m) });
      const cfg2 = validateConfig({ ORANGE_DATA_DIR: tmp }, { persistSecret: true, warn: (m) => warnings.push(m) });
      assert.equal(cfg1.jwtSecretSource, 'persisted');
      assert.equal(cfg1.jwtSecret, cfg2.jwtSecret);
      assert.ok(warnings.length >= 1);
      const secretPath = path.join(tmp, '.jwt-secret');
      assert.ok(fs.existsSync(secretPath));
      if (process.platform !== 'win32') {
        const mode = fs.statSync(secretPath).mode & 0o777;
        assert.equal(mode, 0o600);
      }
    });

    it('fails fast on missing, short, low-entropy, or legacy secret in strict modes', () => {
      const tmp = createTempDir('jxc-strict-');
      tempDirs.push(tmp);

      assert.throws(() => validateConfig({ NODE_ENV: 'production', ORANGE_DATA_DIR: tmp }), ConfigError);
      assert.throws(() => validateConfig({ ORANGE_REQUIRE_SECRET: '1', ORANGE_DATA_DIR: tmp }), ConfigError);
      assert.throws(() => validateConfig({ ORANGE_BIND: '0.0.0.0', ORANGE_DATA_DIR: tmp }), ConfigError);
      assert.throws(
        () => validateConfig({ NODE_ENV: 'production', ORANGE_JWT_SECRET: 'short', ORANGE_DATA_DIR: tmp }),
        ConfigError,
      );
      assert.throws(
        () => validateConfig({ NODE_ENV: 'production', ORANGE_JWT_SECRET: 'a'.repeat(40), ORANGE_DATA_DIR: tmp }),
        ConfigError,
      );
      assert.throws(
        () => validateConfig({ NODE_ENV: 'development', ORANGE_JWT_SECRET: LEGACY_LOCAL_SECRET, ORANGE_DATA_DIR: tmp }),
        ConfigError,
      );
    });

    it('rejects invalid port, nodeEnv, log settings, and backup retention ranges', () => {
      const tmp = createTempDir('jxc-bad-');
      tempDirs.push(tmp);
      const validSecret = crypto.randomBytes(32).toString('hex');

      for (const badPort of ['0', '65536', 'abc', '7741.5', '-1']) {
        assert.throws(
          () => validateConfig({ PORT: badPort, ORANGE_JWT_SECRET: validSecret, ORANGE_DATA_DIR: tmp }),
          ConfigError,
        );
      }
      assert.throws(
        () => validateConfig({ NODE_ENV: 'staging', ORANGE_JWT_SECRET: validSecret, ORANGE_DATA_DIR: tmp }),
        ConfigError,
      );
      assert.throws(
        () => validateConfig({ LOG_LEVEL: 'trace', ORANGE_JWT_SECRET: validSecret, ORANGE_DATA_DIR: tmp }),
        ConfigError,
      );
      assert.throws(
        () => validateConfig({ BACKUP_KEEP_COUNT: '500', ORANGE_JWT_SECRET: validSecret, ORANGE_DATA_DIR: tmp }),
        ConfigError,
      );
    });

    it('parses .env files without overwriting existing process environment variables', () => {
      const tmp = createTempDir('jxc-dotenv-');
      tempDirs.push(tmp);
      const envPath = path.join(tmp, '.env');
      fs.writeFileSync(
        envPath,
        [
          '# comment',
          'PORT=8899',
          'export LOG_LEVEL="warn" # inline comment',
          "ORANGE_ALLOW_HOSTS='erp.local,api.local'",
        ].join('\n'),
        'utf8',
      );
      const parsed = parseDotEnv(fs.readFileSync(envPath, 'utf8'));
      assert.equal(parsed.PORT, '8899');
      assert.equal(parsed.LOG_LEVEL, 'warn');
      assert.equal(parsed.ORANGE_ALLOW_HOSTS, 'erp.local,api.local');

      const target: NodeJS.ProcessEnv = { PORT: '7700' };
      assert.equal(loadDotEnv({ envPath, targetEnv: target }), true);
      assert.equal(target.PORT, '7700');
      assert.equal(target.LOG_LEVEL, 'warn');
    });
  });

  describe('auth cryptographic primitives', () => {
    it('hashes and verifies scrypt passwords cleanly', async () => {
      const hash = await hashPassword('StrongPass!2026');
      assert.ok(hash.startsWith('scrypt$'));
      assert.equal(await verifyPassword('StrongPass!2026', hash), true);
      assert.equal(await verifyPassword('WrongPass!2026', hash), false);
      assert.equal(await verifyPassword('StrongPass!2026', 'invalid-format'), false);
    });

    it('issues and verifies HMAC tokens and rejects tampered payloads', () => {
      const token = issueToken({ userId: 7, teamId: 3, role: 'admin', name: 'boss', ver: 1 });
      const claims = verifyToken(token);
      assert.ok(claims);
      assert.equal(claims.userId, 7);
      assert.equal(claims.teamId, 3);
      assert.equal(claims.role, 'admin');

      const [body, sig] = token.split('.');
      const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
      decoded.teamId = 999;
      const forged = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${sig}`;
      assert.equal(verifyToken(forged), null);
      assert.equal(verifyToken('malformed-token'), null);
    });
  });

  describe('database, date, billNo, and spreadsheet primitives', () => {
    it('migrates isolated SQLite DB idempotently and enforces core date/billNo invariants', () => {
      const tmp = createTempDir('jxc-db-');
      tempDirs.push(tmp);
      const db = openDb(path.join(tmp, 'test.db'));
      try {
        migrate(db);
        migrate(db);
        const tables = (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
        ).map((r) => r.name);
        for (const reqTable of ['team', 'user', 'product', 'doc', 'doc_item', 'stock', 'stock_ledger', 'settlement']) {
          assert.ok(tables.includes(reqTable), `missing table ${reqTable}`);
        }
        assert.equal(tryCheckpoint(db), true);

        const info = db.prepare("INSERT INTO team (name, startPeriod) VALUES ('测试账套', '2026-01-01')").run();
        const teamId = Number(info.lastInsertRowid);
        const no1 = nextBillNo(db, teamId, 'stockin');
        const no2 = nextBillNo(db, teamId, 'stockin');
        assert.notEqual(no1, no2);
        assert.ok(no1.startsWith('RK'));
      } finally {
        db.close();
      }

      assert.match(localDate(), /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(validBizDate('2026-02-28'), null);
      assert.notEqual(validBizDate('2026-02-30'), null);
      assert.notEqual(validBizDate('1999-12-31'), null);
    });

    it('parses UTF-8 BOM CSV with quotes and rejects invalid binary buffers', () => {
      const csvBuf = Buffer.from('\uFEFF商品名称,数量,备注\n"苹果,红富士",1.25,"含""引号"""\n', 'utf8');
      const parsed = readCsv(csvBuf);
      assert.equal(parsed.rows.length, 2);
      assert.deepEqual(parsed.rows[1], ['苹果,红富士', '1.25', '含"引号"']);

      assert.equal(excelSerialToDate(45306), '2024-01-15');
      assert.equal(excelSerialToDate(10), null);
      assert.throws(() => readSpreadsheet(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06])));
    });
  });

  describe('HTTP characterization: stockin -> audit -> stockout -> void -> settlement', () => {
    it('preserves FIFO stock, void reversal, and partner balance invariants via HTTP API', async () => {
      const tmp = createTempDir('jxc-http-');
      tempDirs.push(tmp);
      const db = openDb(path.join(tmp, 'app.db'));
      migrate(db);

      const app = express();
      app.use(express.json());
      const api = express.Router();
      mountAuth(api, db);
      api.use(requireAuth);
      mountCrud(api, db, { table: 'product', fields: ['name', 'unit', 'salePrice', 'purchasePrice'] });
      mountCrud(api, db, { table: 'warehouse', fields: ['name'] });
      mountCrud(api, db, { table: 'customer', fields: ['name'] });
      mountCrud(api, db, { table: 'vendor', fields: ['name'] });
      mountCrud(api, db, { table: 'account', fields: ['name', 'type'] });
      mountDocs(api, db);
      mountStockQueries(api, db);
      mountSettlements(api, db);
      mountPriceMemory(api, db);
      app.use('/api', api);

      const server: http.Server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
      });

      try {
        const port = (server.address() as AddressInfo).port;
        const base = `http://127.0.0.1:${port}/api`;

        const reqJson = async <T>(p: string, method = 'GET', body?: unknown, token?: string): Promise<T> => {
          const headers: Record<string, string> = {};
          if (body !== undefined) headers['content-type'] = 'application/json';
          if (token) headers.authorization = `Bearer ${token}`;
          const res = await fetch(`${base}${p}`, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
          });
          const data = (await res.json()) as T & { error?: string };
          assert.equal(res.ok, true, `${method} ${p} failed (${res.status}): ${JSON.stringify(data)}`);
          return data;
        };

        const reg = await reqJson<{ token: string; user: { teamId: number } }>('/auth/register', 'POST', {
          username: 'boss01',
          password: 'ValidPass!2026',
          teamName: '基线账套',
        });
        const tok = reg.token;

        const wh = await reqJson<{ id: number }>('/warehouse', 'POST', { name: '主仓库' }, tok);
        const ven = await reqJson<{ id: number }>('/vendor', 'POST', { name: '测试供应商' }, tok);
        const cus = await reqJson<{ id: number }>('/customer', 'POST', { name: '测试客户' }, tok);
        const acc = await reqJson<{ id: number }>(
          '/account',
          'POST',
          { name: '现金账户', type: 'cash', balance: 0 },
          tok,
        );

        const prod = await reqJson<{ id: number }>(
          '/product',
          'POST',
          { name: '测试矿泉水', unit: '箱', purchasePrice: 2000, salePrice: 3000 },
          tok,
        );

        // 入库单（赊购 10 箱 * 20.00 元 = 20000 分），审核后应增库存且增供应商应付 20000 分
        const inDoc = await reqJson<{ id: number }>(
          '/doc/create',
          'POST',
          {
            type: 'stockin',
            date: '2026-03-01',
            warehouseId: wh.id,
            partnerType: 'ven',
            partnerId: ven.id,
            items: [{ productId: prod.id, qty: 10, price: 2000 }],
          },
          tok,
        );
        await reqJson('/doc/audit', 'POST', { id: inDoc.id }, tok);

        const stockAfterIn = await reqJson<Array<{ productId: number; qty: number }>>(
          '/stock/list',
          'GET',
          undefined,
          tok,
        );
        const prodStock = stockAfterIn.find((s) => s.productId === prod.id);
        assert.equal(prodStock?.qty, 10);

        const bals1 = await reqJson<Array<{ partnerType: string; partnerId: number; balance: number }>>(
          '/partner/balance',
          'GET',
          undefined,
          tok,
        );
        const venBal1 = bals1.find((b) => b.partnerType === 'ven' && b.partnerId === ven.id);
        assert.equal(venBal1?.balance, 20000);

        // 销售出库 3 箱 * 30.00 元 = 9000 分
        const outDoc = await reqJson<{ id: number }>(
          '/doc/create',
          'POST',
          {
            type: 'stockout',
            date: '2026-03-02',
            warehouseId: wh.id,
            partnerType: 'cus',
            partnerId: cus.id,
            items: [{ productId: prod.id, qty: 3, price: 3000 }],
          },
          tok,
        );
        await reqJson('/doc/audit', 'POST', { id: outDoc.id }, tok);

        const stockAfterOut = await reqJson<Array<{ productId: number; qty: number }>>(
          '/stock/list',
          'GET',
          undefined,
          tok,
        );
        assert.equal(stockAfterOut.find((s) => s.productId === prod.id)?.qty, 7);

        // 收款冲减客户应收 5000 分
        await reqJson(
          '/settlement/create',
          'POST',
          {
            type: 'receipt',
            partnerType: 'cus',
            partnerId: cus.id,
            amount: 5000,
            accountId: acc.id,
            date: '2026-03-02',
          },
          tok,
        );
        const bals2 = await reqJson<Array<{ partnerType: string; partnerId: number; balance: number }>>(
          '/partner/balance',
          'GET',
          undefined,
          tok,
        );
        const cusBal = bals2.find((b) => b.partnerType === 'cus' && b.partnerId === cus.id);
        assert.equal(cusBal?.balance, 4000);

        // 作废出库单，库存应精准冲回至 10
        await reqJson('/doc/void', 'POST', { id: outDoc.id }, tok);
        const stockAfterVoid = await reqJson<Array<{ productId: number; qty: number }>>(
          '/stock/list',
          'GET',
          undefined,
          tok,
        );
        assert.equal(stockAfterVoid.find((s) => s.productId === prod.id)?.qty, 10);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        db.close();
      }
    });
  });
});
