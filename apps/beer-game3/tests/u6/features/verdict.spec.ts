import { describe, expect, it } from 'vitest';
import {
  evaluateThresholds,
  type MeasuredMetrics,
} from '../../../verification/shared/thresholds.js';

// 機能: 負荷試験の合否（AC5.3.1、NFR3.1〜NFR3.6）。閾値は緩めない

const good: MeasuredMetrics = {
  inputConfirmP95: 300,
  reflectionVirtualP95: 1500,
  reflectionBrowserP95: 1800,
  pollNormalP95: 120,
  pollPeakP95: 400,
  serverErrors: 0,
  timeouts: 0,
  connectFailures: 0,
  unexpectedResponses: 0,
  reflectionMissing: 0,
  consistencyBroken: 0,
  eventLoopP99Ms: 10,
};

const main = { mode: 'main' as const, browserTeams: 1, peakSeconds: 180 };
const smoke = { mode: 'smoke' as const, browserTeams: 0, peakSeconds: 0 };

const item = (result: ReturnType<typeof evaluateThresholds>, name: string) =>
  result.items.find((i) => i.name === name);

describe('シナリオ: 閾値の判定', () => {
  it('Given すべて閾値内 When 本試験で判定する Then pass（終了コード 0）で、要件の名前の閾値がすべてある', () => {
    const result = evaluateThresholds(good, main);
    expect(result).toMatchObject({ verdict: 'pass', exitCode: 0 });
    for (const name of [
      'inputConfirmP95',
      'reflectionVirtualP95',
      'reflectionBrowserP95',
      'pollNormalP95',
      'pollPeakP95',
      'serverErrors',
      'timeouts',
      'connectFailures',
      'consistency',
    ]) {
      expect(item(result, name), name).toBeDefined();
    }
  });

  it('閾値は要件のとおり（1 秒、2 秒、2 秒、500 ミリ秒、1 秒、0 件）', () => {
    const result = evaluateThresholds(good, main);
    expect(item(result, 'inputConfirmP95')?.limit).toBe(1000);
    expect(item(result, 'reflectionVirtualP95')?.limit).toBe(2000);
    expect(item(result, 'reflectionBrowserP95')?.limit).toBe(2000);
    expect(item(result, 'pollNormalP95')?.limit).toBe(500);
    expect(item(result, 'pollPeakP95')?.limit).toBe(1000);
    expect(item(result, 'serverErrors')?.limit).toBe(0);
  });

  it('Given 境界の値（ちょうど閾値）When 判定する Then 合格（以内）', () => {
    const result = evaluateThresholds(
      { ...good, pollNormalP95: 500, inputConfirmP95: 1000, reflectionVirtualP95: 2000 },
      main,
    );
    expect(result.verdict).toBe('pass');
  });

  it.each([
    ['inputConfirmP95', 1001],
    ['reflectionVirtualP95', 2001],
    ['reflectionBrowserP95', 2001],
    ['pollNormalP95', 501],
    ['pollPeakP95', 1001],
    ['serverErrors', 1],
    ['timeouts', 1],
    ['connectFailures', 1],
    ['unexpectedResponses', 1],
    ['consistencyBroken', 1],
  ] as const)('Given 本試験で %s=%s When 判定する Then fail（終了コード 1）', (key, value) => {
    const result = evaluateThresholds({ ...good, [key]: value }, main);
    expect(result).toMatchObject({ verdict: 'fail', exitCode: 1 });
  });

  it('Given 短い試験で入力の確定と反映が閾値を超える When 判定する Then 記録のみで合否に使わない（pass）', () => {
    const result = evaluateThresholds(
      { ...good, inputConfirmP95: 5000, reflectionVirtualP95: 9000, reflectionMissing: 3 },
      smoke,
    );
    expect(result).toMatchObject({ verdict: 'pass', exitCode: 0 });
    expect(item(result, 'inputConfirmP95')).toMatchObject({ recordedOnly: true, used: false });
    expect(item(result, 'reflectionVirtualP95')).toMatchObject({ recordedOnly: true, used: false });
  });

  it('Given 同じ値を本試験で判定 When 入力の確定が 5 秒 Then fail（本試験はすべてを判定する）', () => {
    expect(evaluateThresholds({ ...good, inputConfirmP95: 5000 }, main).verdict).toBe('fail');
  });

  it.each([
    ['pollNormalP95', 501],
    ['serverErrors', 1],
    ['timeouts', 1],
    ['consistencyBroken', 1],
  ] as const)('Given 短い試験で標本の多い指標 %s=%s When 判定する Then fail', (key, value) => {
    expect(evaluateThresholds({ ...good, [key]: value }, smoke).verdict).toBe('fail');
  });

  it('Given reflectionMissing が 1 件以上 When 本試験で判定する Then 記録のみ（合否は標本の値 10 秒が百分位に入ることで決まる）', () => {
    const result = evaluateThresholds({ ...good, reflectionMissing: 2 }, main);
    expect(item(result, 'reflectionMissing')).toMatchObject({ recordedOnly: true });
    expect(result.verdict).toBe('pass');
  });

  it('Given 実ブラウザのチームがない When 本試験で判定する Then 実ブラウザの閾値は判定に使わない', () => {
    const result = evaluateThresholds(
      { ...good, reflectionBrowserP95: null },
      { ...main, browserTeams: 0 },
    );
    expect(item(result, 'reflectionBrowserP95')?.used).toBe(false);
    expect(result.verdict).toBe('pass');
  });

  it('Given 最大想定の区間がない When 判定する Then pollPeakP95 は判定に使わない', () => {
    const result = evaluateThresholds({ ...good, pollPeakP95: null }, smoke);
    expect(item(result, 'pollPeakP95')?.used).toBe(false);
  });
});

describe('シナリオ: 測定器の飽和（無効）', () => {
  it('Given イベントループの遅れ（99 パーセンタイル）が 100 ミリ秒超 When 判定する Then invalid（終了コード 2）で、アプリケーションの不合格と区別する', () => {
    const result = evaluateThresholds({ ...good, eventLoopP99Ms: 101 }, main);
    expect(result).toMatchObject({ verdict: 'invalid', exitCode: 2 });
    expect(result.invalidReasons).toContain('harness_saturated');
  });

  it('Given 飽和と閾値の超過が同時 When 判定する Then invalid が優先される', () => {
    const result = evaluateThresholds({ ...good, eventLoopP99Ms: 500, pollNormalP95: 900 }, main);
    expect(result.verdict).toBe('invalid');
  });

  it('Given ちょうど 100 ミリ秒 When 判定する Then 飽和ではない', () => {
    expect(evaluateThresholds({ ...good, eventLoopP99Ms: 100 }, main).verdict).toBe('pass');
  });

  it('Given 判定に使う指標の標本がない When 判定する Then invalid（標本なしを合格にしない）', () => {
    const result = evaluateThresholds({ ...good, pollNormalP95: null }, smoke);
    expect(result.verdict).toBe('invalid');
    expect(result.invalidReasons).toContain('no_samples:pollNormalP95');
  });

  it('Given 実行側の無効の理由（起動の失敗など）When 判定する Then invalid', () => {
    const result = evaluateThresholds(good, { ...main, invalidReason: 'startup_failed' });
    expect(result).toMatchObject({ verdict: 'invalid', exitCode: 2 });
    expect(result.invalidReasons).toContain('startup_failed');
  });
});
