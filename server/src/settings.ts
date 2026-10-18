/**
 * 功能设置：单据编号规则 + 打印抬头（team 级键值配置）
 */
import type { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';

/** 默认单据前缀（可被 team 配置覆盖） */
export const DEFAULT_PREFIX: Record<string, string> = {
  stockin: 'RK', stockout: 'CK', transfer: 'DB', adjust: 'TZ', stocktake: 'PD',
  porder: 'CG', sorder: 'XS', pin: 'CT', sret: 'XT',
  otherin: 'QR', otherout: 'QC', assembly: 'ZZ', stockinit: 'QCQ', quo: 'BJ',
  outapply: 'SQ', prodtask: 'SC',
};

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
  company: '', address: '', phone: '', footer: '本单为业务往来凭证，如有疑问请及时联系。', showLogo: true,
};

const PRINT_KEY = 'print';

function getSetting(db: DatabaseSync, teamId: number, key: string): string | null {
  const row = db.prepare(`SELECT value FROM setting WHERE teamId = ? AND key = ?`).get(teamId, key) as
    | { value: string }
    | undefined;
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
  const raw = getSetting(db, teamId, 'print');
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
  /** 读全部设置（前端打开设置页一次取齐） */
  router.get('/setting/get', (req, res) => {
    const teamId = Number(req.query.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    res.json({
      prefix: loadPrefix(db, teamId),
      noMode: loadNoMode(db, teamId),
      print: loadPrint(db, teamId),
      defaults: DEFAULT_PREFIX,
    });
  });

  /** 保存单据编号前缀 */
  router.post('/setting/prefix', (req, res) => {
    const teamId = Number(req.body.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const input = req.body.prefix as Record<string, unknown> | undefined;
    if (!input || typeof input !== 'object') return res.status(400).json({ error: 'prefix 不能为空' });
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(input)) {
      if (!(k in DEFAULT_PREFIX)) continue;
      const s = String(v ?? '').trim();
      if (s === '') continue;
      // 只允许字母数字，1-4 位
      if (!/^[A-Za-z0-9]{1,4}$/.test(s)) {
        return res.status(400).json({ error: `「${k}」的前缀只能填 1-4 位字母或数字` });
      }
      clean[k] = s.toUpperCase();
    }
    setSetting(db, teamId, 'prefix', JSON.stringify(clean));
    res.json({ ok: true, prefix: loadPrefix(db, teamId) });
  });

  /** 保存编号重置模式 */
  router.post('/setting/no-mode', (req, res) => {
    const teamId = Number(req.body.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const mode = String(req.body.noMode ?? '');
    if (mode !== 'none' && mode !== 'day' && mode !== 'month') {
      return res.status(400).json({ error: '编号重置方式不合法' });
    }
    setSetting(db, teamId, 'noMode', mode);
    res.json({ ok: true, noMode: mode });
  });

  /** 保存打印抬头 */
  router.post('/setting/print', (req, res) => {
    const teamId = Number(req.body.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const p = req.body.print as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object') return res.status(400).json({ error: 'print 不能为空' });
    const conf: PrintConf = {
      company: String(p.company ?? '').trim().slice(0, 60),
      address: String(p.address ?? '').trim().slice(0, 120),
      phone: String(p.phone ?? '').trim().slice(0, 40),
      footer: String(p.footer ?? '').trim().slice(0, 200),
      showLogo: p.showLogo !== false,
    };
    setSetting(db, teamId, 'print', JSON.stringify(conf));
    res.json({ ok: true, print: conf });
  });

  /** 恢复默认（清掉 team 级覆盖） */
  router.post('/setting/reset', (req, res) => {
    const teamId = Number(req.body.teamId);
    if (!teamId) return res.status(400).json({ error: 'teamId 不能为空' });
    const scope = String(req.body.scope ?? 'all');
    if (scope === 'all' || scope === 'prefix') db.prepare(`DELETE FROM setting WHERE teamId = ? AND key = 'prefix'`).run(teamId);
    if (scope === 'all' || scope === 'print') db.prepare(`DELETE FROM setting WHERE teamId = ? AND key = 'print'`).run(teamId);
    if (scope === 'all' || scope === 'noMode') db.prepare(`DELETE FROM setting WHERE teamId = ? AND key = 'noMode'`).run(teamId);
    res.json({ ok: true, prefix: loadPrefix(db, teamId), noMode: loadNoMode(db, teamId), print: loadPrint(db, teamId) });
  });
}
