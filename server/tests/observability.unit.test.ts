import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLogger,
  redactStringValue,
  runWithLogContext,
  sanitizeLogValue,
  updateLogContext,
} from '../src/infra/logger';

describe('Phase 4 Unit Tests: Structured Logger, Redaction & Request Tracing', () => {
  it('filters log entries below configured LOG_LEVEL and formats structured JSON', () => {
    const lines: Array<{ level: string; line: string }> = [];
    const log = createLogger({
      level: 'warn',
      format: 'json',
      sink: (level, line) => lines.push({ level, line }),
    });

    log.debug('debug msg', { step: 1 });
    log.info('info msg', { step: 2 });
    log.warn('warn msg', { step: 3 });
    log.error('error msg', { step: 4 });

    assert.equal(lines.length, 2);
    assert.equal(lines[0].level, 'warn');
    assert.equal(lines[1].level, 'error');

    const warnObj = JSON.parse(lines[0].line) as Record<string, unknown>;
    assert.equal(warnObj.level, 'warn');
    assert.equal(warnObj.msg, 'warn msg');
    assert.equal(warnObj.step, 3);
    assert.ok(typeof warnObj.ts === 'string' && warnObj.ts.length > 10);
  });

  it('recursively redacts sensitive keys, Bearer headers, cookie values, and handles cycles safely', () => {
    const circular: Record<string, unknown> = { ok: true, nested: { apiKey: 'secret-api-key-999' } };
    circular.self = circular;

    const sanitized = sanitizeLogValue({
      username: 'alice',
      password: 'MyPassword123!',
      jwtSecret: 'abcdef',
      nested: {
        authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
        inviteCode: 'INV-9988',
        cookie: 'oc_token=xyz123; HttpOnly',
      },
      circular,
    }) as Record<string, unknown>;

    assert.equal(sanitized.username, 'alice');
    assert.equal(sanitized.password, '[REDACTED]');
    assert.equal(sanitized.jwtSecret, '[REDACTED]');

    const nested = sanitized.nested as Record<string, unknown>;
    assert.equal(nested.authorization, '[REDACTED]');
    assert.equal(nested.inviteCode, '[REDACTED]');
    assert.equal(nested.cookie, '[REDACTED]');

    const circOut = sanitized.circular as Record<string, unknown>;
    assert.equal((circOut.nested as Record<string, unknown>).apiKey, '[REDACTED]');
    assert.equal(circOut.self, '[Circular]');

    const maskedStr = redactStringValue(
      'Failed with Authorization Bearer abc.def.ghi and oc_token=secret_tok; password=rawpass',
    );
    assert.ok(!maskedStr.includes('abc.def.ghi'));
    assert.ok(!maskedStr.includes('secret_tok'));
    assert.ok(!maskedStr.includes('rawpass'));
    assert.ok(maskedStr.includes('Bearer [REDACTED]'));
    assert.ok(maskedStr.includes('oc_token=[REDACTED]'));
  });

  it('propagates requestId, teamId, and userId across async boundaries via AsyncLocalStorage', async () => {
    const captured: string[] = [];
    const log = createLogger({
      level: 'info',
      format: 'json',
      sink: (_level, line) => captured.push(line),
    }).child({ component: 'test-service' });

    await runWithLogContext({ requestId: 'req-trace-42' }, async () => {
      await Promise.resolve();
      updateLogContext({ teamId: 7, userId: 19 });
      log.info('operation finished', { docId: 101 });
    });

    assert.equal(captured.length, 1);
    const parsed = JSON.parse(captured[0]) as Record<string, unknown>;
    assert.equal(parsed.requestId, 'req-trace-42');
    assert.equal(parsed.teamId, 7);
    assert.equal(parsed.userId, 19);
    assert.equal(parsed.component, 'test-service');
    assert.equal(parsed.docId, 101);
  });
});
