import { describe, expect, it } from 'vitest';
import { ROLES } from '../../../src/server/domain/types.js';
import { MemoryStore } from '../../../src/server/session/memory-store.js';
import { bearer, buildTestApp, json } from '../../u1/support/app.js';
import { createWorld, newKey } from '../../u1/support/world.js';
import { expectProblem } from '../support/helpers.js';

describe('操作の履歴（US5.6）', () => {
  describe('AC5.6.1 設定の履歴（BR13.4）', () => {
    it('Given ゲームを作成した / When 履歴を取得する / Then 最初の 1 件が setting で、sequence は 1、需要系列の値そのものは含まない', async () => {
      const world = createWorld();
      const game = await world.createGame({ weekCount: 3, demandSeries: [8, 4, 4] });
      const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        sequence: 1,
        kind: 'setting',
        actorKind: 'facilitator',
        week: null,
        role: null,
      });
      expect(entries[0]!.detail).toMatchObject({
        weekCount: 3,
        initialInventory: 12,
        initialPipelineQuantity: 4,
        inventoryUnitCost: 50,
        backlogUnitCost: 100,
        demandSeriesLength: 3,
        demandSeriesIsProvisional: false,
      });
      expect(JSON.stringify(entries[0]!.detail)).not.toContain('[8,4,4]');
    });
  });

  describe('BR13.3 準備中の割当てと付け替え', () => {
    it('Given 4 人を割り当てた / When 履歴を取得する / Then 役割ごとに assign が残り、ラベルは「表示名 #参加順」', async () => {
      const world = createWorld();
      const game = await world.createGame();
      await world.populate(game);
      const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
      const changes = entries.filter((e) => e.kind === 'roleChange');
      expect(changes).toHaveLength(4);
      expect(changes[0]).toMatchObject({
        actorKind: 'facilitator',
        role: 'factory',
        detail: {
          change: 'assign',
          participantLabel: '工場 #1',
          toRole: 'factory',
          gameStatus: 'preparing',
        },
      });
    });

    it('Given 工場の人を小売店へ付け替えた / When 履歴を取得する / Then reassign が元と先の役割つきで残る', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const player = await world.joinOne(game.joinCode, '太郎');
      await world.session.assignRole(
        game.facilitator,
        game.gameId,
        player.participantId,
        'factory',
      );
      await world.session.assignRole(
        game.facilitator,
        game.gameId,
        player.participantId,
        'retailer',
      );
      const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
      const last = entries.at(-1)!;
      expect(last.kind).toBe('roleChange');
      expect(last.detail).toMatchObject({
        change: 'reassign',
        fromRole: 'factory',
        toRole: 'retailer',
        participantLabel: '太郎 #1',
      });
    });

    it('Given 未割当てに戻した / When 履歴を取得する / Then unassign が残る', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const player = await world.joinOne(game.joinCode, '太郎');
      await world.session.assignRole(
        game.facilitator,
        game.gameId,
        player.participantId,
        'factory',
      );
      await world.session.assignRole(game.facilitator, game.gameId, player.participantId, null);
      const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
      expect(entries.at(-1)!.detail).toMatchObject({ change: 'unassign', toRole: null });
    });
  });

  describe('BR13.1 週の確定', () => {
    it('Given 第 1 週を確定した / When 履歴を取得する / Then weekConfirm が確定した週つきで残る', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.playWeek(game, 1);
      const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
      const confirm = entries.filter((e) => e.kind === 'weekConfirm');
      expect(confirm).toHaveLength(1);
      expect(confirm[0]).toMatchObject({ actorKind: 'facilitator', week: 1, detail: { week: 1 } });
    });

    it('Given 最終週を確定した / When 履歴を取得する / Then weekConfirm に続けて end（finalWeek、system）が連続した番号で残る（BR9.7）', async () => {
      const world = createWorld();
      const game = await world.startedGame({ weekCount: 1, demandSeries: [4] });
      await world.playWeek(game, 1);
      const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
      const tail = entries.slice(-2);
      expect(tail[0]).toMatchObject({ kind: 'weekConfirm' });
      expect(tail[1]).toMatchObject({
        kind: 'end',
        actorKind: 'system',
        week: 1,
        detail: { reason: 'finalWeek', week: 1 },
      });
      expect(tail[1]!.sequence).toBe(tail[0]!.sequence + 1);
    });

    it('Given 確定の保存の途中で失敗した / When 履歴を取得する / Then weekConfirm も end も残らない', async () => {
      const store = new MemoryStore();
      const world = createWorld({ store });
      const game = await world.startedGame({ weekCount: 1, demandSeries: [4] });
      for (const role of ROLES) {
        await world.session.submitDecision(
          game.players[role].principal,
          game.gameId,
          1,
          role,
          { quantity: 4 },
          newKey(),
        );
      }
      const before = (await world.session.getHistory(game.facilitator, game.gameId)).entries.length;
      store.failNextWriteOn = 'appendLog';
      await expectProblem(
        world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey()),
        'internal',
      );
      const after = await world.session.getHistory(game.facilitator, game.gameId);
      expect(after.entries).toHaveLength(before);
      const snapshot = await store.readSnapshot(game.gameId);
      expect(snapshot?.game.status).toBe('running');
    });
  });

  describe('BR13.2 追記専用と連番', () => {
    it('Given 複数の操作をした / When 履歴を取得する / Then sequence は 1 から欠けず重複せず、昇順に返る', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.playWeek(game, 1);
      await world.playWeek(game, 2);
      const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
      expect(entries.map((e) => e.sequence)).toEqual(entries.map((_, index) => index + 1));
      expect(entries.length).toBeGreaterThanOrEqual(1 + 4 + 2);
    });

    it('Given 履歴の保存に失敗した / When 割当てを要求する / Then 割当ても履歴も残らない（BR13.1）', async () => {
      const store = new MemoryStore();
      const world = createWorld({ store });
      const game = await world.createGame();
      const player = await world.joinOne(game.joinCode, '太郎');
      store.failNextWriteOn = 'appendLog';
      await expectProblem(
        world.session.assignRole(game.facilitator, game.gameId, player.participantId, 'factory'),
        'internal',
      );
      const snapshot = await store.readSnapshot(game.gameId);
      expect(snapshot?.assignments).toHaveLength(0);
      const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
      expect(entries.map((e) => e.kind)).toEqual(['setting']);
    });
  });

  describe('BR13.5 進行役だけが取得できる', () => {
    it('Given 参加者 / When 履歴を取得する / Then 403 forbidden', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await expectProblem(
        world.session.getHistory(game.players.retailer.principal, game.gameId),
        'forbidden',
      );
      await expectProblem(world.session.getHistory(null, game.gameId), 'forbidden');
    });

    it('Given 別のゲームの進行役 / When 履歴を取得する / Then 403 forbidden', async () => {
      const world = createWorld();
      const a = await world.createGame();
      const b = await world.createGame();
      await expectProblem(world.session.getHistory(b.facilitator, a.gameId), 'forbidden');
    });

    it('入口: 進行役用コードなら 200 で昇順、参加者の token なら 403', async () => {
      const { app } = await buildTestApp();
      const created = json(
        await app.inject({
          method: 'POST',
          url: '/api/games',
          payload: { name: '履歴', weekCount: 3 },
        }),
      );
      const joined = json(
        await app.inject({
          method: 'POST',
          url: '/api/games/join',
          payload: { joinCode: created.codes.joinCode, displayName: '太郎' },
        }),
      );
      const ok = await app.inject({
        method: 'GET',
        url: `/api/games/${created.gameId}/history`,
        headers: bearer(created.codes.facilitatorCode),
      });
      expect(ok.statusCode).toBe(200);
      expect(json(ok).entries[0]).toMatchObject({ sequence: 1, kind: 'setting' });
      const denied = await app.inject({
        method: 'GET',
        url: `/api/games/${created.gameId}/history`,
        headers: bearer(joined.token),
      });
      expect(denied.statusCode).toBe(403);
      expect(json(denied).kind).toBe('forbidden');
    });
  });

  describe('BR13.6 資格情報を含まない', () => {
    it('Given 一通りの操作をした / When 履歴を取得する / Then 3 種類のコードと token の平文が一切含まれない', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.playWeek(game, 1);
      const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
      const text = JSON.stringify(entries);
      for (const secret of [
        game.facilitatorCode,
        game.joinCode,
        game.observerCode,
        ...ROLES.map((role) => game.players[role].token),
      ]) {
        expect(text).not.toContain(secret);
      }
    });
  });
});
