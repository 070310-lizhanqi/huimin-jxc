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

describe('Phase 4 Integration Tests: Health & Readiness Probes + Request Tracing', () => {
  const savedEnv = { ...process.env };
  let tmpDir = '';
  let db: ReturnType<typeof openDb>;
  let server: http.Server;
  let baseUrl = '';

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-health-'));
    process.env.ORANGE_ENV_FILE = '';
    process.env.ORANGE_DATA_DIR = tmpDir;
    process.env.ORANGE_JWT_SECRET = crypto.randomBytes(32).toString('hex');
    process.env.LOG_LEVEL = 'error';
    resetConfigForTest();
    const cfg = initConfig({ persistSecret: false });
    db = openDb(cfg.dbPath);
    migrate(db);
    const app = createApp(db, cfg);
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      db.close();
    } catch {
      /* may already be closed in readiness test */
    }
    resetConfigForTest();
    process.env = { ...savedEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exposes unauthenticated /health, /api/health, /ready, and /api/ready probes with requestId propagation', async () => {
    const h1 = await fetch(`${baseUrl}/health`, { headers: { 'x-request-id': 'probe-health-1' } });
    assert.equal(h1.status, 200);
    assert.equal(h1.headers.get('x-request-id'), 'probe-health-1');
    const h1Json = (await h1.json()) as Record<string, unknown>;
    assert.equal(h1Json.status, 'ok');
    assert.equal(h1Json.service, 'zhanhui-jxc');
    assert.ok(typeof h1Json.version === 'string' && h1Json.version.length > 0);

    const h2 = await fetch(`${baseUrl}/api/health`);
    assert.equal(h2.status, 200);
    assert.ok(Boolean(h2.headers.get('x-request-id')));

    const r1 = await fetch(`${baseUrl}/ready`);
    assert.equal(r1.status, 200);
    const r1Json = (await r1.json()) as Record<string, unknown>;
    assert.equal(r1Json.status, 'ready');
    assert.equal(r1Json.schemaVersion, 3);

    const r2 = await fetch(`${baseUrl}/api/ready`);
    assert.equal(r2.status, 200);
    const r2Json = (await r2.json()) as Record<string, unknown>;
    assert.equal(r2Json.status, 'ready');
  });

  it('returns 503 SERVICE_UNAVAILABLE from /ready when database connection is closed while keeping /health 200', async () => {
    db.close();

    const liveness = await fetch(`${baseUrl}/health`);
    assert.equal(liveness.status, 200);

    const readiness = await fetch(`${baseUrl}/ready`, { headers: { 'x-request-id': 'probe-ready-down' } });
    assert.equal(readiness.status, 503);
    const body = (await readiness.json()) as Record<string, unknown>;
    assert.equal(body.status, 'not_ready');
    assert.equal(body.code, 'SERVICE_UNAVAILABLE');
    assert.equal(body.requestId, 'probe-ready-down');
    assert.ok(!JSON.stringify(body).includes('database is not open'));

    const apiReadiness = await fetch(`${baseUrl}/api/ready`);
    assert.equal(apiReadiness.status, 503);
  });
});
