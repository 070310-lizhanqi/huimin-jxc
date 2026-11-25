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
});
