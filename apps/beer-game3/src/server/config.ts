import { loadKeyRing, type KeyRing } from './access/keys.js';
import { ConfigError } from './errors.js';

export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  lockTimeoutMs: number;
  hsts: boolean;
  webDist: string;
  runMigrations: boolean;
  keyRing: KeyRing;
}

function parseInteger(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} は ${min} 以上 ${max} 以下の整数で指定してください`);
  }
  return value;
}

/**
 * 環境変数から設定を読む。接続先と鍵が無ければ ConfigError で、起動を拒否する（NFR6.11）。
 * 鍵と接続先はソースにも DB にも置かない。
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new ConfigError('DATABASE_URL が設定されていません');
  }
  return {
    databaseUrl,
    host: env.HOST?.trim() || '0.0.0.0',
    port: parseInteger(env, 'PORT', 3100, 1, 65535),
    lockTimeoutMs: parseInteger(env, 'LOCK_TIMEOUT_MS', 3000, 1, 60000),
    hsts: env.ENABLE_HSTS === 'true',
    webDist: env.WEB_DIST?.trim() || 'dist/web',
    runMigrations: env.RUN_MIGRATIONS === 'true',
    keyRing: loadKeyRing(env),
  };
}
