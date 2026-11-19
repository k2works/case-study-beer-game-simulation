import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgStore } from '../../../src/server/session/pg-store.js';
import { newPgStore, rawPool, resetDatabase } from '../../u1/support/pg.js';
import { FixedClock, newKey } from '../../u1/support/world.js';
import {
  bearer,
  bootGame,
  buildU4App,
  GET,
  json,
  playWeek,
  secondRandom,
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

/** 再起動の代わりに、プロセスの状態を持たない新しいアプリケーションと保存を同じ DB に立てる。 */
async function restart(clock: FixedClock) {
  return buildU4App({ store: track(), clock, random: secondRandom() });
}

describe('US3.1 中断したゲームを確定済みの週から復元する（実際の PostgreSQL）', () => {
  it('AC3.1.1 Given 第 10 週まで確定したゲーム / When 再起動 / Then 第 10 週の状態が一致し、第 11 週から続けられる', async () => {
    const clock = new FixedClock();
    const before = await buildU4App({ store: track(), clock });
    const game = await bootGame(before.app);
    let lastConfirm: Awaited<ReturnType<typeof playWeek>> | null = null;
    const confirmKey = newKey('restart-w10');
    for (let week = 1; week <= 10; week += 1) {
      lastConfirm = await playWeek(
        before.app,
        game,
        week,
        { retailer: 4 + (week % 3), factory: 3 + (week % 2) },
        week === 10 ? confirmKey : undefined,
      );
    }
    const facilitatorBefore = json(
      await GET(before.app, `/api/games/${game.gameId}/state`, game.facilitatorCode),
    );
    const retailerBefore = json(
      await GET(before.app, `/api/games/${game.gameId}/state`, game.players.retailer.token),
    );
    const snapshotBefore = await before.store.readSnapshot(game.gameId);
    const historyBefore = json(
      await before.app.inject({
        method: 'GET',
        url: `/api/games/${game.gameId}/history`,
        headers: game.facilitator,
      }),
    );
    await before.app.close();

    // 再起動: 新しい保存・新しいアプリケーション。復元のための操作はしない（BR20.1）
    const after = await restart(clock);
    const facilitatorAfter = json(
      await GET(after.app, `/api/games/${game.gameId}/state`, game.facilitatorCode),
    );
    const retailerAfter = json(
      await GET(after.app, `/api/games/${game.gameId}/state`, game.players.retailer.token),
    );
    expect(facilitatorAfter).toEqual(facilitatorBefore);
    expect(retailerAfter).toEqual(retailerBefore);
    expect(facilitatorAfter.currentWeek).toBe(11);
    expect(retailerAfter.mine.history).toHaveLength(10);
    expect(await after.store.readSnapshot(game.gameId)).toEqual(snapshotBefore);
    const historyAfter = json(
      await after.app.inject({
        method: 'GET',
        url: `/api/games/${game.gameId}/history`,
        headers: game.facilitator,
      }),
    );
    expect(historyAfter).toEqual(historyBefore);

    // 再起動の前に成功した識別子の再送は、前回と同じ結果を返す
    const replay = await after.app.inject({
      method: 'POST',
      url: `/api/games/${game.gameId}/weeks/10/confirm`,
      headers: { ...game.facilitator, 'idempotency-key': confirmKey },
    });
    expect(replay.statusCode).toBe(200);
    expect(json(replay)).toEqual(lastConfirm);

    // 第 11 週から続けられる
    await playWeek(after.app, game, 11);
    const next = json(
      await GET(after.app, `/api/games/${game.gameId}/state`, game.facilitatorCode),
    );
    expect(next.currentWeek).toBe(12);
  });

  it('AC3.1.2 Given 第 5 週で小売店が 10 を入力済みで未確定 / When 再起動 / Then 入力は 10 のまま残り、割当てと token も一致する', async () => {
    const clock = new FixedClock();
    const before = await buildU4App({ store: track(), clock });
    const game = await bootGame(before.app);
    for (let week = 1; week <= 4; week += 1) {
      await playWeek(before.app, game, week);
    }
    const inputKey = newKey('restart-input');
    const input = await before.app.inject({
      method: 'PUT',
      url: `/api/games/${game.gameId}/weeks/5/decisions/retailer`,
      headers: { ...bearer(game.players.retailer.token), 'idempotency-key': inputKey },
      payload: { quantity: 10 },
    });
    expect(input.statusCode).toBe(200);
    const tokensBefore = await pool.query(
      'select token_hash, revoked_at from return_tokens order by token_hash',
    );
    const assignmentsBefore = await pool.query(
      'select participant_id, role from role_assignments order by role',
    );
    await before.app.close();

    const after = await restart(clock);
    const view = json(
      await GET(after.app, `/api/games/${game.gameId}/state`, game.players.retailer.token),
    );
    expect(view.currentWeek).toBe(5);
    expect(view.mine.decision).toBe(10);
    expect(
      (await pool.query('select token_hash, revoked_at from return_tokens order by token_hash'))
        .rows,
    ).toEqual(tokensBefore.rows);
    expect(
      (await pool.query('select participant_id, role from role_assignments order by role')).rows,
    ).toEqual(assignmentsBefore.rows);

    // 再起動の前に成功した入力の識別子の再送は、前回と同じ結果
    const replay = await after.app.inject({
      method: 'PUT',
      url: `/api/games/${game.gameId}/weeks/5/decisions/retailer`,
      headers: { ...bearer(game.players.retailer.token), 'idempotency-key': inputKey },
      payload: { quantity: 10 },
    });
    expect(replay.statusCode).toBe(200);
    expect(json(replay)).toEqual(json(input));
  });

  it('AC3.1.3 再起動を挟んだゲームと挟まないゲームは、同じ入力から同じ結果になる', async () => {
    const clock = new FixedClock();
    const straight = await buildU4App({ store: track(), clock });
    const restarted = await buildU4App({ store: track(), clock, random: secondRandom() });
    const quantities = (week: number) => ({
      retailer: 3 + (week % 4),
      wholesaler1: 5,
      factory: 2 + (week % 3),
    });

    const a = await bootGame(straight.app, { demandSeries: [8, 4, 4, 6, 5, 7, 3, 4, 9, 2, 5, 6] });
    const b = await bootGame(restarted.app, { demandSeries: [8, 4, 4, 6, 5, 7, 3, 4, 9, 2, 5, 6] });
    let app = restarted.app;
    for (let week = 1; week <= 8; week += 1) {
      await playWeek(straight.app, a, week, quantities(week));
      await playWeek(app, b, week, quantities(week));
      if (week === 4) {
        await app.close();
        app = (await restart(clock)).app;
      }
    }
    const rolesOf = async (target: typeof app, game: typeof a) =>
      json(await GET(target, `/api/games/${game.gameId}/state`, game.facilitatorCode)).roles;
    expect(await rolesOf(app, b)).toEqual(await rolesOf(straight.app, a));
  });
});
