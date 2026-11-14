import { loadKeyRing, type KeyRing } from './access/keys.js';
import {
  DEFAULT_ACCESS_POLICY,
  DEFAULT_SWEEP_INTERVAL_MS,
  type AccessPolicy,
} from './access/policy.js';
import { parseInteger } from './env.js';
import { ConfigError } from './errors.js';
import { loadRetentionPolicy, type RetentionPolicy } from './retention/policy.js';

export type AppEnv = 'development' | 'test' | 'staging' | 'production';

const APP_ENVS: readonly AppEnv[] = ['development', 'test', 'staging', 'production'];

export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  lockTimeoutMs: number;
  hsts: boolean;
  webDist: string;
  runMigrations: boolean;
  keyRing: KeyRing;
  appEnv: AppEnv;
  /** 信頼するプロキシの段数。未設定は null（接続の相手のアドレスを使う）。staging と production では必須（BR18.3） */
  trustedProxyHops: number | null;
  policy: AccessPolicy;
  /** 窓の古い行を削除する周期（ミリ秒） */
  sweepIntervalMs: number;
  /** 保持期間、自動終了の期間、定期処理の周期と上限（BR24.1、BR25.1、BR26.1、BR26.3） */
  retention: RetentionPolicy;
}

function parseAppEnv(env: Record<string, string | undefined>): AppEnv {
  const raw = env.APP_ENV?.trim();
  if (!raw) {
    return 'development';
  }
  const found = APP_ENVS.find((value) => value === raw);
  if (!found) {
    throw new ConfigError(`APP_ENV は ${APP_ENVS.join('、')} のいずれかで指定してください`);
  }
  return found;
}

/**
 * 信頼するプロキシの段数（BR18.3）。staging と production では必須で、無ければ起動しない。
 * 設定しないと全員が 1 つの接続元になり、他人の誤入力で参加できなくなるため。
 */
function parseTrustedProxyHops(
  env: Record<string, string | undefined>,
  appEnv: AppEnv,
): number | null {
  const raw = env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) {
    if (appEnv === 'staging' || appEnv === 'production') {
      throw new ConfigError('staging と production では TRUSTED_PROXY_HOPS の指定が必要です');
    }
    return null;
  }
  return parseInteger(env, 'TRUSTED_PROXY_HOPS', 0, 0, 10);
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
  const appEnv = parseAppEnv(env);
  const minute = 60 * 1000;
  return {
    databaseUrl,
    host: env.HOST?.trim() || '0.0.0.0',
    port: parseInteger(env, 'PORT', 3100, 1, 65535),
    lockTimeoutMs: parseInteger(env, 'LOCK_TIMEOUT_MS', 3000, 1, 60000),
    hsts: env.ENABLE_HSTS === 'true',
    webDist: env.WEB_DIST?.trim() || 'dist/web',
    runMigrations: env.RUN_MIGRATIONS === 'true',
    keyRing: loadKeyRing(env),
    appEnv,
    trustedProxyHops: parseTrustedProxyHops(env, appEnv),
    policy: {
      tokenTtlMs:
        parseInteger(
          env,
          'RETURN_TOKEN_TTL_MINUTES',
          DEFAULT_ACCESS_POLICY.tokenTtlMs / minute,
          1,
          60 * 24 * 30,
        ) * minute,
      touchIntervalMs:
        parseInteger(
          env,
          'TOKEN_TOUCH_INTERVAL_SECONDS',
          DEFAULT_ACCESS_POLICY.touchIntervalMs / 1000,
          1,
          3600,
        ) * 1000,
      joinWindowMs:
        parseInteger(
          env,
          'JOIN_WINDOW_SECONDS',
          DEFAULT_ACCESS_POLICY.joinWindowMs / 1000,
          1,
          3600,
        ) * 1000,
      joinMaxAttempts: parseInteger(
        env,
        'JOIN_WINDOW_MAX_ATTEMPTS',
        DEFAULT_ACCESS_POLICY.joinMaxAttempts,
        1,
        1000,
      ),
    },
    sweepIntervalMs:
      parseInteger(
        env,
        'JOIN_SWEEP_INTERVAL_MINUTES',
        DEFAULT_SWEEP_INTERVAL_MS / minute,
        1,
        24 * 60,
      ) * minute,
    retention: loadRetentionPolicy(env),
  };
}
