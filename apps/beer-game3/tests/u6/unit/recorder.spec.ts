import { describe, expect, it } from 'vitest';
import { Recorder } from '../../../verification/load/recorder.js';
import {
  MISSING_REFLECTION_SAMPLE_MS,
  TIMEOUT_SAMPLE_MS,
} from '../../../verification/shared/stats.js';

// 機能: 標本と台帳を持ち、失敗を標本から落とさない（NFR3.2〜NFR3.4、NFR2.1）

describe('シナリオ: 標本の記録（Recorder）', () => {
  it('Given 立ち上げ期間の標本 When 集計する Then 通常負荷の集計から除かれ、件数だけ別に残る', () => {
    const recorder = new Recorder();
    recorder.setPhase('warmup');
    recorder.recordPoll({ kind: 'ok', durationMs: 900, status: 200 });
    recorder.recordPoll({ kind: 'ok', durationMs: 800, status: 200 });
    recorder.setPhase('normal');
    recorder.recordPoll({ kind: 'ok', durationMs: 10, status: 200 });
    const snap = recorder.snapshot();
    expect(snap.phases.normal.poll).toEqual({ count: 1, p50: 10, p95: 10, p99: 10 });
    expect(snap.phases.warmup.poll.count).toBe(2);
  });

  it('Given タイムアウト When 記録する Then 標本の値を 5 秒として入れ、timeout を数える', () => {
    const recorder = new Recorder();
    recorder.setPhase('normal');
    recorder.recordPoll({ kind: 'timeout' });
    const snap = recorder.snapshot();
    expect(TIMEOUT_SAMPLE_MS).toBe(5000);
    expect(snap.phases.normal.poll.p95).toBe(5000);
    expect(snap.errors.timeout).toBe(1);
  });

  it('Given 接続の失敗 When 記録する Then 標本の値を 5 秒として入れ、connect を数える', () => {
    const recorder = new Recorder();
    recorder.setPhase('normal');
    recorder.recordPoll({ kind: 'connect' });
    const snap = recorder.snapshot();
    expect(snap.phases.normal.poll.p95).toBe(5000);
    expect(snap.errors.connect).toBe(1);
  });

  it('Given 5xx と 503 When 記録する Then http5xx と unavailable を数える（標本の値は実測）', () => {
    const recorder = new Recorder();
    recorder.setPhase('normal');
    recorder.recordPoll({ kind: 'ok', durationMs: 120, status: 500 });
    recorder.recordPoll({ kind: 'ok', durationMs: 130, status: 503 });
    const snap = recorder.snapshot();
    expect(snap.errors.http5xx).toBe(2);
    expect(snap.errors.unavailable).toBe(1);
    expect(snap.phases.normal.poll.count).toBe(2);
  });

  it('Given 429 と想定外の 4xx When 記録する Then rate_limited と unexpected4xx を数える（失敗として扱う）', () => {
    const recorder = new Recorder();
    recorder.setPhase('normal');
    recorder.recordPoll({ kind: 'ok', durationMs: 5, status: 429 });
    recorder.recordPoll({ kind: 'ok', durationMs: 5, status: 403 });
    const snap = recorder.snapshot();
    expect(snap.errors.rateLimited).toBe(1);
    expect(snap.errors.unexpected4xx).toBe(1);
  });

  it('Given 新しい週が現れなかった画面 When 反映を記録する Then 標本の値を 10 秒として入れ、reflectionMissing を数える', () => {
    const recorder = new Recorder();
    recorder.setPhase('normal');
    recorder.recordReflection('virtual', null);
    recorder.recordReflection('virtual', 300);
    const snap = recorder.snapshot();
    expect(MISSING_REFLECTION_SAMPLE_MS).toBe(10000);
    expect(snap.phases.normal.reflectionVirtual.count).toBe(2);
    expect(snap.phases.normal.reflectionVirtual.p99).toBe(10000);
    expect(snap.errors.reflectionMissing).toBe(1);
  });

  it('Given 実ブラウザの反映 When 記録する Then 仮想の利用者の反映とは別の欄に入る', () => {
    const recorder = new Recorder();
    recorder.setPhase('normal');
    recorder.recordReflection('browser', 1200);
    const snap = recorder.snapshot();
    expect(snap.phases.normal.reflectionBrowser.count).toBe(1);
    expect(snap.phases.normal.reflectionVirtual.count).toBe(0);
  });

  it('Given 遅れて送った取り直し When behind を足す Then 累積の回数を返す', () => {
    const recorder = new Recorder();
    recorder.addBehind(3);
    recorder.addBehind(2);
    expect(recorder.snapshot().behind).toBe(5);
  });

  it('Given 入力の確定の成功 When 台帳に載せる Then 成功した値だけが台帳に残る', () => {
    const recorder = new Recorder();
    recorder.setPhase('normal');
    recorder.recordInputConfirm(
      { kind: 'ok', durationMs: 40, status: 200 },
      {
        gameId: 'g1',
        week: 1,
        role: 'factory',
        quantity: 7,
      },
    );
    recorder.recordInputConfirm(
      { kind: 'timeout' },
      {
        gameId: 'g1',
        week: 1,
        role: 'retailer',
        quantity: 3,
      },
    );
    expect(recorder.ledger()).toEqual([{ gameId: 'g1', week: 1, role: 'factory', quantity: 7 }]);
    expect(recorder.snapshot().phases.normal.inputConfirm.count).toBe(2);
  });
});
