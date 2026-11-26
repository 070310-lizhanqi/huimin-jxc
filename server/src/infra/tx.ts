/**
 * 统一 SQLite 立即写事务封装
 * - BEGIN IMMEDIATE 获取写锁：失败抛 BusyError(503)，不执行无效 ROLLBACK
 * - 异常路径使用安全 ROLLBACK（内层 try/catch 防止已自动回滚时二次抛错掩盖原始异常）
 * - 支持关键写操作完成后显式 tryCheckpoint
 */
import type { DatabaseSync } from 'node:sqlite';
import { tryCheckpoint } from '../db';
import { BusyError } from './errors';

export interface TxOptions {
  checkpoint?: boolean;
}

export function safeRollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // SQLite 可能已在 ON CONFLICT / 约束阶段隐式回滚，忽略二次回滚错误以免遮蔽原始异常
  }
}

export function withImmediateTx<T>(db: DatabaseSync, fn: () => T, opts: TxOptions = {}): T {
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch {
    throw new BusyError('系统繁忙，请重试');
  }
  try {
    const result = fn();
    db.exec('COMMIT');
    if (opts.checkpoint) {
      tryCheckpoint(db);
    }
    return result;
  } catch (err) {
    safeRollback(db);
    throw err;
  }
}
