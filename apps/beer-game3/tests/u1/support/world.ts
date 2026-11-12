import { createHash } from 'node:crypto';
import { AccessControl, type Principal } from '../../../src/server/access/access-control.js';
import { loadKeyRing } from '../../../src/server/access/keys.js';
import type { Clock, RandomSource } from '../../../src/server/clock.js';
import { ROLES, type Role } from '../../../src/server/domain/types.js';
import type { KitPreset } from '../../../src/server/domain/kit-preset.js';
import { GameSession } from '../../../src/server/session/game-session.js';
import { MemoryStore } from '../../../src/server/session/memory-store.js';
import type { Store } from '../../../src/server/session/store.js';

/** 試験用の固定の鍵（本番の鍵と共有しない）。vitest.config.ts と同じ値。 */
export const TEST_ENV = {
  CODE_ENC_KEY: 'e1:MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  CODE_HMAC_KEY: 'h1:ZmVkY2JhOTg3NjU0MzIxMGZlZGNiYTk4NzY1NDMyMTA=',
};

/** 固定の時計。advance で進める。 */
export class FixedClock implements Clock {
  private current = new Date('2026-11-12T09:00:00.000Z');

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** 決定論的な乱数。同じ順序で呼べば同じ値を返す。 */
export class SequenceRandom implements RandomSource {
  private counter = 0;

  bytes(size: number): Buffer {
    const out = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const block = createHash('sha256').update(`seed-${this.counter}`).digest();
      this.counter += 1;
      block.copy(out, offset, 0, Math.min(block.length, size - offset));
      offset += block.length;
    }
    return out;
  }
}

export const DISPLAY_NAMES: Record<Role, string> = {
  factory: '工場',
  wholesaler1: '一次卸',
  wholesaler2: '二次卸',
  retailer: '小売店',
};

export interface World {
  store: Store;
  access: AccessControl;
  session: GameSession;
  clock: FixedClock;
  random: SequenceRandom;
  /** 資格情報から Principal を求める（HTTP の入口の代わり） */
  as(credential: string): Promise<Principal>;
  createGame(overrides?: Record<string, unknown>): Promise<CreatedGame>;
  joinOne(joinCode: string, displayName: string): Promise<JoinedParticipant>;
  /** 4 役割に 1 人ずつ参加させて割り当てる（開始前まで） */
  populate(game: CreatedGame): Promise<Record<Role, JoinedParticipant>>;
  /** 作成 → 4 人の参加 → 割当て → 開始まで */
  startedGame(overrides?: Record<string, unknown>): Promise<StartedGame>;
  /** 4 役割が入力し（既定は全員同じ数量）、進行役が週を確定する */
  playWeek(
    game: StartedGame,
    week: number,
    quantities?: Partial<Record<Role, number>>,
  ): Promise<Awaited<ReturnType<GameSession['confirmWeek']>>>;
}

export interface CreatedGame {
  gameId: string;
  joinCode: string;
  facilitatorCode: string;
  observerCode: string;
  facilitator: Principal;
}

export interface JoinedParticipant {
  participantId: string;
  token: string;
  displayName: string;
  joinOrder: number;
  principal: Principal;
}

export interface StartedGame extends CreatedGame {
  players: Record<Role, JoinedParticipant>;
}

export function createWorld(
  options: { store?: Store; lockTimeoutMs?: number; kitPreset?: KitPreset } = {},
): World {
  const clock = new FixedClock();
  const random = new SequenceRandom();
  const keyRing = loadKeyRing(TEST_ENV);
  const store = options.store ?? new MemoryStore({ lockTimeoutMs: options.lockTimeoutMs ?? 3000 });
  const access = new AccessControl({ store, keyRing, random });
  const session = new GameSession({
    store,
    access,
    clock,
    random,
    ...(options.kitPreset ? { kitPreset: options.kitPreset } : {}),
  });

  const world: World = {
    store,
    access,
    session,
    clock,
    random,
    async as(credential) {
      const principal = await access.authenticate(credential);
      if (!principal) {
        throw new Error('資格情報が無効です（試験の組み立ての誤り）');
      }
      return principal;
    },
    async createGame(overrides = {}) {
      const created = await session.createGame({
        name: '試験のゲーム',
        weekCount: 6,
        ...overrides,
      });
      return {
        gameId: created.gameId,
        joinCode: created.codes.joinCode,
        facilitatorCode: created.codes.facilitatorCode,
        observerCode: created.codes.observerCode,
        facilitator: await world.as(created.codes.facilitatorCode),
      };
    },
    async joinOne(joinCode, displayName) {
      const joined = await session.joinGame({ joinCode, displayName });
      return {
        participantId: joined.participantId,
        token: joined.token,
        displayName: joined.displayName,
        joinOrder: joined.joinOrder,
        principal: await world.as(joined.token),
      };
    },
    async populate(game) {
      const players = {} as Record<Role, JoinedParticipant>;
      for (const role of ROLES) {
        const player = await world.joinOne(game.joinCode, DISPLAY_NAMES[role]);
        await session.assignRole(game.facilitator, game.gameId, player.participantId, role);
        // 割当ての後に token から役割が引ける
        players[role] = { ...player, principal: await world.as(player.token) };
      }
      return players;
    },
    async startedGame(overrides = {}) {
      const game = await world.createGame(overrides);
      const players = await world.populate(game);
      await session.startGame(game.facilitator, game.gameId);
      return { ...game, players };
    },
    async playWeek(game, week, quantities = {}) {
      for (const role of ROLES) {
        await session.submitDecision(
          game.players[role].principal,
          game.gameId,
          week,
          role,
          { quantity: quantities[role] ?? 4 },
          newKey(`in-${role}-w${week}`),
        );
      }
      return session.confirmWeek(game.facilitator, game.gameId, week, newKey(`confirm-w${week}`));
    },
  };
  return world;
}

let keySequence = 0;
/** 16 文字以上の Idempotency-Key を作る */
export function newKey(prefix = 'key'): string {
  keySequence += 1;
  return `${prefix}-${String(keySequence).padStart(16, '0')}`;
}
