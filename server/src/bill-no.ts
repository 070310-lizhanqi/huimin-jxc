/**
 * 单据号生成（B-安19②）：docs.ts 与 docimport.ts 原各实现一份，
 * 现收敛到此独立小模块。无循环依赖：本模块只 import settings/db，
 * settings 与 db 均不 import 本模块。
 */
import type { DatabaseSync } from 'node:sqlite';
import { localDate } from './db';
import { BILL_NO_PREFIXES, loadNoMode, loadPrefix } from './settings';
import type { NoMode } from './settings';

/** 单号生成所需的 team 级配置（B-安10②）：导入开始时一次读出，按单据复用，
 *  避免每生成一个单号都重复查两次 setting 表。 */
export interface BillNoConfig {
  prefix: Record<string, string>;
  noMode: NoMode;
}

export function loadBillNoConfig(db: DatabaseSync, teamId: number): BillNoConfig {
  return { prefix: loadPrefix(db, teamId), noMode: loadNoMode(db, teamId) };
}

/** 单号 upsert 语句缓存：按 db 实例缓存（多库测试进程下各库独立编译） */
const stmtCache = new WeakMap<DatabaseSync, import('node:sqlite').StatementSync>();

export function nextBillNo(db: DatabaseSync, teamId: number, type: string, cfg?: BillNoConfig): string {
  // 前缀与重置方式支持 team 级配置（功能设置 → 单据编号）；
  // 调用方已一次读出配置时直接复用，不再逐单查库
  const prefix = cfg ? (cfg.prefix[type] ?? BILL_NO_PREFIXES[type] ?? 'NO') : (loadPrefix(db, teamId)[type] ?? BILL_NO_PREFIXES[type] ?? 'NO');
  const mode = cfg ? cfg.noMode : loadNoMode(db, teamId);
  const full = localDate().replace(/-/g, '');
  const datePart = mode === 'none' ? '' : mode === 'month' ? full.slice(0, 6) : full;
  // 独立序号表：删除草稿后序号不复用，保证 billNo 永不重复
  const key = `${teamId}:${prefix}:${datePart}`;
  let stmt = stmtCache.get(db);
  if (!stmt) {
    stmt = db.prepare(
      `INSERT INTO bill_seq (k, seq) VALUES (?, 1)
       ON CONFLICT(k) DO UPDATE SET seq = seq + 1
       RETURNING seq`,
    );
    stmtCache.set(db, stmt);
  }
  // upsert + RETURNING 一次往返取号（原实现 upsert 后再 SELECT，两次语句）
  const row = stmt.get(key) as { seq: number };
  return `${prefix}${datePart}${String(row.seq).padStart(4, '0')}`;
}
