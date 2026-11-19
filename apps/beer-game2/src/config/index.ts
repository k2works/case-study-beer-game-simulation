export interface Config {
  environment: 'production' | 'development' | 'test';
  port: number;
  databaseUrl: string;
  allowedOrigin: string;
  logLevel: string;
  /** 資格の鍵（古い順。最後が発行用） */
  credentialKeys: { version: string; key: Buffer }[];
  idempotencyKey: Buffer;
  /** メトリクスの次元の環境名（staging、production など） */
  metricsEnvironment: string;
  /** 参加・復帰の専用のレート制限（送信元ごと、1 分あたりの回数）。研修会場は送信元の IP を共有しやすいため、余裕を持たせる */
  authRateLimitPerMinute: number;
}

type Env = Record<string, string | undefined>;

const KEY_BYTES = 32;

function hexKey(name: string, raw: string): Buffer {
  const buf = Buffer.from(raw, 'hex');
  if (buf.length !== KEY_BYTES || buf.toString('hex') !== raw.toLowerCase())
    throw new Error(`${name} は 32 バイト（16 進で 64 文字）です`);
  return buf;
}

/**
 * 資格の鍵。`CREDENTIAL_HMAC_KEYS=v1:<hex>,v2:<hex>`（最後が発行用）。
 * 従来の `CREDENTIAL_HMAC_KEY`（+ `CREDENTIAL_KEY_VERSION`）も受け付ける。
 */
function credentialKeys(env: Env, production: boolean) {
  const name = 'CREDENTIAL_HMAC_KEYS';
  const list = env[name];
  if (list) {
    const keys = list.split(',').map((entry) => {
      const [version, hex, ...rest] = entry.trim().split(':');
      if (!version || !hex || rest.length > 0)
        throw new Error(`${name} は「版:16 進の鍵」をカンマで区切ります`);
      return { version, key: hexKey(name, hex) };
    });
    if (new Set(keys.map((k) => k.version)).size !== keys.length)
      throw new Error(`${name} の鍵の版が重複しています`);
    return keys;
  }
  return [
    {
      version: env.CREDENTIAL_KEY_VERSION ?? 'v1',
      key: key(env, 'CREDENTIAL_HMAC_KEY', production, '11'.repeat(32)),
    },
  ];
}

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
  return hexKey(name, raw);
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new Error(`${name} は正の整数です`);
  return n;
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
    credentialKeys: credentialKeys(env, production),
    idempotencyKey: key(env, 'IDEMPOTENCY_KEY', production, '22'.repeat(32)),
    authRateLimitPerMinute: positiveInt(env, 'AUTH_RATE_LIMIT_PER_MINUTE', 60),
    metricsEnvironment: env.APP_ENV || environment,
  };
}
