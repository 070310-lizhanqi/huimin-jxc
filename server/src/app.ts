/**
 * Express 应用装配工厂（与端口监听 / 文件锁解耦，便于单元测试与集成测试直接挂载）
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Express, Request, RequestHandler, Response, Router } from 'express';
import express from 'express';
import { mountAging } from './aging';
import { mountAuth, requireAuth } from './auth';
import { mountBackup } from './backup';
import type { AppConfig } from './config/env';
import { mountDashboard } from './dashboard';
import { mountDocImport } from './docimport';
import { expressErrorMiddleware, sendError } from './infra/errors';
import { mountJxcReports } from './jxc-report';
import {
  corsMiddleware,
  createHostAllowedFn,
  csrfOriginGuardMiddleware,
  hostGuardMiddleware,
  requestIdMiddleware,
  securityHeadersMiddleware,
} from './middleware/security';
import { mountPriceMemory } from './price';
import { mountReports } from './report';
import { mountArchiveRoutes } from './routes/archives';
import { mountAuditRoutes } from './routes/audit';
import { mountDocs } from './routes/docs';
import { mountSettings } from './settings';
import { mountSettlements } from './settlement';
import { mountStockQueries } from './stock';

export interface CreateAppOptions {
  beforeRoutes?: (app: Express) => void;
  mountApiExtra?: (api: Router) => void;
  gzipMiddleware?: RequestHandler;
}

export function createApp(db: DatabaseSync, appConfig: AppConfig, options: CreateAppOptions = {}): Express {
  const app = express();
  app.set('x-powered-by', false);
  app.set('trust proxy', appConfig.trustProxy);

  const hostAllowed = createHostAllowedFn(appConfig.allowHosts);
  app.use(requestIdMiddleware);
  // A-安5：Host 白名单检查必须在 CORS 之前，防止任意 Host 通过 OPTIONS 预检
  app.use(hostGuardMiddleware(hostAllowed));
  app.use(corsMiddleware(appConfig.port, appConfig.allowHosts));
  app.use(securityHeadersMiddleware);
  app.use(csrfOriginGuardMiddleware(hostAllowed));
  app.use(express.json({ limit: '2mb' }));

  if (options.gzipMiddleware) {
    app.use(options.gzipMiddleware);
  }
  if (options.beforeRoutes) {
    options.beforeRoutes(app);
  }

  const api: Router = express.Router();

  // 认证路由（注册/登录/状态探测为公开；其余在 mountAuth 内部自带 requireAuth）
  mountAuth(api, db);

  // 业务路由全局强制鉴权（requireAuth 会强制覆盖 req.query/req.body.teamId 为令牌团队）
  api.use(requireAuth);

  mountArchiveRoutes(api, db);
  mountDocs(api, db);
  mountDocImport(api, db);
  mountStockQueries(api, db);
  mountSettlements(api, db);
  mountReports(api, db);
  mountAging(api, db);
  mountDashboard(api, db);
  mountJxcReports(api, db);
  mountPriceMemory(api, db);
  mountSettings(api, db);
  mountBackup(api, db);
  mountAuditRoutes(api, db);

  api.get('/team/list', (req: Request, res: Response) => {
    const u = req.auth;
    if (!u) return sendError(req, res, 401, '未登录', 'UNAUTHORIZED');
    const team = db.prepare(`SELECT id, name, startPeriod FROM team WHERE id = ?`).get(u.teamId);
    return res.json(team ? [team] : []);
  });

  if (options.mountApiExtra) {
    options.mountApiExtra(api);
  }

  app.use('/api', api);

  app.use('/api', (req: Request, res: Response) => {
    sendError(req, res, 404, '接口不存在', 'NOT_FOUND');
  });

  const webRoot = path.join(__dirname, '..', '..', 'web');
  if (fs.existsSync(webRoot)) {
    app.use('/vendor', express.static(path.join(webRoot, 'vendor'), { maxAge: '7d', immutable: true }));
    app.use(
      express.static(webRoot, {
        setHeaders: (res, filePath) => {
          if (/\.(?:html|js|css)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    app.get(/^\/(?!api|vendor\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(webRoot, 'index.html'));
    });
    app.use('/vendor', (req: Request, res: Response) => {
      sendError(req, res, 404, 'vendor 文件不存在', 'NOT_FOUND');
    });
  }

  app.use(expressErrorMiddleware);

  return app;
}
