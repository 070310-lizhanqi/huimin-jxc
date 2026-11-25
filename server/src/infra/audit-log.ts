/**
 * 核心业务与安全事件审计日志（audit_log）
 * - 自动对 detail 中的敏感字段（password/token/secret/inviteCode 等）做脱敏
 * - 写入失败不反向拖垮非审计主流程，关键账务写事务可直接在事务内调用 recordAuditTx
 */
import type { Request } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { getRequestId } from './errors';
import { logger } from './logger';

export interface AuditEntryInput {
  teamId: number;
  userId?: number | null;
  username?: string | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  requestId?: string | null;
  ip?: string | null;
  detail?: Record<string, unknown> | string | null;
}

const SENSITIVE_KEY_RE =
  /^(?:password|oldPassword|newPassword|token|secret|jwtSecret|inviteCode|authorization|cookie)$/i;

function sanitizeValue(val: unknown, depth = 0): unknown {
  if (depth > 4 || val === null || val === undefined) return val;
  if (typeof val === 'string') return val.length > 300 ? `${val.slice(0, 300)}...` : val;
  if (typeof val === 'number' || typeof val === 'boolean') return val;
  if (Array.isArray(val)) return val.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  if (typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? '[REDACTED]' : sanitizeValue(v, depth + 1);
    }
    return out;
  }
  return String(val);
}

function formatDetail(detail: AuditEntryInput['detail']): string | null {
  if (detail === undefined || detail === null) return null;
  const raw = typeof detail === 'string' ? detail : JSON.stringify(sanitizeValue(detail));
  if (!raw) return null;
  return raw.length > 2000 ? raw.slice(0, 2000) : raw;
}

export function recordAuditTx(db: DatabaseSync, entry: AuditEntryInput): void {
  const detailStr = formatDetail(entry.detail);
  const entityIdStr =
    entry.entityId !== undefined && entry.entityId !== null && String(entry.entityId).trim() !== ''
      ? String(entry.entityId)
      : null;
  db.prepare(
    `INSERT INTO audit_log (teamId, userId, username, action, entityType, entityId, requestId, ip, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.teamId,
    entry.userId ?? null,
    entry.username ? entry.username.slice(0, 60) : null,
    entry.action.slice(0, 64),
    entry.entityType.slice(0, 40),
    entityIdStr ? entityIdStr.slice(0, 64) : null,
    entry.requestId ? entry.requestId.slice(0, 64) : null,
    entry.ip ? entry.ip.slice(0, 64) : null,
    detailStr,
  );
}

export function recordAudit(db: DatabaseSync, entry: AuditEntryInput): void {
  try {
    recordAuditTx(db, entry);
  } catch (err) {
    // 非事务外围审计写失败只告警不中断业务请求（若在事务内强一致记账请使用 recordAuditTx）
    logger.warn('Failed to persist audit log entry', {
      err: err instanceof Error ? err.message : String(err),
      action: entry.action,
    });
  }
}

export function extractClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (req.app?.get('trust proxy') && typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? req.ip ?? 'unknown';
}

export function recordAuditFromRequest(
  db: DatabaseSync,
  req: Request,
  entry: Omit<AuditEntryInput, 'teamId' | 'userId' | 'username' | 'requestId' | 'ip'> & { teamId?: number },
): void {
  const teamId = entry.teamId ?? req.auth?.teamId ?? 0;
  recordAudit(db, {
    ...entry,
    teamId,
    userId: req.auth?.userId ?? null,
    username: req.auth?.name ?? null,
    requestId: getRequestId(req) ?? null,
    ip: extractClientIp(req),
  });
}

export function recordAuditTxFromRequest(
  db: DatabaseSync,
  req: Request,
  entry: Omit<AuditEntryInput, 'teamId' | 'userId' | 'username' | 'requestId' | 'ip'> & { teamId?: number },
): void {
  const teamId = entry.teamId ?? req.auth?.teamId ?? 0;
  recordAuditTx(db, {
    ...entry,
    teamId,
    userId: req.auth?.userId ?? null,
    username: req.auth?.name ?? null,
    requestId: getRequestId(req) ?? null,
    ip: extractClientIp(req),
  });
}
