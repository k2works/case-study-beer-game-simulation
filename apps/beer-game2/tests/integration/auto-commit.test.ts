import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgReviewReader } from '../../src/adapters/persistence/pg-review-reader.js';
import { PgUnitOfWork } from '../../src/adapters/persistence/pg-unit-of-work.js';
import {
  createApplication,
  type Application,
} from '../../src/application/index.js';
import { ROLES } from '../../src/domain/role.js';
import { TEST_URL, prepareTestDatabase, resetData } from '../support/db.js';
import { fakeCredentials, sequentialIds } from '../support/memory.js';

// 2 つのプロセスの代わりに、接続プールの違う 2 つのアプリを使う（同じ資格の方式なので、互いの資格が使える）
let pools: pg.Pool[];
let apps: Application[];

beforeAll(async () => {
  const first = await prepareTestDatabase();
  pools = [first, new pg.Pool({ connectionString: TEST_URL })];
  const joinCode = sequentialIds().joinCode;
  apps = pools.map((pool) =>
    createApplication({
      uow: new PgUnitOfWork(pool, { idempotencyKey: Buffer.alloc(32, 7) }),
      clock: { now: () => new Date() },
      ids: { uuid: () => randomUUID(), joinCode },
      credentials: fakeCredentials(),
      reviews: new PgReviewReader(pool),
    }),
  );
});
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});
beforeEach(async () => {
  await resetData(pools[0]!);
});

describe('自動確定と手動確定の競合（2 プロセス、実 PostgreSQL）', () => {
  it('[US2.4/AC2.4.4] 最後の保存の自動確定と、進行役の手動の確定が同時に起きても、週は一度だけ確定し、費用は一度だけ計上される', async () => {
    const [a, b] = apps as [Application, Application];
    for (let round = 0; round < 20; round++) {
      const c = await a.createGame({ weeks: 2, commitMode: 'AUTO' });
      const tokens: string[] = [];
      for (const role of ROLES) {
        const j = await a.joinGame({ joinCode: c.joinCode, displayName: role });
        await a.assignRole({
          token: c.facilitatorToken,
          gameId: c.gameId,
          participantId: j.participantId,
          role,
        });
        tokens.push(j.token);
      }
      await a.startGame({ token: c.facilitatorToken, gameId: c.gameId });
      for (const [i, role] of ROLES.slice(0, 3).entries())
        await a.saveDecision({
          token: tokens[i]!,
          gameId: c.gameId,
          role,
          quantity: 4,
          expectedVersion: 0,
        });
      const seen = await b.console({
        token: c.facilitatorToken,
        gameId: c.gameId,
      });
      // プロセス A: 最後の参加者の保存（自動確定）。プロセス B: 進行役の手動の確定
      const results = await Promise.allSettled([
        a.saveDecision({
          token: tokens[3]!,
          gameId: c.gameId,
          role: 'RETAILER',
          quantity: 4,
          expectedVersion: 0,
        }),
        b.commitWeek({
          token: c.facilitatorToken,
          gameId: c.gameId,
          week: 1,
          version: seen.sessionVersion + 1,
          idempotencyKey: `k-${round}`,
        }),
      ]);
      expect(results[0].status).toBe('fulfilled');
      const { rows } = await pools[0]!.query(
        `SELECT count(*)::int AS weeks FROM week_results r
           JOIN sessions s USING (session_id) WHERE s.game_id = $1`,
        [c.gameId],
      );
      expect(rows[0].weeks).toBe(1);
      const after = await a.console({
        token: c.facilitatorToken,
        gameId: c.gameId,
      });
      expect(after.week).toBe(2);
      const me = await a.roleState({ token: tokens[3]!, gameId: c.gameId });
      expect(me.history).toHaveLength(1);
      expect(me.history[0]!.cumulativeCostMinor).toBe(
        me.history[0]!.weeklyCostMinor,
      );
    }
  }, 60_000); // 20 回、ゲームを作り直すため
});
