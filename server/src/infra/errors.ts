/**
 * 统一应用异常、标准错误码与 Express 错误处理中间件
 * - 所有错误响应保持既有 `{ error }` 兼容字段，同时附加 `code` 与 `requestId`
 * - 捕获畸形 JSON SyntaxError 返回 400（而非默认 500）
 * - 兜底未知错误统一返回 500，绝不把内部异常栈或 SQLite 细节泄露给客户端
 */
import type { NextFunction, Request, Response } from 'express';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'BAD_JSON'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, 'VALIDATION_ERROR', message, details);
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = '未登录或令牌已失效') {
    super(401, 'UNAUTHORIZED', message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = '权限不足') {
    super(403, 'FORBIDDEN', message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = '资源不存在') {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'CONFLICT', message);
    this.name = 'ConflictError';
  }
}

export class RateLimitError extends AppError {
  constructor(message = '请求过于频繁，请稍后再试') {
    super(429, 'RATE_LIMITED', message);
    this.name = 'RateLimitError';
  }
}

export class BusyError extends AppError {
  constructor(message = '系统繁忙，请重试') {
    super(503, 'SERVICE_UNAVAILABLE', message);
    this.name = 'BusyError';
  }
}

export function defaultCodeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'VALIDATION_ERROR';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR';
  }
}

export function getRequestId(req?: Request): string | undefined {
  if (!req) return undefined;
  return (req as Request & { requestId?: string }).requestId;
}

export function sendError(
  req: Request,
  res: Response,
  status: number,
  error: string,
  code: ErrorCode = defaultCodeForStatus(status),
  extra?: Record<string, unknown>,
): Response {
  const requestId = getRequestId(req);
  const payload: Record<string, unknown> = {
    error,
    code,
    ...(requestId ? { requestId } : {}),
    ...(extra ?? {}),
  };
  return res.status(status).json(payload);
}

function isMalformedJsonError(err: unknown): boolean {
  if (!(err instanceof SyntaxError)) return false;
  const e = err as SyntaxError & { status?: unknown; type?: unknown; body?: unknown };
  return e.status === 400 && (e.type === 'entity.parse.failed' || 'body' in e);
}

function isPayloadTooLargeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: unknown; type?: unknown };
  return e.status === 413 || e.type === 'entity.too.large';
}

export function expressErrorMiddleware(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  if (isMalformedJsonError(err)) {
    sendError(req, res, 400, '请求体 JSON 格式不正确', 'BAD_JSON');
    return;
  }
  if (isPayloadTooLargeError(err)) {
    sendError(req, res, 413, '请求体过大，超出限制', 'VALIDATION_ERROR');
    return;
  }
  if (err instanceof AppError) {
    sendError(req, res, err.statusCode, err.message, err.code, err.details);
    return;
  }
  console.error('[express-error]', { requestId: getRequestId(req), path: req.originalUrl, err });
  sendError(req, res, 500, '服务器内部错误', 'INTERNAL_ERROR');
}
