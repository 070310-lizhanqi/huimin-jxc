/**
 * 单据号生成（B-安19②）：docs.ts 与 docimport.ts 原各实现一份，
 * 现收敛到此独立小模块。无循环依赖：本模块只 import settings/db，
 * settings 与 db 均不 import 本模块。
 */
import type { DatabaseSync } from 'node:sqlite';
import { localDate } from './db';
import { BILL_NO_PREFIXES, loadNoMode, loadPrefix } from './settings';

/** 单号 upsert 语句缓存：按 db 实例缓存（多库测试进程下各库独立编译） */
const stmtCache = new WeakMap<DatabaseSync, import('node:sqlite').StatementSync>();

export function nextBillNo(db: DatabaseSync, teamId: number, type: string): string {
  // 前缀与重置方式支持 team 级配置（功能设置 → 单据编号）
  const prefix = loadPrefix(db, teamId)[type] ?? BILL_NO_PREFIXES[type] ?? 'NO';
  const mode = loadNoMode(db, teamId);
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
