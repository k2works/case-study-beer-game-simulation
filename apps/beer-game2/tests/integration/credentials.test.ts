import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgUnitOfWork } from '../../src/adapters/persistence/pg-unit-of-work.js';
import { CredentialValidity } from '../../src/domain/credential.js';
import { createGame, joinGame } from '../../src/domain/game.js';
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
const valid = (ms = HOUR) => CredentialValidity.issue(T0, ms);

/** ゲーム 1 つと参加者 1 人を保存し、主体を返す */
async function seed(uow: UnitOfWork) {
  const gameId = randomUUID();
  const participantId = randomUUID();
  let game = createGame({ id: gameId, joinCode: `J-${gameId}`, weeks: 3 }).game;
  game = joinGame(game, { participantId, displayName: '花子' }).game;
  await uow.run((r) => r.games.save(game, null));
  const facilitator: Principal = { gameId, kind: 'FACILITATOR' };
  const participant: Principal = { gameId, kind: 'PARTICIPANT', participantId };
  return { gameId, facilitator, participant };
}

// メモリ版と PostgreSQL 版を、同じ契約で検証する
describe.each([
  ['メモリ', () => memoryUnitOfWork().uow],
  [
    'PostgreSQL',
    () => new PgUnitOfWork(pool, { idempotencyKey: Buffer.alloc(32, 7) }),
  ],
] as const)('資格のリポジトリ（%s）', (_, make) => {
  let uow: UnitOfWork;
  beforeEach(() => {
    uow = make();
  });

  it.each(['SESSION', 'RECOVERY'] as const)(
    '[US3.2/AC3.2.5] %s は、期限の直前まで有効で、期限ちょうど以降は無効（境界）',
    async (purpose) => {
      const { participant } = await seed(uow);
      await uow.run((r) =>
        r.credentials.save('v1:a', participant, purpose, valid()),
      );
      const find = (ms: number) =>
        uow.run((r) => r.credentials.find(['v1:a'], purpose, at(ms)));
      await expect(find(HOUR - 1)).resolves.toEqual(participant);
      await expect(find(HOUR)).resolves.toBeNull();
    },
  );

  it('種類が違えば見つからない（ブラウザセッションの値で復帰できない）', async () => {
    const { participant } = await seed(uow);
    await uow.run((r) =>
      r.credentials.save('v1:s', participant, 'SESSION', valid()),
    );
    await expect(
      uow.run((r) => r.credentials.find(['v1:s'], 'RECOVERY', at(0))),
    ).resolves.toBeNull();
  });

  it('[US3.2/AC3.2.5] 鍵の版ごとの候補のどれかに一致すれば見つかる（ローテーション後の旧版）', async () => {
    const { facilitator } = await seed(uow);
    await uow.run((r) =>
      r.credentials.save('v1:old', facilitator, 'SESSION', valid()),
    );
    await expect(
      uow.run((r) =>
        r.credentials.find(['v2:new', 'v1:old'], 'SESSION', at(0)),
      ),
    ).resolves.toEqual(facilitator);
  });

  it('[US3.2/AC3.2.5] 失効させると、その主体のブラウザセッションと復帰コードがすべて使えない。他の主体は影響しない', async () => {
    const { facilitator, participant } = await seed(uow);
    await uow.run(async (r) => {
      await r.credentials.save('v1:p1', participant, 'SESSION', valid());
      await r.credentials.save('v1:p2', participant, 'SESSION', valid());
      await r.credentials.save('v1:pr', participant, 'RECOVERY', valid());
      await r.credentials.save('v1:f', facilitator, 'SESSION', valid());
      await r.credentials.save('v1:fr', facilitator, 'RECOVERY', valid());
    });
    await uow.run((r) => r.credentials.revokeAll(participant, at(10)));
    const find = (d: string, p: 'SESSION' | 'RECOVERY') =>
      uow.run((r) => r.credentials.find([d], p, at(11)));
    await expect(find('v1:p1', 'SESSION')).resolves.toBeNull();
    await expect(find('v1:p2', 'SESSION')).resolves.toBeNull();
    await expect(find('v1:pr', 'RECOVERY')).resolves.toBeNull();
    await expect(find('v1:f', 'SESSION')).resolves.toEqual(facilitator);
    await expect(find('v1:fr', 'RECOVERY')).resolves.toEqual(facilitator);
  });

  it('[US3.2/AC3.2.5] 復帰コードは主体ごとに 1 つ。再発行すると前の復帰コードは使えない', async () => {
    const { participant } = await seed(uow);
    await uow.run((r) =>
      r.credentials.save('v1:r1', participant, 'RECOVERY', valid()),
    );
    await uow.run((r) => r.credentials.revokeAll(participant, at(1)));
    await uow.run((r) =>
      r.credentials.save('v1:r2', participant, 'RECOVERY', valid()),
    );
    const find = (d: string) =>
      uow.run((r) => r.credentials.find([d], 'RECOVERY', at(2)));
    await expect(find('v1:r1')).resolves.toBeNull();
    await expect(find('v1:r2')).resolves.toEqual(participant);
  });
});

describe('資格の保存内容（PostgreSQL）', () => {
  it('[US3.2/AC3.2.2] ゲームを削除すると、そのゲームの資格は見つからない', async () => {
    const uow = new PgUnitOfWork(pool, { idempotencyKey: Buffer.alloc(32, 7) });
    const { gameId, participant } = await seed(uow);
    await uow.run(async (r) => {
      await r.credentials.save('v1:s', participant, 'SESSION', valid());
      await r.credentials.save('v1:r', participant, 'RECOVERY', valid());
    });
    await pool.query('DELETE FROM games WHERE game_id = $1', [gameId]);
    await expect(
      uow.run((r) => r.credentials.find(['v1:s'], 'SESSION', at(0))),
    ).resolves.toBeNull();
    await expect(
      uow.run((r) => r.credentials.find(['v1:r'], 'RECOVERY', at(0))),
    ).resolves.toBeNull();
  });
});
