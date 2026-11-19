import type { Clock } from '../clock.js';
import type { AccessPolicy } from './policy.js';

export interface SweeperStore {
  sweepJoinAttempts(olderThan: Date): Promise<number>;
}

export interface SweeperDeps {
  store: SweeperStore;
  clock: Clock;
  policy: Pick<AccessPolicy, 'joinWindowMs'>;
  intervalMs: number;
  /** 構造化ログの出力先 */
  log: (line: Record<string, unknown>) => void;
}

export interface Sweeper {
  /** 起動時の掃除（完了を待ちたい試験用） */
  firstRun: Promise<void>;
  /** 直近に始まった掃除（完了を待ちたい試験用） */
  lastRun: () => Promise<void>;
  stop: () => void;
}

/** 窓の古い行を 1 回削除する。失敗は join_attempt_cleanup_failed として warn に出し、例外にしない。 */
export async function runJoinAttemptSweep(
  deps: Pick<SweeperDeps, 'store' | 'clock' | 'policy' | 'log'>,
): Promise<void> {
  try {
    const olderThan = new Date(deps.clock.now().getTime() - deps.policy.joinWindowMs);
    await deps.store.sweepJoinAttempts(olderThan);
  } catch (error) {
    deps.log({
      time: new Date().toISOString(),
      level: 'warn',
      event: 'join_attempt_cleanup_failed',
      errorName: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/**
 * 起動時にすぐ掃除し、以後は intervalMs ごとに掃除する。複数台で重なっても削除は冪等で、
 * ロック中の行は飛ばす。失敗しても次の周期で再実行する（BR18 / reliability-design.md）。
 */
export function startJoinAttemptSweeper(deps: SweeperDeps): Sweeper {
  let last = runJoinAttemptSweep(deps);
  const firstRun = last;
  const timer = setInterval(() => {
    last = runJoinAttemptSweep(deps);
  }, deps.intervalMs);
  // 掃除の周期だけではプロセスを生かし続けない
  timer.unref();
  return {
    firstRun,
    lastRun: () => last,
    stop: () => clearInterval(timer),
  };
}
