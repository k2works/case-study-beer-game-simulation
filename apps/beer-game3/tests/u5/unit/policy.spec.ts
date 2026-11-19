import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/server/config.js';
import { ConfigError } from '../../../src/server/errors.js';
import {
  DEFAULT_RETENTION_POLICY,
  describeRetentionPolicy,
  isExpired,
  isStale,
  loadRetentionPolicy,
} from '../../../src/server/retention/policy.js';
import { TEST_ENV } from '../../u1/support/world.js';
import { DAY_MS } from '../support/harness.js';

const T0 = new Date('2026-11-01T00:00:00.000Z');
const plus = (base: Date, ms: number): Date => new Date(base.getTime() + ms);

describe('NFR7.1 isExpired: 終了から保持期間を過ぎたか（「以降」の境界）', () => {
  it('直前は対象外、ちょうどと直後は対象', () => {
    expect(isExpired(T0, plus(T0, 30 * DAY_MS - 1), 30)).toBe(false);
    expect(isExpired(T0, plus(T0, 30 * DAY_MS), 30)).toBe(true);
    expect(isExpired(T0, plus(T0, 30 * DAY_MS + 1), 30)).toBe(true);
  });

  it('期間は引数で変わる（31 日たったゲームは 30 日で対象、8 日たったゲームは 7 日で対象）', () => {
    expect(isExpired(T0, plus(T0, 31 * DAY_MS), 30)).toBe(true);
    expect(isExpired(T0, plus(T0, 8 * DAY_MS), 7)).toBe(true);
    expect(isExpired(T0, plus(T0, 8 * DAY_MS), 30)).toBe(false);
  });
});

describe('NFR7.1 isStale: 最後の操作から自動終了の期間を過ぎたか', () => {
  it('直前は対象外、ちょうどと直後は対象', () => {
    expect(isStale(T0, plus(T0, 30 * DAY_MS - 1), 30)).toBe(false);
    expect(isStale(T0, plus(T0, 30 * DAY_MS), 30)).toBe(true);
    expect(isStale(T0, plus(T0, 31 * DAY_MS), 30)).toBe(true);
  });
});

describe('NFR6.6 loadRetentionPolicy: 範囲つきで読み、範囲の外は起動を拒否する', () => {
  it('未指定と空文字は既定（30 日、30 日、60 分、100 件）', () => {
    expect(loadRetentionPolicy({})).toEqual(DEFAULT_RETENTION_POLICY);
    expect(loadRetentionPolicy({ RETENTION_DAYS: '', AUTO_END_DAYS: ' ' })).toEqual({
      retentionDays: 30,
      autoEndDays: 30,
      jobIntervalMinutes: 60,
      batchLimit: 100,
    });
    expect(DEFAULT_RETENTION_POLICY).toEqual({
      retentionDays: 30,
      autoEndDays: 30,
      jobIntervalMinutes: 60,
      batchLimit: 100,
    });
  });

  it('指定した値を読む（上限と下限を含む）', () => {
    expect(
      loadRetentionPolicy({
        RETENTION_DAYS: '7',
        AUTO_END_DAYS: '3650',
        RETENTION_JOB_INTERVAL_MINUTES: '1',
        RETENTION_BATCH_LIMIT: '1000',
      }),
    ).toEqual({ retentionDays: 7, autoEndDays: 3650, jobIntervalMinutes: 1, batchLimit: 1000 });
  });

  it.each([
    ['RETENTION_DAYS', '0'],
    ['RETENTION_DAYS', '3651'],
    ['RETENTION_DAYS', '7.5'],
    ['RETENTION_DAYS', 'abc'],
    ['AUTO_END_DAYS', '0'],
    ['AUTO_END_DAYS', '-1'],
    ['RETENTION_JOB_INTERVAL_MINUTES', '0'],
    ['RETENTION_JOB_INTERVAL_MINUTES', '1441'],
    ['RETENTION_BATCH_LIMIT', '0'],
    ['RETENTION_BATCH_LIMIT', '1001'],
  ])('%s=%s は ConfigError', (name, value) => {
    expect(() => loadRetentionPolicy({ [name]: value })).toThrow(ConfigError);
    expect(() => loadRetentionPolicy({ [name]: value })).toThrow(name);
  });

  it('loadConfig が retention を持ち、範囲の外は起動しない', () => {
    const base = { DATABASE_URL: 'postgres://x', ...TEST_ENV };
    expect(loadConfig(base).retention).toEqual(DEFAULT_RETENTION_POLICY);
    expect(loadConfig({ ...base, RETENTION_DAYS: '14' }).retention.retentionDays).toBe(14);
    expect(() => loadConfig({ ...base, RETENTION_DAYS: '0' })).toThrow(ConfigError);
  });
});

describe('NFR6.6 起動時のログ: 有効な設定値と、既定より短いときの警告', () => {
  it('既定のとき: 設定値の 1 行（info）だけ', () => {
    const lines = describeRetentionPolicy(DEFAULT_RETENTION_POLICY);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      event: 'retention_config',
      retentionDays: 30,
      autoEndDays: 30,
      jobIntervalMinutes: 60,
      batchLimit: 100,
    });
  });

  it('保持期間または自動終了が 30 日より短いとき: warn の 1 行を足す', () => {
    const lines = describeRetentionPolicy({ ...DEFAULT_RETENTION_POLICY, retentionDays: 7 });
    expect(lines.map((line) => line.event)).toEqual([
      'retention_config',
      'retention_config_shorter_than_default',
    ]);
    expect(lines[1]).toMatchObject({ level: 'warn' });
    const second = describeRetentionPolicy({ ...DEFAULT_RETENTION_POLICY, autoEndDays: 29 });
    expect(second).toHaveLength(2);
  });
});
