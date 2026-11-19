import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  parseVerifyConfig,
  weekCountFor,
} from '../../../verification/shared/config.js';
import { SeededPlan, displayNameFor } from '../../../verification/shared/rng.js';
import { ROLES } from '../../../verification/shared/roles.js';
import { percentile, summarize } from '../../../verification/shared/stats.js';

// 機能: 同じ入力から同じ要求の列と同じ統計が出る（NFR1.2、NFR9.1）

describe('シナリオ: 種付きの要求の列（SeededPlan）', () => {
  it('Given 同じ種と設定 When 2 回生成する Then 要求の列が一致する', () => {
    const a = new SeededPlan(20261113).sequence(3, 12);
    const b = new SeededPlan(20261113).sequence(3, 12);
    expect(a).toEqual(b);
    expect(a).toHaveLength(12 * ROLES.length);
  });

  it('Given 違う種 When 生成する Then 列が変わる', () => {
    expect(new SeededPlan(1).sequence(0, 12)).not.toEqual(new SeededPlan(2).sequence(0, 12));
  });

  it('Given 2 つのチーム When 生成する Then 列は互いに独立（チームの番号で別の列）', () => {
    const plan = new SeededPlan(7);
    expect(plan.sequence(0, 12)).not.toEqual(plan.sequence(1, 12));
    // 生成の順序に依存しない（先に別のチームを作っても同じ）
    const fresh = new SeededPlan(7);
    fresh.sequence(5, 12);
    expect(fresh.sequence(1, 12)).toEqual(plan.sequence(1, 12));
  });

  it('Given 要求の列 Then 値は 0〜20 の整数で、時刻や応答を含まない', () => {
    for (const item of new SeededPlan(9).sequence(2, 30)) {
      expect(Number.isInteger(item.quantity)).toBe(true);
      expect(item.quantity).toBeGreaterThanOrEqual(0);
      expect(item.quantity).toBeLessThanOrEqual(20);
      expect(Object.keys(item).sort()).toEqual(['quantity', 'role', 'team', 'week']);
    }
  });

  it('Given チームの番号と役割 When 表示名を作る Then 架空の規則に合い、表示名の制約（40 文字以内、先頭が = + - @ でない）を満たす', () => {
    for (let team = 0; team < 15; team += 1) {
      for (const label of ['進行役', '工場', '一次卸', '二次卸', '小売店', '追加 12', '観察者']) {
        const name = displayNameFor(team, label);
        expect(name).toMatch(/^試験チーム \d{2} .+$/);
        expect([...name].length).toBeLessThanOrEqual(40);
        expect('=+-@\t\r'.includes(name[0] ?? '=')).toBe(false);
      }
    }
    expect(displayNameFor(2, '工場')).toBe('試験チーム 03 工場');
  });
});

describe('シナリオ: 百分位（最近順位法）', () => {
  it('Given 1〜100 When 95 パーセンタイルを求める Then 95 番目の値', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 99)).toBe(99);
  });

  it('Given 50 件 When 95 パーセンタイル Then 48 番目（ceil(0.95 × 50)）', () => {
    const values = Array.from({ length: 50 }, (_, i) => (i + 1) * 10);
    expect(percentile(values, 95)).toBe(480);
  });

  it('Given 順序の乱れた入力 When 求める Then 入力を書き換えずに正しい値を返す', () => {
    const values = [5, 1, 4, 2, 3];
    expect(percentile(values, 50)).toBe(3);
    expect(values).toEqual([5, 1, 4, 2, 3]);
  });

  it('Given 空 When 求める Then null（値を作らない）', () => {
    expect(percentile([], 95)).toBeNull();
    expect(summarize([])).toEqual({ count: 0, p50: null, p95: null, p99: null });
  });

  it('summarize は件数と 50、95、99 パーセンタイルを返す', () => {
    const values = Array.from({ length: 200 }, (_, i) => i + 1);
    expect(summarize(values)).toEqual({ count: 200, p50: 100, p95: 190, p99: 198 });
  });
});

describe('シナリオ: 設定の読み込み', () => {
  it('Given 何も指定しない When 読む Then 既定は要件の表の値', () => {
    const result = parseVerifyConfig({});
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.config).toMatchObject({
      teams: 15,
      screensPerTeam: 5,
      extraScreensPerTeam: 13,
      pollIntervalMs: 1000,
      confirmIntervalSeconds: 60,
      warmupSeconds: 10,
      normalSeconds: 600,
      peakSeconds: 180,
      browserTeams: 0,
    });
    expect(result.config.seed).toBe(DEFAULT_CONFIG.seed);
  });

  it('Given 短い試験 When 読む Then 1 分、15 チーム、最大想定の区間と実ブラウザなし', () => {
    const result = parseVerifyConfig({}, 'smoke');
    expect(result.ok && result.config).toMatchObject({
      teams: 15,
      normalSeconds: 60,
      peakSeconds: 0,
      extraScreensPerTeam: 0,
      browserTeams: 0,
    });
  });

  it('Given 本試験 When 読む Then 通常負荷 10 分、最大想定 3 分、実ブラウザ 1 チーム', () => {
    const result = parseVerifyConfig({}, 'main');
    expect(result.ok && result.config).toMatchObject({
      normalSeconds: 600,
      peakSeconds: 180,
      browserTeams: 1,
    });
  });

  it('Given 環境変数 When 読む Then 上書きできる', () => {
    const result = parseVerifyConfig(
      { VERIFY_TEAMS: '2', VERIFY_NORMAL_SECONDS: '5', VERIFY_SEED: '42' },
      'smoke',
    );
    expect(result.ok && result.config).toMatchObject({ teams: 2, normalSeconds: 5, seed: 42 });
  });

  it.each([
    ['VERIFY_TEAMS', '16'],
    ['VERIFY_TEAMS', '0'],
    ['VERIFY_TEAMS', '-1'],
    ['VERIFY_TEAMS', 'abc'],
    ['VERIFY_NORMAL_SECONDS', '0'],
    ['VERIFY_PEAK_SECONDS', '-5'],
    ['VERIFY_BROWSER_TEAMS', '3'],
    ['VERIFY_CONFIRM_INTERVAL_SECONDS', '0'],
  ])(
    'Given %s=%s When 読む Then 不正として問題の一覧を返す（終了コード 2 の元）',
    (name, value) => {
      const result = parseVerifyConfig({ [name]: value });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems.length).toBeGreaterThan(0);
        expect(result.problems.join('')).toContain(name);
      }
    },
  );

  it('Given 実ブラウザのチームがチーム数を超える When 読む Then 不正', () => {
    expect(parseVerifyConfig({ VERIFY_TEAMS: '1', VERIFY_BROWSER_TEAMS: '1' }).ok).toBe(true);
    expect(parseVerifyConfig({ VERIFY_TEAMS: '1', VERIFY_BROWSER_TEAMS: '2' }).ok).toBe(false);
  });

  it('weekCountFor は区間の長さと確定の頻度から、確定が続けられる週数を決める（最大 50）', () => {
    expect(
      weekCountFor({ ...DEFAULT_CONFIG, normalSeconds: 60, peakSeconds: 0 }),
    ).toBeGreaterThanOrEqual(2);
    expect(weekCountFor(DEFAULT_CONFIG)).toBeGreaterThanOrEqual(13);
    expect(weekCountFor({ ...DEFAULT_CONFIG, normalSeconds: 100000 })).toBe(50);
  });
});
