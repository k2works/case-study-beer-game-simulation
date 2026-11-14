import { describe, expect, it } from 'vitest';
import { runVerification } from '../../../verification/load/runner.js';
import { REQUIRED_SUMMARY_FIELDS } from '../../../verification/shared/summary.js';
import { parseVerifyConfig, type VerifyConfig } from '../../../verification/shared/config.js';
import { containsSecret } from '../../../verification/shared/secret.js';
import { SeededPlan } from '../../../verification/shared/rng.js';
import { adminUrl, listVerifyDatabases } from '../support/pg.js';

// 機能: 負荷試験の実行が、アプリケーションと PostgreSQL に対して合格で終わり、要約が揃う（AC5.3.1）

function shortConfig(over: Record<string, string> = {}): VerifyConfig {
  const parsed = parseVerifyConfig(
    {
      VERIFY_TEAMS: '2',
      VERIFY_WARMUP_SECONDS: '1',
      VERIFY_NORMAL_SECONDS: '5',
      VERIFY_CONFIRM_INTERVAL_SECONDS: '2',
      VERIFY_POLL_INTERVAL_MS: '500',
      ...over,
    },
    'smoke',
  );
  if (!parsed.ok) {
    throw new Error(parsed.problems.join(','));
  }
  return parsed.config;
}

describe('シナリオ: 短い負荷試験の実行', () => {
  it('Given 2 チーム数秒の設定 When 実行する Then 合格（終了コード 0）で、要約の必須の欄が揃い、資格情報を含まず、データベースが残らない', async () => {
    const before = await listVerifyDatabases();
    const result = await runVerification({
      config: shortConfig(),
      mode: 'smoke',
      adminDatabaseUrl: adminUrl(),
      revision: { commit: 'test', branch: 'test' },
      log: () => undefined,
    });
    expect(result.exitCode).toBe(0);
    expect(result.summary.verdict.result).toBe('pass');
    for (const field of REQUIRED_SUMMARY_FIELDS) {
      expect(result.summary, field).toHaveProperty(field);
    }
    expect(result.summary.errors).toMatchObject({ http5xx: 0, timeout: 0, connect: 0 });
    expect(result.summary.consistency.checkedGames).toBe(2);
    expect(result.summary.consistency.broken).toEqual([]);
    expect(result.summary.phases.normal.poll.count).toBeGreaterThan(20);
    expect(result.summary.harness.disconnectsSimulated).toBeGreaterThanOrEqual(1);
    expect(result.secrets.length).toBeGreaterThan(0);
    expect(
      containsSecret(
        JSON.stringify(result.summary),
        result.secrets.map((secret) => secret.reveal()),
      ),
    ).toBe(false);
    expect(await listVerifyDatabases()).toEqual(before);
  }, 90_000);

  it('Given 同じ種 When 2 回実行する Then 送った要求の値は種の列と一致し、2 回で食い違わない', async () => {
    const run = () =>
      runVerification({
        config: shortConfig({ VERIFY_SEED: '777' }),
        mode: 'smoke',
        adminDatabaseUrl: adminUrl(),
        revision: { commit: 'test', branch: 'test' },
        log: () => undefined,
      });
    const first = await run();
    const second = await run();
    const plan = new SeededPlan(777);
    const keyOf = (e: { team: number; week: number; role: string }) =>
      `${e.team}/${e.week}/${e.role}`;
    const firstMap = new Map(first.ledger.map((e) => [keyOf(e), e.quantity]));
    for (const entry of [...first.ledger, ...second.ledger]) {
      expect(entry.quantity).toBe(plan.quantity(entry.team, entry.week, entry.role));
    }
    for (const entry of second.ledger) {
      const other = firstMap.get(keyOf(entry));
      if (other !== undefined) {
        expect(other).toBe(entry.quantity);
      }
    }
    expect(first.ledger.length).toBeGreaterThan(0);
  }, 150_000);

  it('Given 測定器の飽和を模擬する When 実行する Then 無効（終了コード 2）で、アプリケーションの結果と分けて報告する', async () => {
    const result = await runVerification({
      config: shortConfig({ VERIFY_NORMAL_SECONDS: '3' }),
      mode: 'smoke',
      adminDatabaseUrl: adminUrl(),
      revision: { commit: 'test', branch: 'test' },
      log: () => undefined,
      eventLoopP99Ms: () => 250,
    });
    expect(result.exitCode).toBe(2);
    expect(result.summary.verdict).toMatchObject({ result: 'invalid' });
    expect(result.summary.verdict.reasons).toContain('harness_saturated');
    expect(result.summary.harness.saturated).toBe(true);
  }, 90_000);

  it('Given 外部のデータベースの管理用の接続 When 許可なしで実行する Then 何も起動せず終了コード 2', async () => {
    const before = await listVerifyDatabases();
    const result = await runVerification({
      config: shortConfig(),
      mode: 'smoke',
      adminDatabaseUrl: 'postgres://app:pw@db.prod.example.com:5432/postgres',
      revision: { commit: 'test', branch: 'test' },
      log: () => undefined,
    });
    expect(result.exitCode).toBe(2);
    expect(result.summary.verdict.reasons).toContain('target_not_allowed');
    expect(JSON.stringify(result.summary)).not.toContain('db.prod.example.com');
    expect(await listVerifyDatabases()).toEqual(before);
  }, 30_000);
});
