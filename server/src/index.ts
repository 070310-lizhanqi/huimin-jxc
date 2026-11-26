/**
 * 服务入口：配置初始化、数据库迁移、gzip 静态加速、单实例锁与优雅停机
 */
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createApp } from './app';
import { ConfigError, initConfig } from './config/env';
import type { AppConfig } from './config/env';
import { dataDir, migrate, openDb, tryCheckpoint } from './db';
import { recordAuditFromRequest } from './infra/audit-log';
import { sendError } from './infra/errors';
import { configureLogger, logger } from './infra/logger';
import { requireAdmin } from './middleware/rbac';

let appConfig: AppConfig;
try {
  appConfig = initConfig({ warn: (msg) => logger.warn(msg) });
  configureLogger({ level: appConfig.logLevel, format: appConfig.logFormat });
} catch (err) {
  if (err instanceof ConfigError) {
    logger.error('Startup failed due to invalid configuration', { message: err.message });
  } else {
    logger.error('Startup failed during config initialization', { err });
  }
  process.exit(1);
}

const PORT = appConfig.port;
const db = openDb(appConfig.dbPath);
migrate(db);

/** 零依赖异步 gzip 中间件（保留 !res.getHeader('content-encoding') 守卫与 /vendor 缓存） */
function createGzipMiddleware(): RequestHandler {
  const GZIP_MIN = 1024;
  const GZIP_MAX_BUFFER = 32 * 1024 * 1024;
  const COMPRESSIBLE = /^(text\/|application\/json|application\/javascript|application\/xml|image\/svg)/;
  const GZIP_SKIP_PATH = /^\/api\/backup\/download/;
  const VENDOR_GZIP_CACHE = new Map<string, { body: Buffer; origSize: number }>();
  let vendorGzipCacheBytes = 0;
  const VENDOR_GZIP_CACHE_MAX = 16 * 1024 * 1024;

  return (req: Request, res: Response, next: NextFunction): void => {
    const accept = String(req.headers['accept-encoding'] ?? '');
    if (!/\bgzip\b/.test(accept) || req.headers['content-encoding']) {
      next();
      return;
    }
    if (GZIP_SKIP_PATH.test(req.path)) {
      next();
      return;
    }
    const reqPath = req.path;
    const reqMethod = req.method;
    const chunks: Buffer[] = [];
    let size = 0;
    let usingGzip = false;
    let overflow = false;
    const origWrite = res.write.bind(res) as (c: unknown) => boolean;
    const origEnd = res.end.bind(res) as (...a: unknown[]) => Response;
    const origSetHeader = res.setHeader.bind(res);
    res.setHeader = (name: string, value: unknown) => {
      if (usingGzip && /^content-length$/i.test(name)) return res;
      return origSetHeader(name, value as never);
    };
    res.write = (chunk: unknown): boolean => {
      if (chunk) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        if (!overflow && size + b.length > GZIP_MAX_BUFFER) {
          overflow = true;
          for (const c of chunks) origWrite(c);
          chunks.length = 0;
          origWrite(b);
          return true;
        }
        if (overflow) {
          origWrite(b);
          return true;
        }
        chunks.push(b);
        size += b.length;
      }
      return true;
    };
    res.end = (...a: unknown[]): Response => {
      const tail = a[0];
      if (tail) {
        const b = Buffer.isBuffer(tail) ? tail : Buffer.from(String(tail));
        if (overflow) {
          origWrite(b);
          return origEnd();
        }
        if (size + b.length > GZIP_MAX_BUFFER) {
          for (const c of chunks) origWrite(c);
          chunks.length = 0;
          origWrite(b);
          return origEnd();
        }
        chunks.push(b);
        size += b.length;
      }
      if (overflow) return origEnd();
      const type = String(res.getHeader('content-type') ?? '').split(';')[0];
      if (size >= GZIP_MIN && COMPRESSIBLE.test(type) && !res.getHeader('content-encoding')) {
        if (reqMethod === 'GET' && reqPath.startsWith('/vendor/')) {
          const hit = VENDOR_GZIP_CACHE.get(reqPath);
          if (hit && hit.origSize === size) {
            usingGzip = true;
            origSetHeader('content-encoding', 'gzip');
            origSetHeader('content-length', String(hit.body.length));
            origSetHeader('vary', 'Accept-Encoding');
            origWrite(hit.body);
            return origEnd();
          }
        }
        usingGzip = true;
        const body = Buffer.concat(chunks);
        chunks.length = 0;
        zlib.gzip(body, { level: 6 }, (err, gzipped) => {
          if (err || !gzipped) {
            logger.error('Gzip compression failed; falling back to plain response', { path: reqPath, err });
            usingGzip = false;
            origWrite(body);
            origEnd();
            return;
          }
          if (reqMethod === 'GET' && reqPath.startsWith('/vendor/') && gzipped.length <= VENDOR_GZIP_CACHE_MAX) {
            if (!VENDOR_GZIP_CACHE.has(reqPath) && vendorGzipCacheBytes + gzipped.length <= VENDOR_GZIP_CACHE_MAX) {
              VENDOR_GZIP_CACHE.set(reqPath, { body: gzipped, origSize: size });
              vendorGzipCacheBytes += gzipped.length;
            }
          }
          origSetHeader('content-encoding', 'gzip');
          origSetHeader('content-length', String(gzipped.length));
          origSetHeader('vary', 'Accept-Encoding');
          origWrite(gzipped);
          origEnd();
        });
        return res;
      }
      for (const c of chunks) origWrite(c);
      return origEnd();
    };
    next();
  };
}

let shutdownHandler: ((signal: string) => Promise<void>) | null = null;

const app = createApp(db, appConfig, {
  gzipMiddleware: createGzipMiddleware(),
  mountApiExtra: (api) => {
    api.post('/admin/shutdown', requireAdmin('仅管理员可执行停机操作'), (req: Request, res: Response) => {
      const remote = req.socket.remoteAddress;
      if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
        return sendError(req, res, 403, '仅允许本机调用', 'FORBIDDEN');
      }
      recordAuditFromRequest(db, req, {
        action: 'admin.shutdown',
        entityType: 'system',
        detail: { remote },
      });
      res.json({ ok: true });
      setTimeout(() => {
        if (shutdownHandler) void shutdownHandler('HTTP');
      }, 50);
      return;
    });
  },
});

function acquireLock(): boolean {
  const lockFile = path.join(dataDir(), 'server.lock');
  try {
    const old = Number(fs.readFileSync(lockFile, 'utf8').trim());
    if (old > 0 && old !== process.pid) {
      try {
        process.kill(old, 0);
        return false;
      } catch {
        /* 残留锁 */
      }
    }
  } catch {
    /* 首次启动 */
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      try {
        fs.writeSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') throw e;
      let other = 0;
      try {
        other = Number(fs.readFileSync(lockFile, 'utf8').trim());
      } catch {
        /* ignore */
      }
      if (!(other > 0) || other === process.pid) {
        try {
          fs.rmSync(lockFile, { force: true });
        } catch {
          /* ignore */
        }
        continue;
      }
      try {
        process.kill(other, 0);
        return false;
      } catch {
        try {
          fs.rmSync(lockFile, { force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }
  let locked = false;
  try {
    locked = Number(fs.readFileSync(lockFile, 'utf8').trim()) === process.pid;
  } catch {
    /* ignore */
  }
  if (!locked) return false;
  process.on('exit', () => {
    try {
      const cur = Number(fs.readFileSync(lockFile, 'utf8').trim());
      if (cur === process.pid) fs.rmSync(lockFile, { force: true });
    } catch {
      /* ignore */
    }
  });
  return true;
}

function writePortFile(port: number): void {
  try {
    const target = path.join(dataDir(), 'port.txt');
    const tmp = `${target}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, String(port));
    fs.renameSync(tmp, target);
  } catch {
    /* 仅影响自动开浏览器 */
  }
}

function listenOn(firstPort: number, tries: number): Promise<{ server: http.Server; port: number }> {
  const host = appConfig.bindHost === 'localhost' ? '127.0.0.1' : appConfig.bindHost;
  return new Promise((resolve, reject) => {
    const attempt = (port: number, left: number) => {
      const server = app.listen(port, host, () => {
        resolve({ server, port });
      });
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && left > 1) attempt(port + 1, left - 1);
        else reject(err);
      });
    };
    attempt(firstPort, tries);
  });
}

(async () => {
  if (!acquireLock()) {
    logger.info('Another zhanhui-jxc instance is already running; exiting', { dataDir: dataDir() });
    process.exit(0);
  }
  const firstPort = PORT;
  const { server, port } = await listenOn(firstPort, 20);
  writePortFile(port);
  logger.info('zhanhui-jxc server listening', {
    port,
    bindHost: appConfig.bindHost,
    nodeEnv: appConfig.nodeEnv,
    url: `http://${appConfig.bindHost === '0.0.0.0' ? '127.0.0.1' : appConfig.bindHost}:${port}`,
  });
  if (port !== firstPort) {
    logger.warn('Preferred port unavailable; shifted to fallback port', { preferredPort: firstPort, actualPort: port });
  }
  try {
    const runtimeDir = path.join(__dirname, '..', '..', '.tools');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'server.pid'), String(process.pid));
  } catch {
    /* ignore */
  }

  let shuttingDown = false;
  const gracefulShutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Graceful shutdown initiated', { signal });
    try {
      await Promise.race([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 10000)),
      ]);
    } catch {
      /* ignore */
    }
    tryCheckpoint(db);
    try {
      db.close();
    } catch {
      /* ignore */
    }
    logger.info('Database closed cleanly; process exiting', { signal });
    process.exit(0);
  };
  shutdownHandler = gracefulShutdown;
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  void server;
})();
