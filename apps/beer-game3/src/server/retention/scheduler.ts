import type { RetentionJob, RetentionRunResult } from './job.js';

/** 停止のとき、実行中の処理の終わりを待つ上限（ミリ秒、NFR5.2）。 */
export const STOP_WAIT_MS = 10_000;

/** 連続の失敗がこの回数以上になった回は、毎回 error を出す（NFR9.2）。 */
const REPEATED_FAILURE_THRESHOLD = 3;

export interface RetentionSchedulerDeps {
  job: Pick<RetentionJob, 'runOnce' | 'requestStop'>;
  intervalMs: number;
  log: (line: Record<string, unknown>) => void;
  stopWaitMs?: number;
}

export interface RetentionScheduler {
  /** 起動時の 1 回（完了を待ちたい試験用。起動は待たない） */
  firstRun: Promise<void>;
  /** 直近に始まった 1 回（完了を待ちたい試験用） */
  lastRun: () => Promise<void>;
  /** 連続の失敗の回数。失敗で増え、失敗のない成功で 0 に戻り、skipped では変わらない */
  consecutiveFailures: () => number;
  /** 次の周期を予約せず、実行中の処理の終わりを最大 stopWaitMs 待つ */
  stop: () => Promise<void>;
}

/**
 * アプリケーションの中のタイマー（BR26.1）。開始と同時に待たずに 1 回、その後は intervalMs ごとに動かす。
 * 前の処理が終わっていなければ、その周期は飛ばす。処理の例外でタイマーを止めず、未処理の拒否にもしない。
 */
export function startRetentionScheduler(deps: RetentionSchedulerDeps): RetentionScheduler {
  let consecutive = 0;
  let running: Promise<void> | null = null;
  let stopped = false;

  const record = (result: RetentionRunResult): void => {
    if (result.skipped) {
      return;
    }
    if (result.failed > 0 || result.runFailed) {
      consecutive += 1;
      if (consecutive >= REPEATED_FAILURE_THRESHOLD) {
        deps.log({
          time: new Date().toISOString(),
          level: 'error',
          event: 'retention_run_repeated_failure',
          consecutive,
        });
      }
    } else {
      consecutive = 0;
    }
  };

  const tick = (): Promise<void> => {
    if (stopped) {
      return Promise.resolve();
    }
    if (running) {
      return running;
    }
    const run: Promise<void> = (async () => {
      try {
        record(await deps.job.runOnce());
      } catch (error) {
        // runOnce は例外を投げない作りだが、タイマーを止めないための最後の守り
        deps.log({
          time: new Date().toISOString(),
          level: 'error',
          event: 'retention_run_failed',
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        record({
          startedAt: new Date().toISOString(),
          autoEnded: 0,
          deleted: 0,
          failed: 0,
          skipped: false,
          durationMs: 0,
          runFailed: true,
        });
      }
    })().finally(() => {
      if (running === run) {
        running = null;
      }
    });
    running = run;
    return run;
  };

  const firstRun = tick();
  const timer = setInterval(() => void tick(), deps.intervalMs);
  // 周期だけではプロセスを生かし続けない（タイマーはアプリケーションの停止を妨げない）
  timer.unref();

  return {
    firstRun,
    lastRun: () => running ?? firstRun,
    consecutiveFailures: () => consecutive,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      deps.job.requestStop();
      const current = running;
      if (!current) {
        return;
      }
      let waitTimer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        waitTimer = setTimeout(resolve, deps.stopWaitMs ?? STOP_WAIT_MS);
      });
      try {
        await Promise.race([current, timeout]);
      } finally {
        clearTimeout(waitTimer);
      }
    },
  };
}
