import { describe, expect, it } from 'vitest';
import { ROLES } from '../../../src/server/domain/types.js';
import { bearer, buildTestApp, json } from '../../u1/support/app.js';
import { createWorld, newKey, type StartedGame, type World } from '../../u1/support/world.js';
import { expectProblem } from '../support/helpers.js';

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

describe('一時停止・再開・終了（US2.5）', () => {
  describe('AC2.5.1 一時停止中は入力と確定を拒否し、閲覧はできる（BR9.1、BR9.3）', () => {
    it('Given 進行中のゲーム / When 進行役が一時停止する / Then paused になり、currentWeek と入力済みの値は変わらない', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.session.submitDecision(
        game.players.retailer.principal,
        game.gameId,
        1,
        'retailer',
        { quantity: 7 },
        newKey(),
      );
      const view = await world.session.pauseGame(game.facilitator, game.gameId);
      expect(view.status).toBe('paused');
      expect(view.currentWeek).toBe(1);
      const mine = await world.session.getState(game.players.retailer.principal, game.gameId);
      expect(mine.mine?.decision).toBe(7);
    });

    it('Given 一時停止中 / When 参加者が発注数を送る / Then 409 state で「一時停止中」を示し、保存済みの値は残る', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.session.submitDecision(
        game.players.retailer.principal,
        game.gameId,
        1,
        'retailer',
        { quantity: 7 },
        newKey(),
      );
      await world.session.pauseGame(game.facilitator, game.gameId);
      const error = await expectProblem(
        world.session.submitDecision(
          game.players.retailer.principal,
          game.gameId,
          1,
          'retailer',
          { quantity: 9 },
          newKey(),
        ),
        'state',
      );
      expect(error.problem.reason).toContain('一時停止中');
      const view = await world.session.getState(game.players.retailer.principal, game.gameId);
      expect(view.status).toBe('paused');
      expect(view.mine?.decision).toBe(7);
    });

    it('Given 一時停止中 / When 進行役が代理入力または週の確定を送る / Then どちらも 409 state（BR9.3）', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await inputAll(world, game, 1);
      await world.session.pauseGame(game.facilitator, game.gameId);
      await expectProblem(
        world.session.submitDecision(
          game.facilitator,
          game.gameId,
          1,
          'factory',
          { quantity: 5 },
          newKey(),
        ),
        'state',
      );
      const error = await expectProblem(
        world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey()),
        'state',
      );
      expect(error.problem.reason).toContain('一時停止中');
    });

    it('Given 一時停止中 / When 以前に成功した識別子の入力を再送する / Then 前回の結果を返す（識別子の照合が状態の検査より先、BR9.3）', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const key = newKey();
      const first = await world.session.submitDecision(
        game.players.retailer.principal,
        game.gameId,
        1,
        'retailer',
        { quantity: 6 },
        key,
      );
      await world.session.pauseGame(game.facilitator, game.gameId);
      const again = await world.session.submitDecision(
        game.players.retailer.principal,
        game.gameId,
        1,
        'retailer',
        { quantity: 6 },
        key,
      );
      expect(again).toEqual(first);
    });

    it('Given 一時停止中 / When 状態を取得する / Then 閲覧できる（status が paused）', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.session.pauseGame(game.facilitator, game.gameId);
      const facilitatorView = await world.session.getState(game.facilitator, game.gameId);
      const participantView = await world.session.getState(
        game.players.factory.principal,
        game.gameId,
      );
      expect(facilitatorView.status).toBe('paused');
      expect(participantView.status).toBe('paused');
      expect(facilitatorView.missingInputRoles).toEqual([...ROLES]);
    });

    it('Given 進行中でない / When 一時停止する / Then 409 state（準備中・一時停止中・終了後）', async () => {
      const world = createWorld();
      const game = await world.createGame();
      await expectProblem(world.session.pauseGame(game.facilitator, game.gameId), 'state');
      const started = await world.startedGame();
      await world.session.pauseGame(started.facilitator, started.gameId);
      await expectProblem(world.session.pauseGame(started.facilitator, started.gameId), 'state');
    });
  });

  describe('AC2.5.2 再開すると進行中に戻る（BR9.2）', () => {
    it('Given 一時停止中 / When 進行役が再開する / Then running に戻り、入力済みの値が保たれ、確定の操作ができる', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await inputAll(world, game, 1);
      await world.session.pauseGame(game.facilitator, game.gameId);
      const view = await world.session.resumeGame(game.facilitator, game.gameId);
      expect(view.status).toBe('running');
      expect(view.currentWeek).toBe(1);
      const result = await world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey());
      expect(result.week).toBe(1);
      expect(result.currentWeek).toBe(2);
    });

    it('Given 一時停止中でない / When 再開する / Then 409 state（冪等にしない）', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await expectProblem(world.session.resumeGame(game.facilitator, game.gameId), 'state');
    });

    it('Given 一時停止中 / When 一時停止と再開を挟む / Then 履歴に pause と resume が週つきで残る', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.session.pauseGame(game.facilitator, game.gameId);
      await world.session.resumeGame(game.facilitator, game.gameId);
      const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
      const tail = entries.slice(-2);
      expect(tail.map((e) => e.kind)).toEqual(['pause', 'resume']);
      expect(tail[0]).toMatchObject({ actorKind: 'facilitator', week: 1, detail: { week: 1 } });
    });
  });

  describe('AC2.5.3 終了後は入力を拒否する（BR9.4、BR9.5、BR9.6）', () => {
    it('Given 進行中 / When 進行役が終了する / Then ended で、reason は facilitator、currentWeek は終了した週のまま、確定前の入力は確定されない', async () => {
      const world = createWorld();
      const game = await world.startedGame({ weekCount: 6 });
      await world.playWeek(game, 1);
      await world.session.submitDecision(
        game.players.retailer.principal,
        game.gameId,
        2,
        'retailer',
        { quantity: 5 },
        newKey(),
      );
      const view = await world.session.endGame(game.facilitator, game.gameId);
      expect(view.status).toBe('ended');
      expect(view.currentWeek).toBe(2);
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot?.game.endReason).toBe('facilitator');
      expect(snapshot?.game.endedAt).not.toBeNull();
      const week2 = snapshot!.weekRecords.filter((r) => r.week === 2);
      expect(week2.every((r) => !r.isConfirmed)).toBe(true);
      expect(week2.find((r) => r.role === 'retailer')?.decision).toBe(5);
    });

    it('Given 一時停止中 / When 進行役が終了する / Then ended になる', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.session.pauseGame(game.facilitator, game.gameId);
      const view = await world.session.endGame(game.facilitator, game.gameId);
      expect(view.status).toBe('ended');
    });

    it('Given 終了した / When 参加者が入力、進行役が確定・一時停止・再開・入れ替えを試みる / Then すべて 409 state', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.session.endGame(game.facilitator, game.gameId);
      const error = await expectProblem(
        world.session.submitDecision(
          game.players.retailer.principal,
          game.gameId,
          1,
          'retailer',
          { quantity: 4 },
          newKey(),
        ),
        'state',
      );
      expect(error.problem.reason).toContain('終了済み');
      await expectProblem(
        world.session.submitDecision(
          game.facilitator,
          game.gameId,
          1,
          'factory',
          { quantity: 4 },
          newKey(),
        ),
        'state',
      );
      await expectProblem(
        world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey()),
        'state',
      );
      await expectProblem(world.session.pauseGame(game.facilitator, game.gameId), 'state');
      await expectProblem(world.session.resumeGame(game.facilitator, game.gameId), 'state');
      await expectProblem(
        world.session.replaceAssignee(game.facilitator, game.gameId, 'retailer', {
          participantId: game.players.retailer.participantId,
          displayName: '新人',
        }),
        'state',
      );
    });

    it('Given 終了済み / When 終了を再送する / Then 現在の状態を返し、endReason・endedAt・履歴は変わらない（冪等）', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.session.endGame(game.facilitator, game.gameId);
      const before = await world.store.readSnapshot(game.gameId);
      const historyBefore = await world.session.getHistory(game.facilitator, game.gameId);
      world.clock.advance(60_000);
      const again = await world.session.endGame(game.facilitator, game.gameId);
      expect(again.status).toBe('ended');
      const after = await world.store.readSnapshot(game.gameId);
      expect(after?.game.endedAt).toEqual(before?.game.endedAt);
      expect(after?.game.endReason).toBe('facilitator');
      expect(after?.game.version).toBe(before?.game.version);
      const historyAfter = await world.session.getHistory(game.facilitator, game.gameId);
      expect(historyAfter.entries).toHaveLength(historyBefore.entries.length);
    });

    it('Given 準備中のゲーム / When 進行役が終了する / Then 409 state（準備中の終了は自動終了だけ、BR9.4）', async () => {
      const world = createWorld();
      const game = await world.createGame();
      await expectProblem(world.session.endGame(game.facilitator, game.gameId), 'state');
    });

    it('Given 準備中のゲーム / When 自動終了（内部の呼び出し）が走る / Then ended・autoEnd で、履歴の end は system', async () => {
      const world = createWorld();
      const game = await world.createGame();
      // U5: 占有の中で期限（最後の操作が staleBefore 以前）を再検査する。ここでは作成の時刻が期限以前
      expect(await world.session.autoEnd(game.gameId, world.clock.now())).toBe('ended');
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot?.game).toMatchObject({ status: 'ended', endReason: 'autoEnd' });
      const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
      expect(entries.at(-1)).toMatchObject({
        kind: 'end',
        actorKind: 'system',
        detail: { reason: 'autoEnd' },
      });
      // 終了済みへの再実行は何もしない
      expect(await world.session.autoEnd(game.gameId, world.clock.now())).toBe('already-ended');
      const again = await world.session.getHistory(game.facilitator, game.gameId);
      expect(again.entries).toHaveLength(entries.length);
    });

    it('履歴の end は進行役の終了で actorKind が facilitator、reason が facilitator、週は終了した週', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.session.endGame(game.facilitator, game.gameId);
      const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
      expect(entries.at(-1)).toMatchObject({
        kind: 'end',
        actorKind: 'facilitator',
        week: 1,
        detail: { reason: 'facilitator', week: 1 },
      });
    });
  });

  describe('AC2.5.4 終了週の確定で自動終了する（BR9.7）', () => {
    it('Given 最終週 / When 確定する / Then ended・finalWeek で、currentWeek は weekCount のまま', async () => {
      const world = createWorld();
      const game = await world.startedGame({ weekCount: 2, demandSeries: [4, 4] });
      await world.playWeek(game, 1);
      const result = await world.playWeek(game, 2);
      expect(result.status).toBe('ended');
      expect(result.currentWeek).toBe(2);
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot?.game.endReason).toBe('finalWeek');
    });

    it('Given 最終週の確定が済んだ / When 進行役が終了を送る / Then 冪等に現在の状態を返し、endReason は finalWeek のまま（競合の後始末）', async () => {
      const world = createWorld();
      const game = await world.startedGame({ weekCount: 1, demandSeries: [4] });
      await world.playWeek(game, 1);
      const view = await world.session.endGame(game.facilitator, game.gameId);
      expect(view.status).toBe('ended');
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot?.game.endReason).toBe('finalWeek');
      const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
      expect(entries.filter((e) => e.kind === 'end')).toHaveLength(1);
    });
  });

  describe('BR9.8 進行役だけが操作できる / 入口', () => {
    it('Given 参加者の token / When 一時停止・再開・終了を要求する / Then 403 forbidden', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const player = game.players.retailer.principal;
      await expectProblem(world.session.pauseGame(player, game.gameId), 'forbidden');
      await expectProblem(world.session.resumeGame(player, game.gameId), 'forbidden');
      await expectProblem(world.session.endGame(player, game.gameId), 'forbidden');
      await expectProblem(world.session.endGame(null, game.gameId), 'forbidden');
    });

    it('入口: pause → resume → end が通り、end の本文に reason を入れても無視され facilitator になる', async () => {
      const { app, store } = await buildTestApp();
      const created = json(
        await app.inject({
          method: 'POST',
          url: '/api/games',
          payload: { name: '入口', weekCount: 3 },
        }),
      );
      const fac = bearer(created.codes.facilitatorCode);
      const roles = ['factory', 'wholesaler1', 'wholesaler2', 'retailer'];
      for (const role of roles) {
        const joined = json(
          await app.inject({
            method: 'POST',
            url: '/api/games/join',
            payload: { joinCode: created.codes.joinCode, displayName: role },
          }),
        );
        await app.inject({
          method: 'PUT',
          url: `/api/games/${created.gameId}/assignments/${joined.participantId}`,
          headers: fac,
          payload: { role },
        });
      }
      await app.inject({ method: 'POST', url: `/api/games/${created.gameId}/start`, headers: fac });
      const paused = await app.inject({
        method: 'POST',
        url: `/api/games/${created.gameId}/pause`,
        headers: fac,
      });
      expect(paused.statusCode).toBe(200);
      expect(json(paused).status).toBe('paused');
      const resumed = await app.inject({
        method: 'POST',
        url: `/api/games/${created.gameId}/resume`,
        headers: fac,
      });
      expect(json(resumed).status).toBe('running');
      const ended = await app.inject({
        method: 'POST',
        url: `/api/games/${created.gameId}/end`,
        headers: { ...fac, 'content-type': 'application/json' },
        payload: { reason: 'finalWeek' },
      });
      expect(ended.statusCode).toBe(200);
      expect(json(ended).status).toBe('ended');
      const snapshot = await store.readSnapshot(created.gameId);
      expect(snapshot?.game.endReason).toBe('facilitator');
      const again = await app.inject({
        method: 'POST',
        url: `/api/games/${created.gameId}/end`,
        headers: fac,
      });
      expect(again.statusCode).toBe(200);
    });

    it('入口: 参加者の token での pause は 403、準備中の end は 409', async () => {
      const { app } = await buildTestApp();
      const created = json(
        await app.inject({
          method: 'POST',
          url: '/api/games',
          payload: { name: '入口', weekCount: 3 },
        }),
      );
      const joined = json(
        await app.inject({
          method: 'POST',
          url: '/api/games/join',
          payload: { joinCode: created.codes.joinCode, displayName: '太郎' },
        }),
      );
      const denied = await app.inject({
        method: 'POST',
        url: `/api/games/${created.gameId}/pause`,
        headers: bearer(joined.token),
      });
      expect(denied.statusCode).toBe(403);
      const endPreparing = await app.inject({
        method: 'POST',
        url: `/api/games/${created.gameId}/end`,
        headers: bearer(created.codes.facilitatorCode),
      });
      expect(endPreparing.statusCode).toBe(409);
      expect(json(endPreparing).kind).toBe('state');
    });
  });
});
