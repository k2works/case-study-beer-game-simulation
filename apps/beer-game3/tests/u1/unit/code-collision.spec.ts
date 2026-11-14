import { describe, expect, it } from 'vitest';
import { AccessControl } from '../../../src/server/access/access-control.js';
import { loadKeyRing } from '../../../src/server/access/keys.js';
import { AppError, CodeCollisionError } from '../../../src/server/errors.js';
import { GameSession } from '../../../src/server/session/game-session.js';
import { MemoryStore } from '../../../src/server/session/memory-store.js';
import type { NewGame } from '../../../src/server/session/store.js';
import { FixedClock, SequenceRandom, TEST_ENV } from '../support/world.js';

/** 照合用の値が重なったことにして、createGame を指定の回数だけ失敗させる保存 */
class CollidingStore extends MemoryStore {
  attempts = 0;

  constructor(private readonly collisions: number) {
    super();
  }

  override async createGame(input: NewGame): Promise<void> {
    this.attempts += 1;
    if (this.attempts <= this.collisions) {
      throw new CodeCollisionError();
    }
    return super.createGame(input);
  }
}

function sessionOn(store: CollidingStore): GameSession {
  const random = new SequenceRandom();
  const clock = new FixedClock();
  const access = new AccessControl({ store, keyRing: loadKeyRing(TEST_ENV), random, clock });
  return new GameSession({ store, access, clock, random });
}

describe('コードの重なり（BR1.4）', () => {
  it('照合用の値が重なったら、コードを発行し直してゲームを作る', async () => {
    const store = new CollidingStore(2);
    const created = await sessionOn(store).createGame({ name: '試験', weekCount: 3 });
    expect(store.attempts).toBe(3);
    expect(created.gameId).toBeDefined();
  });

  it('重なりが続いて上限に達したら、ゲームを作らず internal で返す', async () => {
    const store = new CollidingStore(99);
    const error = await sessionOn(store)
      .createGame({ name: '試験', weekCount: 3 })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).problem.kind).toBe('internal');
    expect(store.attempts).toBe(5);
  });
});
