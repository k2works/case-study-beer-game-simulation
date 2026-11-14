import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../../src/server/session/memory-store.js';
import { expectProblem } from '../../u3/support/helpers.js';
import { createWorld, newKey, type World } from '../../u1/support/world.js';

const HOUR = 60 * 60 * 1000;

const lastOperationOf = async (world: World, gameId: string): Promise<Date> => {
  const snapshot = await world.store.readSnapshot(gameId);
  return snapshot!.game.lastOperationAt;
};

describe('BR25.2 最後の操作の時刻は、状態を変える操作の保存と同じ保存で更新する', () => {
  it('Given ゲームを作成した / Then lastOperationAt は createdAt と同じ', async () => {
    const world = createWorld();
    const game = await world.createGame();
    const snapshot = await world.store.readSnapshot(game.gameId);
    expect(snapshot!.game.lastOperationAt).toEqual(snapshot!.game.createdAt);
  });

  it('Given 準備中のゲーム / When 参加、割当て、開始と進む / Then 操作のたびに時刻が現在の時計になる', async () => {
    const world = createWorld();
    const game = await world.createGame();
    world.clock.advance(HOUR);
    const player = await world.joinOne(game.joinCode, '太郎');
    expect(await lastOperationOf(world, game.gameId)).toEqual(world.clock.now());

    world.clock.advance(HOUR);
    await world.session.assignRole(game.facilitator, game.gameId, player.participantId, 'factory');
    expect(await lastOperationOf(world, game.gameId)).toEqual(world.clock.now());

    for (const role of ['wholesaler1', 'wholesaler2', 'retailer'] as const) {
      const other = await world.joinOne(game.joinCode, role);
      await world.session.assignRole(game.facilitator, game.gameId, other.participantId, role);
    }
    world.clock.advance(HOUR);
    await world.session.startGame(game.facilitator, game.gameId);
    expect(await lastOperationOf(world, game.gameId)).toEqual(world.clock.now());
  });

  it('Given 開始したゲーム / When 入力、確定、一時停止、再開、入れ替え、終了 / Then 毎回、操作の時刻に更新される', async () => {
    const world = createWorld();
    const game = await world.startedGame({ weekCount: 4 });
    const steps: Array<[string, () => Promise<unknown>]> = [
      [
        '入力',
        () =>
          world.session.submitDecision(
            game.players.retailer.principal,
            game.gameId,
            1,
            'retailer',
            { quantity: 5 },
            newKey('lo-in'),
          ),
      ],
      [
        '代理入力',
        () =>
          world.session.submitDecision(
            game.facilitator,
            game.gameId,
            1,
            'factory',
            { quantity: 3 },
            newKey('lo-proxy'),
          ),
      ],
      ['一時停止', () => world.session.pauseGame(game.facilitator, game.gameId)],
      ['再開', () => world.session.resumeGame(game.facilitator, game.gameId)],
      [
        '入れ替え',
        () =>
          world.session.replaceAssignee(game.facilitator, game.gameId, 'retailer', {
            participantId: game.players.retailer.participantId,
            displayName: '新しい人',
          }),
      ],
      ['終了', () => world.session.endGame(game.facilitator, game.gameId)],
    ];
    for (const [label, run] of steps) {
      world.clock.advance(HOUR);
      await run();
      expect(await lastOperationOf(world, game.gameId), label).toEqual(world.clock.now());
    }
  });

  it('Given 全員が入力した週 / When 進行役が確定する / Then 確定の時刻に更新される', async () => {
    const world = createWorld();
    const game = await world.startedGame({ weekCount: 4 });
    world.clock.advance(HOUR);
    await world.playWeek(game, 1);
    expect(await lastOperationOf(world, game.gameId)).toEqual(world.clock.now());
  });

  it('Given 操作のあと時間が過ぎた / When 状態、履歴を見る / Then 時刻は進まない', async () => {
    const world = createWorld();
    const game = await world.startedGame({ weekCount: 4 });
    const before = await lastOperationOf(world, game.gameId);
    world.clock.advance(5 * HOUR);
    await world.session.getState(game.facilitator, game.gameId);
    await world.session.getState(game.players.retailer.principal, game.gameId);
    await world.session.getHistory(game.facilitator, game.gameId);
    expect(await lastOperationOf(world, game.gameId)).toEqual(before);
  });

  it('Given 入力が保存済み / When 同じ識別子で再送する / Then 前回と同じ結果を返すだけで、時刻は進まない', async () => {
    const world = createWorld();
    const game = await world.startedGame({ weekCount: 4 });
    const key = newKey('lo-replay');
    const principal = game.players.retailer.principal;
    await world.session.submitDecision(principal, game.gameId, 1, 'retailer', { quantity: 5 }, key);
    const saved = await lastOperationOf(world, game.gameId);
    world.clock.advance(3 * HOUR);
    await world.session.submitDecision(principal, game.gameId, 1, 'retailer', { quantity: 5 }, key);
    expect(await lastOperationOf(world, game.gameId)).toEqual(saved);
  });

  it('Given 当週ではない週への入力 / When 拒否される / Then 時刻は進まない', async () => {
    const world = createWorld();
    const game = await world.startedGame({ weekCount: 4 });
    const before = await lastOperationOf(world, game.gameId);
    world.clock.advance(2 * HOUR);
    await expectProblem(
      world.session.submitDecision(
        game.players.retailer.principal,
        game.gameId,
        3,
        'retailer',
        { quantity: 5 },
        newKey('lo-reject'),
      ),
      'state',
    );
    expect(await lastOperationOf(world, game.gameId)).toEqual(before);
  });

  it('Given 確定の保存が途中で失敗する / Then 状態も時刻も元のまま（同じ保存の中で更新する）', async () => {
    const store = new MemoryStore();
    const world = createWorld({ store });
    const game = await world.startedGame({ weekCount: 4 });
    for (const role of ['factory', 'wholesaler1', 'wholesaler2', 'retailer'] as const) {
      await world.session.submitDecision(
        game.players[role].principal,
        game.gameId,
        1,
        role,
        { quantity: 4 },
        newKey(`lo-fail-${role}`),
      );
    }
    const before = await store.readSnapshot(game.gameId);
    world.clock.advance(4 * HOUR);
    store.failNextWriteOn = 'confirmRecords';
    await expect(
      world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey('lo-fail-confirm')),
    ).rejects.toBeDefined();
    const after = await store.readSnapshot(game.gameId);
    expect(after!.game.lastOperationAt).toEqual(before!.game.lastOperationAt);
    expect(after!.game.version).toBe(before!.game.version);
  });
});
