/**
 * 功能设置：单据编号规则 + 打印抬头（team 级键值配置）
 */
import type { Request, Response, Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { recordAuditFromRequest } from './infra/audit-log';
import { sendError } from './infra/errors';
import { parsePositiveInt } from './infra/validate';

/** 默认单据前缀（可被 team 配置覆盖） */
export const DEFAULT_PREFIX: Record<string, string> = {
  stockin: 'RK',
  stockout: 'CK',
  transfer: 'DB',
  adjust: 'TZ',
  stocktake: 'PD',
  porder: 'CG',
  sorder: 'XS',
  pin: 'CT',
  sret: 'XT',
  otherin: 'QR',
  otherout: 'QC',
  assembly: 'ZZ',
  stockinit: 'QCQ',
  quo: 'BJ',
  outapply: 'SQ',
  prodtask: 'SC',
};

/**
 * B-安19②：单号前缀表只留 settings.ts 一份（唯一来源）。
 * docimport.ts 与 docs.ts 里的旧硬编码副本已删，单号生成函数收敛到
 * server/src/bill-no.ts（nextBillNo），两处共用。
 */
export const BILL_NO_PREFIXES: Record<string, string> = DEFAULT_PREFIX;

/** 编号日期格式：none=流水不分日期 / day=按日重置 / month=按月重置 */
export type NoMode = 'none' | 'day' | 'month';

export interface PrintConf {
  company: string;
  address: string;
  phone: string;
  footer: string;
  showLogo: boolean;
}

export const DEFAULT_PRINT: PrintConf = {
  company: '',
  address: '',
  phone: '',
  footer: '本单为业务往来凭证，如有疑问请及时联系。',
  showLogo: true,
};

const PRINT_KEY = 'print';

function getSetting(db: DatabaseSync, teamId: number, key: string): string | null {
  const row = db.prepare(`SELECT value FROM setting WHERE teamId = ? AND key = ?`).get(teamId, key) as
    { value: string } | undefined;
  return row ? row.value : null;
}

function setSetting(db: DatabaseSync, teamId: number, key: string, value: string): void {
  db.prepare(
    `INSERT INTO setting (teamId, key, value) VALUES (?, ?, ?)
     ON CONFLICT(teamId, key) DO UPDATE SET value = excluded.value`,
  ).run(teamId, key, value);
}

/** 取某 team 的单据前缀表（缺省回落 DEFAULT_PREFIX） */
export function loadPrefix(db: DatabaseSync, teamId: number): Record<string, string> {
  const raw = getSetting(db, teamId, 'prefix');
  const out: Record<string, string> = { ...DEFAULT_PREFIX };
  if (!raw) return out;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) out[k] = v.trim().toUpperCase().slice(0, 4);
      }
    }
  } catch {
    /* 脏数据回落到默认 */
  }
  return out;
}

/** 取编号重置模式 */
export function loadNoMode(db: DatabaseSync, teamId: number): NoMode {
  const raw = getSetting(db, teamId, 'noMode');
  return raw === 'none' || raw === 'month' ? raw : 'day';
}

/** 取打印抬头配置 */
export function loadPrint(db: DatabaseSync, teamId: number): PrintConf {
  const raw = getSetting(db, teamId, PRINT_KEY);
  if (!raw) return { ...DEFAULT_PRINT };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Record<string, unknown>;
      return {
        company: String(p.company ?? ''),
        address: String(p.address ?? ''),
        phone: String(p.phone ?? ''),
        footer: String(p.footer ?? DEFAULT_PRINT.footer),
        showLogo: p.showLogo !== false,
      };
    }
  } catch {
    /* 脏数据回落 */
  }
  return { ...DEFAULT_PRINT };
}

export function mountSettings(router: Router, db: DatabaseSync): void {
  /**
   * A-安3（后端）：设置写接口仅管理员可用，与 backup.ts 同款 requireAdmin 守卫。
   * mountSettings 挂在全局 requireAuth 之后，req.auth 已由令牌注入。
   * 读接口 /setting/get 不设限（店员看设置页不写即不影响）；E 组并行做前端
   * 店员入口门控，两者随同一批快照发布，不存在 403 窗口。
   */
  const requireAdmin = (req: Request, res: Response): boolean => {
    if (!req.auth) {
      sendError(req, res, 401, '未登录', 'UNAUTHORIZED');
      return false;
    }
    if (req.auth.role !== 'admin') {
      sendError(req, res, 403, '仅管理员可以修改设置', 'FORBIDDEN');
      return false;
    }
    return true;
  };

  /** 读全部设置（前端打开设置页一次取齐） */
  router.get('/setting/get', (req, res) => {
    const teamRes = parsePositiveInt(req.query.teamId, 'teamId');
    if (!teamRes.ok) {
      return sendError(
        req,
        res,
        400,
        req.query.teamId === undefined || req.query.teamId === '' || req.query.teamId === '0'
          ? 'teamId 不能为空'
          : teamRes.error,
        'VALIDATION_ERROR',
      );
    }
    const teamId = teamRes.value;
    return res.json({
      prefix: loadPrefix(db, teamId),
      noMode: loadNoMode(db, teamId),
      print: loadPrint(db, teamId),
      defaults: DEFAULT_PREFIX,
    });
  });

  /** 保存单据编号前缀 */
  router.post('/setting/prefix', (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return sendError(req, res, 400, '请求体必须是对象', 'VALIDATION_ERROR');
    }
    const body = req.body as Record<string, unknown>;
    const teamRes = parsePositiveInt(body.teamId, 'teamId');
    if (!teamRes.ok) {
      return sendError(
        req,
        res,
        400,
        body.teamId === undefined || body.teamId === '' || body.teamId === 0 || body.teamId === '0'
          ? 'teamId 不能为空'
          : teamRes.error,
        'VALIDATION_ERROR',
      );
    }
    const teamId = teamRes.value;
    const input = body.prefix;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return sendError(req, res, 400, 'prefix 不能为空且必须是对象', 'VALIDATION_ERROR');
    }
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (!(k in DEFAULT_PREFIX)) continue;
      if (v === null || v === undefined) continue;
      if (typeof v !== 'string' && typeof v !== 'number') {
        return sendError(req, res, 400, `「${k}」的前缀格式无效`, 'VALIDATION_ERROR');
      }
      const s = String(v).trim();
      if (s === '') continue;
      // 只允许字母数字，1-4 位
      if (!/^[A-Za-z0-9]{1,4}$/.test(s)) {
        return sendError(req, res, 400, `「${k}」的前缀只能填 1-4 位字母或数字`, 'VALIDATION_ERROR');
      }
      clean[k] = s.toUpperCase();
    }
    setSetting(db, teamId, 'prefix', JSON.stringify(clean));
    recordAuditFromRequest(db, req, {
      teamId,
      action: 'setting.prefix',
      entityType: 'setting',
      entityId: 'prefix',
      detail: clean,
    });
    return res.json({ ok: true, prefix: loadPrefix(db, teamId) });
  });

  /** 保存编号重置模式 */
  router.post('/setting/no-mode', (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return sendError(req, res, 400, '请求体必须是对象', 'VALIDATION_ERROR');
    }
    const body = req.body as Record<string, unknown>;
    const teamRes = parsePositiveInt(body.teamId, 'teamId');
    if (!teamRes.ok) {
      return sendError(
        req,
        res,
        400,
        body.teamId === undefined || body.teamId === '' || body.teamId === 0 || body.teamId === '0'
          ? 'teamId 不能为空'
          : teamRes.error,
        'VALIDATION_ERROR',
      );
    }
    const teamId = teamRes.value;
    const mode = typeof body.noMode === 'string' ? body.noMode : '';
    if (mode !== 'none' && mode !== 'day' && mode !== 'month') {
      return sendError(req, res, 400, '编号重置方式不合法', 'VALIDATION_ERROR');
    }
    setSetting(db, teamId, 'noMode', mode);
    recordAuditFromRequest(db, req, {
      teamId,
      action: 'setting.no_mode',
      entityType: 'setting',
      entityId: 'noMode',
      detail: { noMode: mode },
    });
    return res.json({ ok: true, noMode: mode });
  });

  /** 保存打印抬头 */
  router.post('/setting/print', (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return sendError(req, res, 400, '请求体必须是对象', 'VALIDATION_ERROR');
    }
    const body = req.body as Record<string, unknown>;
    const teamRes = parsePositiveInt(body.teamId, 'teamId');
    if (!teamRes.ok) {
      return sendError(
        req,
        res,
        400,
        body.teamId === undefined || body.teamId === '' || body.teamId === 0 || body.teamId === '0'
          ? 'teamId 不能为空'
          : teamRes.error,
        'VALIDATION_ERROR',
      );
    }
    const teamId = teamRes.value;
    const rawPrint = body.print;
    if (!rawPrint || typeof rawPrint !== 'object' || Array.isArray(rawPrint)) {
      return sendError(req, res, 400, 'print 不能为空且必须是对象', 'VALIDATION_ERROR');
    }
    const p = rawPrint as Record<string, unknown>;
    for (const [label, val] of [
      ['company', p.company],
      ['address', p.address],
      ['phone', p.phone],
      ['footer', p.footer],
    ] as const) {
      if (val !== undefined && val !== null && typeof val !== 'string') {
        return sendError(req, res, 400, `print.${label} 必须是字符串`, 'VALIDATION_ERROR');
      }
    }
    if (p.showLogo !== undefined && typeof p.showLogo !== 'boolean') {
      return sendError(req, res, 400, 'print.showLogo 必须是布尔值', 'VALIDATION_ERROR');
    }
    const conf: PrintConf = {
      company: (typeof p.company === 'string' ? p.company : '').trim().slice(0, 60),
      address: (typeof p.address === 'string' ? p.address : '').trim().slice(0, 120),
      phone: (typeof p.phone === 'string' ? p.phone : '').trim().slice(0, 40),
      footer: (typeof p.footer === 'string' ? p.footer : '').trim().slice(0, 200),
      showLogo: p.showLogo !== false,
    };
    setSetting(db, teamId, PRINT_KEY, JSON.stringify(conf));
    recordAuditFromRequest(db, req, {
      teamId,
      action: 'setting.print',
      entityType: 'setting',
      entityId: PRINT_KEY,
      detail: { company: conf.company, showLogo: conf.showLogo },
    });
    return res.json({ ok: true, print: conf });
  });

  /** 恢复默认（清掉 team 级覆盖） */
  router.post('/setting/reset', (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return sendError(req, res, 400, '请求体必须是对象', 'VALIDATION_ERROR');
    }
    const body = req.body as Record<string, unknown>;
    const teamRes = parsePositiveInt(body.teamId, 'teamId');
    if (!teamRes.ok) {
      return sendError(
        req,
        res,
        400,
        body.teamId === undefined || body.teamId === '' || body.teamId === 0 || body.teamId === '0'
          ? 'teamId 不能为空'
          : teamRes.error,
        'VALIDATION_ERROR',
      );
    }
    const teamId = teamRes.value;
    if (body.scope !== undefined && typeof body.scope !== 'string') {
      return sendError(req, res, 400, 'scope 格式无效', 'VALIDATION_ERROR');
    }
    const scope = typeof body.scope === 'string' ? body.scope : 'all';
    if (scope === 'all' || scope === 'prefix')
      db.prepare(`DELETE FROM setting WHERE teamId = ? AND key = 'prefix'`).run(teamId);
    if (scope === 'all' || scope === PRINT_KEY)
      db.prepare(`DELETE FROM setting WHERE teamId = ? AND key = ?`).run(teamId, PRINT_KEY);
    if (scope === 'all' || scope === 'noMode')
      db.prepare(`DELETE FROM setting WHERE teamId = ? AND key = 'noMode'`).run(teamId);
    recordAuditFromRequest(db, req, {
      teamId,
      action: 'setting.reset',
      entityType: 'setting',
      entityId: scope,
    });
    return res.json({
      ok: true,
      prefix: loadPrefix(db, teamId),
      noMode: loadNoMode(db, teamId),
      print: loadPrint(db, teamId),
    });
  });
}
