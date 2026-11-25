/**
 * 轻量级强类型输入校验原语（零外部依赖）
 * - 用于路由参数、查询参数、JSON 请求体与导入行数据的严格 Schema 校验
 */
import { validBizDate } from '../db';
import { QTY_MAX, roundQty } from '../shared/money';
import { ValidationError } from './errors';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parsePositiveInt(raw: unknown, label: string): ParseResult<number> {
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(s)) return { ok: false, error: `${label} 必须是正整数` };
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) return { ok: false, error: `${label} 必须是正整数` };
  return { ok: true, value: n };
}

export function parseOptionalPositiveInt(raw: unknown, label: string): ParseResult<number | null> {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, value: null };
  }
  return parsePositiveInt(raw, label);
}

export function parseNonEmptyString(raw: unknown, label: string, maxLen: number): ParseResult<string> {
  if (typeof raw !== 'string') return { ok: false, error: `${label} 必须是字符串` };
  const s = raw.trim();
  if (!s) return { ok: false, error: `${label} 不能为空` };
  if (s.length > maxLen) return { ok: false, error: `${label} 长度不能超过 ${maxLen} 个字符` };
  return { ok: true, value: s };
}

export function parseOptionalString(raw: unknown, label: string, maxLen: number): ParseResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: `${label} 必须是字符串` };
  const s = raw.trim();
  if (!s) return { ok: true, value: null };
  if (s.length > maxLen) return { ok: false, error: `${label} 长度不能超过 ${maxLen} 个字符` };
  return { ok: true, value: s };
}

export function parseBizDateOptional(raw: unknown, label: string): ParseResult<string | null> {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, value: null };
  }
  const s = String(raw).trim();
  const err = validBizDate(s);
  if (err) return { ok: false, error: `${label}${err}` };
  return { ok: true, value: s };
}

export function parseBizDateRequired(raw: unknown, label: string): ParseResult<string> {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { ok: false, error: `${label} 不能为空` };
  }
  const s = String(raw).trim();
  const err = validBizDate(s);
  if (err) return { ok: false, error: `${label}${err}` };
  return { ok: true, value: s };
}

export function parseEnum<T extends string>(raw: unknown, allowed: readonly T[], label: string): ParseResult<T> {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!allowed.includes(s as T)) {
    return { ok: false, error: `${label} 非法，允许值：${allowed.join(' / ')}` };
  }
  return { ok: true, value: s as T };
}

export function parseQty(
  raw: unknown,
  label: string,
  opts: { allowNegative?: boolean; allowZero?: boolean; max?: number } = {},
): ParseResult<number> {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n)) return { ok: false, error: `${label} 必须是有效数字` };
  const rounded = roundQty(n);
  const max = opts.max ?? QTY_MAX;
  if (Math.abs(rounded) > max) return { ok: false, error: `${label} 超出上限（${max}）` };
  if (!opts.allowNegative && rounded < 0) return { ok: false, error: `${label} 不能为负数` };
  if (!opts.allowZero && rounded === 0) return { ok: false, error: `${label} 不能为 0` };
  return { ok: true, value: rounded };
}

export function parseCents(
  raw: unknown,
  label: string,
  opts: { allowNegative?: boolean; maxAbs?: number; defaultZero?: boolean } = {},
): ParseResult<number> {
  if ((raw === undefined || raw === null || raw === '') && opts.defaultZero) {
    return { ok: true, value: 0 };
  }
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n)) return { ok: false, error: `${label} 必须是整数分金额` };
  const cents = Math.round(n);
  const maxAbs = opts.maxAbs ?? 1e11;
  if (Math.abs(cents) > maxAbs) return { ok: false, error: `${label} 超出金额上限` };
  if (!opts.allowNegative && cents < 0) return { ok: false, error: `${label} 不能为负数` };
  return { ok: true, value: cents };
}

export function unwrapOrThrow<T>(result: ParseResult<T>): T {
  if (!result.ok) {
    throw new ValidationError(result.error);
  }
  return result.value;
}
