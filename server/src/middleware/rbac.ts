/**
 * RBAC 角色守卫中间件
 */
import type { NextFunction, Request, Response } from 'express';
import { sendError } from '../infra/errors';

export function requireRole(allowedRoles: readonly string[], forbiddenMessage = '权限不足，无权执行此操作') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      sendError(req, res, 401, '未登录或令牌已失效', 'UNAUTHORIZED');
      return;
    }
    if (!allowedRoles.includes(req.auth.role)) {
      sendError(req, res, 403, forbiddenMessage, 'FORBIDDEN');
      return;
    }
    next();
  };
}

export function requireAdmin(forbiddenMessage = '仅管理员可执行此操作') {
  return requireRole(['admin'], forbiddenMessage);
}
