/**
 * 应用配置加载与启动校验（零外部依赖）
 * - 支持读取当前工作目录下的 .env（不覆盖已存在的进程环境变量）
 * - 严格校验所有环境变量并快速失败
 * - 生产/公网绑定/强制校验模式下拒绝缺失或弱 JWT 密钥；仅本机开发/桌面模式自动持久化随机密钥到 <dataDir>/.jwt-secret
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type NodeEnv = 'development' | 'test' | 'production';
export type CookieSecureMode = '0' | '1' | 'auto';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'pretty' | 'json';
export type JwtSecretSource = 'env' | 'persisted' | 'ephemeral';

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly bindHost: string;
  readonly isLoopbackBind: boolean;
  readonly dataDir: string;
  readonly dbPath: string;
  readonly jwtSecret: string;
  readonly jwtSecretSource: JwtSecretSource;
  readonly requireSecret: boolean;
  readonly allowHosts: readonly string[];
  readonly cookieSecure: CookieSecureMode;
  readonly trustProxy: boolean;
  readonly logLevel: LogLevel;
  readonly logFormat: LogFormat;
  readonly backupKeepCount: number;
}

export interface ValidateConfigOptions {
  persistSecret?: boolean;
  warn?: (message: string) => void;
}

export interface InitConfigOptions extends ValidateConfigOptions {
  envPath?: string;
}

export class ConfigError extends Error {
  readonly details: readonly string[];

  constructor(message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'ConfigError';
    this.details = details;
  }
}

const VALID_NODE_ENVS: ReadonlySet<string> = new Set(['development', 'test', 'production']);
const VALID_COOKIE_SECURE: ReadonlySet<string> = new Set(['0', '1', 'auto']);
const VALID_LOG_LEVELS: ReadonlySet<string> = new Set(['debug', 'info', 'warn', 'error']);
const VALID_LOG_FORMATS: ReadonlySet<string> = new Set(['pretty', 'json']);

/**
 * 已知不安全示例/历史固定密钥的 SHA-256 摘要（不在源码中存放明文密钥）
 */
const DISALLOWED_SECRET_SHA256: ReadonlySet<string> = new Set([
  'b5969f8c192611862831aa2edd1220f9f696b3d5278e3092dbbabff4158d3d7f',
  '2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b', // "secret"
  '8bb0cf6eb9b17d0f7d22b456f121257dc125491f0a165d2d1823f9b7e1d1a3f2',
]);

const MIN_SECRET_LENGTH = 32;

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function isWeakOrKnownSecret(secret: string): string | null {
  if (secret.length < MIN_SECRET_LENGTH) {
    return `ORANGE_JWT_SECRET 长度至少需要 ${MIN_SECRET_LENGTH} 个字符（当前 ${secret.length} 个字符）`;
  }
  if (DISALLOWED_SECRET_SHA256.has(sha256Hex(secret))) {
    return 'ORANGE_JWT_SECRET 不能使用源码示例或历史默认密钥';
  }
  if (/^(?:your[-_]?secret|change[-_]?me|placeholder|example[-_]?secret)/i.test(secret)) {
    return 'ORANGE_JWT_SECRET 不能使用占位符文本';
  }
  const uniqueChars = new Set(secret);
  if (uniqueChars.size < 6) {
    return 'ORANGE_JWT_SECRET 熵值过低（重复字符过多），请使用高随机度字符串';
  }
  return null;
}

export function isLoopbackAddress(bind: string): boolean {
  const normalized = bind.trim().toLowerCase();
  if (normalized === '' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') {
    return true;
  }
  const m = normalized.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return Number(m[1]) <= 255 && Number(m[2]) <= 255 && Number(m[3]) <= 255;
}

function parseBooleanFlag(raw: string | undefined, defaultValue: boolean, name: string, errors: string[]): boolean {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  errors.push(`${name} 非法值 "${raw}"，仅允许 0 / 1 / true / false`);
  return defaultValue;
}

function parseIntRange(
  raw: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
  name: string,
  errors: string[],
): number {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    errors.push(`${name} 非法值 "${raw}"，必须为 ${min}-${max} 的整数`);
    return defaultValue;
  }
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num) || num < min || num > max) {
    errors.push(`${name} 超出范围 "${raw}"，合法范围为 ${min}-${max} 的整数`);
    return defaultValue;
  }
  return num;
}

function loadOrCreateLocalSecret(resolvedDataDir: string): { secret: string; created: boolean } {
  const secretFile = path.join(resolvedDataDir, '.jwt-secret');
  try {
    if (fs.existsSync(secretFile)) {
      const existing = fs.readFileSync(secretFile, 'utf8').trim();
      if (isWeakOrKnownSecret(existing) === null) {
        return { secret: existing, created: false };
      }
    }
  } catch {
    // 读取失败时按首次创建逻辑重新生成
  }

  fs.mkdirSync(resolvedDataDir, { recursive: true });
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(secretFile, `${generated}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { secret: generated, created: true };
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
    if (code === 'EEXIST') {
      const existing = fs.readFileSync(secretFile, 'utf8').trim();
      if (isWeakOrKnownSecret(existing) === null) {
        return { secret: existing, created: false };
      }
    }
    fs.writeFileSync(secretFile, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(secretFile, 0o600);
    } catch {
      // Windows NTFS 等不支持 POSIX chmod 的文件系统忽略权限收紧失败
    }
    return { secret: generated, created: true };
  }
}

export function parseDotEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const withoutExport = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trimStart() : trimmed;
    const eqIndex = withoutExport.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = withoutExport.slice(0, eqIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = withoutExport.slice(eqIndex + 1).trim();
    if (val.startsWith('"')) {
      let end = -1;
      for (let i = 1; i < val.length; i++) {
        if (val[i] === '\\') {
          i++;
          continue;
        }
        if (val[i] === '"') {
          end = i;
          break;
        }
      }
      if (end > 0) {
        val = val
          .slice(1, end)
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    } else if (val.startsWith("'")) {
      const end = val.indexOf("'", 1);
      if (end > 0) {
        val = val.slice(1, end);
      }
    } else {
      const commentIdx = val.startsWith('#') ? 0 : val.search(/\s+#/);
      if (commentIdx >= 0) val = val.slice(0, commentIdx).trimEnd();
    }
    result[key] = val;
  }
  return result;
}

export function loadDotEnv(options: { envPath?: string; targetEnv?: NodeJS.ProcessEnv } = {}): boolean {
  const targetEnv = options.targetEnv ?? process.env;
  if (targetEnv.ORANGE_ENV_FILE === '' && !options.envPath) return false;
  const resolvedPath = options.envPath
    ? path.resolve(options.envPath)
    : targetEnv.ORANGE_ENV_FILE
      ? path.resolve(targetEnv.ORANGE_ENV_FILE)
      : path.join(process.cwd(), '.env');

  if (!fs.existsSync(resolvedPath)) return false;
  const raw = fs.readFileSync(resolvedPath, 'utf8');
  const parsed = parseDotEnv(raw);
  for (const [key, value] of Object.entries(parsed)) {
    if (targetEnv[key] === undefined) {
      targetEnv[key] = value;
    }
  }
  return true;
}

export function validateConfig(rawEnv: NodeJS.ProcessEnv, options: ValidateConfigOptions = {}): AppConfig {
  const errors: string[] = [];
  const warn = options.warn ?? ((msg: string) => process.stderr.write(`${msg}\n`));

  const rawNodeEnv = (rawEnv.NODE_ENV ?? 'development').trim() || 'development';
  if (!VALID_NODE_ENVS.has(rawNodeEnv)) {
    errors.push(`NODE_ENV 非法值 "${rawNodeEnv}"，仅允许 development | test | production`);
  }
  const nodeEnv = (VALID_NODE_ENVS.has(rawNodeEnv) ? rawNodeEnv : 'development') as NodeEnv;

  const rawPort = rawEnv.PORT !== undefined && rawEnv.PORT.trim() !== '' ? rawEnv.PORT : rawEnv.ORANGE_PORT;
  const port = parseIntRange(rawPort, 7741, 1, 65535, 'PORT', errors);
  const bindHost = (rawEnv.ORANGE_BIND ?? '127.0.0.1').trim() || '127.0.0.1';
  const isLoopbackBind = isLoopbackAddress(bindHost);

  const rawDataDir = rawEnv.ORANGE_DATA_DIR?.trim();
  const resolvedDataDir = rawDataDir ? path.resolve(rawDataDir) : path.join(process.cwd(), 'data');

  const rawDbPath = rawEnv.ORANGE_DB_PATH?.trim();
  const dbPath = rawDbPath ? path.resolve(rawDbPath) : path.join(resolvedDataDir, 'huimin-clone.db');

  const requireSecret = parseBooleanFlag(rawEnv.ORANGE_REQUIRE_SECRET, false, 'ORANGE_REQUIRE_SECRET', errors);

  const allowHosts = (rawEnv.ORANGE_ALLOW_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);

  const rawCookieSecure = (rawEnv.ORANGE_COOKIE_SECURE ?? '0').trim() || '0';
  if (!VALID_COOKIE_SECURE.has(rawCookieSecure)) {
    errors.push(`ORANGE_COOKIE_SECURE 非法值 "${rawCookieSecure}"，仅允许 0 | 1 | auto`);
  }
  const cookieSecure = (VALID_COOKIE_SECURE.has(rawCookieSecure) ? rawCookieSecure : '0') as CookieSecureMode;

  const trustProxy = parseBooleanFlag(rawEnv.ORANGE_TRUST_PROXY, false, 'ORANGE_TRUST_PROXY', errors);

  const rawLogLevel = (rawEnv.LOG_LEVEL ?? 'info').trim().toLowerCase() || 'info';
  if (!VALID_LOG_LEVELS.has(rawLogLevel)) {
    errors.push(`LOG_LEVEL 非法值 "${rawLogLevel}"，仅允许 debug | info | warn | error`);
  }
  const logLevel = (VALID_LOG_LEVELS.has(rawLogLevel) ? rawLogLevel : 'info') as LogLevel;

  const defaultLogFormat: LogFormat = nodeEnv === 'production' ? 'json' : 'pretty';
  const rawLogFormat = (rawEnv.LOG_FORMAT ?? defaultLogFormat).trim().toLowerCase() || defaultLogFormat;
  if (!VALID_LOG_FORMATS.has(rawLogFormat)) {
    errors.push(`LOG_FORMAT 非法值 "${rawLogFormat}"，仅允许 pretty | json`);
  }
  const logFormat = (VALID_LOG_FORMATS.has(rawLogFormat) ? rawLogFormat : defaultLogFormat) as LogFormat;

  const backupKeepCount = parseIntRange(rawEnv.BACKUP_KEEP_COUNT, 30, 1, 365, 'BACKUP_KEEP_COUNT', errors);

  const rawSecret = rawEnv.ORANGE_JWT_SECRET?.trim() ?? '';
  const strictSecretRequired = nodeEnv === 'production' || requireSecret || !isLoopbackBind;

  let jwtSecret = '';
  let jwtSecretSource: JwtSecretSource = 'env';

  if (rawSecret.length > 0) {
    const secretIssue = isWeakOrKnownSecret(rawSecret);
    if (secretIssue) {
      errors.push(secretIssue);
    } else {
      jwtSecret = rawSecret;
      jwtSecretSource = 'env';
    }
  } else if (strictSecretRequired) {
    const reason =
      nodeEnv === 'production'
        ? '当前为 production 环境'
        : requireSecret
          ? '已启用 ORANGE_REQUIRE_SECRET=1'
          : `绑定地址为非本机回环地址（ORANGE_BIND=${bindHost}）`;
    errors.push(
      `${reason}，必须显式配置强随机 ORANGE_JWT_SECRET（>= ${MIN_SECRET_LENGTH} 位，可用 node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" 生成）`,
    );
  } else if (options.persistSecret !== false) {
    // 仅本机回环非生产模式下自动持久化 CSPRNG 密钥，避免源码出现固定回落密钥
    const loaded = loadOrCreateLocalSecret(resolvedDataDir);
    jwtSecret = loaded.secret;
    jwtSecretSource = 'persisted';
    warn(
      `[安全提示] 未设置 ORANGE_JWT_SECRET，已从本机密钥文件加载随机签名密钥（${path.join(resolvedDataDir, '.jwt-secret')}）；公网或生产部署请显式设置 ORANGE_JWT_SECRET。`,
    );
  } else {
    jwtSecret = crypto.randomBytes(32).toString('hex');
    jwtSecretSource = 'ephemeral';
  }

  if (errors.length > 0) {
    throw new ConfigError(`环境变量配置校验失败：\n  - ${errors.join('\n  - ')}`, errors);
  }

  return Object.freeze({
    nodeEnv,
    port,
    bindHost,
    isLoopbackBind,
    dataDir: resolvedDataDir,
    dbPath,
    jwtSecret,
    jwtSecretSource,
    requireSecret,
    allowHosts: Object.freeze(allowHosts),
    cookieSecure,
    trustProxy,
    logLevel,
    logFormat,
    backupKeepCount,
  });
}

let cachedConfig: AppConfig | null = null;

export function initConfig(options: InitConfigOptions = {}): AppConfig {
  loadDotEnv({ envPath: options.envPath });
  cachedConfig = validateConfig(process.env, {
    persistSecret: options.persistSecret,
    warn: options.warn,
  });
  return cachedConfig;
}

export function getConfig(): AppConfig {
  if (!cachedConfig) {
    return initConfig();
  }
  return cachedConfig;
}

export function resetConfigForTest(): void {
  cachedConfig = null;
}
