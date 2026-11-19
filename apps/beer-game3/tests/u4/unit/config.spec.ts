import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/server/config.js';
import { ConfigError } from '../../../src/server/errors.js';
import { TEST_ENV } from '../../u1/support/world.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost/db', ...TEST_ENV };

describe('NFR6.6 接続元の設定（TRUSTED_PROXY_HOPS）', () => {
  it('開発とテストでは未設定を許し、接続の相手のアドレスを使う（null）', () => {
    expect(loadConfig(base).trustedProxyHops).toBeNull();
    expect(loadConfig({ ...base, APP_ENV: 'test' }).trustedProxyHops).toBeNull();
  });

  it('staging と production では必須。未設定または不正なら起動しない', () => {
    for (const appEnv of ['staging', 'production']) {
      expect(() => loadConfig({ ...base, APP_ENV: appEnv })).toThrow(ConfigError);
      expect(() => loadConfig({ ...base, APP_ENV: appEnv, TRUSTED_PROXY_HOPS: 'abc' })).toThrow(
        ConfigError,
      );
      expect(() => loadConfig({ ...base, APP_ENV: appEnv, TRUSTED_PROXY_HOPS: '-1' })).toThrow(
        ConfigError,
      );
      expect(loadConfig({ ...base, APP_ENV: appEnv, TRUSTED_PROXY_HOPS: '1' })).toMatchObject({
        appEnv,
        trustedProxyHops: 1,
      });
    }
  });

  it('0 段（プロキシを信頼しない）も明示できる', () => {
    expect(
      loadConfig({ ...base, APP_ENV: 'production', TRUSTED_PROXY_HOPS: '0' }).trustedProxyHops,
    ).toBe(0);
  });

  it('APP_ENV が知らない値なら拒否する', () => {
    expect(() => loadConfig({ ...base, APP_ENV: 'prod' })).toThrow(ConfigError);
  });
});

describe('仮の数値の既定と上書き（24 時間、10 回、60 秒、1 分、10 分）', () => {
  it('既定の値を補う', () => {
    const config = loadConfig(base);
    expect(config.policy).toEqual({
      tokenTtlMs: 24 * 60 * 60 * 1000,
      touchIntervalMs: 60 * 1000,
      joinWindowMs: 60 * 1000,
      joinMaxAttempts: 10,
    });
    expect(config.sweepIntervalMs).toBe(10 * 60 * 1000);
  });

  it('環境変数で上書きでき、範囲外は拒否する', () => {
    expect(
      loadConfig({
        ...base,
        RETURN_TOKEN_TTL_MINUTES: '30',
        JOIN_WINDOW_MAX_ATTEMPTS: '5',
        JOIN_WINDOW_SECONDS: '120',
        TOKEN_TOUCH_INTERVAL_SECONDS: '30',
        JOIN_SWEEP_INTERVAL_MINUTES: '5',
      }),
    ).toMatchObject({
      policy: {
        tokenTtlMs: 30 * 60 * 1000,
        joinMaxAttempts: 5,
        joinWindowMs: 120 * 1000,
        touchIntervalMs: 30 * 1000,
      },
      sweepIntervalMs: 5 * 60 * 1000,
    });
    expect(() => loadConfig({ ...base, JOIN_WINDOW_MAX_ATTEMPTS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, RETURN_TOKEN_TTL_MINUTES: 'x' })).toThrow(ConfigError);
  });
});
