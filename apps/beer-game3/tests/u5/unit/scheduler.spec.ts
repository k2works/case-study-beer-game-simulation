import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RetentionRunResult } from '../../../src/server/retention/job.js';
import { startRetentionScheduler } from '../../../src/server/retention/scheduler.js';

const result = (overrides: Partial<RetentionRunResult> = {}): RetentionRunResult => ({
  startedAt: '2026-11-13T09:00:00.000Z',
  autoEnded: 0,
  deleted: 0,
  failed: 0,
  skipped: false,
  durationMs: 1,
  runFailed: false,
  ...overrides,
});

const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setup(results: Array<RetentionRunResult | Error | (() => Promise<RetentionRunResult>)>) {
  const queue = [...results];
  const logs: Array<Record<string, unknown>> = [];
  const job = {
    runOnce: vi.fn(async () => {
      const next = queue.shift() ?? result();
      if (next instanceof Error) {
        throw next;
      }
      return typeof next === 'function' ? next() : next;
    }),
    requestStop: vi.fn(),
  };
  const scheduler = startRetentionScheduler({
    job,
    intervalMs: 60 * MINUTE,
    log: (line) => logs.push(line),
  });
  return { job, logs, scheduler };
}

describe('BR26.1 BR26.5 起動時に待たずに 1 回、その後は一定の間隔で動く', () => {
  it('開始と同時に 1 回始め（起動を待たせない）、間隔ごとに動く', async () => {
    const { job, scheduler } = setup([]);
    expect(job.runOnce).toHaveBeenCalledTimes(1);
    await scheduler.firstRun;
    await vi.advanceTimersByTimeAsync(59 * MINUTE);
    expect(job.runOnce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(job.runOnce).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(job.runOnce).toHaveBeenCalledTimes(3);
    await scheduler.stop();
  });

  it('前の処理が終わっていなければ、その周期は飛ばす（重ねない）', async () => {
    let release: () => void = () => undefined;
    const slow = () =>
      new Promise<RetentionRunResult>((resolve) => {
        release = () => resolve(result());
      });
    const { job, scheduler } = setup([slow]);
    await vi.advanceTimersByTimeAsync(61 * MINUTE);
    expect(job.runOnce).toHaveBeenCalledTimes(1);
    release();
    await scheduler.firstRun;
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(job.runOnce).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });
});

describe('NFR9.2 連続の失敗の回数', () => {
  it('失敗で増え、成功で 0 に戻り、skipped では変わらない。3 回以上で毎回 error を出す', async () => {
    const { scheduler, logs } = setup([
      result({ failed: 1 }),
      result({ runFailed: true }),
      result({ skipped: true }),
      result({ failed: 2 }),
      result({ failed: 1 }),
      result(),
    ]);
    const counts: number[] = [];
    await scheduler.firstRun;
    counts.push(scheduler.consecutiveFailures());
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(60 * MINUTE);
      counts.push(scheduler.consecutiveFailures());
    }
    expect(counts).toEqual([1, 2, 2, 3, 4, 0]);
    const repeated = logs.filter((line) => line.event === 'retention_run_repeated_failure');
    expect(repeated.map((line) => line.consecutive)).toEqual([3, 4]);
    expect(repeated[0]).toMatchObject({ level: 'error' });
    await scheduler.stop();
  });

  it('処理が想定外の例外を投げても、タイマーは止まらず、未処理の拒否にならない（失敗に数える）', async () => {
    const { job, scheduler, logs } = setup([new Error('想定外')]);
    await scheduler.firstRun;
    expect(scheduler.consecutiveFailures()).toBe(1);
    expect(logs.find((line) => line.event === 'retention_run_failed')).toMatchObject({
      level: 'error',
      errorName: 'Error',
    });
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(job.runOnce).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });
});

describe('BR26.6 NFR5.2 停止: 次の周期を予約せず、実行中の処理の終わりを最大 10 秒待つ', () => {
  it('停止のあとは動かない。実行中の処理を待ってから戻る', async () => {
    let release: () => void = () => undefined;
    const slow = () =>
      new Promise<RetentionRunResult>((resolve) => {
        release = () => resolve(result({ deleted: 1 }));
      });
    const { job, scheduler } = setup([slow]);
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    expect(job.requestStop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(120 * MINUTE);
    expect(job.runOnce).toHaveBeenCalledTimes(1);
  });

  it('10 秒を超えても終わらなければ、待つのをやめて戻る', async () => {
    const never = () => new Promise<RetentionRunResult>(() => undefined);
    const { scheduler } = setup([never]);
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stopped).toBe(true);
  });

  it('何も実行していなければ、すぐに戻る', async () => {
    const { scheduler } = setup([]);
    await scheduler.firstRun;
    await scheduler.stop();
    expect(scheduler.consecutiveFailures()).toBe(0);
  });
});
