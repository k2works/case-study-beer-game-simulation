import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PgStore } from '../../../src/server/session/pg-store.js';
import { newPgStore, rawPool, resetDatabase } from '../../u1/support/pg.js';
import { FixedClock } from '../../u1/support/world.js';
import { bearer, bootGame, buildU4App, secondRandom } from '../support/harness.js';

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

/** touchToken が実際に書き込んだ回数を数える。 */
function countWrites(store: PgStore): { writes: () => number } {
  let writes = 0;
  const original = store.touchToken.bind(store);
  store.touchToken = async (...args) => {
    const written = await original(...args);
    if (written) {
      writes += 1;
    }
    return written;
  };
  return { writes: () => writes };
}

const lastUsedOf = async (token: string): Promise<Date> => {
  const { createHash } = await import('node:crypto');
  const hash = `sha256:${createHash('sha256').update(token).digest('hex')}`;
  const result = await pool.query('select last_used_at from return_tokens where token_hash = $1', [
    hash,
  ]);
  return result.rows[0].last_used_at as Date;
};

describe('NFR3.3 lastUsedAt の延長（実際の PostgreSQL）', () => {
  it('1 分の間に同じ token で 60 回の要求を送っても、書き込みは 1 回', async () => {
    const clock = new FixedClock();
    const store = track();
    const counter = countWrites(store);
    const { app } = await buildU4App({ store, clock });
    const game = await bootGame(app);
    const token = game.players.retailer.token;
    const issuedAt = await lastUsedOf(token);

    clock.advance(2 * 60 * 1000);
    for (let i = 0; i < 60; i += 1) {
      clock.advance(500);
      const response = await app.inject({
        method: 'GET',
        url: `/api/games/${game.gameId}/state`,
        headers: bearer(token),
      });
      expect(response.statusCode).toBe(200);
      await app.whenIdle();
    }
    expect(counter.writes()).toBe(1);
    const updated = await lastUsedOf(token);
    expect(updated.getTime()).toBeGreaterThan(issuedAt.getTime());
  });

  it('2 つのアプリケーションから同時に送っても、書き込みは 1 回', async () => {
    const clock = new FixedClock();
    const firstStore = track();
    const secondStore = track();
    const first = countWrites(firstStore);
    const second = countWrites(secondStore);
    const a = await buildU4App({ store: firstStore, clock });
    const b = await buildU4App({ store: secondStore, clock, random: secondRandom() });
    const game = await bootGame(a.app);
    const token = game.players.factory.token;

    clock.advance(5 * 60 * 1000);
    const url = `/api/games/${game.gameId}/state`;
    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        (i % 2 === 0 ? a.app : b.app).inject({ method: 'GET', url, headers: bearer(token) }),
      ),
    );
    await Promise.all([a.app.whenIdle(), b.app.whenIdle()]);
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    expect(first.writes() + second.writes()).toBe(1);
  });

  it('延長は return_tokens の 1 行だけを書き、ゲームの版を変えず、履歴に書かない', async () => {
    const clock = new FixedClock();
    const { app } = await buildU4App({ store: track(), clock });
    const game = await bootGame(app);
    const before = await pool.query(
      'select g.version, (select count(*) from operation_log_entries) as logs from games g where game_id = $1',
      [game.gameId],
    );
    clock.advance(10 * 60 * 1000);
    await app.inject({
      method: 'GET',
      url: `/api/games/${game.gameId}/state`,
      headers: bearer(game.players.retailer.token),
    });
    await app.whenIdle();
    const after = await pool.query(
      'select g.version, (select count(*) from operation_log_entries) as logs from games g where game_id = $1',
      [game.gameId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
