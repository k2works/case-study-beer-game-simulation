import { describe, expect, it } from 'vitest';
import { AppError, unavailableError } from '../../../src/server/errors.js';
import { Reporting } from '../../../src/server/reporting/reporting.js';
import { startRetentionScheduler } from '../../../src/server/retention/scheduler.js';
import { expectProblem } from '../../u3/support/helpers.js';
import { buildRig, finishedGame } from '../support/harness.js';

const reporting = (readSnapshot: () => Promise<never>) =>
  new Reporting({ store: { readSnapshot } });

describe('NFR2.3 reliability: 読み取りの失敗は、空の結果を返さずに 503 にする', () => {
  it('読み取りが失敗したら、結果も出力も 503（unavailable）。メッセージ（行の内容を含みうる）は返さない', async () => {
    const broken = reporting(async () => {
      throw new Error('接続エラー: 太郎のゲーム');
    });
    for (const run of [
      () => broken.results('11111111-1111-4111-8111-111111111111'),
      () => broken.exportGame('11111111-1111-4111-8111-111111111111', 'csv'),
    ]) {
      const error = await expectProblem(run(), 'unavailable');
      expect(JSON.stringify(error.problem)).not.toContain('太郎');
    }
  });

  it('保存の層が返した AppError（順番待ちの時間切れなど）は、そのまま返す', async () => {
    const waiting = reporting(async () => {
      throw unavailableError('待てませんでした', '少し待ってください');
    });
    const error = await waiting.results('x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).problem.reason).toBe('待てませんでした');
  });

  it('見つからないゲーム（削除済みを含む）は、存在しないゲームと同じ 403', async () => {
    const missing = new Reporting({ store: { readSnapshot: async () => null } });
    const results = await expectProblem(missing.results('x'), 'forbidden');
    const exported = await expectProblem(missing.exportGame('x', 'csv'), 'forbidden');
    expect(results.problem).toEqual(exported.problem);
  });

  it('終了前の出力の形式が誤りでも、読み取りの前に 422 を返す（権限のある人のみがここに届く）', async () => {
    let reads = 0;
    const counted = new Reporting({
      store: {
        readSnapshot: async () => {
          reads += 1;
          return null;
        },
      },
    });
    await expectProblem(counted.exportGame('x', 'xml'), 'validation');
    expect(reads).toBe(0);
  });
});

describe('結果と出力の整形の組み合わせ（メモリ上の保存）', () => {
  it('実際のゲームの結果は、ゲーム名を含まず、確定済みの週の数と一致する', async () => {
    const rig = buildRig();
    const game = await finishedGame(rig.world, 3);
    const view = await new Reporting({ store: rig.store }).results(game.gameId);
    expect(view.confirmedWeeks).toBe(3);
    expect(JSON.stringify(view)).not.toContain('試験のゲーム');
  });
});

describe('scheduler.lastRun: 直近に始まった 1 回を待てる', () => {
  it('実行中はその 1 回、終わっていれば最初の 1 回を返す', async () => {
    const scheduler = startRetentionScheduler({
      job: {
        runOnce: async () => ({
          startedAt: '2026-11-13T00:00:00.000Z',
          autoEnded: 0,
          deleted: 0,
          failed: 0,
          skipped: false,
          durationMs: 0,
          runFailed: false,
        }),
        requestStop: () => undefined,
      },
      intervalMs: 3_600_000,
      log: () => undefined,
    });
    await scheduler.lastRun();
    await scheduler.firstRun;
    await scheduler.lastRun();
    await scheduler.stop();
    expect(scheduler.consecutiveFailures()).toBe(0);
  });
});
