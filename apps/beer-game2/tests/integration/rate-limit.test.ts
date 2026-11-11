import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgRateLimiter } from '../../src/adapters/persistence/pg-rate-limiter.js';
import type { RateLimiter } from '../../src/ports/index.js';
import { prepareTestDatabase, resetData } from '../support/db.js';
import { memoryRateLimiter } from '../support/memory.js';

let pool: pg.Pool;
beforeAll(async () => {
  pool = await prepareTestDatabase();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetData(pool);
});

const T0 = new Date('2026-11-11T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const WINDOW = 60_000;

describe.each([
  ['メモリ', () => memoryRateLimiter(3, WINDOW)],
  ['PostgreSQL', () => new PgRateLimiter(pool, { limit: 3, windowMs: WINDOW })],
] as const)('レート制限（%s）', (_, make) => {
  let limiter: RateLimiter;
  beforeEach(() => {
    limiter = make();
  });

  it('[US3.2] 窓の中で上限までは通し、超えたら拒否する', async () => {
    const results = [];
    for (let i = 0; i < 4; i++)
      results.push(await limiter.hit('recover:1.2.3.4', at(i)));
    expect(results).toEqual([true, true, true, false]);
  });

  it('窓が変われば、数え直す', async () => {
    for (let i = 0; i < 4; i++) await limiter.hit('recover:1.2.3.4', at(i));
    await expect(limiter.hit('recover:1.2.3.4', at(WINDOW))).resolves.toBe(
      true,
    );
  });

  it('バケットごとに数える', async () => {
    for (let i = 0; i < 4; i++) await limiter.hit('recover:1.2.3.4', at(i));
    await expect(limiter.hit('join:1.2.3.4', at(5))).resolves.toBe(true);
    await expect(limiter.hit('recover:5.6.7.8', at(5))).resolves.toBe(true);
  });
});

describe('レート制限（PostgreSQL、タスク間の共有）', () => {
  it('[US3.2] 2 つのインスタンス（タスク）で、上限を共有する', async () => {
    const a = new PgRateLimiter(pool, { limit: 2, windowMs: WINDOW });
    const b = new PgRateLimiter(pool, { limit: 2, windowMs: WINDOW });
    const results = await Promise.all([
      a.hit('join:9.9.9.9', at(0)),
      b.hit('join:9.9.9.9', at(1)),
      a.hit('join:9.9.9.9', at(2)),
      b.hit('join:9.9.9.9', at(3)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(2);
  });

  it('古い窓の行は、書き込み時に消す', async () => {
    const limiter = new PgRateLimiter(pool, { limit: 2, windowMs: WINDOW });
    await limiter.hit('join:1.1.1.1', at(0));
    await limiter.hit('join:1.1.1.1', at(3 * WINDOW));
    const { rows } = await pool.query('SELECT window_start FROM rate_limits');
    expect(rows).toHaveLength(1);
  });
});
