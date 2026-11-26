/**
 * 结构化日志与敏感信息脱敏模块
 * - 支持 AsyncLocalStorage 透传 requestId / userId / teamId
 * - 支持 LOG_LEVEL（debug | info | warn | error）与 LOG_FORMAT（json | pretty）
 * - 递归脱敏密码、令牌、Cookie、密钥等敏感字段，避免泄露到 stdout/stderr 或日志文件
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { LogFormat, LogLevel } from '../config/env';

export interface LogContext {
  requestId?: string;
  userId?: number;
  teamId?: number;
}

export type LogSink = (level: LogLevel, line: string) => void;

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  sink?: LogSink;
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  child(defaultMeta: Record<string, unknown>): Logger;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY_RE =
  /(?:pass(?:word|wd)?|secret|token|cookie|authorization|invite[-_]?code|api[-_]?key|credential|private[-_]?key|session)/i;

const logContextStorage = new AsyncLocalStorage<LogContext>();

let configuredLevel: LogLevel | null = null;
let configuredFormat: LogFormat | null = null;

function resolveEnvLevel(): LogLevel {
  if (configuredLevel) return configuredLevel;
  const raw = (process.env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
}

function resolveEnvFormat(): LogFormat {
  if (configuredFormat) return configuredFormat;
  const raw = (process.env.LOG_FORMAT ?? '').trim().toLowerCase();
  if (raw === 'json' || raw === 'pretty') {
    return raw;
  }
  return process.env.NODE_ENV === 'production' ? 'json' : 'pretty';
}

export function configureLogger(options: { level?: LogLevel; format?: LogFormat }): void {
  if (options.level) configuredLevel = options.level;
  if (options.format) configuredFormat = options.format;
}

export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return logContextStorage.run({ ...ctx }, fn);
}

export function getLogContext(): LogContext | undefined {
  return logContextStorage.getStore();
}

export function updateLogContext(patch: Partial<LogContext>): void {
  const store = logContextStorage.getStore();
  if (!store) return;
  if (patch.requestId !== undefined) store.requestId = patch.requestId;
  if (patch.userId !== undefined) store.userId = patch.userId;
  if (patch.teamId !== undefined) store.teamId = patch.teamId;
}

export function redactStringValue(input: string): string {
  const redacted = input
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(oc_token)=[^;\s]+/gi, '$1=[REDACTED]')
    .replace(/\b(password|passwd|secret|token|apiKey|api_key|inviteCode)=([^\s,&]+)/gi, '$1=[REDACTED]');
  return redacted.length > 2000 ? `${redacted.slice(0, 2000)}...` : redacted;
}

export function sanitizeLogValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactStringValue(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (depth >= 5) return '[MaxDepth]';

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (Buffer.isBuffer(value)) {
    return `<Buffer ${value.length} bytes>`;
  }
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: redactStringValue(value.message),
    };
    const errWithCode = value as Error & { code?: unknown };
    if (errWithCode.code !== undefined) {
      out.code = typeof errWithCode.code === 'string' ? errWithCode.code : String(errWithCode.code);
    }
    if (value.stack) {
      out.stack = redactStringValue(value.stack);
    }
    return out;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 50).map((item) => sanitizeLogValue(item, depth + 1, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeLogValue(v, depth + 1, seen);
      }
    }
    return out;
  }

  return String(value);
}

function defaultSink(level: LogLevel, line: string): void {
  if (level === 'error' || level === 'warn') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

export function createLogger(options: LoggerOptions = {}, boundMeta: Record<string, unknown> = {}): Logger {
  const emit = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    const activeLevel = options.level ?? resolveEnvLevel();
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[activeLevel]) {
      return;
    }

    const activeFormat = options.format ?? resolveEnvFormat();
    const sink = options.sink ?? defaultSink;
    const ctx = getLogContext();
    const ts = new Date().toISOString();
    const cleanMsg = redactStringValue(message);

    const combinedMeta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(boundMeta)) {
      combinedMeta[k] = v;
    }
    if (meta) {
      for (const [k, v] of Object.entries(meta)) {
        combinedMeta[k] = v;
      }
    }
    const sanitizedMeta = sanitizeLogValue(combinedMeta) as Record<string, unknown>;

    if (activeFormat === 'json') {
      const record: Record<string, unknown> = {
        ts,
        level,
        msg: cleanMsg,
        ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
        ...(ctx?.teamId !== undefined ? { teamId: ctx.teamId } : {}),
        ...(ctx?.userId !== undefined ? { userId: ctx.userId } : {}),
        ...sanitizedMeta,
      };
      sink(level, JSON.stringify(record));
      return;
    }

    const reqTag = ctx?.requestId ? `[${ctx.requestId.slice(0, 8)}] ` : '';
    const hasMeta = Object.keys(sanitizedMeta).length > 0;
    const metaSuffix = hasMeta ? ` ${JSON.stringify(sanitizedMeta)}` : '';
    sink(level, `[${ts}] ${level.toUpperCase().padEnd(5)} ${reqTag}${cleanMsg}${metaSuffix}`);
  };

  return {
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
    child: (extraMeta) => createLogger(options, { ...boundMeta, ...extraMeta }),
  };
}

export const logger: Logger = createLogger();

function isQuietProbePath(pathname: string): boolean {
  return (
    pathname === '/health' ||
    pathname === '/ready' ||
    pathname === '/api/health' ||
    pathname === '/api/ready' ||
    !pathname.startsWith('/api')
  );
}

export const requestLoggingMiddleware: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  const startNs = process.hrtime.bigint();
  const pathname = (req.originalUrl || req.url || '/').split('?')[0];

  res.on('finish', () => {
    const reqWithAuth = req as Request & { auth?: { userId?: number; teamId?: number }; requestId?: string };
    if (reqWithAuth.auth) {
      updateLogContext({
        userId: reqWithAuth.auth.userId,
        teamId: reqWithAuth.auth.teamId,
      });
    }

    const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    const status = res.statusCode;
    const meta: Record<string, unknown> = {
      method: req.method,
      path: pathname,
      status,
      durationMs: Number(durationMs.toFixed(2)),
    };
    if (reqWithAuth.requestId && !getLogContext()?.requestId) {
      meta.requestId = reqWithAuth.requestId;
    }
    if (reqWithAuth.auth?.teamId !== undefined) {
      meta.teamId = reqWithAuth.auth.teamId;
    }
    if (reqWithAuth.auth?.userId !== undefined) {
      meta.userId = reqWithAuth.auth.userId;
    }

    if (status >= 500) {
      logger.error('HTTP request failed', meta);
    } else if (status >= 400 && !isQuietProbePath(pathname)) {
      logger.warn('HTTP request rejected', meta);
    } else if (isQuietProbePath(pathname)) {
      logger.debug('HTTP request completed', meta);
    } else {
      logger.info('HTTP request completed', meta);
    }
  });

  next();
};
