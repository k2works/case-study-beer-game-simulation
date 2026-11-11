import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgUnitOfWork } from '../../src/adapters/persistence/pg-unit-of-work.js';
import { CredentialValidity } from '../../src/domain/credential.js';
import { createGame } from '../../src/domain/game.js';
import type { Principal, UnitOfWork } from '../../src/ports/index.js';
import { prepareTestDatabase, resetData } from '../support/db.js';
import { memoryUnitOfWork } from '../support/memory.js';

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
const HOUR = 60 * 60 * 1000;

async function seedGame(uow: UnitOfWork) {
  const gameId = randomUUID();
  const game = createGame({
    id: gameId,
    joinCode: `J-${gameId}`,
    weeks: 3,
  }).game;
  await uow.run((r) => r.games.save(game, null));
  return gameId;
}

describe.each([
  ['メモリ', () => memoryUnitOfWork().uow],
  [
    'PostgreSQL',
    () => new PgUnitOfWork(pool, { idempotencyKey: Buffer.alloc(32, 7) }),
  ],
] as const)('観察者のリポジトリ（%s）', (_, make) => {
  let uow: UnitOfWork;
  beforeEach(() => {
    uow = make();
  });

  it('[US1.3/AC1.3.1] 招待は期限の直前まで有効で、期限ちょうど以降は無効（境界）', async () => {
    const gameId = await seedGame(uow);
    const id = randomUUID();
    await uow.run((r) =>
      r.observers.saveInvitation('v1:i', {
        id,
        gameId,
        validity: CredentialValidity.issue(T0, HOUR),
      }),
    );
    const find = (ms: number) =>
      uow.run((r) => r.observers.findInvitation(['v2:x', 'v1:i'], at(ms)));
    await expect(find(HOUR - 1)).resolves.toEqual({ id, gameId });
    await expect(find(HOUR)).resolves.toBeNull();
    await expect(
      uow.run((r) => r.observers.activeInvitations(gameId, at(0))),
    ).resolves.toEqual([{ id, expiresAt: at(HOUR) }]);
  });

  it('[US1.3/AC1.3.4] 失効させると見つからず、一覧から消える。他のゲームの招待は失効できない', async () => {
    const gameId = await seedGame(uow);
    const other = await seedGame(uow);
    const id = randomUUID();
    await uow.run((r) =>
      r.observers.saveInvitation('v1:i', {
        id,
        gameId,
        validity: CredentialValidity.issue(T0, HOUR),
      }),
    );
    await expect(
      uow.run((r) => r.observers.revokeInvitation(other, id, at(1))),
    ).resolves.toBe(false);
    await expect(
      uow.run((r) => r.observers.revokeInvitation(gameId, id, at(1))),
    ).resolves.toBe(true);
    await expect(
      uow.run((r) => r.observers.findInvitation(['v1:i'], at(2))),
    ).resolves.toBeNull();
    await expect(
      uow.run((r) => r.observers.activeInvitations(gameId, at(2))),
    ).resolves.toEqual([]);
  });

  it('[US1.3/AC1.3.3] 観察者を加えて数えられ、観察者の資格（ブラウザセッション）を保存・失効できる', async () => {
    const gameId = await seedGame(uow);
    const invitationId = randomUUID();
    const observerId = randomUUID();
    const principal: Principal = { gameId, kind: 'OBSERVER', observerId };
    await uow.run(async (r) => {
      await r.observers.saveInvitation('v1:i', {
        id: invitationId,
        gameId,
        validity: CredentialValidity.issue(T0, HOUR),
      });
      await r.observers.addObserver({
        id: observerId,
        gameId,
        invitationId,
        displayName: '見学者',
      });
      await r.credentials.save(
        'v1:o',
        principal,
        'SESSION',
        CredentialValidity.issue(T0, HOUR),
      );
    });
    await expect(
      uow.run((r) => r.observers.countObservers(gameId)),
    ).resolves.toBe(1);
    await expect(
      uow.run((r) => r.credentials.find(['v1:o'], 'SESSION', at(0))),
    ).resolves.toEqual(principal);
    await uow.run((r) => r.credentials.revokeAll(principal, at(1)));
    await expect(
      uow.run((r) => r.credentials.find(['v1:o'], 'SESSION', at(2))),
    ).resolves.toBeNull();
  });
});

describe('観察者の削除（PostgreSQL）', () => {
  it('ゲームを削除すると、招待・観察者・観察者の資格が連鎖して消える', async () => {
    const uow = new PgUnitOfWork(pool, { idempotencyKey: Buffer.alloc(32, 7) });
    const gameId = await seedGame(uow);
    const invitationId = randomUUID();
    const observerId = randomUUID();
    await uow.run(async (r) => {
      await r.observers.saveInvitation('v1:i', {
        id: invitationId,
        gameId,
        validity: CredentialValidity.issue(T0, HOUR),
      });
      await r.observers.addObserver({
        id: observerId,
        gameId,
        invitationId,
        displayName: '観察者',
      });
      await r.credentials.save(
        'v1:o',
        { gameId, kind: 'OBSERVER', observerId },
        'SESSION',
        CredentialValidity.issue(T0, HOUR),
      );
    });
    await pool.query('DELETE FROM games WHERE game_id = $1', [gameId]);
    for (const table of [
      'observer_invitations',
      'observers',
      'browser_sessions',
    ]) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE game_id = $1`,
        [gameId],
      );
      expect(rows[0].n).toBe(0);
    }
  });
});
