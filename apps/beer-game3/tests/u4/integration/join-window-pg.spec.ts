import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyedDigest, loadKeyRing } from '../../../src/server/access/keys.js';
import { startJoinAttemptSweeper } from '../../../src/server/access/join-sweeper.js';
import { normalizeSource } from '../../../src/server/access/source.js';
import { DEFAULT_ACCESS_POLICY } from '../../../src/server/access/policy.js';
import { JOIN_WINDOW_LOCK_CLASS, type PgStore } from '../../../src/server/session/pg-store.js';
import { newPgStore, rawPool, resetDatabase } from '../../u1/support/pg.js';
import { FixedClock, TEST_ENV } from '../../u1/support/world.js';
import { bootGame, buildU4App, joinWithBadCode, secondRandom } from '../support/harness.js';

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

const track = (lockTimeoutMs?: number): PgStore => {
  const store = newPgStore(lockTimeoutMs);
  stores.push(store);
  return store;
};

const count = async (): Promise<number> =>
  (await pool.query('select count(*)::int as n from join_attempts')).rows[0].n as number;

const sourceKeyOf = (ip: string): string => keyedDigest(loadKeyRing(TEST_ENV), normalizeSource(ip));

describe('NFR6.5 / NFR2.3 試行の窓の原子性（実際の PostgreSQL）', () => {
  it('境界: 9・10 回目は 403、11 回目は 429。窓に残る行は接続元ごとに最新の 11 件まで', async () => {
    const { app } = await buildU4App({ store: track() });
    const statuses: number[] = [];
    for (let i = 0; i < 14; i += 1) {
      statuses.push((await joinWithBadCode(app)).statusCode);
    }
    expect(statuses).toEqual([...Array(10).fill(403), ...Array(4).fill(429)]);
    expect(await count()).toBe(11);
  });

  it('同じ接続元から同時に 20 件の無効な試行を送っても、通る（403 になる）のは 10 件までで、残りは 429', async () => {
    const { app } = await buildU4App({ store: track() });
    const results = await Promise.all(Array.from({ length: 20 }, () => joinWithBadCode(app)));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 403)).toHaveLength(10);
    expect(codes.filter((c) => c === 429)).toHaveLength(10);
  });

  it('アプリケーションが 2 つ（別の接続プール）でも、通算で 10 件までである', async () => {
    const clock = new FixedClock();
    const first = await buildU4App({ store: track(), clock });
    const second = await buildU4App({ store: track(), clock, random: secondRandom() });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => joinWithBadCode(i % 2 === 0 ? first.app : second.app)),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 403)).toHaveLength(10);
    expect(codes.filter((c) => c === 429)).toHaveLength(10);
  });

  it('有効なコードの参加は、窓が空でも数えず、制限中のコードの検証も行わない', async () => {
    const { app } = await buildU4App({ store: track() });
    const game = await bootGame(app, { start: false });
    const joins = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: '/api/games/join',
          remoteAddress: '203.0.113.5',
          payload: { joinCode: game.joinCode, displayName: `同時 ${i}` },
        }),
      ),
    );
    expect(joins.every((r) => r.statusCode === 201)).toBe(true);
    expect(await count()).toBe(0);
  });

  it('ロックの待ちが lock_timeout を超えたら 503 で拒否し、制限なしで通さない。別の接続元は待たされない', async () => {
    const { app } = await buildU4App({ store: track(300) });
    const game = await bootGame(app, { start: false });
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock($1::int, hashtext($2))', [
        JOIN_WINDOW_LOCK_CLASS,
        sourceKeyOf('203.0.113.200'),
      ]);
      const blocked = await app.inject({
        method: 'POST',
        url: '/api/games/join',
        remoteAddress: '203.0.113.200',
        payload: { joinCode: game.joinCode, displayName: '待たされる人' },
      });
      expect(blocked.statusCode).toBe(503);
      expect(blocked.json()).toMatchObject({ kind: 'unavailable' });

      const startedAt = Date.now();
      const other = await app.inject({
        method: 'POST',
        url: '/api/games/join',
        remoteAddress: '203.0.113.201',
        payload: { joinCode: game.joinCode, displayName: '別の接続元' },
      });
      expect(other.statusCode).toBe(201);
      expect(Date.now() - startedAt).toBeLessThan(250);
    } finally {
      await client.query('rollback');
      client.release();
    }
    // 503 のあとに参加者は増えていない
    const participants = await pool.query('select count(*)::int as n from participants');
    expect(participants.rows[0].n).toBe(5);
  });

  it('NFR2.2 窓の保存が失敗したら 500 で、参加を成功させない（制限なしで通さない）', async () => {
    const { app } = await buildU4App({ store: track() });
    const game = await bootGame(app, { start: false });
    await pool.query(`
      create or replace function u4_fail() returns trigger as $$
      begin raise exception 'injected failure'; end $$ language plpgsql`);
    await pool.query(
      'create trigger u4_fail_trigger before insert on join_attempts for each statement execute function u4_fail()',
    );
    try {
      const bad = await joinWithBadCode(app, '203.0.113.210');
      expect(bad.statusCode).toBe(500);
      expect(bad.json()).toMatchObject({ kind: 'internal' });
    } finally {
      await pool.query('drop trigger if exists u4_fail_trigger on join_attempts');
      await pool.query('drop function if exists u4_fail');
    }
    // 窓が壊れていても、有効なコードの参加は、数える必要がないので通る
    const joined = await app.inject({
      method: 'POST',
      url: '/api/games/join',
      remoteAddress: '203.0.113.210',
      payload: { joinCode: game.joinCode, displayName: '通る人' },
    });
    expect(joined.statusCode).toBe(201);
  });
});

describe('NFR7.1 / 掃除（起動時と定期。ロック中の行は飛ばす）', () => {
  const insertOld = async (sources: number, ageSeconds: number): Promise<void> => {
    await pool.query(
      `insert into join_attempts (source_key, attempted_at)
       select 'src-' || n, now() - make_interval(secs => $2) from generate_series(1, $1) n`,
      [sources, ageSeconds],
    );
  };

  it('IPv6 の /64 を回転させた 1,000 件の試行のあと、掃除で 60 秒を過ぎた行が残らない', async () => {
    const store = track();
    const base = new Date('2026-11-12T09:00:00.000Z');
    await Promise.all(
      Array.from({ length: 1000 }, (_, i) =>
        store.attemptJoin({
          sourceKey: `rotating-${i}`,
          now: base,
          windowMs: 60_000,
          maxAttempts: 10,
          codeHashes: ['none'],
        }),
      ),
    );
    expect(await count()).toBe(1000);
    const later = new Date(base.getTime() + 61_000);
    const removed = await store.sweepJoinAttempts(new Date(later.getTime() - 60_000));
    expect(removed).toBe(1000);
    expect(await count()).toBe(0);
  });

  it('掃除は、60 秒以内の行を残し、古い行だけを消す', async () => {
    const store = track();
    await insertOld(5, 300);
    await insertOld(0, 0);
    await pool.query(
      "insert into join_attempts (source_key, attempted_at) values ('fresh', now())",
    );
    const removed = await store.sweepJoinAttempts(new Date(Date.now() - 60_000));
    expect(removed).toBe(5);
    expect(await count()).toBe(1);
  });

  it('起動時に掃除が実行され、起動前から残っていた古い行が消える', async () => {
    const store = track();
    await insertOld(20, 3600);
    const logs: Array<Record<string, unknown>> = [];
    const sweeper = startJoinAttemptSweeper({
      store,
      clock: { now: () => new Date() },
      policy: DEFAULT_ACCESS_POLICY,
      intervalMs: 600_000,
      log: (line) => logs.push(line),
    });
    await sweeper.firstRun;
    sweeper.stop();
    expect(await count()).toBe(0);
  });

  it('2 台が同時に掃除しても、エラーにならず、結果は同じ', async () => {
    const first = track();
    const second = track();
    await insertOld(200, 600);
    const cutoff = new Date(Date.now() - 60_000);
    const [a, b] = await Promise.all([
      first.sweepJoinAttempts(cutoff),
      second.sweepJoinAttempts(cutoff),
    ]);
    expect(a + b).toBe(200);
    expect(await count()).toBe(0);
  });

  it('ロック中の行は飛ばし、待たない。参加の要求の処理を待たせない', async () => {
    const store = track();
    await insertOld(3, 600);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("select 1 from join_attempts where source_key = 'src-1' for update");
      const startedAt = Date.now();
      const removed = await store.sweepJoinAttempts(new Date(Date.now() - 60_000));
      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(removed).toBe(2);
      expect(await count()).toBe(1);
    } finally {
      await client.query('rollback');
      client.release();
    }
    // 次の周期で残りも消える
    expect(await store.sweepJoinAttempts(new Date(Date.now() - 60_000))).toBe(1);
  });

  it('掃除が失敗したら join_attempt_cleanup_failed を warn で出し、次の周期で再実行する。参加の要求には影響しない', async () => {
    vi.useFakeTimers();
    try {
      const store = track();
      const logs: Array<Record<string, unknown>> = [];
      let fail = true;
      const flaky = {
        sweepJoinAttempts: async (olderThan: Date) => {
          if (fail) {
            throw new Error('掃除の失敗');
          }
          return store.sweepJoinAttempts(olderThan);
        },
      };
      await insertOld(4, 600);
      const sweeper = startJoinAttemptSweeper({
        store: flaky,
        clock: { now: () => new Date() },
        policy: DEFAULT_ACCESS_POLICY,
        intervalMs: 600_000,
        log: (line) => logs.push(line),
      });
      await sweeper.firstRun;
      expect(logs).toEqual([
        expect.objectContaining({ level: 'warn', event: 'join_attempt_cleanup_failed' }),
      ]);
      expect(await count()).toBe(4);

      fail = false;
      await vi.advanceTimersByTimeAsync(600_000);
      await sweeper.lastRun();
      sweeper.stop();
      expect(await count()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
