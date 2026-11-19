import type { Clock } from '../clock.js';
import type { AutoEndResult, DeleteResult } from '../session/game-session.js';
import type { Store } from '../session/store.js';
import { FailureMemory } from './failure-memory.js';
import { expiredBefore, staleBefore, type RetentionPolicy } from './policy.js';

/** 定期処理の排他の鍵（BR26.2）。PostgreSQL のアドバイザリロックの鍵は、この名前から導く。 */
export const RETENTION_LOCK_KEY = 'beer-game3:retention-job';

/** 1 回分の結果（RetentionRunResult）。runFailed は全体の失敗で、ログには出さず連続の失敗の判定に使う。 */
export interface RetentionRunResult {
  startedAt: string;
  autoEnded: number;
  deleted: number;
  failed: number;
  skipped: boolean;
  durationMs: number;
  runFailed: boolean;
}

type LogLine = Record<string, unknown>;

export interface RetentionJobDeps {
  store: Pick<Store, 'findStaleGames' | 'findExpiredGames' | 'runExclusive'>;
  /** GameSession の内部の入口（HTTP の経路は持たない） */
  session: {
    autoEnd(gameId: string, staleBefore: Date): Promise<AutoEndResult>;
    deleteIfExpired(gameId: string, expiredBefore: Date): Promise<DeleteResult>;
  };
  clock: Clock;
  policy: RetentionPolicy;
  /** 構造化ログの出力先。許可リストの項目だけを渡す（NFR6.4） */
  log: (line: LogLine) => void;
  failures?: FailureMemory;
}

const errorNameOf = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');

interface Counters {
  autoEnded: number;
  deleted: number;
  failed: number;
}

/**
 * 定期処理の 1 回分（BR26）。アドバイザリロックを取り、削除の対象を選んでから、
 * 自動終了を先に、削除を後に、1 ゲームずつ順に行う。1 つのゲームの失敗はほかを止めない。
 * 時刻は注入した Clock から得る（試験では runOnce に時刻を指定して直接呼べる）。
 */
export class RetentionJob {
  private readonly failures: FailureMemory;
  private stopRequested = false;

  constructor(private readonly deps: RetentionJobDeps) {
    this.failures =
      deps.failures ?? new FailureMemory({ cooldownMs: deps.policy.jobIntervalMinutes * 60_000 });
  }

  /** 停止の要求。実行中の 1 ゲームの保存が終わったら、次のゲームを始めずに終える（NFR5.2）。 */
  requestStop(): void {
    this.stopRequested = true;
  }

  async runOnce(now: Date = this.deps.clock.now()): Promise<RetentionRunResult> {
    const started = performance.now();
    const counters: Counters = { autoEnded: 0, deleted: 0, failed: 0 };
    let skipped = false;
    let runFailed = false;
    try {
      const outcome = await this.deps.store.runExclusive(RETENTION_LOCK_KEY, () =>
        this.work(now, counters),
      );
      skipped = !outcome.acquired;
    } catch (error) {
      // 全体の失敗（データベースに接続できない、など）。例外にせず、次の周期でやり直す（BR26.4）
      runFailed = true;
      this.deps.log({
        time: new Date().toISOString(),
        level: 'error',
        event: 'retention_run_failed',
        errorName: errorNameOf(error),
      });
    }
    const result: RetentionRunResult = {
      startedAt: now.toISOString(),
      ...counters,
      skipped,
      durationMs: Math.round(performance.now() - started),
      runFailed,
    };
    this.deps.log({
      time: new Date().toISOString(),
      level: runFailed ? 'error' : counters.failed > 0 ? 'warn' : 'info',
      event: 'retention_run',
      startedAt: result.startedAt,
      autoEnded: result.autoEnded,
      deleted: result.deleted,
      failed: result.failed,
      skipped: result.skipped,
      durationMs: result.durationMs,
    });
    return result;
  }

  private async work(now: Date, counters: Counters): Promise<void> {
    const { store, session, policy } = this.deps;
    const staleLimit = staleBefore(now, policy.autoEndDays);
    const expiredLimit = expiredBefore(now, policy.retentionDays);
    const exclude = this.failures.excluded(now);
    // 削除の対象は、自動終了を行う前の時点で選ぶ（BR25.5）。直近に失敗したゲームは除いて選ぶ（BR26.3）
    const expired = await store.findExpiredGames(expiredLimit, policy.batchLimit, exclude);
    const stale = await store.findStaleGames(staleLimit, policy.batchLimit, exclude);

    for (const gameId of stale) {
      if (this.stopRequested) {
        return;
      }
      try {
        const outcome = await session.autoEnd(gameId, staleLimit);
        if (outcome === 'ended') {
          counters.autoEnded += 1;
          this.deps.log({
            time: new Date().toISOString(),
            level: 'info',
            event: 'game_auto_ended',
            gameId,
            at: now.toISOString(),
            reason: 'autoEnd',
          });
        }
        this.failures.forget(gameId);
      } catch (error) {
        this.fail(counters, gameId, 'autoEnd', error, now);
      }
    }

    for (const gameId of expired) {
      if (this.stopRequested) {
        return;
      }
      try {
        const outcome = await session.deleteIfExpired(gameId, expiredLimit);
        if (outcome === 'deleted') {
          counters.deleted += 1;
          // ログに残すのは、ゲームの識別子、削除の時刻、理由だけ（BR24.6）
          this.deps.log({
            time: new Date().toISOString(),
            level: 'info',
            event: 'game_deleted',
            gameId,
            deletedAt: now.toISOString(),
            reason: 'retentionExpired',
          });
        }
        this.failures.forget(gameId);
      } catch (error) {
        this.fail(counters, gameId, 'delete', error, now);
      }
    }
  }

  /** 1 つのゲームの失敗: 種類だけをログに出し（メッセージは出さない）、1 周期のあいだ選択から外す。 */
  private fail(
    counters: Counters,
    gameId: string,
    operation: 'autoEnd' | 'delete',
    error: unknown,
    now: Date,
  ): void {
    counters.failed += 1;
    this.failures.record(gameId, now);
    this.deps.log({
      time: new Date().toISOString(),
      level: 'warn',
      event: 'game_retention_failed',
      gameId,
      operation,
      errorName: errorNameOf(error),
    });
  }
}
