import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { HmacCredentialPolicy } from '../../src/adapters/http/credentials.js';

const KEY_HEX = 'ab'.repeat(32);
const prod = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@h:5432/d',
  ALLOWED_ORIGIN: 'https://beer.example.test',
  CREDENTIAL_HMAC_KEY: KEY_HEX,
  CREDENTIAL_KEY_VERSION: 'v1',
  IDEMPOTENCY_KEY: 'cd'.repeat(32),
};

describe('loadConfig', () => {
  it('[US6.1] 本番相当の設定が揃っていれば読み込める', () => {
    const config = loadConfig(prod);
    expect(config).toMatchObject({ environment: 'production', port: 3000 });
    expect(config.credentialKeys).toEqual([
      { version: 'v1', key: Buffer.from(KEY_HEX, 'hex') },
    ]);
  });

  it('[US3.2/AC3.2.5] 鍵を複数の版で渡せる（最後が発行用）', () => {
    const env: Record<string, string | undefined> = {
      ...prod,
      CREDENTIAL_HMAC_KEYS: `v1:${KEY_HEX},v2:${'ef'.repeat(32)}`,
    };
    delete env.CREDENTIAL_HMAC_KEY;
    expect(loadConfig(env).credentialKeys.map((k) => k.version)).toEqual([
      'v1',
      'v2',
    ]);
  });

  it.each([
    ['版が無い', KEY_HEX],
    ['鍵が短い', 'v1:abcd'],
    ['版が重複', `v1:${KEY_HEX},v1:${KEY_HEX}`],
  ])(
    '[US3.2/AC3.2.5] 鍵の版の形式の誤り（%s）は、起動に失敗する',
    (_, value) => {
      expect(() =>
        loadConfig({ ...prod, CREDENTIAL_HMAC_KEYS: value }),
      ).toThrow(/CREDENTIAL_HMAC_KEYS/);
    },
  );

  it.each([
    'CREDENTIAL_HMAC_KEY',
    'IDEMPOTENCY_KEY',
    'DATABASE_URL',
    'ALLOWED_ORIGIN',
  ])('[US6.1] 本番で %s が無ければ、起動に失敗する', (name) => {
    const env: Record<string, string | undefined> = { ...prod };
    delete env[name];
    expect(() => loadConfig(env)).toThrow(new RegExp(name));
  });

  it('本番で鍵が短ければ失敗する', () => {
    expect(() => loadConfig({ ...prod, CREDENTIAL_HMAC_KEY: 'abcd' })).toThrow(
      /CREDENTIAL_HMAC_KEY/,
    );
  });

  it('参加・復帰のレート制限は既定で 1 分 60 回。不正な値は起動に失敗する', () => {
    expect(loadConfig(prod).authRateLimitPerMinute).toBe(60);
    expect(
      loadConfig({ ...prod, AUTH_RATE_LIMIT_PER_MINUTE: '30' })
        .authRateLimitPerMinute,
    ).toBe(30);
    expect(() =>
      loadConfig({ ...prod, AUTH_RATE_LIMIT_PER_MINUTE: '0' }),
    ).toThrow(/AUTH_RATE_LIMIT_PER_MINUTE/);
  });

  it('[US6.1/AC6.1.3] メトリクスの環境名は APP_ENV、無ければ実行環境の名前', () => {
    expect(loadConfig(prod).metricsEnvironment).toBe('production');
    expect(loadConfig({ ...prod, APP_ENV: 'staging' }).metricsEnvironment).toBe(
      'staging',
    );
  });

  it('開発では、鍵が無くても既定値で起動する', () => {
    expect(loadConfig({ NODE_ENV: 'development' })).toMatchObject({
      environment: 'development',
      allowedOrigin: 'http://localhost:5173',
    });
  });
});

describe('HmacCredentialPolicy', () => {
  const v1 = { version: 'v1', key: Buffer.from(KEY_HEX, 'hex') };
  const v2 = { version: 'v2', key: Buffer.alloc(32, 7) };
  const policy = new HmacCredentialPolicy([v1]);

  it('[US1.2] 256 ビットの資格を発行し、ダイジェストと鍵の版だけを保存形式にする', () => {
    const { token, digest } = policy.issue();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(digest).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(digest).not.toContain(token);
    expect(policy.digestsOf(token)).toEqual([digest]);
  });

  it('[US3.2/AC3.2.5] 発行は最新の版の鍵。ローテーション後も、旧版の資格のダイジェストを検証用に返す', () => {
    const old = policy.issue();
    const rotated = new HmacCredentialPolicy([v1, v2]);
    expect(rotated.issue().digest).toMatch(/^v2:/);
    expect(rotated.digestsOf(old.token)).toContain(old.digest);
    expect(rotated.digestsOf(old.token)[0]).toMatch(/^v2:/);
  });

  it('旧版の鍵を外すと、旧版の資格は検証できない', () => {
    const old = policy.issue();
    const only2 = new HmacCredentialPolicy([v2]);
    expect(only2.digestsOf(old.token)).not.toContain(old.digest);
  });

  it('鍵が 1 つも無ければ作れない', () => {
    expect(() => new HmacCredentialPolicy([])).toThrow();
  });

  it('発行のたびに違う資格になる', () => {
    expect(policy.issue().token).not.toBe(policy.issue().token);
  });

  it('鍵が違えば、同じ資格でもダイジェストが違う（定数時間で比較する）', () => {
    const other = new HmacCredentialPolicy([
      { version: 'v1', key: Buffer.alloc(32, 1) },
    ]);
    const { token, digest } = policy.issue();
    expect(other.digestsOf(token)).not.toContain(digest);
    expect(policy.matches(token, digest)).toBe(true);
    expect(other.matches(token, digest)).toBe(false);
  });
});
