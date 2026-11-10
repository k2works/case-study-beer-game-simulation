import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApplication,
  type Application,
} from '../../src/application/index.js';
import { PgUnitOfWork } from '../../src/adapters/persistence/pg-unit-of-work.js';
import { FACILITATOR } from '../../src/domain/actor.js';
import { ROLES } from '../../src/domain/role.js';
import { ConflictError, type UnitOfWork } from '../../src/ports/index.js';
import { fakeCredentials, sequentialIds } from '../support/memory.js';
import { prepareTestDatabase, resetData } from '../support/db.js';
import {
  createGame,
  joinGame,
  assignRole,
  startGame,
} from '../../src/domain/game.js';
import {
  commitWeek,
  saveDecision,
  startSession,
} from '../../src/domain/session.js';
import { randomUUID } from 'node:crypto';

const KEY = Buffer.alloc(32, 7);
let pool: pg.Pool;
let uow: UnitOfWork;

beforeAll(async () => {
  pool = await prepareTestDatabase();
  uow = new PgUnitOfWork(pool, { idempotencyKey: KEY });
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetData(pool);
});

const uid = () => randomUUID();

function readyGame(id = uid()) {
  let g = createGame({ id, joinCode: `J-${id.slice(0, 8)}`, weeks: 3 }).game;
  const ids: string[] = [];
  for (const role of ROLES) {
    const pid = uid();
    ids.push(pid);
    g = joinGame(g, { participantId: pid, displayName: `P-${role}` }).game;
    g = assignRole(g, FACILITATOR, pid, role).game;
  }
  return { game: g, ids };
}

describe('Game の永続化', () => {
  it('[US1.1] 保存した Game を、参加者と役割の割り当てごと読み戻せる', async () => {
    const { game } = readyGame();
    await uow.run((r) => r.games.save(game, null));
    const loaded = await uow.run((r) => r.games.find(game.id));
    expect(loaded).toEqual(game);
    expect(await uow.run((r) => r.games.findByJoinCode(game.joinCode))).toEqual(
      game,
    );
  });

  it('[US2.3/AC2.3.2] 版が古い更新は競合になり、何も変わらない', async () => {
    const { game } = readyGame();
    await uow.run((r) => r.games.save(game, null));
    const started = startGame(game, FACILITATOR).game;
    await uow.run((r) => r.games.save(started, game.version));
    await expect(
      uow.run((r) => r.games.save(started, game.version)),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      uow.run((r) => r.games.save(game, null)),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await uow.run((r) => r.games.find(game.id)))?.status).toBe(
      'STARTED',
    );
  });
});

describe('Session の永続化', () => {
  async function started() {
    const { game, ids } = readyGame();
    const s = startGame(game, FACILITATOR).game;
    const { session } = startSession(s, uid());
    await uow.run(async (r) => {
      await r.games.save(s, null);
      await r.sessions.save(session, null);
    });
    return { game: s, session, ids };
  }

  it('[US2.3/AC2.3.5] 意思決定と、役割別の週結果を保存し、読み戻せる', async () => {
    const { session: s0, ids } = await started();
    let s = s0;
    for (const [i, role] of ROLES.entries()) {
      const next = saveDecision(
        s,
        { kind: 'PARTICIPANT', participantId: ids[i]! },
        role,
        4 + i,
        0,
      );
      await uow.run((r) => r.sessions.save(next.session, s.version));
      s = next.session;
    }
    expect(await uow.run((r) => r.sessions.findByGame(s.gameId))).toEqual(s);
    const committed = commitWeek(s, FACILITATOR, {
      week: 1,
      version: s.version,
    }).session;
    await uow.run((r) => r.sessions.save(committed, s.version));
    const loaded = await uow.run((r) => r.sessions.findByGame(s.gameId));
    expect(loaded).toEqual(committed);
    const { rows } = await pool.query(
      'SELECT role, ordered, ending_inventory FROM week_role_results ORDER BY role',
    );
    expect(rows).toHaveLength(4);
    expect(rows.find((x) => x.role === 'RETAILER')).toMatchObject({
      ordered: 7,
    });
  });

  it('[US2.3/AC2.3.2] 同じ週の二重の確定は、主キーで防がれる', async () => {
    const { session: s0, ids } = await started();
    let s = s0;
    for (const [i, role] of ROLES.entries()) {
      s = saveDecision(
        s,
        { kind: 'PARTICIPANT', participantId: ids[i]! },
        role,
        4,
        0,
      ).session;
    }
    await uow.run((r) => r.sessions.save(s, s0.version));
    const committed = commitWeek(s, FACILITATOR, {
      week: 1,
      version: s.version,
    }).session;
    await uow.run((r) => r.sessions.save(committed, s.version));
    await expect(
      pool.query('INSERT INTO week_results (session_id, week) VALUES ($1, 1)', [
        s.id,
      ]),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

describe('冪等記録', () => {
  it('[US2.3/AC2.3.2] 応答は暗号化されて保存され、同じ内容で読み戻せる', async () => {
    const { game } = readyGame();
    await uow.run((r) => r.games.save(game, null));
    const response = { committedWeek: 1, nextWeek: 2, status: 'ACTIVE' };
    await uow.run((r) =>
      r.idempotency.save({
        gameId: game.id,
        key: 'k1',
        fingerprint: '1:3',
        response,
      }),
    );
    const { rows } = await pool.query(
      'SELECT key_digest, response FROM idempotency_records',
    );
    expect(rows[0].key_digest).not.toContain('k1');
    expect(rows[0].response.toString('utf8')).not.toContain('committedWeek');
    expect(await uow.run((r) => r.idempotency.find(game.id, 'k1'))).toEqual({
      gameId: game.id,
      key: 'k1',
      fingerprint: '1:3',
      response,
    });
    expect(
      await uow.run((r) => r.idempotency.find(game.id, 'other')),
    ).toBeNull();
  });
});

describe('ユースケースを実 PostgreSQL で通す', () => {
  let app: Application;
  beforeEach(() => {
    app = createApplication({
      uow,
      clock: { now: () => new Date() },
      ids: { uuid: () => randomUUID(), joinCode: sequentialIds().joinCode },
      credentials: fakeCredentials(),
    });
  });

  async function table() {
    const c = await app.createGame({ weeks: 2 });
    const players: Record<string, { token: string }> = {};
    for (const role of ROLES) {
      const j = await app.joinGame({ joinCode: c.joinCode, displayName: role });
      await app.assignRole({
        token: c.facilitatorToken,
        gameId: c.gameId,
        participantId: j.participantId,
        role,
      });
      players[role] = { token: j.token };
    }
    await app.startGame({ token: c.facilitatorToken, gameId: c.gameId });
    return { c, players };
  }

  it('[US2.4/AC2.4.1] 自動確定: 最後の保存と同じトランザクションで確定し、種別 AUTO が残る', async () => {
    const c = await app.createGame({ weeks: 2, commitMode: 'AUTO' });
    const tokens: string[] = [];
    for (const role of ROLES) {
      const j = await app.joinGame({ joinCode: c.joinCode, displayName: role });
      await app.assignRole({
        token: c.facilitatorToken,
        gameId: c.gameId,
        participantId: j.participantId,
        role,
      });
      tokens.push(j.token);
    }
    await app.startGame({ token: c.facilitatorToken, gameId: c.gameId });
    for (const [i, role] of ROLES.entries()) {
      await app.saveDecision({
        token: tokens[i]!,
        gameId: c.gameId,
        role,
        quantity: 4,
        expectedVersion: 0,
      });
    }
    const { rows } = await pool.query(
      'SELECT week, commit_kind FROM week_results',
    );
    expect(rows).toEqual([{ week: 1, commit_kind: 'AUTO' }]);
    expect(
      (await app.lobby({ token: c.facilitatorToken, gameId: c.gameId }))
        .commitMode,
    ).toBe('AUTO');
  });

  it('[US2.3/AC2.3.1] 作成から最終週の確定まで通り、役割別の結果が残る', async () => {
    const { c, players } = await table();
    for (let week = 1; week <= 2; week++) {
      for (const role of ROLES) {
        await app.saveDecision({
          token: players[role]!.token,
          gameId: c.gameId,
          role,
          quantity: 4,
          expectedVersion: 0,
        });
      }
      const con = await app.console({
        token: c.facilitatorToken,
        gameId: c.gameId,
      });
      await app.commitWeek({
        token: c.facilitatorToken,
        gameId: c.gameId,
        week,
        version: con.sessionVersion,
        idempotencyKey: `k${week}`,
      });
    }
    expect(
      (await app.console({ token: c.facilitatorToken, gameId: c.gameId }))
        .status,
    ).toBe('ENDED');
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM week_role_results',
    );
    expect(rows[0].n).toBe(8);
  });

  it('[US2.3/AC2.3.3] 確定の途中で失敗しても、部分的な更新は残らない（原子性）', async () => {
    const { c, players } = await table();
    for (const role of ROLES) {
      await app.saveDecision({
        token: players[role]!.token,
        gameId: c.gameId,
        role,
        quantity: 4,
        expectedVersion: 0,
      });
    }
    const con = await app.console({
      token: c.facilitatorToken,
      gameId: c.gameId,
    });
    const failing: UnitOfWork = {
      run: (work) =>
        uow.run((repos) =>
          work({
            ...repos,
            idempotency: {
              find: (g, k) => repos.idempotency.find(g, k),
              save: async () => {
                throw new Error('injected failure');
              },
            },
          }),
        ),
    };
    const broken = createApplication({
      uow: failing,
      clock: { now: () => new Date() },
      ids: { uuid: () => randomUUID(), joinCode: () => 'x' },
      credentials: fakeCredentials(),
    });
    await expect(
      broken.commitWeek({
        token: c.facilitatorToken,
        gameId: c.gameId,
        week: 1,
        version: con.sessionVersion,
        idempotencyKey: 'boom',
      }),
    ).rejects.toThrow('injected failure');
    const after = await app.console({
      token: c.facilitatorToken,
      gameId: c.gameId,
    });
    expect(after).toMatchObject({
      week: 1,
      sessionVersion: con.sessionVersion,
    });
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM week_results',
    );
    expect(rows[0].n).toBe(0);
  });

  it('ゲームを削除すると、関連する全表の行が連鎖して消える（削除の網羅）', async () => {
    const { c } = await table();
    await pool.query('DELETE FROM games WHERE game_id = $1', [c.gameId]);
    const { rows: tables } = await pool.query(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'game_id'`,
    );
    expect(tables.length).toBeGreaterThanOrEqual(6);
    for (const { table_name } of tables) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM ${table_name}`,
      );
      expect(rows[0].n, table_name).toBe(0);
    }
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM role_decisions',
    );
    expect(rows[0].n).toBe(0);
  });
});
