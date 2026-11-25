import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { initConfig, resetConfigForTest, resolveStoragePaths, validateConfig } from '../src/config/env';
import { checkField, mountCrud } from '../src/crud';
import { getSchemaVersion, listAppliedMigrations, migrate, openDb } from '../src/db';
import { BusyError, expressErrorMiddleware } from '../src/infra/errors';
import { safeRollback, withImmediateTx } from '../src/infra/tx';
import {
  parseBizDateOptional,
  parseBizDateRequired,
  parseCents,
  parseEnum,
  parseNonEmptyString,
  parseOptionalPositiveInt,
  parsePositiveInt,
  parseQty,
} from '../src/infra/validate';
import { importProducts } from '../src/services/product-import-service';
import { allocateDocDiscounts, lineAmount, roundHalfAwayFromZero, roundQty, sumQty } from '../src/shared/money';

describe('Phase 3 Unit Tests: Money, Validation, Transactions, Migrations, Product Import', () => {
  const savedEnv = { ...process.env };
  const tempDirs: string[] = [];

  const mkTmp = (prefix: string): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(d);
    return d;
  };

  before(() => {
    process.env.ORANGE_ENV_FILE = '';
    process.env.ORANGE_JWT_SECRET = crypto.randomBytes(32).toString('hex');
    resetConfigForTest();
    initConfig({ persistSecret: false });
  });

  after(() => {
    resetConfigForTest();
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      process.env[k] = v;
    }
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('shared/money precision guarantees', () => {
    it('eliminates IEEE754 float drift on qty sums and line amounts', () => {
      assert.equal(sumQty([0.1, 0.2, 0.3]), 0.6);
      assert.equal(roundQty(0.1 + 0.2), 0.3);
      assert.equal(lineAmount(0.1, 3333), 333);
      assert.equal(lineAmount(0.15, 100), 15);
      assert.equal(roundHalfAwayFromZero(-1.5), -2);
      assert.equal(roundHalfAwayFromZero(1.5), 2);
      assert.equal(roundHalfAwayFromZero(-0.5), -1);
      // Negative symmetric rounding and zero without -0
      assert.equal(roundQty(-0.00005), -0.0001);
      assert.equal(roundQty(0.00005), 0.0001);
      assert.equal(sumQty([-0.00005, -0.00005]), -0.0002);
      assert.equal(sumQty([0.00005, 0.00005]), 0.0002);
      assert.equal(Object.is(roundQty(-0.00001), 0), true);
      assert.equal(Object.is(sumQty([-0.00001]), 0), true);
    });

    it('allocates document-level discounts across lines with exact cent conservation', () => {
      const lines = [
        { docId: 10, productId: 1, type: 'stockout', discount: 100, qty: 1, amount: 333 },
        { docId: 10, productId: 2, type: 'stockout', discount: 100, qty: 1, amount: 333 },
        { docId: 10, productId: 3, type: 'stockout', discount: 100, qty: 1, amount: 334 },
      ];
      const net = allocateDocDiscounts(lines);
      const totalNet = (net.get('10:1') ?? 0) + (net.get('10:2') ?? 0) + (net.get('10:3') ?? 0);
      assert.equal(totalNet, 900);
      assert.equal(net.get('10:1'), 300);
      assert.equal(net.get('10:2'), 300);
      assert.equal(net.get('10:3'), 300);
    });
  });

  describe('infra/validate schema primitives', () => {
    it('validates positive ints, non-empty strings, biz dates, enums, qty, and cents', () => {
      assert.deepEqual(parsePositiveInt('42', 'id'), { ok: true, value: 42 });
      assert.equal(parsePositiveInt('0', 'id').ok, false);
      assert.equal(parsePositiveInt('1.5', 'id').ok, false);
      assert.equal(parsePositiveInt('12abc', 'id').ok, false);

      assert.deepEqual(parseOptionalPositiveInt('', 'catId'), { ok: true, value: null });
      assert.equal(parseOptionalPositiveInt('-5', 'catId').ok, false);

      assert.deepEqual(parseNonEmptyString('  红富士  ', '名称', 20), { ok: true, value: '红富士' });
      assert.equal(parseNonEmptyString('   ', '名称', 20).ok, false);
      assert.equal(parseNonEmptyString(123, '名称', 20).ok, false);

      assert.equal(parseBizDateRequired('', '单据日期').ok, false);
      assert.equal(parseBizDateOptional('2026-02-30', '日期').ok, false);
      assert.deepEqual(parseBizDateRequired('2026-02-28', '日期'), { ok: true, value: '2026-02-28' });

      assert.deepEqual(parseEnum('bank', ['cash', 'bank'] as const, '类型'), { ok: true, value: 'bank' });
      assert.equal(parseEnum('crypto', ['cash', 'bank'] as const, '类型').ok, false);

      assert.equal(parseQty(0, '数量').ok, false);
      assert.deepEqual(parseQty(1.23456, '数量'), { ok: true, value: 1.2346 });
      assert.equal(parseCents(-1, '金额').ok, false);
      assert.deepEqual(parseCents(undefined, '金额', { defaultZero: true }), { ok: true, value: 0 });
    });
  });

  describe('infra/tx transaction safety & busy handling', () => {
    it('rolls back cleanly on business error without masking original exception and handles BusyError', () => {
      const tmp = mkTmp('jxc-tx-');
      const dbPath = path.join(tmp, 'tx.db');
      const db1 = openDb(dbPath);
      const db2 = new DatabaseSync(dbPath);
      try {
        db1.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
        assert.throws(() => {
          withImmediateTx(db1, () => {
            db1.prepare("INSERT INTO t (v) VALUES ('temp')").run();
            throw new Error('business_boom');
          });
        }, /business_boom/);
        const count = (db1.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c;
        assert.equal(count, 0);

        // safeRollback when no active tx must never throw
        assert.doesNotThrow(() => safeRollback(db1));

        // Simulate write lock held by db2 exceeding busy_timeout(0)
        db1.exec('PRAGMA busy_timeout = 10;');
        db2.exec("BEGIN IMMEDIATE; INSERT INTO t (v) VALUES ('lock');");
        try {
          assert.throws(() => withImmediateTx(db1, () => {}), BusyError);
        } finally {
          db2.exec('ROLLBACK;');
        }
      } finally {
        db2.close();
        db1.close();
      }
    });
  });

  describe('db versioned migrations', () => {
    it('tracks applied migrations V1..V3 and upgrades pre-existing legacy DB cleanly', () => {
      const tmp = mkTmp('jxc-mig-');
      const dbPath = path.join(tmp, 'legacy.db');
      const raw = new DatabaseSync(dbPath);
      raw.exec(`
        CREATE TABLE team (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, startPeriod TEXT NOT NULL);
        INSERT INTO team (name, startPeriod) VALUES ('老客户账套', '2025-01-01');
      `);
      raw.close();

      const db = openDb(dbPath);
      try {
        migrate(db);
        migrate(db);
        assert.equal(getSchemaVersion(db), 3);
        const applied = listAppliedMigrations(db);
        assert.deepEqual(
          applied.map((r) => r.version),
          [1, 2, 3],
        );
        const team = db.prepare('SELECT name FROM team WHERE id = 1').get() as { name: string };
        assert.equal(team.name, '老客户账套');
        const tables = (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
        ).map((t) => t.name);
        assert.ok(tables.includes('price_memory'));
        assert.ok(tables.includes('audit_log'));
        assert.ok(tables.includes('idempotency_key'));
      } finally {
        db.close();
      }
    });
  });

  describe('services/product-import-service partial success and limits', () => {
    it('imports valid products, auto-creates categories, and skips invalid rows safely', () => {
      const tmp = mkTmp('jxc-imp-');
      const db = openDb(path.join(tmp, 'imp.db'));
      try {
        migrate(db);
        const teamId = Number(
          db.prepare("INSERT INTO team (name, startPeriod) VALUES ('导入测试', '2026-01-01')").run().lastInsertRowid,
        );
        const res = importProducts(db, teamId, [
          { name: '可乐 330ml', catName: '饮料', unit: '罐', purchasePrice: '2.50', salePrice: '4.00', lowQty: '10' },
          { name: '可乐 330ml', catName: '饮料', unit: '罐' },
          { name: '', catName: '饮料' },
          { name: '价格异常品', purchasePrice: 'not-a-number' },
          { name: '长字段品', barcode: 'B'.repeat(80) },
        ]);
        assert.equal(res.total, 5);
        assert.equal(res.success, 1);
        assert.equal(res.errors.length, 4);
        const prod = db.prepare('SELECT purchasePrice, salePrice FROM product WHERE teamId = ?').get(teamId) as {
          purchasePrice: number;
          salePrice: number;
        };
        assert.equal(prod.purchasePrice, 250);
        assert.equal(prod.salePrice, 400);

        const nonObjectRes = importProducts(db, teamId, [
          null as unknown as Record<string, unknown>,
          { name: '空行后合法商品', salePrice: '9.90' },
        ]);
        assert.equal(nonObjectRes.total, 2);
        assert.equal(nonObjectRes.success, 1);
        assert.equal(nonObjectRes.errors.length, 1);
      } finally {
        db.close();
      }
    });
  });

  describe('config/env ORANGE_PORT legacy fallback', () => {
    it('falls back to ORANGE_PORT when PORT is unset and prioritizes PORT when set', () => {
      const prevPort = process.env.PORT;
      const prevOrangePort = process.env.ORANGE_PORT;
      try {
        delete process.env.PORT;
        process.env.ORANGE_PORT = '18888';
        resetConfigForTest();
        const cfg1 = initConfig({ persistSecret: false });
        assert.equal(cfg1.port, 18888);

        process.env.PORT = '17777';
        resetConfigForTest();
        const cfg2 = initConfig({ persistSecret: false });
        assert.equal(cfg2.port, 17777);
      } finally {
        if (prevPort === undefined) delete process.env.PORT;
        else process.env.PORT = prevPort;
        if (prevOrangePort === undefined) delete process.env.ORANGE_PORT;
        else process.env.ORANGE_PORT = prevOrangePort;
        resetConfigForTest();
        initConfig({ persistSecret: false });
      }
    });
  });

  describe('legacy archive value normalization and srcBillNo uniqueness', () => {
    it('normalizes legacy account.type and customer.priceLevel during migrate and enforces unique srcBillNo index', () => {
      const tmp = mkTmp('jxc-legacy-norm-');
      const db = openDb(path.join(tmp, 'legacy.db'));
      try {
        migrate(db);
        const teamId = Number(
          db.prepare("INSERT INTO team (name, startPeriod) VALUES ('兼容测试', '202611')").run().lastInsertRowid,
        );
        const whId = Number(
          db.prepare("INSERT INTO warehouse (teamId, name) VALUES (?, '主仓')").run(teamId).lastInsertRowid,
        );
        const accId = Number(
          db.prepare("INSERT INTO account (teamId, name, type, balance) VALUES (?, '老微信', 'wx', 0)").run(teamId)
            .lastInsertRowid,
        );
        const cus1Id = Number(
          db.prepare("INSERT INTO customer (teamId, name, priceLevel) VALUES (?, '老批发客', 'whole')").run(teamId)
            .lastInsertRowid,
        );
        const cus2Id = Number(
          db.prepare("INSERT INTO customer (teamId, name, priceLevel) VALUES (?, '老零售客', 'retail')").run(teamId)
            .lastInsertRowid,
        );

        // Re-running migrate normalizes legacy stored values idempotently
        migrate(db);
        const acc = db.prepare('SELECT type FROM account WHERE id = ?').get(accId) as { type: string };
        const cus1 = db.prepare('SELECT priceLevel FROM customer WHERE id = ?').get(cus1Id) as { priceLevel: string };
        const cus2 = db.prepare('SELECT priceLevel FROM customer WHERE id = ?').get(cus2Id) as { priceLevel: string };
        assert.equal(acc.type, 'wechat');
        assert.equal(cus1.priceLevel, 'wholePrice');
        assert.equal(cus2.priceLevel, 'retailPrice');

        // Unique partial index idx_doc_team_type_src_billno_uniq allows NULL/empty srcBillNo, rejects duplicates
        db.prepare(
          `INSERT INTO doc (teamId, billNo, type, date, warehouseId, status, totalAmount, totalQty, srcBillNo)
           VALUES (?, 'CK-N1', 'stockout', '2026-11-25', ?, 'draft', 0, 1, NULL)`,
        ).run(teamId, whId);
        db.prepare(
          `INSERT INTO doc (teamId, billNo, type, date, warehouseId, status, totalAmount, totalQty, srcBillNo)
           VALUES (?, 'CK-N2', 'stockout', '2026-11-25', ?, 'draft', 0, 1, '')`,
        ).run(teamId, whId);
        db.prepare(
          `INSERT INTO doc (teamId, billNo, type, date, warehouseId, status, totalAmount, totalQty, srcBillNo)
           VALUES (?, 'CK-S1', 'stockout', '2026-11-25', ?, 'draft', 0, 1, 'EXT-UNIQ-1')`,
        ).run(teamId, whId);
        assert.throws(() => {
          db.prepare(
            `INSERT INTO doc (teamId, billNo, type, date, warehouseId, status, totalAmount, totalQty, srcBillNo)
             VALUES (?, 'CK-S2', 'stockout', '2026-11-25', ?, 'draft', 0, 1, 'EXT-UNIQ-1')`,
          ).run(teamId, whId);
        });
      } finally {
        db.close();
      }
    });
  });

  describe('config/env ORANGE_TRUST_PROXY hop count and resolveStoragePaths', () => {
    it('parses hop count 0..20 (accepting boolean aliases) and rejects invalid values', () => {
      const tmp = mkTmp('jxc-tp-');
      assert.equal(validateConfig({ ORANGE_DATA_DIR: tmp }, { persistSecret: false }).trustProxy, 0);
      assert.equal(
        validateConfig({ ORANGE_DATA_DIR: tmp, ORANGE_TRUST_PROXY: 'false' }, { persistSecret: false }).trustProxy,
        0,
      );
      assert.equal(
        validateConfig({ ORANGE_DATA_DIR: tmp, ORANGE_TRUST_PROXY: 'true' }, { persistSecret: false }).trustProxy,
        1,
      );
      assert.equal(
        validateConfig({ ORANGE_DATA_DIR: tmp, ORANGE_TRUST_PROXY: '2' }, { persistSecret: false }).trustProxy,
        2,
      );
      assert.throws(() => validateConfig({ ORANGE_DATA_DIR: tmp, ORANGE_TRUST_PROXY: '21' }, { persistSecret: false }));
      assert.throws(() => validateConfig({ ORANGE_DATA_DIR: tmp, ORANGE_TRUST_PROXY: '-1' }, { persistSecret: false }));
      assert.throws(() =>
        validateConfig({ ORANGE_DATA_DIR: tmp, ORANGE_TRUST_PROXY: 'abc' }, { persistSecret: false }),
      );

      const paths = resolveStoragePaths({
        NODE_ENV: 'production',
        ORANGE_DATA_DIR: tmp,
      });
      assert.equal(paths.dataDir, path.resolve(tmp));
      assert.equal(paths.dbPath, path.join(path.resolve(tmp), 'huimin-clone.db'));
    });
  });

  describe('crud checkField strict typing & DB error mapping', () => {
    it('rejects booleans, objects, arrays, and non-finite numbers while preserving null/empty clearing', () => {
      assert.deepEqual(checkField('salePrice', undefined), { value: null });
      assert.deepEqual(checkField('salePrice', null), { value: null });
      assert.deepEqual(checkField('salePrice', ''), { value: null });
      assert.deepEqual(checkField('remark', ''), { value: null });
      assert.deepEqual(checkField('salePrice', 10800), { value: 10800 });
      assert.deepEqual(checkField('catId', '12'), { value: 12 });
      assert.deepEqual(checkField('archived', 1), { value: 1 });
      assert.deepEqual(checkField('archived', '0'), { value: 0 });
      assert.deepEqual(checkField('balance', -5000), { value: -5000 });
      assert.deepEqual(checkField('balance', '-0'), { value: 0 });
      assert.deepEqual(checkField('balance', -0), { value: 0 });

      for (const [field, bad] of [
        ['salePrice', true],
        ['salePrice', false],
        ['catId', false],
        ['priceLevel', {}],
        ['remark', []],
        ['lowQty', { qty: 1 }],
        ['archived', true],
        ['archived', 2],
        ['salePrice', Number.NaN],
        ['salePrice', Number.POSITIVE_INFINITY],
        ['balance', 1e30],
        ['balance', -1e30],
        ['balance', '9'.repeat(20)],
        ['balance', '1e5'],
      ] as const) {
        const res = checkField(field, bad);
        assert.equal('error' in res, true, `Expected ${field}=${JSON.stringify(bad)} to fail validation`);
      }
    });

    it('maps UNIQUE to 400, SQLITE_BUSY to 503, and NOT NULL/FK to 500 without leaking raw SQLite messages', async () => {
      const tmp = mkTmp('jxc-crud-err-');
      const dbPath = path.join(tmp, 'crud.db');
      const db1 = openDb(dbPath);
      const db2 = new DatabaseSync(dbPath);
      let server: http.Server | null = null;
      try {
        db1.exec(`
          CREATE TABLE parent_item (id INTEGER PRIMARY KEY, teamId INTEGER NOT NULL, name TEXT NOT NULL UNIQUE);
          CREATE TABLE child_item (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            teamId INTEGER NOT NULL,
            name TEXT NOT NULL UNIQUE,
            requiredNote TEXT NOT NULL,
            parentId INTEGER REFERENCES parent_item(id)
          );
          INSERT INTO parent_item (id, teamId, name) VALUES (1, 1, 'P1');
        `);
        const app = express();
        app.use(express.json());
        const router = express.Router();
        mountCrud(router, db1, { table: 'child_item', fields: ['name', 'requiredNote', 'parentId'] });
        app.use('/api', router);
        app.use(expressErrorMiddleware);
        const srv = await new Promise<http.Server>((resolve) => {
          const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        server = srv;
        const port = (srv.address() as AddressInfo).port;
        const url = `http://127.0.0.1:${port}/api/child_item`;

        const okCreate = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ teamId: 1, name: 'C1', requiredNote: 'ok', parentId: 1 }),
        });
        assert.equal(okCreate.status, 200);
        const created = (await okCreate.json()) as { id: number };

        // UNIQUE -> 400 VALIDATION_ERROR
        const dupRes = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ teamId: 1, name: 'C1', requiredNote: 'ok', parentId: 1 }),
        });
        assert.equal(dupRes.status, 400);
        const dupJson = (await dupRes.json()) as { code: string; error: string };
        assert.equal(dupJson.code, 'VALIDATION_ERROR');

        // NOT NULL violation (unvalidated requiredNote=null) -> 500 INTERNAL_ERROR (no raw SQLite leak)
        const notNullRes = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ teamId: 1, name: 'C2', requiredNote: null, parentId: 1 }),
        });
        assert.equal(notNullRes.status, 500);
        const notNullJson = (await notNullRes.json()) as { code: string; error: string };
        assert.equal(notNullJson.code, 'INTERNAL_ERROR');
        assert.equal(notNullJson.error.includes('NOT NULL'), false);
        assert.equal(notNullJson.error.includes('名称可能已存在'), false);

        // FOREIGN KEY violation on PUT -> 500 INTERNAL_ERROR (no raw SQLite leak)
        const fkRes = await fetch(`${url}/${created.id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ teamId: 1, parentId: 9999 }),
        });
        assert.equal(fkRes.status, 500);
        const fkJson = (await fkRes.json()) as { code: string; error: string };
        assert.equal(fkJson.code, 'INTERNAL_ERROR');
        assert.equal(fkJson.error.includes('FOREIGN KEY'), false);
        assert.equal(fkJson.error.includes('名称可能已存在'), false);

        // SQLITE_BUSY -> 503 SERVICE_UNAVAILABLE
        db1.exec('PRAGMA busy_timeout = 10;');
        db2.exec("BEGIN IMMEDIATE; INSERT INTO parent_item (id, teamId, name) VALUES (2, 1, 'P2');");
        try {
          const busyRes = await fetch(`${url}/${created.id}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ teamId: 1, requiredNote: 'updated' }),
          });
          assert.equal(busyRes.status, 503);
          const busyJson = (await busyRes.json()) as { code: string };
          assert.equal(busyJson.code, 'SERVICE_UNAVAILABLE');
        } finally {
          db2.exec('ROLLBACK;');
        }
      } finally {
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        db2.close();
        db1.close();
      }
    });

    it('isolates importProducts snapshot reads inside withImmediateTx write lock', () => {
      const tmp = mkTmp('jxc-imp-tx-');
      const dbPath = path.join(tmp, 'imp.db');
      const db1 = openDb(dbPath);
      const db2 = new DatabaseSync(dbPath);
      try {
        migrate(db1);
        const teamId = Number(
          db1.prepare("INSERT INTO team (name, startPeriod) VALUES ('并发导入', '202611')").run().lastInsertRowid,
        );
        db1.exec('PRAGMA busy_timeout = 10;');
        db2.exec('BEGIN IMMEDIATE;');
        try {
          assert.throws(() => importProducts(db1, teamId, [{ name: '锁冲突品' }]), BusyError);
        } finally {
          db2.exec('ROLLBACK;');
        }
      } finally {
        db2.close();
        db1.close();
      }
    });
  });
});
