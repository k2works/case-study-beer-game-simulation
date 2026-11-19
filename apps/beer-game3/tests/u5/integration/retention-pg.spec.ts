import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FailureMemory } from '../../../src/server/retention/failure-memory.js';
import { RETENTION_LOCK_KEY, RetentionJob } from '../../../src/server/retention/job.js';
import type { RetentionPolicy } from '../../../src/server/retention/policy.js';
import type { PgStore } from '../../../src/server/session/pg-store.js';
import { newPgStore, rawPool, resetDatabase } from '../../u1/support/pg.js';
import { newKey } from '../../u1/support/world.js';
import {
  DAY_MS,
  buildRig,
  buildU4App,
  endedEarly,
  finishedGame,
  getResults,
  json,
  playedGame,
  type Rig,
} from '../support/harness.js';

let pool: pg.Pool;
const stores: PgStore[] = [];

beforeAll(async () => {
  await resetDatabase();
  pool = rawPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase();
});

afterEach(async () => {
  while (stores.length > 0) {
    await stores.pop()!.close();
  }
});

const track = (): PgStore => {
  const store = newPgStore();
  stores.push(store);
  return store;
};

const pgRig = (options: { policy?: Partial<RetentionPolicy> } = {}): Rig =>
  buildRig({ ...options, store: track() });

/** game_id を持つ、すべての表の行数。 */
async function rowsWithGame(gameId: string): Promise<Record<string, number>> {
  const tables = await pool.query(
    `select distinct table_name from information_schema.columns
      where column_name = 'game_id' and table_schema = 'public' order by table_name`,
  );
  const counts: Record<string, number> = {};
  for (const row of tables.rows) {
    const table = row.table_name as string;
    const result = await pool.query(`select count(*)::int as n from ${table} where game_id = $1`, [
      gameId,
    ]);
    counts[table] = result.rows[0].n as number;
  }
  return counts;
}

async function dependentRows(gameId: string): Promise<number> {
  const result = await pool.query(
    `select
       (select count(*) from return_tokens t join participants p on p.participant_id = t.participant_id where p.game_id = $1) +
       (select count(*) from demand_series d join game_settings s on s.settings_id = d.settings_id where s.game_id = $1) as n`,
    [gameId],
  );
  return Number(result.rows[0].n);
}

describe('NFR7.2 NFR2.1 削除（実際の PostgreSQL）', () => {
  it('game_id を持つすべての表の行が 0 件になり、ほかのゲームは残る。連鎖のない参照（入力者）があっても成り立つ', async () => {
    const rig = pgRig();
    const doomed = await playedGame(rig.world, { weekCount: 4, confirmWeeks: 3 });
    // 入れ替えで旧担当者の行が残る状態、冪等の記録、履歴を作る
    await rig.world.session.replaceAssignee(doomed.facilitator, doomed.gameId, 'retailer', {
      participantId: doomed.players.retailer.participantId,
      displayName: '交代',
    });
    await rig.world.session.endGame(doomed.facilitator, doomed.gameId);

    const before = await rowsWithGame(doomed.gameId);
    expect(Object.keys(before)).toEqual(
      expect.arrayContaining([
        'access_codes',
        'game_settings',
        'idempotency_records',
        'operation_log_entries',
        'participants',
        'pipeline_slots',
        'role_assignments',
        'week_records',
      ]),
    );
    expect(before.participants).toBe(5);
    expect(before.idempotency_records).toBeGreaterThan(0);
    expect(before.week_records).toBeGreaterThan(0);
    expect(await dependentRows(doomed.gameId)).toBeGreaterThan(0);

    rig.world.clock.advance(31 * DAY_MS);
    const result = await rig.job.runOnce();
    expect(result).toMatchObject({ deleted: 1, failed: 0 });

    const after = await rowsWithGame(doomed.gameId);
    expect(Object.values(after).every((n) => n === 0)).toBe(true);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(await dependentRows(doomed.gameId)).toBe(0);
  });

  it('期限前のほかのゲームの行は、ひとつも減らない', async () => {
    const rig = pgRig();
    const doomed = await endedEarly(rig.world, 2, 5);
    rig.world.clock.advance(20 * DAY_MS);
    const keeper = await finishedGame(rig.world, 3);
    const keeperBefore = await rowsWithGame(keeper.gameId);
    rig.world.clock.advance(11 * DAY_MS);
    expect(await rig.job.runOnce()).toMatchObject({ deleted: 1 });
    expect(await rowsWithGame(keeper.gameId)).toEqual(keeperBefore);
    expect(Object.values(await rowsWithGame(doomed.gameId)).every((n) => n === 0)).toBe(true);
  });

  it('削除の文の後・コミットの前に例外が起きたら、すべての表の行が残る（原子性）', async () => {
    const rig = pgRig();
    const game = await finishedGame(rig.world, 3);
    const before = await rowsWithGame(game.gameId);
    await expect(
      rig.store.transact(game.gameId, async (tx) => {
        await tx.deleteGame();
        throw new Error('コミットの前の障害');
      }),
    ).rejects.toThrow('コミットの前の障害');
    expect(await rowsWithGame(game.gameId)).toEqual(before);
    expect(await dependentRows(game.gameId)).toBeGreaterThan(0);
  });

  it('終了していないゲームは、deleteGame の SQL の条件でも削除できない（二重の守り）', async () => {
    const rig = pgRig();
    const running = await rig.world.startedGame({ weekCount: 4 });
    await expect(
      rig.store.transact(running.gameId, async (tx) => {
        await tx.deleteGame();
      }),
    ).rejects.toBeDefined();
    expect((await rig.store.readSnapshot(running.gameId))!.game.status).toBe('running');
  });
});

describe('NFR4.2 runExclusive: アドバイザリロックによる二重実行の防止（専用の接続）', () => {
  it('実行中は、別のプールの接続からは取れず（待たない）、終わったら取れる', async () => {
    const first = track();
    const second = track();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const holder = first.runExclusive(RETENTION_LOCK_KEY, async () => {
      started();
      await held;
      return 'first';
    });
    await running;
    const attempt = await second.runExclusive(RETENTION_LOCK_KEY, async () => 'second');
    expect(attempt).toEqual({ acquired: false });
    // 別の鍵は取れる
    expect(await second.runExclusive('other-job', async () => 'other')).toEqual({
      acquired: true,
      value: 'other',
    });
    release();
    expect(await holder).toEqual({ acquired: true, value: 'first' });
    expect(await second.runExclusive(RETENTION_LOCK_KEY, async () => 'again')).toEqual({
      acquired: true,
      value: 'again',
    });
  });

  it('処理が失敗してもロックを解放する。ロックを持つ接続は、ゲームの処理には使わない', async () => {
    const store = track();
    await expect(
      store.runExclusive(RETENTION_LOCK_KEY, async () => {
        // ロックの保持中も、別の接続でゲームの処理ができる
        await store.ping();
        throw new Error('処理の失敗');
      }),
    ).rejects.toThrow('処理の失敗');
    const locks = await pool.query(
      `select count(*)::int as n from pg_locks
        where locktype = 'advisory'
          and database = (select oid from pg_database where datname = current_database())`,
    );
    expect(locks.rows[0].n).toBe(0);
    expect(await store.runExclusive(RETENTION_LOCK_KEY, async () => 1)).toEqual({
      acquired: true,
      value: 1,
    });
  });

  it('1 つのインスタンスの RetentionJob を 2 つ同時に始めても、片方は skipped になる', async () => {
    const rig = pgRig();
    await finishedGame(rig.world, 3);
    rig.world.clock.advance(31 * DAY_MS);
    // 先に始めた処理が削除の途中で止まる（ロックを持ったまま）ように門を置き、重なりを決定的にする
    let reached!: () => void;
    const reachedGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let open!: () => void;
    const openGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const first = new RetentionJob({
      store: track(),
      session: {
        autoEnd: (id, before) => rig.world.session.autoEnd(id, before),
        deleteIfExpired: async (id, before) => {
          reached();
          await openGate;
          return rig.world.session.deleteIfExpired(id, before);
        },
      },
      clock: rig.world.clock,
      policy: rig.policy,
      log: () => undefined,
    });
    const second = new RetentionJob({
      store: track(),
      session: rig.world.session,
      clock: rig.world.clock,
      policy: rig.policy,
      log: () => undefined,
    });
    const firstRun = first.runOnce();
    await reachedGate;
    const secondResult = await second.runOnce();
    open();
    const firstResult = await firstRun;
    expect(secondResult.skipped).toBe(true);
    expect(firstResult.skipped).toBe(false);
    expect(firstResult.deleted + secondResult.deleted).toBe(1);
  });
});

describe('NFR2.4 NFR4.1 対象の選択: 部分索引を使う述語、古い順、上限、除外', () => {
  async function seed(rig: Rig) {
    const created = { a: '', b: '', c: '', d: '' };
    for (const name of ['a', 'b', 'c', 'd'] as const) {
      created[name] = (await rig.world.createGame()).gameId;
    }
    const finished = (await finishedGame(rig.world, 3)).gameId;
    const day = (n: number) => new Date(Date.UTC(2026, 0, n));
    await pool.query('update games set last_operation_at = $2 where game_id = $1', [
      created.a,
      day(4),
    ]);
    await pool.query('update games set last_operation_at = $2 where game_id = $1', [
      created.b,
      day(2),
    ]);
    await pool.query('update games set last_operation_at = $2 where game_id = $1', [
      created.c,
      day(3),
    ]);
    await pool.query('update games set last_operation_at = $2 where game_id = $1', [
      created.d,
      day(20),
    ]);
    await pool.query('update games set ended_at = $2, last_operation_at = $2 where game_id = $1', [
      finished,
      day(1),
    ]);
    return { created, finished, day };
  }

  it('findStaleGames: 未終了だけを、最後の操作の古い順に、上限と除外つきで返す', async () => {
    const rig = pgRig();
    const { created, day } = await seed(rig);
    const store = rig.store;
    expect(await store.findStaleGames(day(10), 10, [])).toEqual([created.b, created.c, created.a]);
    expect(await store.findStaleGames(day(10), 2, [])).toEqual([created.b, created.c]);
    expect(await store.findStaleGames(day(10), 10, [created.b])).toEqual([created.c, created.a]);
    // 除外した分の後ろにある、正常なゲームが選ばれる
    expect(await store.findStaleGames(day(10), 2, [created.b])).toEqual([created.c, created.a]);
    // 期限ちょうどは対象
    expect(await store.findStaleGames(day(2), 10, [])).toEqual([created.b]);
    expect(await store.findStaleGames(new Date(day(2).getTime() - 1), 10, [])).toEqual([]);
  });

  it('findExpiredGames: 終了済みだけを、終了の古い順に返す', async () => {
    const rig = pgRig();
    const { finished, day } = await seed(rig);
    const second = (await finishedGame(rig.world, 3)).gameId;
    await pool.query('update games set ended_at = $2 where game_id = $1', [second, day(0 + 1)]);
    await pool.query("update games set ended_at = '2026-01-01T00:00:00Z' where game_id = $1", [
      finished,
    ]);
    await pool.query("update games set ended_at = '2025-12-31T00:00:00Z' where game_id = $1", [
      second,
    ]);
    expect(await rig.store.findExpiredGames(day(30), 10, [])).toEqual([second, finished]);
    expect(await rig.store.findExpiredGames(day(30), 1, [])).toEqual([second]);
    expect(await rig.store.findExpiredGames(day(30), 10, [second])).toEqual([finished]);
    expect(await rig.store.findExpiredGames(new Date('2025-12-30T00:00:00Z'), 10, [])).toEqual([]);
  });

  it('選ぶ問い合わせは部分索引を使える（索引の述語と合っている）', async () => {
    const rig = pgRig();
    await seed(rig);
    const client = await pool.connect();
    try {
      await client.query('set enable_seqscan = off');
      const stale = await client.query(
        `explain select game_id from games where status <> 'ended' and last_operation_at <= now()
           and game_id <> all('{}'::uuid[]) order by last_operation_at asc limit 5`,
      );
      expect(stale.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('games_stale_idx');
      const expired = await client.query(
        `explain select game_id from games where status = 'ended' and ended_at <= now()
           and game_id <> all('{}'::uuid[]) order by ended_at asc limit 5`,
      );
      expect(expired.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('games_expired_idx');
    } finally {
      client.release();
    }
  });
});

describe('BR25.4 自動終了の再検査（実際の PostgreSQL）', () => {
  it('選んだあとに操作があれば not-stale、なければ ended。履歴の end は system', async () => {
    const rig = pgRig();
    const game = await rig.world.startedGame({ weekCount: 5 });
    rig.world.clock.advance(31 * DAY_MS);
    const now = rig.world.clock.now();
    const staleBefore = new Date(now.getTime() - 30 * DAY_MS);
    expect(await rig.store.findStaleGames(staleBefore, 10, [])).toEqual([game.gameId]);

    // 選んだあとに、参加者の入力があった
    await rig.world.session.submitDecision(
      game.players.retailer.principal,
      game.gameId,
      1,
      'retailer',
      { quantity: 4 },
      newKey('after-select'),
    );
    expect(await rig.world.session.autoEnd(game.gameId, staleBefore)).toBe('not-stale');
    expect((await rig.store.readSnapshot(game.gameId))!.game.status).toBe('running');

    rig.world.clock.advance(31 * DAY_MS);
    expect(
      await rig.world.session.autoEnd(
        game.gameId,
        new Date(rig.world.clock.now().getTime() - 30 * DAY_MS),
      ),
    ).toBe('ended');
    const history = await rig.world.session.getHistory(game.facilitator, game.gameId);
    expect(history.entries.at(-1)).toMatchObject({ kind: 'end', actorKind: 'system' });
  });

  it('last_operation_at は減らない（greatest）。終了の保存で 1 回だけ更新される', async () => {
    const rig = pgRig();
    const game = await rig.world.startedGame({ weekCount: 5 });
    const read = async () => (await rig.store.readSnapshot(game.gameId))!.game.lastOperationAt;
    const t1 = await read();
    await rig.store.transact(game.gameId, async (tx) => {
      await tx.touchOperation(new Date(t1.getTime() - DAY_MS));
    });
    expect(await read()).toEqual(t1);
    await rig.store.transact(game.gameId, async (tx) => {
      await tx.touchOperation(new Date(t1.getTime() + 5000));
    });
    expect((await read()).getTime()).toBe(t1.getTime() + 5000);
  });
});

describe('NFR2.3 結果の読み取りと削除の重なり（READ ONLY の REPEATABLE READ）', () => {
  it('削除が完了してから読むと、存在しないゲーム（null）', async () => {
    const rig = pgRig();
    const game = await finishedGame(rig.world, 3);
    await pool.query('delete from games where game_id = $1', [game.gameId]);
    expect(await rig.store.readSnapshot(game.gameId)).toBeNull();
  });

  it('最初の問い合わせのあと、別の接続で削除が完了しても、完全な結果が返る（一部の行だけが欠けない）', async () => {
    const rig = pgRig();
    const game = await finishedGame(rig.world, 3);
    const complete = (await rig.store.readSnapshot(game.gameId))!;
    expect(complete.weekRecords).toHaveLength(12);

    const internal = rig.store as unknown as { pool: pg.Pool };
    const connect = internal.pool.connect.bind(internal.pool) as () => Promise<pg.PoolClient>;
    let deleted = false;
    internal.pool.connect = (async () => {
      const client = await connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
        const result = await query(...args);
        // ゲームの行を読んだ直後（2 つ目の問い合わせの前）に、別の接続で削除を完了させる
        if (!deleted && /from games where game_id/.test(String(args[0]))) {
          deleted = true;
          await pool.query('delete from games where game_id = $1', [game.gameId]);
        }
        return result;
      };
      return client;
    }) as never;

    const overlapped = await rig.store.readSnapshot(game.gameId);
    expect(deleted).toBe(true);
    expect(overlapped).toEqual(complete);
    expect(
      await pool.query('select 1 from games where game_id = $1', [game.gameId]),
    ).toHaveProperty('rowCount', 0);
  });
});

describe('NFR1.1 結果と出力は、再起動を挟んでも同じ内容（実際の PostgreSQL）', () => {
  it('別の保存・別のアプリケーションから取得した結果と出力が、完全に一致する', async () => {
    const rig = pgRig();
    const game = await finishedGame(rig.world, 4);
    const first = await buildU4App({ store: rig.store, clock: rig.world.clock });
    const resultsBefore = json(await getResults(first.app, game.gameId, game.facilitatorCode));
    const exportBefore = (
      await first.app.inject({
        method: 'GET',
        url: `/api/games/${game.gameId}/export?format=csv`,
        headers: { authorization: `Bearer ${game.facilitatorCode}` },
      })
    ).body;
    await first.app.close();

    const restarted = await buildU4App({ store: track(), clock: rig.world.clock });
    const resultsAfter = json(await getResults(restarted.app, game.gameId, game.facilitatorCode));
    const exportAfter = (
      await restarted.app.inject({
        method: 'GET',
        url: `/api/games/${game.gameId}/export?format=csv`,
        headers: { authorization: `Bearer ${game.facilitatorCode}` },
      })
    ).body;
    expect(resultsAfter).toEqual(resultsBefore);
    expect(exportAfter).toBe(exportBefore);
    expect(resultsBefore.confirmedWeeks).toBe(4);
  });
});

describe('NFR2.4 NFR3.4 定期処理（実際の PostgreSQL）', () => {
  it('失敗するゲームが上限と同じ数あっても、後ろの正常なゲームが 2 回の処理のうちに削除される', async () => {
    const rig = pgRig({ policy: { batchLimit: 2 } });
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push((await finishedGame(rig.world, 3)).gameId);
      rig.world.clock.advance(60_000);
    }
    rig.world.clock.advance(31 * DAY_MS);
    const bad = new Set([ids[0]!, ids[1]!]);
    const job = new RetentionJob({
      store: rig.store,
      session: {
        autoEnd: (id, before) => rig.world.session.autoEnd(id, before),
        deleteIfExpired: async (id, before) => {
          if (bad.has(id)) {
            throw new Error('障害');
          }
          return rig.world.session.deleteIfExpired(id, before);
        },
      },
      clock: rig.world.clock,
      policy: rig.policy,
      log: () => undefined,
      failures: new FailureMemory({ cooldownMs: 3_600_000 }),
    });
    expect(await job.runOnce()).toMatchObject({ failed: 2, deleted: 0 });
    expect(await job.runOnce()).toMatchObject({ failed: 0, deleted: 2 });
    const left = (await pool.query('select game_id from games order by created_at')).rows.map(
      (r) => r.game_id,
    );
    expect(left).toEqual([ids[0], ids[1]]);
    // 準備（4 ゲームを実際の操作で終了まで進める）に 4〜5 秒かかるため、既定の 5 秒では間欠的に落ちる
  }, 30_000);

  it('200 件の対象を 1 回の処理で扱う: 1 ゲームの所要時間と 1 回の所要時間が目標内（NFR3.4）', async ({
    annotate,
  }) => {
    const rig = pgRig({ policy: { batchLimit: 100 } });
    // 対象のゲームを SQL で大量に作る（アプリの操作ではなく、規模の測定のための準備）
    await pool.query(
      `insert into games (game_id, name, week_count, status, end_reason, created_at, ended_at, last_operation_at)
       select gen_random_uuid(), 'bulk-' || n, 3, 'ended', 'facilitator',
              '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'
         from generate_series(1, 150) n`,
    );
    await pool.query(
      `insert into games (game_id, name, week_count, status, created_at, last_operation_at)
       select gen_random_uuid(), 'stale-' || n, 3, 'preparing', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
         from generate_series(1, 150) n`,
    );
    // 設定と需要系列は削除の連鎖の対象に含める
    await pool.query(
      `insert into game_settings (settings_id, game_id, week_count)
       select gen_random_uuid(), game_id, 3 from games`,
    );
    // 時計の起点は 2026-11-12。どちらの期限（2026-01 の作成と終了）も十分に過ぎている
    const started = performance.now();
    const result = await rig.job.runOnce();
    const duration = performance.now() - started;
    await annotate(
      `1 回の処理: ${Math.round(duration)} ms（自動終了 ${result.autoEnded} 件、削除 ${result.deleted} 件）`,
    );
    expect(result).toMatchObject({ autoEnded: 100, deleted: 100, failed: 0 });
    expect(duration).toBeLessThan(5 * 60_000);
    expect(duration / 200).toBeLessThan(1000);
    expect(Number((await pool.query('select count(*) from game_settings')).rows[0].count)).toBe(
      200,
    );
    // 300 ゲームの準備と 200 件の処理で 4〜5 秒かかるため、既定の 5 秒では間欠的に落ちる
  }, 60_000);
});
