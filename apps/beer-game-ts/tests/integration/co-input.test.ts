import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgExportReader } from '../../src/adapters/persistence/pg-export-reader.js';
import { PgReviewReader } from '../../src/adapters/persistence/pg-review-reader.js';
import { PgUnitOfWork } from '../../src/adapters/persistence/pg-unit-of-work.js';
import {
  createApplication,
  type Application,
} from '../../src/application/index.js';
import { DecisionConflict } from '../../src/application/errors.js';
import { FACILITATOR } from '../../src/domain/actor.js';
import { assignRole, createGame, joinGame } from '../../src/domain/game.js';
import { ROLES } from '../../src/domain/role.js';
import type { UnitOfWork } from '../../src/ports/index.js';
import { prepareTestDatabase, resetData } from '../support/db.js';
import { fakeCredentials, sequentialIds } from '../support/memory.js';

let pool: pg.Pool;
let uow: UnitOfWork;
let app: Application;

beforeAll(async () => {
  pool = await prepareTestDatabase();
  uow = new PgUnitOfWork(pool, { idempotencyKey: Buffer.alloc(32, 7) });
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetData(pool);
  app = createApplication({
    uow,
    clock: { now: () => new Date() },
    ids: { uuid: () => randomUUID(), joinCode: sequentialIds().joinCode },
    credentials: fakeCredentials(),
    reviews: new PgReviewReader(pool),
    exports: new PgExportReader(pool, new PgReviewReader(pool)),
  });
});

/** 小売店に `coHolders` 人（共同担当）を割り当てて開始する */
async function coTable(coHolders: number) {
  const c = await app.createGame({ weeks: 2 });
  const retailers: string[] = [];
  for (const role of ROLES) {
    const n = role === 'RETAILER' ? coHolders : 1;
    for (let i = 0; i < n; i++) {
      const j = await app.joinGame({
        joinCode: c.joinCode,
        displayName: `${role}-${i}`,
      });
      await app.assignRole({
        token: c.facilitatorToken,
        gameId: c.gameId,
        participantId: j.participantId,
        role,
      });
      if (role === 'RETAILER') retailers.push(j.token);
    }
  }
  await app.startGame({ token: c.facilitatorToken, gameId: c.gameId });
  return { gameId: c.gameId, retailers };
}

describe('共同担当の永続化', () => {
  it('[US1.2/AC1.2.4] 同じ役割の複数の担当を、参加の順で保存し、読み戻せる', async () => {
    const id = randomUUID();
    let g = createGame({ id, joinCode: `J-${id}`, weeks: 3 }).game;
    for (const pid of ['a', 'b'].map(() => randomUUID())) {
      g = joinGame(g, {
        participantId: pid,
        displayName: pid.slice(0, 4),
      }).game;
      g = assignRole(g, FACILITATOR, pid, 'RETAILER').game;
    }
    await uow.run((r) => r.games.save(g, null));
    const loaded = await uow.run((r) => r.games.find(id));
    expect(loaded?.assignments).toEqual(g.assignments);
    const names = await uow.run((r) => r.games.participantNames(id));
    expect(Object.values(names).sort()).toEqual(
      g.participants.map((p) => p.displayName).sort(),
    );
  });

  it('[US2.1/AC2.1.4] 旧形式（役割 → 参加者 ID の文字列）の担当も、一覧として読み、保存で新形式に書き戻す', async () => {
    const { gameId, retailers } = await coTable(1);
    // B4 までの形式に戻す
    await pool.query(
      `UPDATE sessions SET holders = (
         SELECT jsonb_object_agg(key, value->0) FROM jsonb_each(holders)
       ) WHERE game_id = $1`,
      [gameId],
    );
    const before = await pool.query(
      "SELECT jsonb_typeof(holders->'RETAILER') AS t FROM sessions WHERE game_id = $1",
      [gameId],
    );
    expect(before.rows[0].t).toBe('string');
    const state = await app.roleState({ token: retailers[0]!, gameId });
    expect(state.role).toBe('RETAILER');
    await app.saveDecision({
      token: retailers[0]!,
      gameId,
      role: 'RETAILER',
      quantity: 4,
      expectedVersion: 0,
    });
    const after = await pool.query(
      "SELECT jsonb_typeof(holders->'RETAILER') AS t FROM sessions WHERE game_id = $1",
      [gameId],
    );
    expect(after.rows[0].t).toBe('array');
  });
});

describe('共同入力の並行性（実 PostgreSQL）', () => {
  it('[US2.2/AC2.2.3] 共同担当が同じ版から同時に保存すると、受理は 1 件だけで、残りは勝った値と保存者を受け取る（失われた更新 0 件）', async () => {
    const { gameId, retailers } = await coTable(4);
    const results = await Promise.allSettled(
      retailers.map((token, i) =>
        app.saveDecision({
          token,
          gameId,
          role: 'RETAILER',
          quantity: 10 + i,
          expectedVersion: 0,
        }),
      ),
    );
    const accepted = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(retailers.length - 1);
    const state = await app.roleState({ token: retailers[0]!, gameId });
    expect(state.decision?.version).toBe(1);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(DecisionConflict);
      // 拒否された側が受け取る最新値は、実際に保存された値と保存者
      expect((r.reason as DecisionConflict).latest).toEqual(state.decision);
    }
  });

  it('[US2.2/AC2.2.4] 受理された保存は、続けて版を進める保存でだけ上書きされる（100 回の並行の試行で版と値が一致）', async () => {
    const { gameId, retailers } = await coTable(2);
    let version = 0;
    for (let round = 0; round < 50; round++) {
      const results = await Promise.allSettled(
        retailers.map((token, i) =>
          app.saveDecision({
            token,
            gameId,
            role: 'RETAILER',
            quantity: round * 10 + i,
            expectedVersion: version,
          }),
        ),
      );
      const ok = results.flatMap((r) =>
        r.status === 'fulfilled' ? [r.value] : [],
      );
      expect(ok).toHaveLength(1);
      version = ok[0]!.version;
    }
    const state = await app.roleState({ token: retailers[1]!, gameId });
    expect(state.decision?.version).toBe(50);
  });
});
