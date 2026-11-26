/**
 * 健康检查与就绪探针路由（无需登录即可访问，供容器健康检查与监控系统探活）
 * - GET /health, /api/health：进程存活探针（Liveness）
 * - GET /ready,  /api/ready：数据库连通性与迁移就绪探针（Readiness）
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Express, Request, Response } from 'express';
import { getSchemaVersion } from '../db';
import { getRequestId } from '../infra/errors';
import { logger } from '../infra/logger';

export interface HealthMountOptions {
  version?: string;
  checkReady?: () => boolean;
}

let cachedVersion: string | null = null;

export function readAppVersion(): string {
  if (cachedVersion) return cachedVersion;
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'package.json'),
    path.join(__dirname, '..', '..', 'package.json'),
    path.join(process.cwd(), 'package.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim()) {
        cachedVersion = parsed.version.trim();
        return cachedVersion;
      }
    } catch {
      /* 尝试下一候选路径 */
    }
  }
  cachedVersion = 'unknown';
  return cachedVersion;
}

export function mountHealthRoutes(app: Express, db: DatabaseSync, options: HealthMountOptions = {}): void {
  const version = options.version ?? readAppVersion();

  const handleLiveness = (_req: Request, res: Response): void => {
    res.status(200).json({
      status: 'ok',
      service: 'zhanhui-jxc',
      version,
      pid: process.pid,
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  };

  const handleReadiness = (req: Request, res: Response): void => {
    try {
      if (options.checkReady && !options.checkReady()) {
        throw new Error('custom readiness check returned false');
      }
      const probe = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
      if (!probe || probe.ok !== 1) {
        throw new Error('database probe returned unexpected result');
      }
      const schemaVersion = getSchemaVersion(db);
      res.status(200).json({
        status: 'ready',
        service: 'zhanhui-jxc',
        version,
        schemaVersion,
        uptimeSec: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn('Readiness probe failed', { err });
      const requestId = getRequestId(req);
      res.status(503).json({
        status: 'not_ready',
        error: '数据库或服务未就绪',
        code: 'SERVICE_UNAVAILABLE',
        ...(requestId ? { requestId } : {}),
        timestamp: new Date().toISOString(),
      });
    }
  };

  app.get('/health', handleLiveness);
  app.get('/api/health', handleLiveness);
  app.get('/ready', handleReadiness);
  app.get('/api/ready', handleReadiness);
}
