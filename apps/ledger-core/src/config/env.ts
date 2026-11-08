import path from 'node:path';
import fs from 'node:fs';

const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

function parseEnvInt(
  key: string,
  defaultValue: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER
): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `[ENV_BOOT_ERROR] Invalid integer for ${key}="${raw}". Expected integer between ${min} and ${max}.`
    );
  }
  return parsed;
}

const nodeEnv = (process.env.NODE_ENV ?? 'development') as
  | 'development'
  | 'production'
  | 'test';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    '[ENV_BOOT_ERROR] Missing required environment variable: DATABASE_URL. Configure it in apps/ledger-core/.env or process environment.'
  );
}

const dbStatementTimeoutMs = parseEnvInt('DB_STATEMENT_TIMEOUT_MS', 5_000, 100, 120_000);
const dbLockTimeoutMs = parseEnvInt('DB_LOCK_TIMEOUT_MS', 2_000, 50, 60_000);
const httpRequestTimeoutMs = parseEnvInt('HTTP_REQUEST_TIMEOUT_MS', 15_000, 1_000, 300_000);

// Ensure Postgres cancels blocked/slow queries before Fastify drops the HTTP socket
if (httpRequestTimeoutMs <= dbStatementTimeoutMs + dbLockTimeoutMs) {
  throw new Error(
    `[ENV_BOOT_ERROR] HTTP_REQUEST_TIMEOUT_MS (${httpRequestTimeoutMs}) must be strictly greater than DB_STATEMENT_TIMEOUT_MS (${dbStatementTimeoutMs}) + DB_LOCK_TIMEOUT_MS (${dbLockTimeoutMs}).`
  );
}

export const env = {
  NODE_ENV: nodeEnv,
  IS_PRODUCTION: nodeEnv === 'production',
  LEDGER_CORE_HOST: process.env.LEDGER_CORE_HOST ?? '0.0.0.0',
  LEDGER_CORE_PORT: parseEnvInt('LEDGER_CORE_PORT', 3001, 1, 65535),
  DATABASE_URL: databaseUrl,
  LOG_LEVEL: process.env.LOG_LEVEL ?? (nodeEnv === 'production' ? 'info' : 'debug'),
  LOG_LIFECYCLE_TRACE: process.env.LOG_LIFECYCLE_TRACE === 'true',

  HTTP_CONNECTION_TIMEOUT_MS: parseEnvInt('HTTP_CONNECTION_TIMEOUT_MS', 10_000, 1_000, 120_000),
  HTTP_REQUEST_TIMEOUT_MS: httpRequestTimeoutMs,
  HTTP_KEEP_ALIVE_TIMEOUT_MS: parseEnvInt('HTTP_KEEP_ALIVE_TIMEOUT_MS', 5_000, 1_000, 300_000),

  DB_POOL_MAX: parseEnvInt('DB_POOL_MAX', 20, 1, 500),
  DB_IDLE_TIMEOUT_SEC: parseEnvInt('DB_IDLE_TIMEOUT_SEC', 30, 1, 3600),
  DB_CONNECT_TIMEOUT_SEC: parseEnvInt('DB_CONNECT_TIMEOUT_SEC', 10, 1, 120),
  DB_STATEMENT_TIMEOUT_MS: dbStatementTimeoutMs,
  DB_LOCK_TIMEOUT_MS: dbLockTimeoutMs,
  DB_IDLE_IN_TX_TIMEOUT_MS: parseEnvInt('DB_IDLE_IN_TX_TIMEOUT_MS', 10_000, 500, 300_000),
  DB_DRAIN_TIMEOUT_SEC: parseEnvInt('DB_DRAIN_TIMEOUT_SEC', 5, 1, 60),
} as const;
