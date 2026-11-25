/**
 * Express 4 async 路由统一包装（B-安19①：auth.ts 与 backup.ts 此前各写一份，
 * 文案略有出入，现抽到此处单模块共用）。
 *
 * Express 4 不捕获 async 路由抛出的错误；包装后统一返回通用 500 JSON，
 * 详情只写服务端日志，避免未处理 rejection 导致请求挂起，也避免把
 * 内部错误信息回吐给客户端（A-安4）。
 */
import type { Request, Response } from 'express';
import { logger } from './infra/logger';

export function safeHandler(fn: (req: Request, res: Response) => unknown) {
  return (req: Request, res: Response): void => {
    Promise.resolve(fn(req, res)).catch((e) => {
      logger.error('Unhandled async route error', { method: req.method, path: req.originalUrl, err: e });
      if (!res.headersSent) res.status(500).json({ error: '服务器内部错误' });
      else res.end();
    });
  };
}
