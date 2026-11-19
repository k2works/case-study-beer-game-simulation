import { describe, expect, it } from 'vitest';
import { ROLES } from '../../../src/server/domain/types.js';
import { MemoryStore } from '../../../src/server/session/memory-store.js';
import { bearer, buildTestApp, json } from '../../u1/support/app.js';
import { createWorld, newKey } from '../../u1/support/world.js';
import { expectProblem } from '../support/helpers.js';

describe('担当者の入れ替え（US2.6）', () => {
  describe('AC2.6.1 進行中に入れ替える（BR10.2〜BR10.4）', () => {
    it('Given 進行中 / When 小売店の担当者を別の人に入れ替える / Then 新しい参加者が同じ役割に就き、旧 token は無効、役割の状態と確定前の入力は変わらない', async () => {
      const world = createWorld();
      const game = await world.startedGame({ weekCount: 6 });
      await world.playWeek(game, 1);
      await world.session.submitDecision(
        game.players.retailer.principal,
        game.gameId,
        2,
        'retailer',
        { quantity: 7 },
        newKey(),
      );
      const before = await world.session.getState(game.players.retailer.principal, game.gameId);
      const oldToken = game.players.retailer.token;

      const result = await world.session.replaceAssignee(
        game.facilitator,
        game.gameId,
        'retailer',
        { participantId: game.players.retailer.participantId, displayName: '新人' },
      );

      expect(result).toMatchObject({
        role: 'retailer',
        displayName: '新人',
        joinOrder: 5,
        label: '新人 #5',
        replacedParticipantId: game.players.retailer.participantId,
      });
      expect(result.token).toMatch(/^tok_/);
      // 旧 token は無効（認証できない）
      await expect(world.access.authenticate(oldToken)).resolves.toBeNull();
      // 新しい token で、役割の状態が引き継がれている
      const principal = await world.as(result.token);
      const after = await world.session.getState(principal, game.gameId);
      expect(after.role).toBe('retailer');
      expect(after.mine).toMatchObject({
        week: 2,
        inventory: before.mine!.inventory,
        backlog: before.mine!.backlog,
        cumulativeCost: before.mine!.cumulativeCost,
        decision: 7,
        history: before.mine!.history,
      });
      // 役割ごとの人数は変わらない
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot!.assignments.filter((a) => a.role === 'retailer')).toHaveLength(1);
      const old = snapshot!.participants.find(
        (p) => p.participantId === game.players.retailer.participantId,
      );
      expect(old?.replacedAt).not.toBeNull();
      const created = snapshot!.participants.find((p) => p.participantId === result.participantId);
      expect(created).toMatchObject({ createdByFacilitator: true, replacedAt: null });
    });

    it('Given 入れ替えた / When 旧 token で状態の取得や入力を要求する / Then 認可に通らない（BR10.4）', async () => {
      const { app } = await buildTestApp();
      const created = json(
        await app.inject({
          method: 'POST',
          url: '/api/games',
          payload: { name: '入れ替え', weekCount: 3 },
        }),
      );
      const fac = bearer(created.codes.facilitatorCode);
      const tokens: Record<string, string> = {};
      const ids: Record<string, string> = {};
      for (const role of ROLES) {
        const joined = json(
          await app.inject({
            method: 'POST',
            url: '/api/games/join',
            payload: { joinCode: created.codes.joinCode, displayName: role },
          }),
        );
        tokens[role] = joined.token;
        ids[role] = joined.participantId;
        await app.inject({
          method: 'PUT',
          url: `/api/games/${created.gameId}/assignments/${joined.participantId}`,
          headers: fac,
          payload: { role },
        });
      }
      await app.inject({ method: 'POST', url: `/api/games/${created.gameId}/start`, headers: fac });

      const replaced = await app.inject({
        method: 'POST',
        url: `/api/games/${created.gameId}/roles/retailer/replacement`,
        headers: fac,
        payload: { participantId: ids.retailer, displayName: '新人' },
      });
      expect(replaced.statusCode).toBe(201);
      expect(replaced.headers['cache-control']).toBe('no-store');
      expect(json(replaced).token).toMatch(/^tok_/);

      const state = await app.inject({
        method: 'GET',
        url: `/api/games/${created.gameId}/state`,
        headers: bearer(tokens.retailer!),
      });
      expect(state.statusCode).toBe(403);
      const input = await app.inject({
        method: 'PUT',
        url: `/api/games/${created.gameId}/weeks/1/decisions/retailer`,
        headers: { ...bearer(tokens.retailer!), 'idempotency-key': newKey('old-token') },
        payload: { quantity: 5 },
      });
      expect(input.statusCode).toBe(403);
      // 新しい token は使える
      const fresh = await app.inject({
        method: 'GET',
        url: `/api/games/${created.gameId}/state`,
        headers: bearer(json(replaced).token),
      });
      expect(fresh.statusCode).toBe(200);
      expect(json(fresh).role).toBe('retailer');
    });

    it('履歴に roleChange（replace）が、新旧のラベルと状態つきで残り、token の値は含まない', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const result = await world.session.replaceAssignee(
        game.facilitator,
        game.gameId,
        'retailer',
        {
          participantId: game.players.retailer.participantId,
          displayName: '新人',
        },
      );
      const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
      const last = entries.at(-1)!;
      expect(last).toMatchObject({
        kind: 'roleChange',
        actorKind: 'facilitator',
        role: 'retailer',
        detail: {
          change: 'replace',
          participantId: result.participantId,
          participantLabel: '新人 #5',
          toRole: 'retailer',
          replacedParticipantId: game.players.retailer.participantId,
          replacedParticipantLabel: '小売店 #4',
          gameStatus: 'running',
        },
      });
      expect(JSON.stringify(entries)).not.toContain(result.token);
      expect(JSON.stringify(entries)).not.toContain(game.players.retailer.token);
    });
  });

  describe('AC2.6.2 別の役割への移動は拒否する（BR10.1）', () => {
    it('Given 進行中 / When PUT assignments で小売店の担当者を工場へ移そうとする / Then 409 state で、割当ては変わらない', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const error = await expectProblem(
        world.session.assignRole(
          game.facilitator,
          game.gameId,
          game.players.retailer.participantId,
          'factory',
        ),
        'state',
      );
      expect(error.problem.hint).toContain('replacement');
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(
        snapshot!.assignments.find((a) => a.participantId === game.players.retailer.participantId)
          ?.role,
      ).toBe('retailer');
    });

    it('Given 進行中 / When 一時停止中も含めて PUT assignments を使う / Then 常に 409 state', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.session.pauseGame(game.facilitator, game.gameId);
      await expectProblem(
        world.session.assignRole(
          game.facilitator,
          game.gameId,
          game.players.retailer.participantId,
          'retailer',
        ),
        'state',
      );
      await expectProblem(
        world.session.assignRole(
          game.facilitator,
          game.gameId,
          game.players.retailer.participantId,
          null,
        ),
        'state',
      );
    });

    it('Given 小売店の担当者 / When 工場の入れ替えとして指定する / Then 409 conflict（その役割の担当者ではない、BR10.2）', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await expectProblem(
        world.session.replaceAssignee(game.facilitator, game.gameId, 'factory', {
          participantId: game.players.retailer.participantId,
          displayName: '新人',
        }),
        'conflict',
      );
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot!.participants).toHaveLength(4);
    });
  });

  describe('AC2.6.3 一時停止中も入れ替えられる（BR10.5）', () => {
    it('Given 一時停止中 / When 同じ役割の担当者を入れ替える / Then 入れ替えられ、状態は paused のまま', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.session.pauseGame(game.facilitator, game.gameId);
      await world.session.replaceAssignee(game.facilitator, game.gameId, 'wholesaler1', {
        participantId: game.players.wholesaler1.participantId,
        displayName: '新人',
      });
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot!.game.status).toBe('paused');
      const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
      expect(entries.at(-1)!.detail).toMatchObject({ change: 'replace', gameStatus: 'paused' });
    });

    it('Given 準備中 / When 入れ替えを要求する / Then 409 state（準備中は割当てを使う）', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const players = await world.populate(game);
      await expectProblem(
        world.session.replaceAssignee(game.facilitator, game.gameId, 'factory', {
          participantId: players.factory.participantId,
          displayName: '新人',
        }),
        'state',
      );
    });
  });

  describe('BR10.6 再送の安全', () => {
    it('Given 入れ替え済み / When 同じ旧担当者でもう一度入れ替える / Then 409 conflict で、参加者を作らず、先の token は有効なまま', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const first = await world.session.replaceAssignee(game.facilitator, game.gameId, 'retailer', {
        participantId: game.players.retailer.participantId,
        displayName: '新人',
      });
      await expectProblem(
        world.session.replaceAssignee(game.facilitator, game.gameId, 'retailer', {
          participantId: game.players.retailer.participantId,
          displayName: '別の人',
        }),
        'conflict',
      );
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot!.participants).toHaveLength(5);
      await expect(world.access.authenticate(first.token)).resolves.toMatchObject({
        kind: 'participant',
        participantId: first.participantId,
      });
    });

    it('Given 応答を失った / When 新しい担当者を旧担当者としてもう一度入れ替える / Then 入れ替えられ、参加順の番号が飛ぶ', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const first = await world.session.replaceAssignee(game.facilitator, game.gameId, 'retailer', {
        participantId: game.players.retailer.participantId,
        displayName: '太郎',
      });
      const second = await world.session.replaceAssignee(
        game.facilitator,
        game.gameId,
        'retailer',
        {
          participantId: first.participantId,
          displayName: '太郎',
        },
      );
      expect(first.label).toBe('太郎 #5');
      expect(second.label).toBe('太郎 #6');
      await expect(world.access.authenticate(first.token)).resolves.toBeNull();
    });
  });

  describe('入力の検証と認可', () => {
    it('表示名が空、41 文字、識別子が uuid でない、余計な項目 → 422 validation', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const base = { participantId: game.players.retailer.participantId, displayName: '新人' };
      for (const body of [
        { ...base, displayName: '   ' },
        { ...base, displayName: 'あ'.repeat(41) },
        { ...base, participantId: 'x' },
        { ...base, extra: 1 },
        undefined,
      ]) {
        await expectProblem(
          world.session.replaceAssignee(game.facilitator, game.gameId, 'retailer', body),
          'validation',
        );
      }
      await expectProblem(
        world.session.replaceAssignee(game.facilitator, game.gameId, 'brewer', base),
        'validation',
      );
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot!.participants).toHaveLength(4);
    });

    it('参加者・無資格・別ゲームの進行役は 403 forbidden', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const other = await world.createGame();
      const body = { participantId: game.players.retailer.participantId, displayName: '新人' };
      await expectProblem(
        world.session.replaceAssignee(
          game.players.factory.principal,
          game.gameId,
          'retailer',
          body,
        ),
        'forbidden',
      );
      await expectProblem(
        world.session.replaceAssignee(null, game.gameId, 'retailer', body),
        'forbidden',
      );
      await expectProblem(
        world.session.replaceAssignee(other.facilitator, game.gameId, 'retailer', body),
        'forbidden',
      );
    });
  });

  describe('NFR2.1 入れ替えの原子性', () => {
    it('Given 入れ替えの途中の保存が失敗する / When 入れ替える / Then 何も変わらない（旧担当者の割当てと token は有効、新しい参加者もいない）', async () => {
      const store = new MemoryStore();
      const world = createWorld({ store });
      const game = await world.startedGame();
      for (const operation of ['replaceParticipant', 'appendLog']) {
        store.failNextWriteOn = operation;
        await expectProblem(
          world.session.replaceAssignee(game.facilitator, game.gameId, 'retailer', {
            participantId: game.players.retailer.participantId,
            displayName: '新人',
          }),
          'internal',
        );
        const snapshot = await store.readSnapshot(game.gameId);
        expect(snapshot!.participants).toHaveLength(4);
        expect(
          snapshot!.assignments.find((a) => a.participantId === game.players.retailer.participantId)
            ?.role,
        ).toBe('retailer');
        await expect(
          world.access.authenticate(game.players.retailer.token),
        ).resolves.not.toBeNull();
        const history = await world.session.getHistory(game.facilitator, game.gameId);
        expect(
          history.entries.some(
            (e) => e.detail && 'change' in e.detail && e.detail.change === 'replace',
          ),
        ).toBe(false);
      }
    });
  });

  describe('NFR6.3 入れ替えと旧担当者の入力の競合', () => {
    it('Given 旧担当者が入れ替えの前に認可を通っていた / When 入れ替えのコミットの後に入力が占有を取る / Then 403 forbidden で decision は書かれない', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      // 入口の認可を通った時点の Principal（入れ替えより前）
      const stale = await world.access.authenticate(game.players.retailer.token);
      expect(stale).not.toBeNull();
      await world.session.replaceAssignee(game.facilitator, game.gameId, 'retailer', {
        participantId: game.players.retailer.participantId,
        displayName: '新人',
      });
      await expectProblem(
        world.session.submitDecision(stale, game.gameId, 1, 'retailer', { quantity: 9 }, newKey()),
        'forbidden',
      );
      const snapshot = await world.store.readSnapshot(game.gameId);
      const record = snapshot!.weekRecords.find((r) => r.week === 1 && r.role === 'retailer');
      expect(record?.decision).toBeNull();
      expect(record?.decidedByParticipantId).toBeNull();
    });

    it('Given 旧担当者が成功した識別子で入力済み / When 入れ替え後にその識別子を再送する / Then 403 forbidden（認可が先で、前回の結果を返さない）', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const stale = await world.access.authenticate(game.players.retailer.token);
      const key = newKey();
      await world.session.submitDecision(stale, game.gameId, 1, 'retailer', { quantity: 6 }, key);
      await world.session.replaceAssignee(game.facilitator, game.gameId, 'retailer', {
        participantId: game.players.retailer.participantId,
        displayName: '新人',
      });
      await expectProblem(
        world.session.submitDecision(stale, game.gameId, 1, 'retailer', { quantity: 6 }, key),
        'forbidden',
      );
    });
  });
});
