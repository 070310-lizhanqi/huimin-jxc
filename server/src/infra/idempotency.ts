/**
 * 持久化幂等键（Idempotency-Key HTTP Header）支持
 * - 与既有 3s/5s 内存防重窗并存：不传 Idempotency-Key 时保持既有行为
 * - 传入 Idempotency-Key 时：相同参数重放原状态码与响应体；相同 Key 不同请求体返回 409 Conflict
 */
import crypto from 'node:crypto';
import type { Request } from 'express';
import type { DatabaseSync } from 'node:sqlite';

const KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
let writeCounter = 0;

export type ExtractedIdempotencyKey = { present: false } | { present: true; key: string } | { error: string };

export function extractIdempotencyKey(req: Request): ExtractedIdempotencyKey {
  const raw = req.headers['idempotency-key'];
  if (raw === undefined) return { present: false };
  const val = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = String(val ?? '').trim();
  if (!trimmed || !KEY_RE.test(trimmed)) {
    return { error: 'Idempotency-Key 格式非法（需 1-128 位字母/数字/._:-）' };
  }
  return { present: true, key: trimmed };
}

function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (key === 'teamId') continue;
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

export function hashRequestPayload(scope: string, body: unknown): string {
  const normalized = JSON.stringify({ scope, body: canonicalize(body) });
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export type IdempotencyLookupResult =
  { hit: false } | { conflict: true } | { hit: true; statusCode: number; body: unknown };

export function lookupIdempotencyKey(
  db: DatabaseSync,
  teamId: number,
  scope: string,
  key: string,
  requestHash: string,
): IdempotencyLookupResult {
  const row = db
    .prepare(
      `SELECT requestHash, statusCode, responseBody, createdAt FROM idempotency_key WHERE teamId = ? AND scope = ? AND key = ?`,
    )
    .get(teamId, scope, key) as
    { requestHash: string; statusCode: number; responseBody: string; createdAt: number } | undefined;
  if (!row) return { hit: false };
  if (Date.now() - row.createdAt > IDEMPOTENCY_TTL_MS) {
    db.prepare(`DELETE FROM idempotency_key WHERE teamId = ? AND scope = ? AND key = ?`).run(teamId, scope, key);
    return { hit: false };
  }
  if (row.requestHash !== requestHash) {
    return { conflict: true };
  }
  return {
    hit: true,
    statusCode: row.statusCode,
    body: JSON.parse(row.responseBody) as unknown,
  };
}

export function saveIdempotencyKey(
  db: DatabaseSync,
  teamId: number,
  scope: string,
  key: string,
  requestHash: string,
  statusCode: number,
  body: unknown,
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO idempotency_key (teamId, scope, key, requestHash, statusCode, responseBody, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(teamId, scope, key) DO UPDATE SET
       requestHash = excluded.requestHash,
       statusCode = excluded.statusCode,
       responseBody = excluded.responseBody,
       createdAt = excluded.createdAt`,
  ).run(teamId, scope, key, requestHash, statusCode, JSON.stringify(body), now);

  writeCounter++;
  if (writeCounter % 100 === 0) {
    db.prepare(`DELETE FROM idempotency_key WHERE createdAt < ?`).run(now - IDEMPOTENCY_TTL_MS);
  }
}
