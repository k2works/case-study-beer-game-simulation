import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/server/errors.js';
import { ROLES } from '../../../src/server/domain/types.js';
import type { MemoryStore } from '../../../src/server/session/memory-store.js';
import type { WeekRecordRow } from '../../../src/server/session/store.js';
import { createWorld, newKey, type StartedGame, type World } from '../../u1/support/world.js';

async function kindOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof AppError ? error.problem.kind : String(error)),
  );
}

async function inputAll(world: World, game: StartedGame, week: number, quantity = 4) {
  for (const role of ROLES) {
    await world.session.submitDecision(
      game.players[role].principal,
      game.gameId,
      week,
      role,
      { quantity },
      newKey(),
    );
  }
}

describe('確定の保証（US2.4）', () => {
  describe('AC2.4.2 / BR7.1 同時の確定は一度だけ', () => {
    it('Given 入力がそろった第 1 週 / When 識別子が違う確定が 3 件同時に届く / Then 1 件だけが確定し、残りは 409 state。週は一度だけ進む', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await inputAll(world, game, 1);
      const outcomes = await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          kindOf(world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey(`race${i}`))),
        ),
      );
      expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'state')).toHaveLength(2);
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot?.game.currentWeek).toBe(2);
      expect(snapshot?.weekRecords.filter((r) => r.week === 1 && r.isConfirmed)).toHaveLength(4);
      expect(snapshot?.weekRecords.filter((r) => r.week === 2)).toHaveLength(4);
    });

    it('Given 同じ識別子 / When 同時に 3 件届く / Then 3 件とも同じ結果を返し、確定は一度だけ', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await inputAll(world, game, 1);
      const key = newKey('same');
      const [a, b, c] = await Promise.all([
        world.session.confirmWeek(game.facilitator, game.gameId, 1, key),
        world.session.confirmWeek(game.facilitator, game.gameId, 1, key),
        world.session.confirmWeek(game.facilitator, game.gameId, 1, key),
      ]);
      expect(b).toEqual(a);
      expect(c).toEqual(a);
      expect((await world.store.readSnapshot(game.gameId))?.game.currentWeek).toBe(2);
    });

    it('Given 最終週が確定済み / When 識別子が違う確定が届く / Then 409 state（前回の結果は返さない）。同じ識別子なら前回の結果', async () => {
      const world = createWorld();
      const game = await world.startedGame({ weekCount: 2 });
      await world.playWeek(game, 1);
      await inputAll(world, game, 2);
      const key = newKey('final');
      const final = await world.session.confirmWeek(game.facilitator, game.gameId, 2, key);
      const before = await world.store.readSnapshot(game.gameId);
      await expect(
        kindOf(world.session.confirmWeek(game.facilitator, game.gameId, 2, newKey())),
      ).resolves.toBe('state');
      await expect(
        world.session.confirmWeek(game.facilitator, game.gameId, 2, key),
      ).resolves.toEqual(final);
      expect(await world.store.readSnapshot(game.gameId)).toEqual(before);
    });
  });

  describe('AC2.4.3 / BR7.3 入力の二重送信は 1 件', () => {
    it('Given 発注数の送信 / When 同じ識別子・同じ内容で 2 回届く / Then 2 回目は前回の結果で、入力は 1 件のまま', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const key = newKey('dup');
      const retailer = game.players.retailer.principal;
      const first = await world.session.submitDecision(
        retailer,
        game.gameId,
        1,
        'retailer',
        { quantity: 7 },
        key,
      );
      const second = await world.session.submitDecision(
        retailer,
        game.gameId,
        1,
        'retailer',
        { quantity: 7 },
        key,
      );
      expect(second).toEqual(first);
      const snapshot = await world.store.readSnapshot(game.gameId);
      const mine = snapshot?.weekRecords.filter((r) => r.week === 1 && r.role === 'retailer');
      expect(mine).toHaveLength(1);
      expect(mine?.[0]?.decision).toBe(7);
    });

    it('Given 同じ識別子で内容が違う送信 / When 届く / Then 409 conflict で、入力は元のまま', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const key = newKey('dup');
      const retailer = game.players.retailer.principal;
      await world.session.submitDecision(
        retailer,
        game.gameId,
        1,
        'retailer',
        { quantity: 7 },
        key,
      );
      await expect(
        kindOf(
          world.session.submitDecision(retailer, game.gameId, 1, 'retailer', { quantity: 8 }, key),
        ),
      ).resolves.toBe('conflict');
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(
        snapshot?.weekRecords.find((r) => r.week === 1 && r.role === 'retailer')?.decision,
      ).toBe(7);
    });
  });

  describe('AC2.4.1 / BR7.2 途中の失敗は何も残さない（メモリ上の保存）', () => {
    const steps = [
      'confirmRecords',
      'replaceSlots',
      'insertWeekRecords',
      'updateGame',
      'saveIdempotency',
    ];
    for (const step of steps) {
      it(`Given ${step} で保存に失敗する / When 週を確定する / Then 500 internal。確定前の状態のままで、やり直せる`, async () => {
        const world = createWorld();
        const game = await world.startedGame();
        await inputAll(world, game, 1);
        const before = await world.store.readSnapshot(game.gameId);
        const viewBefore = await world.session.getState(game.facilitator, game.gameId);
        (world.store as MemoryStore).failNextWriteOn = step;
        await expect(
          kindOf(world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey())),
        ).resolves.toBe('internal');
        expect(await world.store.readSnapshot(game.gameId)).toEqual(before);
        expect(await world.session.getState(game.facilitator, game.gameId)).toEqual(viewBefore);
        await expect(
          world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey()),
        ).resolves.toMatchObject({ week: 1, currentWeek: 2 });
      });
    }

    it('Given 最終週の確定で updateGame が失敗する / When 確定する / Then ゲームは進行中のまま', async () => {
      const world = createWorld();
      const game = await world.startedGame({ weekCount: 1 });
      await inputAll(world, game, 1);
      (world.store as MemoryStore).failNextWriteOn = 'updateGame';
      await expect(
        kindOf(world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey())),
      ).resolves.toBe('internal');
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot?.game.status).toBe('running');
      expect(snapshot?.weekRecords.every((r) => !r.isConfirmed)).toBe(true);
    });
  });

  describe('AC2.4.1 / BR7.4 前の週の記録が欠けているときは、0 を代入せず失敗にする', () => {
    function dropRecord(
      world: World,
      gameId: string,
      predicate: (r: WeekRecordRow) => boolean,
    ): void {
      const games = (
        world.store as unknown as { games: Map<string, { weekRecords: WeekRecordRow[] }> }
      ).games;
      const data = games.get(gameId)!;
      data.weekRecords = data.weekRecords.filter((r) => !predicate(r));
    }

    it('Given 第 1 週の小売店の確定済みの記録が欠けた第 2 週 / When 第 2 週を確定する / Then 500 internal で、状態は変わらない', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.playWeek(game, 1);
      await inputAll(world, game, 2);
      dropRecord(world, game.gameId, (r) => r.week === 1 && r.role === 'retailer');
      const before = await world.store.readSnapshot(game.gameId);
      await expect(
        kindOf(world.session.confirmWeek(game.facilitator, game.gameId, 2, newKey())),
      ).resolves.toBe('internal');
      expect(await world.store.readSnapshot(game.gameId)).toEqual(before);
    });

    it('Given 第 1 週の記録が確定済みでない第 2 週 / When 第 2 週を確定する / Then 500 internal', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.playWeek(game, 1);
      await inputAll(world, game, 2);
      const games = (
        world.store as unknown as { games: Map<string, { weekRecords: WeekRecordRow[] }> }
      ).games;
      const target = games
        .get(game.gameId)!
        .weekRecords.find((r) => r.week === 1 && r.role === 'wholesaler1')!;
      target.isConfirmed = false;
      await expect(
        kindOf(world.session.confirmWeek(game.facilitator, game.gameId, 2, newKey())),
      ).resolves.toBe('internal');
    });

    it('Given 遅延の枠の行が欠けた / When 週を確定する / Then 500 internal（0 を代入しない）', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await inputAll(world, game, 1);
      const games = (world.store as unknown as { games: Map<string, { slots: unknown[] }> }).games;
      games.get(game.gameId)!.slots.pop();
      await expect(
        kindOf(world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey())),
      ).resolves.toBe('internal');
    });
  });
});
