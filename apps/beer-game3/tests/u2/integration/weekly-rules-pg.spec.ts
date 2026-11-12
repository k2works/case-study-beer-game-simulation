import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../src/server/errors.js';
import { ROLES } from '../../../src/server/domain/types.js';
import { runMigrations } from '../../../src/server/migrate.js';
import type { PgStore } from '../../../src/server/session/pg-store.js';
import { createWorld, newKey, type StartedGame, type World } from '../../u1/support/world.js';
import { databaseUrl, newPgStore, rawPool, resetDatabase } from '../../u1/support/pg.js';
import { playAndCompare } from '../support/golden.js';

let store: PgStore;
let pool: pg.Pool;
let world: World;

beforeAll(async () => {
  await resetDatabase();
  pool = rawPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase();
  store = newPgStore(400);
  world = createWorld({ store });
});

async function kindOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof AppError ? error.problem.kind : String(error)),
  );
}

async function inputAll(game: StartedGame, week: number, quantity = 4) {
  for (const role of ROLES) {
    await world.session.submitDecision(
      game.players[role].principal,
      game.gameId,
      week,
      role,
      { quantity },
      newKey(),
    );
  }
}

const INT32_MAX = 2 ** 31 - 1;

describe('BR8.2 費用の列は 64 ビット整数', () => {
  it('week_records の weekly_cost と cumulative_cost は bigint', async () => {
    const result = await pool.query(
      `select column_name, data_type from information_schema.columns
        where table_name = 'week_records' and column_name in ('weekly_cost', 'cumulative_cost')
        order by column_name`,
    );
    expect(result.rows).toEqual([
      { column_name: 'cumulative_cost', data_type: 'bigint' },
      { column_name: 'weekly_cost', data_type: 'bigint' },
    ]);
  });

  it('移行を 1 つ戻して再び進めても、既存の値は変わらない（小さな値のとき）', async () => {
    const game = await world.startedGame();
    await world.playWeek(game, 1);
    const before = await pool.query(
      'select role, weekly_cost::text as w, cumulative_cost::text as c from week_records where game_id = $1 and week = 1 order by role',
      [game.gameId],
    );
    // 新しい順に戻す: U3 の移行、続いて U2 の移行（費用の列）
    await runMigrations(databaseUrl(), 'down', 2);
    try {
      const narrowed = await pool.query(
        `select data_type from information_schema.columns
          where table_name = 'week_records' and column_name = 'weekly_cost'`,
      );
      expect(narrowed.rows[0]?.data_type).toBe('integer');
    } finally {
      await runMigrations(databaseUrl(), 'up');
    }
    const after = await pool.query(
      'select role, weekly_cost::text as w, cumulative_cost::text as c from week_records where game_id = $1 and week = 1 order by role',
      [game.gameId],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('上限の設定（在庫・枠 9999、単価 10000、需要 0、全員が 9999 を発注）で 50 週が確定でき、週次・累積が 32 ビットを超えても正しく保存・復元される', async () => {
    const game = await world.startedGame({
      weekCount: 50,
      initialInventory: 9999,
      initialPipelineQuantity: 9999,
      inventoryUnitCost: 10000,
      backlogUnitCost: 10000,
      demandSeries: Array.from({ length: 50 }, () => 0),
    });
    let last;
    for (let week = 1; week <= 50; week += 1) {
      last = await world.playWeek(game, week, {
        factory: 9999,
        wholesaler1: 9999,
        wholesaler2: 9999,
        retailer: 9999,
      });
    }
    expect(last?.status).toBe('ended');
    // 小売店は毎週 9999 が入荷し、需要は 0。在庫は 9999 × (週 + 1)（独立した閉じた式）
    const retailer = last?.results.find((r) => r.role === 'retailer');
    expect(retailer?.inventory).toBe(9999 * 51);
    expect(retailer?.weeklyCost).toBe(9999 * 51 * 10000);
    const expectedCumulative = 10000 * 9999 * (50 + (50 * 51) / 2);
    expect(expectedCumulative).toBe(132_486_750_000);
    expect(retailer?.cumulativeCost).toBe(expectedCumulative);
    expect(retailer?.weeklyCost).toBeGreaterThan(INT32_MAX);
    expect(retailer?.cumulativeCost).toBeGreaterThan(INT32_MAX);
    // 卸と工場は在庫 9999 のまま（入荷 = 出荷 = 9999）
    for (const role of ['factory', 'wholesaler1', 'wholesaler2'] as const) {
      const row = last?.results.find((r) => r.role === role);
      expect(row?.inventory).toBe(9999);
      expect(row?.cumulativeCost).toBe(9999 * 10000 * 50);
    }
    // 保存された値が、桁あふれも丸めもなく読み戻せる
    const raw = await pool.query(
      `select cumulative_cost::text as c from week_records where game_id = $1 and week = 50 and role = 'retailer'`,
      [game.gameId],
    );
    expect(raw.rows[0]?.c).toBe('132486750000');
    const view = await world.session.getState(game.players.retailer.principal, game.gameId);
    expect(view.mine?.cumulativeCost).toBe(expectedCumulative);
    const snapshot = await store.readSnapshot(game.gameId);
    for (const record of snapshot?.weekRecords ?? []) {
      expect(typeof record.cumulativeCost).toBe('number');
      expect(Number.isSafeInteger(record.cumulativeCost)).toBe(true);
    }
  }, 120_000);

  it('在庫ゼロ・需要と発注がすべて 9999・単価 10000 の最悪の受注残でも 50 週が確定でき、累積が 32 ビットを超えて保存される', async () => {
    const game = await world.startedGame({
      weekCount: 50,
      initialInventory: 0,
      initialPipelineQuantity: 0,
      inventoryUnitCost: 10000,
      backlogUnitCost: 10000,
      demandSeries: Array.from({ length: 50 }, () => 9999),
    });
    let last;
    for (let week = 1; week <= 50; week += 1) {
      last = await world.playWeek(game, week, {
        factory: 9999,
        wholesaler1: 9999,
        wholesaler2: 9999,
        retailer: 9999,
      });
    }
    expect(last?.status).toBe('ended');
    const retailer = last?.results.find((r) => r.role === 'retailer');
    expect(retailer?.cumulativeCost).toBeGreaterThan(INT32_MAX);
    // 独立した確認: 最終週の累積は、DB が集計した週次費用の合計と等しい（役割ごと）
    const sums = await pool.query(
      `select role, sum(weekly_cost)::text as total,
              max(cumulative_cost) filter (where week = 50)::text as final
         from week_records where game_id = $1 group by role order by role`,
      [game.gameId],
    );
    expect(sums.rows).toHaveLength(4);
    for (const row of sums.rows) {
      expect(row.final).toBe(row.total);
      expect(Number.isSafeInteger(Number(row.final))).toBe(true);
    }
    const teamFinal = last?.results.reduce((sum, r) => sum + r.cumulativeCost, 0) ?? 0;
    expect(Number.isSafeInteger(teamFinal)).toBe(true);
  }, 120_000);
});

describe('AC2.4.2 / BR7.1 実際の PostgreSQL での同時の確定', () => {
  it('識別子が違う確定が 4 件同時に届いても、1 件だけが確定する', async () => {
    const game = await world.startedGame();
    await inputAll(game, 1);
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        kindOf(world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey(`u2race${i}`))),
      ),
    );
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'state')).toHaveLength(3);
    const counts = await pool.query(
      `select count(*) filter (where is_confirmed)::int as confirmed, count(*)::int as total
         from week_records where game_id = $1 and week = 1`,
      [game.gameId],
    );
    expect(counts.rows[0]).toEqual({ confirmed: 4, total: 4 });
    const idem = await pool.query(
      `select count(*)::int as n from idempotency_records where game_id = $1 and operation = 'confirmWeek'`,
      [game.gameId],
    );
    expect(idem.rows[0].n).toBe(1);
  });

  it('最終週の確定のあと、識別子が違う確定は 409 state、同じ識別子は前回の結果', async () => {
    const game = await world.startedGame({ weekCount: 1 });
    await inputAll(game, 1);
    const key = newKey('final');
    const final = await world.session.confirmWeek(game.facilitator, game.gameId, 1, key);
    await expect(
      kindOf(world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey())),
    ).resolves.toBe('state');
    await expect(world.session.confirmWeek(game.facilitator, game.gameId, 1, key)).resolves.toEqual(
      final,
    );
  });
});

describe('AC2.4.1 / BR7.2 実際の PostgreSQL での途中の失敗', () => {
  const injections: Array<{ label: string; table: string; event: 'insert' | 'update' }> = [
    { label: 'confirmRecords（週の記録の更新）', table: 'week_records', event: 'update' },
    { label: 'replaceSlots（枠の入れ替え）', table: 'pipeline_slots', event: 'insert' },
    { label: 'updateGame（週の進行と版）', table: 'games', event: 'update' },
    { label: 'saveIdempotency（冪等性の記録）', table: 'idempotency_records', event: 'insert' },
  ];

  for (const { label, table, event } of injections) {
    it(`${label} で失敗したら 500 internal。確定前の状態のまま、復旧後にやり直せる`, async () => {
      const game = await world.startedGame();
      await inputAll(game, 1);
      const before = await store.readSnapshot(game.gameId);
      const idemBefore = (
        await pool.query('select count(*)::int as n from idempotency_records where game_id = $1', [
          game.gameId,
        ])
      ).rows[0].n;
      await pool.query(
        `create or replace function u2_fail() returns trigger as $$ begin raise exception 'injected failure'; end $$ language plpgsql`,
      );
      await pool.query(
        `create trigger u2_fail_trigger before ${event} on ${table} for each statement execute function u2_fail()`,
      );
      try {
        await expect(
          kindOf(world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey())),
        ).resolves.toBe('internal');
      } finally {
        await pool.query(`drop trigger if exists u2_fail_trigger on ${table}`);
        await pool.query('drop function if exists u2_fail');
      }
      expect(await store.readSnapshot(game.gameId)).toEqual(before);
      const idemAfter = (
        await pool.query('select count(*)::int as n from idempotency_records where game_id = $1', [
          game.gameId,
        ])
      ).rows[0].n;
      expect(idemAfter).toBe(idemBefore);
      await expect(
        world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey()),
      ).resolves.toMatchObject({ week: 1, currentWeek: 2 });
    });
  }

  it('insertWeekRecords（次週の記録の追加）で失敗しても、確定前の状態のまま', async () => {
    const game = await world.startedGame();
    await inputAll(game, 1);
    const before = await store.readSnapshot(game.gameId);
    // 次週の記録の追加だけを失敗させる: 第 2 週の行を先に置いて一意制約に当てる
    await pool.query(
      `insert into week_records (week_record_id, game_id, week, role) values (gen_random_uuid(), $1, 2, 'retailer')`,
      [game.gameId],
    );
    try {
      await expect(
        kindOf(world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey())),
      ).resolves.toBe('internal');
    } finally {
      await pool.query(`delete from week_records where game_id = $1 and week = 2`, [game.gameId]);
    }
    expect(await store.readSnapshot(game.gameId)).toEqual(before);
    await expect(
      world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey()),
    ).resolves.toMatchObject({ currentWeek: 2 });
  });
});

describe('BR7.4 実際の PostgreSQL で前の週の記録が欠けているとき', () => {
  it('第 1 週の小売店の記録が消えた第 2 週の確定は 500 internal で、状態は変わらない', async () => {
    const game = await world.startedGame();
    await world.playWeek(game, 1);
    await inputAll(game, 2);
    await pool.query(
      `delete from week_records where game_id = $1 and week = 1 and role = 'retailer'`,
      [game.gameId],
    );
    const before = await store.readSnapshot(game.gameId);
    await expect(
      kindOf(world.session.confirmWeek(game.facilitator, game.gameId, 2, newKey())),
    ).resolves.toBe('internal');
    expect(await store.readSnapshot(game.gameId)).toEqual(before);
  });
});

describe('AC5.2.1 / BR8.3 実際の PostgreSQL での 50 週の golden test', () => {
  it('保存・復元をはさんでも、全週・全役割の結果が別の計算の期待値と一致する', async () => {
    await playAndCompare(world);
  }, 120_000);
});
