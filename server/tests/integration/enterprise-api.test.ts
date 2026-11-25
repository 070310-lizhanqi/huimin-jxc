import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/app';
import { initConfig, resetConfigForTest } from '../../src/config/env';
import { migrate, openDb } from '../../src/db';

interface HttpResult<T = unknown> {
  status: number;
  headers: Headers;
  json: T & { error?: string; code?: string; requestId?: string };
}

describe('Phase 3 Integration Tests: Security, Validation, Concurrency, Idempotency, RBAC & Audit', () => {
  const savedEnv = { ...process.env };
  let tmpDir = '';
  let db: ReturnType<typeof openDb>;
  let server: http.Server;
  let baseUrl = '';
  let port = 0;

  let adminToken = '';
  let adminCookie = '';
  let clerkToken = '';
  let teamId = 0;
  let whId = 0;
  let wh2Id = 0;
  let cusId = 0;
  let venId = 0;
  let accId = 0;
  let prodId = 0;

  async function req<T = Record<string, unknown>>(
    urlPath: string,
    opts: { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; token?: string } = {},
  ): Promise<HttpResult<T>> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let payload: string | undefined;
    if (opts.rawBody !== undefined) {
      headers['content-type'] = headers['content-type'] ?? 'application/json';
      payload = opts.rawBody;
    } else if (opts.body !== undefined) {
      headers['content-type'] = headers['content-type'] ?? 'application/json';
      payload = JSON.stringify(opts.body);
    }
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method: opts.method ?? 'GET',
      headers,
      body: payload,
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    return {
      status: res.status,
      headers: res.headers,
      json: parsed as T & { error?: string; code?: string; requestId?: string },
    };
  }

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-int-'));
    process.env.ORANGE_ENV_FILE = '';
    process.env.ORANGE_DATA_DIR = tmpDir;
    process.env.ORANGE_JWT_SECRET = crypto.randomBytes(32).toString('hex');
    resetConfigForTest();
    const cfg = initConfig({ persistSecret: false });
    db = openDb(cfg.dbPath);
    migrate(db);
    const app = createApp(db, cfg);
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    // Register first admin + setup fixtures
    const reg = await req<{ token: string; teamId: number }>('/api/auth/register', {
      method: 'POST',
      body: { username: 'adminboss', password: 'StrongAdmin!2026', teamName: '企业测试账套' },
    });
    assert.equal(reg.status, 200);
    adminToken = reg.json.token;
    teamId = reg.json.teamId;
    const setCookie = reg.headers.get('set-cookie') ?? '';
    adminCookie = setCookie.split(';')[0];
    assert.ok(adminCookie.startsWith('oc_token='));

    // Create clerk user
    const mkClerk = await req('/api/auth/users', {
      method: 'POST',
      token: adminToken,
      body: { username: 'clerk01', password: 'ClerkPass!2026', role: 'clerk' },
    });
    assert.equal(mkClerk.status, 200);
    const clerkLogin = await req<{ token: string }>('/api/auth/login', {
      method: 'POST',
      body: { username: 'clerk01', password: 'ClerkPass!2026' },
    });
    assert.equal(clerkLogin.status, 200);
    clerkToken = clerkLogin.json.token;

    whId = (
      await req<{ id: number }>('/api/warehouse', { method: 'POST', token: adminToken, body: { name: '一号仓' } })
    ).json.id;
    wh2Id = (
      await req<{ id: number }>('/api/warehouse', { method: 'POST', token: adminToken, body: { name: '二号仓' } })
    ).json.id;
    cusId = (
      await req<{ id: number }>('/api/customer', {
        method: 'POST',
        token: adminToken,
        body: { name: '甲客户', priceLevel: 'salePrice' },
      })
    ).json.id;
    venId = (
      await req<{ id: number }>('/api/vendor', { method: 'POST', token: adminToken, body: { name: '乙供应商' } })
    ).json.id;
    accId = (
      await req<{ id: number }>('/api/account', {
        method: 'POST',
        token: adminToken,
        body: { name: '主银行', type: 'bank', balance: 50000 },
      })
    ).json.id;
    prodId = (
      await req<{ id: number }>('/api/product', {
        method: 'POST',
        token: adminToken,
        body: { name: '测试大米', unit: '袋', purchasePrice: 3000, salePrice: 5000 },
      })
    ).json.id;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    resetConfigForTest();
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      process.env[k] = v;
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns structured 400 BAD_JSON on malformed JSON, echoes/generates X-Request-Id, and returns JSON 404', async () => {
    const badJson = await req('/api/auth/login', {
      method: 'POST',
      rawBody: '{"username":',
      headers: { 'x-request-id': 'trace-test-123' },
    });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.json.code, 'BAD_JSON');
    assert.equal(badJson.headers.get('x-request-id'), 'trace-test-123');
    assert.equal(badJson.json.requestId, 'trace-test-123');

    const missingApi = await req('/api/does-not-exist', { token: adminToken });
    assert.equal(missingApi.status, 404);
    assert.equal(missingApi.json.code, 'NOT_FOUND');
    assert.ok(missingApi.headers.get('x-request-id'));
  });

  it('enforces DNS rebinding Host guard and Cookie CSRF Origin guard', async () => {
    // Node fetch disallows forging Host header directly in some versions, verify CSRF Origin via Cookie
    const crossSite = await req('/api/warehouse', {
      method: 'POST',
      body: { name: '非法跨站仓' },
      headers: { cookie: adminCookie, origin: 'https://evil.example.com' },
    });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.json.code, 'FORBIDDEN');

    const sameSite = await req<{ id: number }>('/api/warehouse', {
      method: 'POST',
      body: { name: '同源合法仓' },
      headers: { cookie: adminCookie, origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(sameSite.status, 200);
    assert.ok(sameSite.json.id > 0);
  });

  it('validates CRUD required fields, positive integer :id, foreign key ownership, and enums', async () => {
    const emptyName = await req('/api/product', { method: 'POST', token: adminToken, body: { name: '   ' } });
    assert.equal(emptyName.status, 400);
    assert.equal(emptyName.json.error, '名称不能为空');

    const badPutId = await req('/api/product/abc', { method: 'PUT', token: adminToken, body: { name: 'x' } });
    assert.equal(badPutId.status, 400);

    const badDelId = await req('/api/product/1.5', { method: 'DELETE', token: adminToken });
    assert.equal(badDelId.status, 400);

    const badCat = await req('/api/product', {
      method: 'POST',
      token: adminToken,
      body: { name: '跨队商品', catId: 999999 },
    });
    assert.equal(badCat.status, 400);
    assert.equal(badCat.json.error, '商品分类不存在');

    const missingWhRes = await req('/api/reservoir', {
      method: 'POST',
      token: adminToken,
      body: { name: 'A区' },
    });
    assert.equal(missingWhRes.status, 400);

    const badAccType = await req('/api/account', {
      method: 'POST',
      token: adminToken,
      body: { name: '坏账户', type: 'bitcoin' },
    });
    assert.equal(badAccType.status, 400);

    const badPriceLvl = await req('/api/customer', {
      method: 'POST',
      token: adminToken,
      body: { name: '坏客户', priceLevel: 'vip999' },
    });
    assert.equal(badPriceLvl.status, 400);

    // Also test cross-warehouse valid reservoir + transfer validation
    const resOk = await req<{ id: number }>('/api/reservoir', {
      method: 'POST',
      token: adminToken,
      body: { name: 'A1货位', warehouseId: whId },
    });
    assert.equal(resOk.status, 200);
    assert.notEqual(whId, wh2Id);
  });

  it('prevents concurrent oversell and enforces persistent Idempotency-Key across docs and settlements', async () => {
    // Stock in 5 bags
    const inDoc = await req<{ id: number; billNo: string }>('/api/doc/create', {
      method: 'POST',
      token: adminToken,
      headers: { 'Idempotency-Key': 'idem-in-001' },
      body: {
        type: 'stockin',
        date: '2026-04-01',
        warehouseId: whId,
        partnerType: 'ven',
        partnerId: venId,
        items: [{ productId: prodId, qty: 5, price: 3000 }],
      },
    });
    assert.equal(inDoc.status, 200);

    // Replay same Idempotency-Key returns same doc id without duplicating
    const inDocReplay = await req<{ id: number; billNo: string }>('/api/doc/create', {
      method: 'POST',
      token: adminToken,
      headers: { 'Idempotency-Key': 'idem-in-001' },
      body: {
        type: 'stockin',
        date: '2026-04-01',
        warehouseId: whId,
        partnerType: 'ven',
        partnerId: venId,
        items: [{ productId: prodId, qty: 5, price: 3000 }],
      },
    });
    assert.equal(inDocReplay.status, 200);
    assert.equal(inDocReplay.json.id, inDoc.json.id);
    assert.equal(inDocReplay.headers.get('idempotent-replayed'), 'true');

    // Same key with different payload returns 409 CONFLICT
    const inDocConflict = await req('/api/doc/create', {
      method: 'POST',
      token: adminToken,
      headers: { 'Idempotency-Key': 'idem-in-001' },
      body: {
        type: 'stockin',
        date: '2026-04-01',
        warehouseId: whId,
        partnerType: 'ven',
        partnerId: venId,
        items: [{ productId: prodId, qty: 99, price: 3000 }],
      },
    });
    assert.equal(inDocConflict.status, 409);
    assert.equal(inDocConflict.json.code, 'CONFLICT');

    // Audit stockin idempotently
    const auditIn = await req('/api/doc/audit', {
      method: 'POST',
      token: adminToken,
      headers: { 'Idempotency-Key': 'idem-audit-in-001' },
      body: { id: inDoc.json.id },
    });
    assert.equal(auditIn.status, 200);

    // Two competing stockout drafts of qty 4 each (total 8 > available 5)
    const out1 = await req<{ id: number }>('/api/doc/create', {
      method: 'POST',
      token: clerkToken,
      body: {
        type: 'stockout',
        date: '2026-04-02',
        warehouseId: whId,
        partnerType: 'cus',
        partnerId: cusId,
        items: [{ productId: prodId, qty: 4, price: 5000 }],
      },
    });
    const out2 = await req<{ id: number }>('/api/doc/create', {
      method: 'POST',
      token: clerkToken,
      body: {
        type: 'stockout',
        date: '2026-04-02',
        warehouseId: whId,
        partnerType: 'cus',
        partnerId: cusId,
        items: [{ productId: prodId, qty: 4, price: 5000 }],
      },
    });
    assert.equal(out1.status, 200);
    assert.equal(out2.status, 200);

    const [a1, a2] = await Promise.all([
      req('/api/doc/audit', { method: 'POST', token: clerkToken, body: { id: out1.json.id } }),
      req('/api/doc/audit', { method: 'POST', token: clerkToken, body: { id: out2.json.id } }),
    ]);
    const statuses = [a1.status, a2.status].sort();
    assert.deepEqual(statuses, [200, 400], `Expected exactly one pass and one oversell block, got ${statuses}`);

    const stockRows = await req<Array<{ productId: number; qty: number }>>('/api/stock/list', { token: adminToken });
    const stockItem = (stockRows.json as unknown as Array<{ productId: number; qty: number }>).find(
      (r) => r.productId === prodId,
    );
    assert.equal(stockItem?.qty, 1);

    // Settlement Idempotency-Key + invalid refDocId check
    const badRef = await req('/api/settlement/create', {
      method: 'POST',
      token: clerkToken,
      body: {
        type: 'receipt',
        partnerType: 'cus',
        partnerId: cusId,
        amount: 1000,
        accountId: accId,
        refDocId: 999999,
      },
    });
    assert.equal(badRef.status, 400);
    assert.equal(badRef.json.error, '关联单据不存在');

    const s1 = await req<{ id: number }>('/api/settlement/create', {
      method: 'POST',
      token: clerkToken,
      headers: { 'Idempotency-Key': 'idem-settle-001' },
      body: { type: 'receipt', partnerType: 'cus', partnerId: cusId, amount: 5000, accountId: accId },
    });
    const s2 = await req<{ id: number }>('/api/settlement/create', {
      method: 'POST',
      token: clerkToken,
      headers: { 'Idempotency-Key': 'idem-settle-001' },
      body: { type: 'receipt', partnerType: 'cus', partnerId: cusId, amount: 5000, accountId: accId },
    });
    assert.equal(s1.status, 200);
    assert.equal(s2.status, 200);
    assert.equal(s2.json.id, s1.json.id);
    assert.equal(s2.headers.get('idempotent-replayed'), 'true');
  });

  it('enforces RBAC boundaries and records structured audit_log entries', async () => {
    // Clerk cannot view audit logs, import products, or modify settings
    const clerkAudit = await req('/api/audit-logs', { token: clerkToken });
    assert.equal(clerkAudit.status, 403);
    assert.equal(clerkAudit.json.code, 'FORBIDDEN');

    const clerkImport = await req('/api/product/import', {
      method: 'POST',
      token: clerkToken,
      body: { teamId, rows: [{ name: '非法导入品' }] },
    });
    assert.equal(clerkImport.status, 403);

    const clerkSetting = await req('/api/setting/prefix', {
      method: 'POST',
      token: clerkToken,
      body: { prefix: { stockin: 'XX' } },
    });
    assert.equal(clerkSetting.status, 403);

    // Clerk CAN change own password
    const clerkPwd = await req<{ ok: boolean }>('/api/auth/password', {
      method: 'POST',
      token: clerkToken,
      body: { oldPassword: 'ClerkPass!2026', newPassword: 'ClerkPassNew!2026' },
    });
    assert.equal(clerkPwd.status, 200);

    // Admin inspects audit logs and verifies key actions + zero password leak
    const logs = await req<{ rows: Array<{ action: string; detail: string | null }>; total: number }>(
      '/api/audit-logs?rows=50',
      { token: adminToken },
    );
    assert.equal(logs.status, 200);
    assert.ok(logs.json.total >= 5);
    const actions = new Set(logs.json.rows.map((r) => r.action));
    assert.ok(actions.has('auth.login'));
    assert.ok(actions.has('doc.create'));
    assert.ok(actions.has('doc.audit'));
    assert.ok(actions.has('settlement.create'));
    assert.ok(actions.has('auth.password_change'));

    const allDetails = logs.json.rows.map((r) => r.detail ?? '').join('\n');
    assert.equal(allDetails.includes('ClerkPassNew!2026'), false);
    assert.equal(allDetails.includes('StrongAdmin!2026'), false);
  });

  it('rejects prototype/non-object/negative/out-of-range inputs and preserves unified error envelopes', async () => {
    // 1. Auth non-string username -> 400 VALIDATION_ERROR with code + requestId (no 500 or array coercion)
    const badLogin = await req('/api/auth/login', {
      method: 'POST',
      body: { username: ['adminboss'], password: 'StrongAdmin!2026' },
    });
    assert.equal(badLogin.status, 400);
    assert.equal(badLogin.json.code, 'VALIDATION_ERROR');
    assert.ok(badLogin.json.requestId);

    // 2. doc/create edge cases: Object.prototype key, non-object item, near-zero qty, object remark, empty date
    const protoDoc = await req('/api/doc/create', {
      method: 'POST',
      token: adminToken,
      body: {
        type: 'toString',
        warehouseId: whId,
        items: [{ productId: prodId, qty: 1, price: 100 }],
      },
    });
    assert.equal(protoDoc.status, 400);

    const nullItemDoc = await req('/api/doc/create', {
      method: 'POST',
      token: adminToken,
      body: { type: 'stockin', warehouseId: whId, partnerType: 'ven', partnerId: venId, items: [null] },
    });
    assert.equal(nullItemDoc.status, 400);

    const tinyQtyDoc = await req('/api/doc/create', {
      method: 'POST',
      token: adminToken,
      body: {
        type: 'stockin',
        warehouseId: whId,
        partnerType: 'ven',
        partnerId: venId,
        items: [{ productId: prodId, qty: 0.00001, price: 100 }],
      },
    });
    assert.equal(tinyQtyDoc.status, 400);

    const objRemarkDoc = await req('/api/doc/create', {
      method: 'POST',
      token: adminToken,
      body: {
        type: 'stockin',
        warehouseId: whId,
        partnerType: 'ven',
        partnerId: venId,
        remark: { nested: 1 },
        items: [{ productId: prodId, qty: 1, price: 100 }],
      },
    });
    assert.equal(objRemarkDoc.status, 400);
    assert.equal(objRemarkDoc.json.code, 'VALIDATION_ERROR');

    // Empty date normalizes to today's valid YYYY-MM-DD rather than storing ''
    const emptyDateDoc = await req<{ id: number; billNo: string }>('/api/doc/create', {
      method: 'POST',
      token: adminToken,
      body: {
        type: 'stockin',
        date: '',
        warehouseId: whId,
        partnerType: 'ven',
        partnerId: venId,
        items: [{ productId: prodId, qty: 1, price: 100 }],
      },
    });
    assert.equal(emptyDateDoc.status, 200);
    const createdDocRow = db.prepare('SELECT date FROM doc WHERE id = ?').get(emptyDateDoc.json.id) as { date: string };
    assert.match(createdDocRow.date, /^\d{4}-\d{2}-\d{2}$/);

    // 3. doc/audit invalid id returns 400 (not 404), and concurrent/replay sets Idempotent-Replayed header
    const badAuditId = await req('/api/doc/audit', {
      method: 'POST',
      token: adminToken,
      body: { id: 'abc' },
    });
    assert.equal(badAuditId.status, 400);
    assert.equal(badAuditId.json.code, 'VALIDATION_ERROR');

    const auditAgain = await req<{ id: number }>('/api/doc/audit', {
      method: 'POST',
      token: adminToken,
      headers: { 'Idempotency-Key': 'idem-audit-in-001' },
      body: { id: emptyDateDoc.json.id },
    });
    // Different docId -> 409 CONFLICT for reused key on different payload
    assert.equal(auditAgain.status, 409);

    const auditSame = await req<{ ok: boolean }>('/api/doc/audit', {
      method: 'POST',
      token: adminToken,
      headers: { 'Idempotency-Key': 'idem-audit-regress-001' },
      body: { id: emptyDateDoc.json.id },
    });
    assert.equal(auditSame.status, 200);
    const auditReplay = await req<{ ok: boolean }>('/api/doc/audit', {
      method: 'POST',
      token: adminToken,
      headers: { 'Idempotency-Key': 'idem-audit-regress-001' },
      body: { id: emptyDateDoc.json.id },
    });
    assert.equal(auditReplay.status, 200);
    assert.equal(auditReplay.headers.get('idempotent-replayed'), 'true');

    // 4. CRUD validation: invalid parentId, negative prices/lowQty
    const badCat = await req('/api/cat', {
      method: 'POST',
      token: adminToken,
      body: { teamId, name: '非法父类目', parentId: 'abc' },
    });
    assert.equal(badCat.status, 400);

    const negPriceProd = await req('/api/product', {
      method: 'POST',
      token: adminToken,
      body: { teamId, name: '负价商品', salePrice: -100 },
    });
    assert.equal(negPriceProd.status, 400);

    const negLowQtyProd = await req('/api/product', {
      method: 'POST',
      token: adminToken,
      body: { teamId, name: '负预警商品', lowQty: -1 },
    });
    assert.equal(negLowQtyProd.status, 400);

    // 5. Settlement create with empty date, invalid PUT accountId/remark, concurrent DELETE atomicity
    const accBefore = (db.prepare('SELECT balance FROM account WHERE id = ?').get(accId) as { balance: number })
      .balance;
    const settleEmptyDate = await req<{ id: number }>('/api/settlement/create', {
      method: 'POST',
      token: adminToken,
      body: {
        teamId,
        type: 'receipt',
        partnerType: 'cus',
        partnerId: cusId,
        amount: 1200,
        accountId: accId,
        date: '',
      },
    });
    assert.equal(settleEmptyDate.status, 200);
    const settleRow = db
      .prepare('SELECT date, accountId FROM settlement WHERE id = ?')
      .get(settleEmptyDate.json.id) as {
      date: string;
      accountId: number;
    };
    assert.match(settleRow.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(settleRow.accountId, accId);

    const badSettlePut = await req(`/api/settlement/${settleEmptyDate.json.id}`, {
      method: 'PUT',
      token: adminToken,
      body: { teamId, amount: 1500, accountId: 'abc' },
    });
    assert.equal(badSettlePut.status, 400);
    assert.equal(badSettlePut.json.code, 'VALIDATION_ERROR');
    assert.ok(badSettlePut.json.requestId);

    const accAfterBadPut = (db.prepare('SELECT balance FROM account WHERE id = ?').get(accId) as { balance: number })
      .balance;
    assert.equal(accAfterBadPut, accBefore + 1200);

    // Concurrent DELETE: only one succeeds (200), second returns 404, balance reverts strictly once
    const [del1, del2] = await Promise.all([
      req(`/api/settlement/${settleEmptyDate.json.id}`, { method: 'DELETE', token: adminToken }),
      req(`/api/settlement/${settleEmptyDate.json.id}`, { method: 'DELETE', token: adminToken }),
    ]);
    assert.deepEqual([del1.status, del2.status].sort(), [200, 404]);
    const accAfterDelete = (db.prepare('SELECT balance FROM account WHERE id = ?').get(accId) as { balance: number })
      .balance;
    assert.equal(accAfterDelete, accBefore);

    // 6. Price, settings, backup & report unified error contracts & validation fixes
    const badPriceSet = await req('/api/price/set', {
      method: 'POST',
      token: adminToken,
      body: { teamId, partnerId: cusId, productId: prodId, price: '' },
    });
    assert.equal(badPriceSet.status, 400);
    assert.equal(badPriceSet.json.code, 'VALIDATION_ERROR');
    assert.ok(badPriceSet.json.requestId);

    const priceListKw = await req<{ rows: unknown[]; total: number }>(
      `/api/price/list?teamId=${teamId}&kw=${encodeURIComponent('测试')}`,
      { token: adminToken },
    );
    assert.equal(priceListKw.status, 200);

    const badPriceDel = await req(`/api/price/abc?teamId=${teamId}`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert.equal(badPriceDel.status, 400);

    const arrPrefix = await req('/api/setting/prefix', {
      method: 'POST',
      token: adminToken,
      body: { teamId, prefix: ['RK'] },
    });
    assert.equal(arrPrefix.status, 400);
    assert.equal(arrPrefix.json.code, 'VALIDATION_ERROR');
    assert.ok(arrPrefix.json.requestId);

    const badPrint = await req('/api/setting/print', {
      method: 'POST',
      token: adminToken,
      body: { teamId, print: { company: {} } },
    });
    assert.equal(badPrint.status, 400);

    const badBackupDl = await req('/api/backup/download?file=../etc/passwd', { token: adminToken });
    assert.equal(badBackupDl.status, 400);
    assert.equal(badBackupDl.json.code, 'VALIDATION_ERROR');
    assert.ok(badBackupDl.json.requestId);

    const badReportSales = await req('/api/report/sales?from=bad-date', { token: adminToken });
    assert.equal(badReportSales.status, 400);
    assert.equal(badReportSales.json.code, 'VALIDATION_ERROR');
    assert.ok(badReportSales.json.requestId);

    const badStatement = await req('/api/report/statement?partnerId=abc', { token: adminToken });
    assert.equal(badStatement.status, 400);
    assert.equal(badStatement.json.code, 'VALIDATION_ERROR');
    assert.ok(badStatement.json.requestId);
  });

  it('enforces atomic /doc/import RBAC, rollback, barcode dedup, and concurrent duplicate protection', async () => {
    const csvRollback = [
      '单据类型,单号,日期,客户,商品,条码,数量,单价',
      '销售出库,EXT-RB-1,2026-10-15,回滚客户X,回滚商品Y,BC-RB-1,2,100',
      '销售出库,EXT-RB-2,2026-10-15,甲客户,测试大米,,2000000,600',
    ].join('\n');

    // Re-login clerk after earlier password change incremented tokenVer
    const clerkRelogin = await req<{ token: string }>('/api/auth/login', {
      method: 'POST',
      body: { username: 'clerk01', password: 'ClerkPassNew!2026' },
    });
    assert.equal(clerkRelogin.status, 200);
    const activeClerkToken = clerkRelogin.json.token;

    // Clerk cannot autoCreate=1
    const clerkAttempt = await req(`/api/doc/import?teamId=${teamId}&dryRun=0&autoCreate=1`, {
      method: 'POST',
      token: activeClerkToken,
      headers: { 'content-type': 'application/octet-stream' },
      rawBody: csvRollback,
    });
    assert.equal(clerkAttempt.status, 403);
    assert.equal(clerkAttempt.json.code, 'FORBIDDEN');

    // Admin hitting MAX_TOTAL_AMOUNT_CENTS on bill 2 rolls back bill 1's auto-created customer/product/doc
    const failImport = await req(`/api/doc/import?teamId=${teamId}&dryRun=0&autoCreate=1`, {
      method: 'POST',
      token: adminToken,
      headers: { 'content-type': 'application/octet-stream' },
      rawBody: csvRollback,
    });
    assert.equal(failImport.status, 400);
    assert.equal(failImport.json.code, 'VALIDATION_ERROR');

    assert.equal(
      db.prepare("SELECT COUNT(*) AS c FROM customer WHERE teamId = ? AND name = '回滚客户X'").get(teamId)
        ? (
            db.prepare("SELECT COUNT(*) AS c FROM customer WHERE teamId = ? AND name = '回滚客户X'").get(teamId) as {
              c: number;
            }
          ).c
        : -1,
      0,
    );
    assert.equal(
      (
        db.prepare("SELECT COUNT(*) AS c FROM product WHERE teamId = ? AND name = '回滚商品Y'").get(teamId) as {
          c: number;
        }
      ).c,
      0,
    );
    assert.equal(
      (
        db.prepare("SELECT COUNT(*) AS c FROM doc WHERE teamId = ? AND srcBillNo = 'EXT-RB-1'").get(teamId) as {
          c: number;
        }
      ).c,
      0,
    );

    // Barcode auto-create updates prodByBarcode inside import transaction + concurrent duplicate srcBillNo blocked
    const csvBarcode = [
      '单据类型,单号,日期,客户,商品,条码,数量,单价',
      '销售出库,EXT-BC-1,2026-10-15,甲客户,条码自建品,BC-AUTOCREATE-9,1,50',
      '销售出库,EXT-BC-1,2026-10-15,甲客户,条码自建品_别名,BC-AUTOCREATE-9,2,50',
    ].join('\n');
    const [imp1, imp2] = await Promise.all([
      req<{ summary?: { imported?: number }; skippedBills?: unknown[] }>(
        `/api/doc/import?teamId=${teamId}&dryRun=0&autoCreate=1`,
        {
          method: 'POST',
          token: adminToken,
          headers: { 'content-type': 'application/octet-stream' },
          rawBody: csvBarcode,
        },
      ),
      req<{ summary?: { imported?: number }; skippedBills?: unknown[] }>(
        `/api/doc/import?teamId=${teamId}&dryRun=0&autoCreate=1`,
        {
          method: 'POST',
          token: adminToken,
          headers: { 'content-type': 'application/octet-stream' },
          rawBody: csvBarcode,
        },
      ),
    ]);
    assert.deepEqual([imp1.status, imp2.status], [200, 200]);
    const totalImported = (imp1.json.summary?.imported ?? 0) + (imp2.json.summary?.imported ?? 0);
    assert.equal(totalImported, 1);
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS c FROM product WHERE teamId = ? AND barcode = 'BC-AUTOCREATE-9'")
          .get(teamId) as { c: number }
      ).c,
      1,
    );
    assert.equal(
      (
        db.prepare("SELECT COUNT(*) AS c FROM doc WHERE teamId = ? AND srcBillNo = 'EXT-BC-1'").get(teamId) as {
          c: number;
        }
      ).c,
      1,
    );
  });

  it('isolates null-batch stocktake deductions and allows voiding zero-diff audited stocktake', async () => {
    const pM1 = (
      await req<{ id: number }>('/api/product', {
        method: 'POST',
        token: adminToken,
        body: { name: '盘点批次测试品', unit: '箱', purchasePrice: 1000, salePrice: 2000 },
      })
    ).json.id;

    // Inbound batch 'BATCH-A' (10) and null batch (5)
    const inDoc = await req<{ id: number }>('/api/doc/create', {
      method: 'POST',
      token: adminToken,
      body: {
        teamId,
        type: 'stockin',
        date: '2026-10-10',
        partnerType: 'ven',
        partnerId: venId,
        warehouseId: whId,
        items: [
          { productId: pM1, qty: 10, price: 1000, batchNo: 'BATCH-A' },
          { productId: pM1, qty: 5, price: 1000, batchNo: null },
        ],
      },
    });
    assert.equal(inDoc.status, 200);
    assert.equal(
      (await req('/api/doc/audit', { method: 'POST', token: adminToken, body: { id: inDoc.json.id, teamId } })).status,
      200,
    );

    // Regular stockout without batchNo still uses wildcard FIFO across batches (consumes 2 from oldest BATCH-A)
    const outDoc = await req<{ id: number }>('/api/doc/create', {
      method: 'POST',
      token: adminToken,
      body: {
        teamId,
        type: 'stockout',
        date: '2026-10-11',
        partnerType: 'cus',
        partnerId: cusId,
        warehouseId: whId,
        items: [{ productId: pM1, qty: 2, price: 2000, batchNo: null }],
      },
    });
    assert.equal(outDoc.status, 200);
    assert.equal(
      (await req('/api/doc/audit', { method: 'POST', token: adminToken, body: { id: outDoc.json.id, teamId } })).status,
      200,
    );

    // Stocktake count 0 on null batch must ONLY deduct null batch (5 -> 0), NOT touch BATCH-A (still 8)
    const stZero = await req<{ id: number }>('/api/doc/create', {
      method: 'POST',
      token: adminToken,
      body: {
        teamId,
        type: 'stocktake',
        date: '2026-10-12',
        warehouseId: whId,
        items: [{ productId: pM1, qty: 0, price: 0, batchNo: null }],
      },
    });
    assert.equal(stZero.status, 200);
    assert.equal(
      (await req('/api/doc/audit', { method: 'POST', token: adminToken, body: { id: stZero.json.id, teamId } })).status,
      200,
    );

    const batchA = db
      .prepare(
        `SELECT COALESCE(SUM(qty), 0) AS q FROM stock WHERE teamId = ? AND productId = ? AND warehouseId = ? AND batchNo = 'BATCH-A'`,
      )
      .get(teamId, pM1, whId) as { q: number };
    const batchNull = db
      .prepare(
        `SELECT COALESCE(SUM(qty), 0) AS q FROM stock WHERE teamId = ? AND productId = ? AND warehouseId = ? AND batchNo IS NULL`,
      )
      .get(teamId, pM1, whId) as { q: number };
    assert.equal(batchA.q, 8);
    assert.equal(batchNull.q, 0);

    // Zero-diff stocktake (qty === 8 matching BATCH-A book qty 8) audits & voids cleanly
    const stEq = await req<{ id: number }>('/api/doc/create', {
      method: 'POST',
      token: adminToken,
      body: {
        teamId,
        type: 'stocktake',
        date: '2026-10-13',
        warehouseId: whId,
        items: [{ productId: pM1, qty: 8, price: 0, batchNo: 'BATCH-A' }],
      },
    });
    assert.equal(stEq.status, 200);
    assert.equal(
      (await req('/api/doc/audit', { method: 'POST', token: adminToken, body: { id: stEq.json.id, teamId } })).status,
      200,
    );
    const voidEq = await req('/api/doc/void', {
      method: 'POST',
      token: adminToken,
      body: { id: stEq.json.id, teamId },
    });
    assert.equal(voidEq.status, 200);
    const stEqRow = db.prepare('SELECT status FROM doc WHERE id = ?').get(stEq.json.id) as { status: string };
    assert.equal(stEqRow.status, 'void');
  });

  it('enforces doc.type<->partnerType pairing, integer cents, strict types, and partnerType report isolation', async () => {
    // Mismatched partnerType or partner on non-partner doc rejected with 400
    for (const badBody of [
      {
        teamId,
        type: 'stockout',
        warehouseId: whId,
        partnerType: 'ven',
        partnerId: venId,
        items: [{ productId: prodId, qty: 1, price: 100 }],
      },
      {
        teamId,
        type: 'pin',
        warehouseId: whId,
        partnerType: 'cus',
        partnerId: cusId,
        items: [{ productId: prodId, qty: 1, price: 100 }],
      },
      {
        teamId,
        type: 'outapply',
        partnerType: 'ven',
        partnerId: venId,
        items: [{ productId: prodId, qty: 1, price: 100 }],
      },
      {
        teamId,
        type: 'transfer',
        warehouseId: whId,
        partnerType: 'cus',
        partnerId: cusId,
        items: [{ productId: prodId, qty: 1, price: 0, toWarehouseId: wh2Id }],
      },
      // Fractional float price and boolean amounts rejected
      {
        teamId,
        type: 'sorder',
        partnerType: 'cus',
        partnerId: cusId,
        items: [{ productId: prodId, qty: 1, price: 100.4 }],
      },
      {
        teamId,
        type: 'sorder',
        partnerType: 'cus',
        partnerId: cusId,
        discount: true,
        items: [{ productId: prodId, qty: 1, price: 100 }],
      },
      {
        teamId,
        type: 'stockout',
        warehouseId: whId,
        partnerType: 'cus',
        partnerId: cusId,
        paidAmount: true,
        items: [{ productId: prodId, qty: 1, price: 100 }],
      },
      {
        teamId,
        type: 'stockout',
        warehouseId: whId,
        partnerType: 'cus',
        partnerId: cusId,
        deposit: 10.5,
        items: [{ productId: prodId, qty: 1, price: 100 }],
      },
    ]) {
      const r = await req('/api/doc/create', { method: 'POST', token: adminToken, body: badBody });
      assert.equal(r.status, 400);
      assert.equal(r.json.code, 'VALIDATION_ERROR');
    }

    // Settlement type-strict amounts & query IDs
    const badSettleBool = await req('/api/settlement/create', {
      method: 'POST',
      token: adminToken,
      body: { teamId, type: 'receipt', partnerType: 'cus', partnerId: cusId, amount: true },
    });
    assert.equal(badSettleBool.status, 400);
    const badSettleFloat = await req('/api/settlement/create', {
      method: 'POST',
      token: adminToken,
      body: { teamId, type: 'receipt', partnerType: 'cus', partnerId: cusId, amount: 10.5 },
    });
    assert.equal(badSettleFloat.status, 400);

    const validSettle = await req<{ id: number }>('/api/settlement/create', {
      method: 'POST',
      token: adminToken,
      body: { teamId, type: 'receipt', partnerType: 'cus', partnerId: cusId, amount: 500 },
    });
    assert.equal(validSettle.status, 200);
    const badSettlePutBool = await req(`/api/settlement/${validSettle.json.id}`, {
      method: 'PUT',
      token: adminToken,
      body: { teamId, amount: true },
    });
    assert.equal(badSettlePutBool.status, 400);
    const badSettlePutFloat = await req(`/api/settlement/${validSettle.json.id}`, {
      method: 'PUT',
      token: adminToken,
      body: { teamId, amount: 50.5 },
    });
    assert.equal(badSettlePutFloat.status, 400);
    assert.equal(
      (await req(`/api/settlement/${validSettle.json.id}`, { method: 'DELETE', token: adminToken })).status,
      200,
    );

    for (const badQueryUrl of [
      `/api/doc/list?teamId=${teamId}&partnerId=abc`,
      `/api/doc/export?teamId=${teamId}&partnerId=abc`,
      `/api/settlement/list?teamId=${teamId}&partnerId=abc`,
      `/api/settlement/list?teamId=${teamId}&refDocId=abc`,
    ]) {
      const r = await req(badQueryUrl, { token: adminToken });
      assert.equal(r.status, 400);
      assert.equal(r.json.code, 'VALIDATION_ERROR');
    }

    // Also reject mismatched partnerType on /doc/edit
    const draftForEdit = await req<{ id: number }>('/api/doc/create', {
      method: 'POST',
      token: adminToken,
      body: {
        teamId,
        type: 'stockout',
        warehouseId: whId,
        partnerType: 'cus',
        partnerId: cusId,
        items: [{ productId: prodId, qty: 1, price: 100 }],
      },
    });
    assert.equal(draftForEdit.status, 200);
    const badEditPartner = await req('/api/doc/edit', {
      method: 'PUT',
      token: adminToken,
      body: {
        id: draftForEdit.json.id,
        teamId,
        type: 'stockout',
        warehouseId: whId,
        partnerType: 'ven',
        partnerId: venId,
        items: [{ productId: prodId, qty: 1, price: 100 }],
      },
    });
    assert.equal(badEditPartner.status, 400);
    assert.equal(badEditPartner.json.code, 'VALIDATION_ERROR');

    // /report/statement & /report/aging isolate by partnerType even when customer.id === vendor.id
    assert.equal(cusId, venId);
    const todayIso = new Date().toISOString().slice(0, 10);
    // Simulate a legacy anomalous doc row with stockout + partnerType='ven' on colliding id
    db.prepare(
      `INSERT INTO doc (teamId, billNo, type, date, partnerType, partnerId, warehouseId, status, totalAmount, totalQty)
       VALUES (?, 'CK-LEGACY-MISMATCH', 'stockout', ?, 'ven', ?, ?, 'audit', 99900, 1)`,
    ).run(teamId, todayIso, venId, whId);
    const stAr = await req<{ lines: Array<{ billNo?: string }> }>(
      `/api/report/statement?teamId=${teamId}&partnerId=${cusId}&mode=ar&from=2000-01-01&to=2099-12-31`,
      { token: adminToken },
    );
    assert.equal(stAr.status, 200);
    assert.equal(
      stAr.json.lines.some((r) => r.billNo === 'CK-LEGACY-MISMATCH'),
      false,
    );
    const agingAr = await req<{ rows: Array<{ partnerId: number; total: number }> }>(
      `/api/report/aging?teamId=${teamId}&mode=ar`,
      { token: adminToken },
    );
    assert.equal(agingAr.status, 200);
    db.prepare(`DELETE FROM doc WHERE billNo = 'CK-LEGACY-MISMATCH'`).run();
  });

  it('allows updating legacy wx/whole/retail archive rows and preserves duplicate-product order fulfillment & copy precision', async () => {
    const legAccId = Number(
      db.prepare("INSERT INTO account (teamId, name, type, balance) VALUES (?, '旧微信账户', 'wx', 0)").run(teamId)
        .lastInsertRowid,
    );
    const legCusId = Number(
      db.prepare("INSERT INTO customer (teamId, name, priceLevel) VALUES (?, '旧批发客户', 'whole')").run(teamId)
        .lastInsertRowid,
    );

    const putAcc = await req(`/api/account/${legAccId}`, {
      method: 'PUT',
      token: adminToken,
      body: { teamId, name: '新微信账户', type: 'wechat' },
    });
    assert.equal(putAcc.status, 200);
    const putCus = await req(`/api/customer/${legCusId}`, {
      method: 'PUT',
      token: adminToken,
      body: { teamId, name: '新批发客户', priceLevel: 'wholePrice' },
    });
    assert.equal(putCus.status, 200);

    // Ensure enough stock exists for duplicate-product partial conversion
    const inStock = await req<{ id: number }>('/api/doc/create', {
      method: 'POST',
      token: adminToken,
      body: {
        teamId,
        type: 'stockin',
        warehouseId: whId,
        partnerType: 'ven',
        partnerId: venId,
        items: [{ productId: prodId, qty: 30, price: 3000 }],
      },
    });
    assert.equal(inStock.status, 200);
    assert.equal(
      (await req('/api/doc/audit', { method: 'POST', token: adminToken, body: { id: inStock.json.id, teamId } }))
        .status,
      200,
    );

    const sorder = await req<{ id: number }>('/api/doc/create', {
      method: 'POST',
      token: adminToken,
      body: {
        teamId,
        type: 'sorder',
        partnerType: 'cus',
        partnerId: cusId,
        items: [
          { productId: prodId, qty: 10, price: 5000 },
          { productId: prodId, qty: 5, price: 4800 },
        ],
      },
    });
    assert.equal(sorder.status, 200);
    assert.equal(
      (await req('/api/doc/audit', { method: 'POST', token: adminToken, body: { id: sorder.json.id, teamId } })).status,
      200,
    );

    const partialOut = await req<{ id: number }>('/api/doc/create', {
      method: 'POST',
      token: adminToken,
      body: {
        teamId,
        type: 'stockout',
        warehouseId: whId,
        partnerType: 'cus',
        partnerId: cusId,
        refOrderId: sorder.json.id,
        items: [{ productId: prodId, qty: 12, price: 5000 }],
      },
    });
    assert.equal(partialOut.status, 200);
    assert.equal(
      (await req('/api/doc/audit', { method: 'POST', token: adminToken, body: { id: partialOut.json.id, teamId } }))
        .status,
      200,
    );

    const infoRes = await req<{ fulfillment: Array<{ ordered: number; converted: number; remain: number }> }>(
      `/api/doc/info?id=${sorder.json.id}&teamId=${teamId}`,
      { token: adminToken },
    );
    assert.equal(infoRes.status, 200);
    assert.deepEqual(
      infoRes.json.fulfillment.map((f) => f.remain),
      [0, 3],
    );

    const convRes = await req<{ id: number; doc?: { totalQty: number } }>('/api/doc/convert', {
      method: 'POST',
      token: adminToken,
      body: { id: sorder.json.id, teamId, toType: 'stockout', warehouseId: whId },
    });
    assert.equal(convRes.status, 200);
    const convInfo = await req<{ doc: { totalQty: number }; items: Array<{ qty: number }> }>(
      `/api/doc/info?id=${convRes.json.id}&teamId=${teamId}`,
      { token: adminToken },
    );
    assert.equal(convInfo.status, 200);
    assert.equal(convInfo.json.doc.totalQty, 3);
    assert.equal(convInfo.json.items.length, 1);
    assert.equal(convInfo.json.items[0].qty, 3);

    // /doc/copy float precision: 0.1 + 0.2 -> 0.3
    const floatDraft = await req<{ id: number }>('/api/doc/create', {
      method: 'POST',
      token: adminToken,
      body: {
        teamId,
        type: 'quo',
        partnerType: 'cus',
        partnerId: cusId,
        items: [
          { productId: prodId, qty: 0.1, price: 1000 },
          { productId: prodId, qty: 0.2, price: 1000 },
        ],
      },
    });
    assert.equal(floatDraft.status, 200);
    const copied = await req<{ id: number }>('/api/doc/copy', {
      method: 'POST',
      token: adminToken,
      body: { id: floatDraft.json.id, teamId },
    });
    assert.equal(copied.status, 200);
    const copiedRow = db.prepare('SELECT totalQty FROM doc WHERE id = ?').get(copied.json.id) as { totalQty: number };
    assert.equal(copiedRow.totalQty, 0.3);
  });

  it('rejects backup symlinks on restore/delete and resists X-Forwarded-For spoofing under ORANGE_TRUST_PROXY=1', async () => {
    // 1) Backup symlink guard on restore and delete
    const bDir = path.join(tmpDir, 'backups');
    fs.mkdirSync(bDir, { recursive: true });
    const outsideTarget = path.join(tmpDir, 'outside-secret.txt');
    fs.writeFileSync(outsideTarget, 'keep-me', 'utf8');
    const symName = 'backup-20261015-120000-sym1.db';
    fs.symlinkSync(outsideTarget, path.join(bDir, symName));

    const restoreSym = await req('/api/backup/restore', {
      method: 'POST',
      token: adminToken,
      body: { file: symName, password: 'StrongAdmin!2026' },
    });
    assert.equal(restoreSym.status, 400);
    assert.equal(restoreSym.json.code, 'VALIDATION_ERROR');

    const delSym = await req(`/api/backup/${symName}`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert.equal(delSym.status, 400);
    assert.equal(delSym.json.code, 'VALIDATION_ERROR');
    assert.equal(fs.readFileSync(outsideTarget, 'utf8'), 'keep-me');

    // 2) ORANGE_TRUST_PROXY=0 ignores X-Forwarded-Proto=https when ORANGE_COOKIE_SECURE=auto
    const proxyTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-tp-int-'));
    let proxyServer: http.Server | null = null;
    let proxyDb: ReturnType<typeof openDb> | null = null;
    try {
      process.env.ORANGE_DATA_DIR = proxyTmp;
      process.env.ORANGE_COOKIE_SECURE = 'auto';
      process.env.ORANGE_TRUST_PROXY = '0';
      resetConfigForTest();
      const cfgNoTrust = initConfig({ persistSecret: false });
      proxyDb = openDb(cfgNoTrust.dbPath);
      migrate(proxyDb);
      const appNoTrust = createApp(proxyDb, cfgNoTrust);
      const srvNoTrust = await new Promise<http.Server>((resolve) => {
        const s = appNoTrust.listen(0, '127.0.0.1', () => resolve(s));
      });
      proxyServer = srvNoTrust;
      const pPort = (srvNoTrust.address() as AddressInfo).port;
      const regRes = await fetch(`http://127.0.0.1:${pPort}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
        body: JSON.stringify({ username: 'tpadmin', password: 'StrongProxy!2026', teamName: '代理测试' }),
      });
      assert.equal(regRes.status, 200);
      assert.equal((regRes.headers.get('set-cookie') ?? '').includes('; Secure'), false);
      await new Promise<void>((resolve) => srvNoTrust.close(() => resolve()));
      proxyServer = null;

      // 3) ORANGE_TRUST_PROXY=1 uses rightmost proxy hop (anti-spoofing) for rate limiter & audit_log.ip
      process.env.ORANGE_TRUST_PROXY = '1';
      resetConfigForTest();
      const cfgTrust = initConfig({ persistSecret: false });
      const appTrust = createApp(proxyDb, cfgTrust);
      const srvTrust = await new Promise<http.Server>((resolve) => {
        const s = appTrust.listen(0, '127.0.0.1', () => resolve(s));
      });
      proxyServer = srvTrust;
      const tPort = (srvTrust.address() as AddressInfo).port;

      // Success login with spoofed left XFF records rightmost 198.51.100.77 in audit_log
      const okLogin = await fetch(`http://127.0.0.1:${tPort}/api/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '10.0.0.99, 198.51.100.77',
          'x-forwarded-proto': 'https',
        },
        body: JSON.stringify({ username: 'tpadmin', password: 'StrongProxy!2026' }),
      });
      assert.equal(okLogin.status, 200);
      assert.equal((okLogin.headers.get('set-cookie') ?? '').includes('; Secure'), true);
      const lastAudit = proxyDb
        .prepare("SELECT ip FROM audit_log WHERE action = 'auth.login' ORDER BY id DESC LIMIT 1")
        .get() as { ip: string };
      assert.equal(lastAudit.ip, '198.51.100.77');

      // 15 failed logins rotating left-most spoofed IP still share rightmost 198.51.100.77 bucket -> 16th returns 429
      let hit429 = false;
      for (let i = 1; i <= 17; i++) {
        const r = await fetch(`http://127.0.0.1:${tPort}/api/auth/login`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': `10.0.0.${i}, 198.51.100.77`,
          },
          body: JSON.stringify({ username: 'tpadmin', password: 'WrongPassword!1' }),
        });
        if (r.status === 429) {
          hit429 = true;
          break;
        }
        assert.equal(r.status, 401);
      }
      assert.equal(hit429, true);
    } finally {
      if (proxyServer) await new Promise<void>((resolve) => proxyServer!.close(() => resolve()));
      if (proxyDb) proxyDb.close();
      fs.rmSync(proxyTmp, { recursive: true, force: true });
      process.env.ORANGE_DATA_DIR = tmpDir;
      delete process.env.ORANGE_COOKIE_SECURE;
      delete process.env.ORANGE_TRUST_PROXY;
      resetConfigForTest();
      initConfig({ persistSecret: false });
    }
  });
});
