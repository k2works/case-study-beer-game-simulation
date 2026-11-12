import { describe, expect, it } from 'vitest';
import { ROLES } from '../../../src/server/domain/types.js';
import { bearer, buildTestApp, json } from '../../u1/support/app.js';
import { createWorld, newKey } from '../../u1/support/world.js';
import { expectProblem } from '../support/helpers.js';

describe('進行管理（US2.8）', () => {
  describe('AC2.8.1 プレイ中に 4 役割の入力完了状況と現在の状態が見える（BR14.1）', () => {
    it('Given 2 役割が入力済み / When 進行役が状態を取得する / Then 入力済みの真偽、不足の役割、各役割の状態、担当者の一覧、入力済みの数が返る', async () => {
      const world = createWorld();
      const game = await world.startedGame({ weekCount: 6 });
      await world.session.submitDecision(
        game.players.factory.principal,
        game.gameId,
        1,
        'factory',
        { quantity: 4 },
        newKey(),
      );
      await world.session.submitDecision(
        game.facilitator,
        game.gameId,
        1,
        'retailer',
        { quantity: 6 },
        newKey(),
      );
      const view = await world.session.getState(game.facilitator, game.gameId);
      expect(view).toMatchObject({
        viewerKind: 'facilitator',
        status: 'running',
        currentWeek: 1,
        inputsDone: 2,
        missingInputRoles: ['wholesaler1', 'wholesaler2'],
      });
      expect(view.roles!.factory).toEqual({
        decided: true,
        receipt: 4,
        ordersReceived: 4,
        inventory: 12,
        backlog: 0,
        cumulativeCost: 0,
      });
      expect(view.roles!.wholesaler1!.decided).toBe(false);
      expect(view.assignees).toHaveLength(4);
    });

    it('BR14.2 進行役の投影は、入力値そのものを含まない（代理入力した値も、参加者の値も）', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.session.submitDecision(
        game.players.factory.principal,
        game.gameId,
        1,
        'factory',
        { quantity: 7771 },
        newKey(),
      );
      await world.session.submitDecision(
        game.facilitator,
        game.gameId,
        1,
        'retailer',
        { quantity: 7772 },
        newKey(),
      );
      const view = await world.session.getState(game.facilitator, game.gameId);
      const text = JSON.stringify(view);
      expect(text).not.toContain('7771');
      expect(text).not.toContain('7772');
      for (const role of ROLES) {
        expect(Object.keys(view.roles![role]).sort()).toEqual(
          ['backlog', 'cumulativeCost', 'decided', 'inventory', 'ordersReceived', 'receipt'].sort(),
        );
      }
    });

    it('BR14.1 一時停止中と終了後も取得できる', async () => {
      const world = createWorld();
      const game = await world.startedGame({ weekCount: 2, demandSeries: [4, 4] });
      await world.session.pauseGame(game.facilitator, game.gameId);
      const paused = await world.session.getState(game.facilitator, game.gameId);
      expect(paused.status).toBe('paused');
      expect(paused.roles).toBeDefined();
      await world.session.resumeGame(game.facilitator, game.gameId);
      await world.playWeek(game, 1);
      await world.playWeek(game, 2);
      const ended = await world.session.getState(game.facilitator, game.gameId);
      expect(ended).toMatchObject({ status: 'ended', currentWeek: 2 });
      expect(ended.roles).toBeDefined();
    });

    it('入れ替え済みの担当者は一覧に含まれず、新しい担当者が出る', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.session.replaceAssignee(game.facilitator, game.gameId, 'retailer', {
        participantId: game.players.retailer.participantId,
        displayName: '新人',
      });
      const view = await world.session.getState(game.facilitator, game.gameId);
      expect(view.assignees!.filter((a) => a.role === 'retailer').map((a) => a.label)).toEqual([
        '新人 #5',
      ]);
      expect(view.participants.find((p) => p.label === '小売店 #4')?.replaced).toBe(true);
    });
  });

  describe('AC2.8.2 進行管理は進行役用コードがないと見られない（BR14.3）', () => {
    it('Given 参加者の token / When 状態を取得する / Then 進行役の投影の項目（担当者の一覧、他の役割の状況）を含まない', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const view = await world.session.getState(game.players.retailer.principal, game.gameId);
      expect(view.viewerKind).toBe('participant');
      expect(view.roles).toBeUndefined();
      expect(view.assignees).toBeUndefined();
      expect(view.assignments).toBeUndefined();
      expect(view.missingInputRoles).toBeUndefined();
    });

    it('Given 無資格・別のゲームの進行役 / When 状態を取得する / Then 403 forbidden', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const other = await world.createGame();
      await expectProblem(world.session.getState(null, game.gameId), 'forbidden');
      await expectProblem(world.session.getState(other.facilitator, game.gameId), 'forbidden');
    });

    it('入口: 参加者の token の状態は participant の投影、無資格は 403、進行役は facilitator の投影', async () => {
      const { app } = await buildTestApp();
      const created = json(
        await app.inject({
          method: 'POST',
          url: '/api/games',
          payload: { name: '管理', weekCount: 3 },
        }),
      );
      const joined = json(
        await app.inject({
          method: 'POST',
          url: '/api/games/join',
          payload: { joinCode: created.codes.joinCode, displayName: '太郎' },
        }),
      );
      const participant = json(
        await app.inject({
          method: 'GET',
          url: `/api/games/${created.gameId}/state`,
          headers: bearer(joined.token),
        }),
      );
      expect(participant.viewerKind).toBe('participant');
      expect(participant.assignees).toBeUndefined();
      const anonymous = await app.inject({
        method: 'GET',
        url: `/api/games/${created.gameId}/state`,
      });
      expect(anonymous.statusCode).toBe(403);
      const facilitator = json(
        await app.inject({
          method: 'GET',
          url: `/api/games/${created.gameId}/state`,
          headers: bearer(created.codes.facilitatorCode),
        }),
      );
      expect(facilitator.viewerKind).toBe('facilitator');
      expect(facilitator.participants[0].label).toBe('太郎 #1');
    });
  });
});
