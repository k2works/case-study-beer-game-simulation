import { describe, expect, it, vi } from 'vitest';
import { FailureMemory } from '../../../src/server/retention/failure-memory.js';
import {
  RETENTION_LOCK_KEY,
  RetentionJob,
  type RetentionJobDeps,
} from '../../../src/server/retention/job.js';
import { DEFAULT_RETENTION_POLICY } from '../../../src/server/retention/policy.js';
import { DAY_MS } from '../support/harness.js';

const NOW = new Date('2026-11-13T09:00:00.000Z');

interface Rig {
  calls: string[];
  logs: Array<Record<string, unknown>>;
  job: RetentionJob;
  store: RetentionJobDeps['store'] & {
    findStaleGames: ReturnType<typeof vi.fn>;
    findExpiredGames: ReturnType<typeof vi.fn>;
  };
  session: {
    autoEnd: ReturnType<typeof vi.fn>;
    deleteIfExpired: ReturnType<typeof vi.fn>;
  };
  failures: FailureMemory;
}

function rig(options: {
  stale?: string[];
  expired?: string[];
  autoEnd?: (id: string) => Promise<string>;
  deleteIfExpired?: (id: string) => Promise<string>;
  acquired?: boolean;
  findExpiredFails?: boolean;
  policy?: Partial<typeof DEFAULT_RETENTION_POLICY>;
}): Rig {
  const calls: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const failures = new FailureMemory({ cooldownMs: 60 * 60_000 });
  const store = {
    findStaleGames: vi.fn(async () => {
      calls.push('findStale');
      return options.stale ?? [];
    }),
    findExpiredGames: vi.fn(async () => {
      calls.push('findExpired');
      if (options.findExpiredFails) {
        throw Object.assign(new Error('接続できません: 太郎'), { name: 'ConnectionError' });
      }
      return options.expired ?? [];
    }),
    runExclusive: vi.fn(async (key: string, fn: () => Promise<unknown>) => {
      calls.push(`lock:${key}`);
      if (options.acquired === false) {
        return { acquired: false as const };
      }
      return { acquired: true as const, value: await fn() };
    }),
  } as unknown as Rig['store'];
  const session = {
    autoEnd: vi.fn(async (id: string) => {
      calls.push(`autoEnd:${id}`);
      return (options.autoEnd ? options.autoEnd(id) : 'ended') as never;
    }),
    deleteIfExpired: vi.fn(async (id: string) => {
      calls.push(`delete:${id}`);
      return (options.deleteIfExpired ? options.deleteIfExpired(id) : 'deleted') as never;
    }),
  };
  const job = new RetentionJob({
    store,
    session,
    clock: { now: () => NOW },
    policy: { ...DEFAULT_RETENTION_POLICY, ...options.policy },
    log: (line) => logs.push(line),
    failures,
  });
  return { calls, logs, job, store, session, failures };
}

describe('BR26.3 1 回の処理: 削除の対象を先に選び、自動終了を先に、削除を後に行う', () => {
  it('ロックを取り、対象は期限の時刻と上限と除外つきで選ぶ', async () => {
    const r = rig({ stale: ['s1', 's2'], expired: ['e1'] });
    r.failures.record('bad', NOW);
    const result = await r.job.runOnce();

    expect(r.calls).toEqual([
      `lock:${RETENTION_LOCK_KEY}`,
      'findExpired',
      'findStale',
      'autoEnd:s1',
      'autoEnd:s2',
      'delete:e1',
    ]);
    expect(r.store.findStaleGames).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 30 * DAY_MS),
      100,
      ['bad'],
    );
    expect(r.store.findExpiredGames).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 30 * DAY_MS),
      100,
      ['bad'],
    );
    expect(r.session.autoEnd).toHaveBeenCalledWith('s1', new Date(NOW.getTime() - 30 * DAY_MS));
    expect(r.session.deleteIfExpired).toHaveBeenCalledWith(
      'e1',
      new Date(NOW.getTime() - 30 * DAY_MS),
    );
    expect(result).toMatchObject({ autoEnded: 2, deleted: 1, failed: 0, skipped: false });
    expect(result.runFailed).toBe(false);
  });

  it('設定した期間と上限を、そのまま使う', async () => {
    const r = rig({ policy: { retentionDays: 7, autoEndDays: 14, batchLimit: 5 } });
    await r.job.runOnce(NOW);
    expect(r.store.findExpiredGames).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 7 * DAY_MS),
      5,
      [],
    );
    expect(r.store.findStaleGames).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 14 * DAY_MS),
      5,
      [],
    );
  });
});

describe('BR24.5 BR25.4 結果の区別: 対象から外れたものは、失敗にも件数にも数えない', () => {
  it('not-stale、already-ended、not-expired、not-found は失敗ではない', async () => {
    const outcomes: Record<string, string> = {
      a: 'not-stale',
      b: 'already-ended',
      c: 'not-found',
      d: 'ended',
      x: 'not-expired',
      y: 'not-found',
      z: 'deleted',
    };
    const r = rig({
      stale: ['a', 'b', 'c', 'd'],
      expired: ['x', 'y', 'z'],
      autoEnd: async (id) => outcomes[id]!,
      deleteIfExpired: async (id) => outcomes[id]!,
    });
    expect(await r.job.runOnce()).toMatchObject({ autoEnded: 1, deleted: 1, failed: 0 });
    expect(r.logs.filter((line) => line.event === 'game_auto_ended')).toHaveLength(1);
    expect(r.logs.filter((line) => line.event === 'game_deleted')).toHaveLength(1);
  });
});

describe('BR26.2 ロックを取れないとき', () => {
  it('何もせず skipped を返し、info でログに出す', async () => {
    const r = rig({ stale: ['s1'], expired: ['e1'], acquired: false });
    const result = await r.job.runOnce();
    expect(result).toMatchObject({ skipped: true, autoEnded: 0, deleted: 0, failed: 0 });
    expect(r.calls).toEqual([`lock:${RETENTION_LOCK_KEY}`]);
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toMatchObject({ event: 'retention_run', level: 'info', skipped: true });
  });
});

describe('BR26.4 失敗の扱い', () => {
  it('1 つのゲームの失敗は、残りを止めない。失敗は FailureMemory に記録し、成功は忘れる', async () => {
    const r = rig({
      stale: ['s1', 's2'],
      expired: ['e1', 'e2'],
      autoEnd: async (id) => {
        if (id === 's1') {
          throw Object.assign(new Error('個人の情報を含むメッセージ'), { name: 'StoreError' });
        }
        return 'ended';
      },
      deleteIfExpired: async (id) => {
        if (id === 'e1') {
          throw new Error('x');
        }
        return 'deleted';
      },
    });
    // 前の周期に失敗していたが、今回は成功する（成功したら忘れる）
    r.failures.record('s2', new Date(NOW.getTime() - 1000));
    expect(r.failures.excluded(NOW)).toEqual(['s2']);
    const result = await r.job.runOnce();
    expect(result).toMatchObject({ autoEnded: 1, deleted: 1, failed: 2, runFailed: false });
    expect(r.failures.excluded(NOW).sort()).toEqual(['e1', 's1']);
    const failed = r.logs.filter((line) => line.event === 'game_retention_failed');
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({
      level: 'warn',
      gameId: 's1',
      operation: 'autoEnd',
      errorName: 'StoreError',
    });
    expect(failed[1]).toMatchObject({ gameId: 'e1', operation: 'delete' });
    expect(JSON.stringify(r.logs)).not.toContain('個人の情報');
    expect(r.logs.find((line) => line.event === 'retention_run')).toMatchObject({
      level: 'warn',
      failed: 2,
    });
  });

  it('全体の失敗（対象を選べない、など）は例外にせず、error でログに出して結果を返す', async () => {
    const r = rig({ findExpiredFails: true, stale: ['s1'] });
    const result = await r.job.runOnce();
    expect(result).toMatchObject({ runFailed: true, autoEnded: 0, deleted: 0, skipped: false });
    const failure = r.logs.find((line) => line.event === 'retention_run_failed');
    expect(failure).toMatchObject({ level: 'error', errorName: 'ConnectionError' });
    expect(JSON.stringify(r.logs)).not.toContain('太郎');
    expect(r.logs.find((line) => line.event === 'retention_run')).toMatchObject({ level: 'error' });
  });

  it('ロックの取得そのものが失敗しても、例外にしない', async () => {
    const r = rig({});
    r.store.runExclusive = vi.fn(async () => {
      throw Object.assign(new Error('timeout'), { name: 'UnavailableError' });
    }) as never;
    const result = await r.job.runOnce();
    expect(result.runFailed).toBe(true);
  });
});

describe('NFR5.2 停止の要求', () => {
  it('停止の要求があれば、次のゲームを始めずに終える', async () => {
    const r = rig({ stale: ['s1', 's2', 's3'], expired: ['e1'] });
    r.session.autoEnd.mockImplementation(async (id: string) => {
      r.calls.push(`autoEnd:${id}`);
      if (id === 's1') {
        r.job.requestStop();
      }
      return 'ended';
    });
    const result = await r.job.runOnce();
    expect(r.calls.filter((c) => c.startsWith('autoEnd'))).toEqual(['autoEnd:s1']);
    expect(r.calls.some((c) => c.startsWith('delete'))).toBe(false);
    expect(result).toMatchObject({ autoEnded: 1, deleted: 0 });
  });
});

describe('結果のログ（RetentionRunResult）', () => {
  it('startedAt、各件数、skipped、所要時間を 1 行で出す', async () => {
    const r = rig({ stale: ['s1'], expired: ['e1'] });
    await r.job.runOnce();
    const summary = r.logs.find((line) => line.event === 'retention_run')!;
    expect(Object.keys(summary).sort()).toEqual([
      'autoEnded',
      'deleted',
      'durationMs',
      'event',
      'failed',
      'level',
      'skipped',
      'startedAt',
      'time',
    ]);
    expect(summary).toMatchObject({
      level: 'info',
      startedAt: NOW.toISOString(),
      autoEnded: 1,
      deleted: 1,
      failed: 0,
      skipped: false,
    });
  });
});
