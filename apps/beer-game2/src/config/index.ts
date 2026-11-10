export interface Config {
  environment: 'production' | 'development' | 'test';
  port: number;
  databaseUrl: string;
  allowedOrigin: string;
  logLevel: string;
  credentialHmacKey: Buffer;
  credentialKeyVersion: string;
  idempotencyKey: Buffer;
}

type Env = Record<string, string | undefined>;

function key(
  env: Env,
  name: string,
  production: boolean,
  fallback: string,
): Buffer {
  const raw = env[name];
  if (raw === undefined || raw === '') {
    if (production) throw new Error(`本番では ${name} が必須です`);
    return Buffer.from(fallback, 'hex');
  }
  const buf = Buffer.from(raw, 'hex');
  if (buf.length !== 32)
    throw new Error(`${name} は 32 バイト（16 進で 64 文字）です`);
  return buf;
}

function required(
  env: Env,
  name: string,
  production: boolean,
  fallback: string,
): string {
  const v = env[name];
  if (v) return v;
  if (production) throw new Error(`本番では ${name} が必須です`);
  return fallback;
}

/** 設定を読み込む。本番で鍵などが未設定なら、起動に失敗する */
export function loadConfig(env: Env): Config {
  const nodeEnv = env.NODE_ENV;
  const environment =
    nodeEnv === 'production'
      ? 'production'
      : nodeEnv === 'test'
        ? 'test'
        : 'development';
  const production = environment === 'production';
  return {
    environment,
    port: Number(env.PORT ?? 3000),
    databaseUrl: required(
      env,
      'DATABASE_URL',
      production,
      'postgres://beer_game2:local-only@localhost:5433/beer_game2',
    ),
    allowedOrigin: required(
      env,
      'ALLOWED_ORIGIN',
      production,
      'http://localhost:5173',
    ),
    logLevel: env.LOG_LEVEL ?? 'info',
    credentialHmacKey: key(
      env,
      'CREDENTIAL_HMAC_KEY',
      production,
      '11'.repeat(32),
    ),
    credentialKeyVersion: env.CREDENTIAL_KEY_VERSION ?? 'v1',
    idempotencyKey: key(env, 'IDEMPOTENCY_KEY', production, '22'.repeat(32)),
  };
}
