/**
 * 请求追踪 ID、DNS Rebinding Host 守卫、CORS、Cookie CSRF Origin 守卫与基线安全头中间件
 */
import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { sendError } from '../infra/errors';

const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const UNSAFE_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const requestIdMiddleware: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
  const incoming = req.headers['x-request-id'];
  const raw = Array.isArray(incoming) ? incoming[0] : incoming;
  const requestId = raw && SAFE_REQUEST_ID_RE.test(raw.trim()) ? raw.trim() : crypto.randomUUID();
  (req as Request & { requestId?: string }).requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
};

export function createHostAllowedFn(extraAllowHosts: readonly string[]): (hostHeader: string) => boolean {
  const allowSet = new Set(['127.0.0.1', 'localhost', '[::1]', ...extraAllowHosts.map((h) => h.toLowerCase())]);
  return (hostHeader: string): boolean => {
    const bare = hostHeader.replace(/:\d+$/, '').toLowerCase();
    if (allowSet.has(bare)) return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
  };
}

/** Host 白名单检查（必须在 CORS 之前，防止预检绕过） */
export function hostGuardMiddleware(hostAllowed: (hostHeader: string) => boolean): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = String(req.headers.host ?? '');
    if (host && !hostAllowed(host)) {
      sendError(req, res, 421, '请求 Host 不在允许列表内（本机应用默认仅允许 127.0.0.1/localhost）', 'FORBIDDEN');
      return;
    }
    next();
  };
}

export function corsMiddleware(port: number, extraAllowHosts: readonly string[]): RequestHandler {
  const allowOrigins = new Set([
    ...[port, 19387].flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]),
    ...extraAllowHosts.flatMap((h) => [`http://${h}`, `https://${h}`, `http://${h}:${port}`, `https://${h}:${port}`]),
  ]);

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin && allowOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-request-id,idempotency-key');
      res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id,Idempotent-Replayed');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

/**
 * 基于 Cookie 凭据的写操作 CSRF Origin 核验：
 * 当请求带 oc_token Cookie 且不带 Authorization Bearer，且浏览器发送了 Origin 头时，
 * 必须确认 Origin 主机属于本机/白名单 Host，阻断第三方网站诱导提交的跨站写请求。
 */
export function csrfOriginGuardMiddleware(hostAllowed: (hostHeader: string) => boolean): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!UNSAFE_HTTP_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }
    const authHeader = String(req.headers.authorization ?? '');
    if (/^Bearer\s+/i.test(authHeader)) {
      next();
      return;
    }
    const cookieHeader = String(req.headers.cookie ?? '');
    if (!/\boc_token=/.test(cookieHeader)) {
      next();
      return;
    }
    const origin = String(req.headers.origin ?? '').trim();
    if (!origin || origin === 'null') {
      if (origin === 'null') {
        sendError(req, res, 403, '跨站请求已被拒绝（Origin 非法）', 'FORBIDDEN');
        return;
      }
      next();
      return;
    }
    try {
      const parsed = new URL(origin);
      const hostBare = parsed.hostname.toLowerCase();
      const bracketed = parsed.hostname.includes(':') ? `[${hostBare}]` : hostBare;
      const reqHostBare = String(req.headers.host ?? '')
        .replace(/:\d+$/, '')
        .toLowerCase();
      if (hostBare === reqHostBare || hostAllowed(hostBare) || hostAllowed(bracketed)) {
        next();
        return;
      }
    } catch {
      // Origin 解析失败直接拦截
    }
    sendError(req, res, 403, '跨站写请求已被拒绝', 'FORBIDDEN');
  };
}

export const securityHeadersMiddleware: RequestHandler = (_req: Request, res: Response, next: NextFunction): void => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
};
