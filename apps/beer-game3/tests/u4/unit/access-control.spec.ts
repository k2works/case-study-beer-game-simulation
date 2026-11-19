import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  isExpired,
  type Action,
  type Principal,
} from '../../../src/server/access/access-control.js';
import { AppError } from '../../../src/server/errors.js';
import { createWorld } from '../../u1/support/world.js';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const kindOf = (fn: () => unknown): string => {
  try {
    fn();
    return 'ok';
  } catch (error) {
    return error instanceof AppError ? error.problem.kind : String(error);
  }
};

describe('BR17.1 期限の判定（isExpired、NFR5.2）', () => {
  const lastUsed = new Date('2026-11-12T09:00:00.000Z');
  const ttl = 24 * HOUR;

  it('24 時間 − 1 分の前は有効', () => {
    expect(isExpired(lastUsed, new Date(lastUsed.getTime() + 24 * HOUR - MINUTE), ttl)).toBe(false);
  });

  it('ちょうど 24 時間までは有効で、24 時間 + 1 分の後は無効', () => {
    expect(isExpired(lastUsed, new Date(lastUsed.getTime() + 24 * HOUR), ttl)).toBe(false);
    expect(isExpired(lastUsed, new Date(lastUsed.getTime() + 24 * HOUR + MINUTE), ttl)).toBe(true);
  });

  it('有効期間は引数で決まる（設定値）', () => {
    expect(isExpired(lastUsed, new Date(lastUsed.getTime() + 2 * MINUTE), MINUTE)).toBe(true);
  });
});

describe('BR15.1 観察者の資格情報（AccessControl.authenticate）', () => {
  it('観察者用コードは、そのゲームの観察者として特定される', async () => {
    const world = createWorld();
    const game = await world.createGame();
    const principal = await world.access.authenticate(game.observerCode);
    expect(principal).toEqual({ kind: 'observer', gameId: game.gameId });
  });

  it('参加コードを資格情報として出しても、誰としても特定されない', async () => {
    const world = createWorld();
    const game = await world.createGame();
    expect(await world.access.authenticate(game.joinCode)).toBeNull();
  });

  it('観察者用コードを大文字小文字や一部変えた値は特定されない', async () => {
    const world = createWorld();
    const game = await world.createGame();
    expect(await world.access.authenticate(game.observerCode.toUpperCase())).toBeNull();
    expect(await world.access.authenticate(`${game.observerCode}x`)).toBeNull();
  });
});

describe('BR19.1 操作の表（authorize）', () => {
  const gameId = '11111111-1111-4111-8111-111111111111';
  const otherGame = '22222222-2222-4222-8222-222222222222';
  const world = createWorld();

  const facilitator: Principal = { kind: 'facilitator', gameId };
  const observer: Principal = { kind: 'observer', gameId };
  const retailer: Principal = {
    kind: 'participant',
    gameId,
    participantId: 'p-retailer',
    role: 'retailer',
  };
  const unassigned: Principal = {
    kind: 'participant',
    gameId,
    participantId: 'p-none',
    role: null,
  };

  const attempt = (principal: Principal | null, action: Action, role?: string, game = gameId) =>
    kindOf(() =>
      world.access.authorize(principal, action, { gameId: game, ...(role ? { role } : {}) }),
    );

  it('観察者に許すのは状態の取得だけ。ほかのすべての操作は 403', () => {
    expect(attempt(observer, 'viewState')).toBe('ok');
    for (const action of ACTIONS.filter((a) => a !== 'viewState' && a !== 'identify')) {
      expect(attempt(observer, action, 'retailer'), action).toBe('forbidden');
    }
  });

  it('進行役は、自分のゲームのすべての操作ができる（代理入力を含む）', () => {
    for (const action of ACTIONS) {
      expect(attempt(facilitator, action, 'factory'), action).toBe('ok');
    }
  });

  it('参加者は、状態の取得、自分の役割の入力、結果の閲覧（U5）だけができる', () => {
    expect(attempt(retailer, 'viewState')).toBe('ok');
    expect(attempt(retailer, 'viewResults')).toBe('ok');
    // 結果を見られるのは、役割が割り当てられた参加者だけ（BR21.2）
    expect(attempt(unassigned, 'viewResults')).toBe('forbidden');
    expect(attempt(retailer, 'submitDecision', 'retailer')).toBe('ok');
    expect(attempt(retailer, 'submitDecision', 'factory')).toBe('forbidden');
    expect(attempt(retailer, 'submitDecision', 'not-a-role')).toBe('forbidden');
    expect(attempt(unassigned, 'submitDecision', 'retailer')).toBe('forbidden');
    for (const action of ACTIONS.filter(
      (a) => !['viewState', 'viewResults', 'submitDecision', 'identify'].includes(a),
    )) {
      expect(attempt(retailer, action, 'retailer'), action).toBe('forbidden');
    }
  });

  it('資格情報なし、または別のゲームの資格情報は、すべて 403', () => {
    for (const action of ACTIONS.filter((a) => a !== 'identify')) {
      expect(attempt(null, action, 'retailer'), action).toBe('forbidden');
      expect(attempt(facilitator, action, 'retailer', otherGame), action).toBe('forbidden');
      expect(attempt(retailer, action, 'retailer', otherGame), action).toBe('forbidden');
      expect(attempt(observer, action, 'retailer', otherGame), action).toBe('forbidden');
    }
  });

  it('identify（自分が誰かを確かめる）は、有効な資格情報なら種類によらずゲームを問わない', () => {
    expect(kindOf(() => world.access.authorize(observer, 'identify', {}))).toBe('ok');
    expect(kindOf(() => world.access.authorize(null, 'identify', {}))).toBe('forbidden');
  });
});

describe('BR17.3 無効な token は同じ結果（resolveParticipant、NFR6.4）', () => {
  it('不明、入れ替えで失効、期限切れの 3 つが、すべて null で区別できない', async () => {
    const world = createWorld();
    const game = await world.startedGame();
    const retailer = game.players.retailer;
    const factory = game.players.factory;

    // 有効な間は特定できる
    expect(await world.access.authenticate(factory.token)).not.toBeNull();

    // 不明
    const unknown = await world.access.authenticate('tok_unknown-unknown-unknown-unknown');

    // 入れ替えで失効
    await world.session.replaceAssignee(game.facilitator, game.gameId, 'retailer', {
      participantId: retailer.participantId,
      displayName: '交代した人',
    });
    const revoked = await world.access.authenticate(retailer.token);

    // 期限切れ（最後の操作から 24 時間 + 1 分）
    world.clock.advance(24 * HOUR + MINUTE);
    const expired = await world.access.authenticate(factory.token);

    expect(unknown).toBeNull();
    expect(revoked).toBeNull();
    expect(expired).toBeNull();
  });

  it('期限の手前の token は有効で、期限を過ぎた token は行を変えずに無効になる', async () => {
    const world = createWorld();
    const game = await world.startedGame();
    const token = game.players.factory.token;
    world.clock.advance(24 * HOUR - MINUTE);
    expect(await world.access.authenticate(token)).not.toBeNull();
    world.clock.advance(2 * MINUTE);
    expect(await world.access.authenticate(token)).toBeNull();
  });
});

describe('BR17.6 入れ替えの新しい token は、発行の時刻から数える', () => {
  it('入れ替えから 23 時間後でも新しい token は有効で、25 時間後は無効', async () => {
    const world = createWorld();
    const game = await world.startedGame();
    world.clock.advance(20 * HOUR);
    const replaced = await world.session.replaceAssignee(game.facilitator, game.gameId, 'factory', {
      participantId: game.players.factory.participantId,
      displayName: '新しい工場',
    });
    world.clock.advance(23 * HOUR);
    expect(await world.access.authenticate(replaced.token)).not.toBeNull();
    world.clock.advance(2 * HOUR);
    expect(await world.access.authenticate(replaced.token)).toBeNull();
  });
});
