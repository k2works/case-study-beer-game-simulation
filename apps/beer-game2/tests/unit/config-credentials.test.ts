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
    expect(loadConfig(prod)).toMatchObject({
      environment: 'production',
      port: 3000,
      credentialKeyVersion: 'v1',
    });
  });

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

  it('開発では、鍵が無くても既定値で起動する', () => {
    expect(loadConfig({ NODE_ENV: 'development' })).toMatchObject({
      environment: 'development',
      allowedOrigin: 'http://localhost:5173',
    });
  });
});

describe('HmacCredentialPolicy', () => {
  const policy = new HmacCredentialPolicy(Buffer.from(KEY_HEX, 'hex'), 'v1');

  it('[US1.2] 256 ビットの資格を発行し、ダイジェストと鍵の版だけを保存形式にする', () => {
    const { token, digest } = policy.issue();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(digest).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(digest).not.toContain(token);
    expect(policy.digestOf(token)).toBe(digest);
  });

  it('発行のたびに違う資格になる', () => {
    expect(policy.issue().token).not.toBe(policy.issue().token);
  });

  it('鍵が違えば、同じ資格でもダイジェストが違う（定数時間で比較する）', () => {
    const other = new HmacCredentialPolicy(Buffer.alloc(32, 1), 'v1');
    const { token, digest } = policy.issue();
    expect(other.digestOf(token)).not.toBe(digest);
    expect(policy.matches(token, digest)).toBe(true);
    expect(other.matches(token, digest)).toBe(false);
  });
});
