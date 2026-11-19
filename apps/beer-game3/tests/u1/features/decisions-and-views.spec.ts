import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/server/errors.js';
import { ROLES } from '../../../src/server/domain/types.js';
import { createWorld, newKey } from '../support/world.js';

async function expectProblem(promise: Promise<unknown>, kind: string): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).problem.kind).toBe(kind);
  return error as AppError;
}

describe('入力と役割別の見せ方（US1.4）', () => {
  describe('AC1.4.1 他の役割の情報は返さない', () => {
    it('Given 小売店の参加者 / When 他役割の在庫を取得する要求を直接送る / Then 拒否され、値は返らない', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const retailer = game.players.retailer.principal;
      // 他の役割への入力は 403
      await expectProblem(
        world.session.submitDecision(
          retailer,
          game.gameId,
          1,
          'factory',
          { quantity: 5 },
          newKey(),
        ),
        'forbidden',
      );
      // 他のゲームの識別子を指定した要求も 403
      const other = await world.createGame();
      await expectProblem(world.session.getState(retailer, other.gameId), 'forbidden');
      // 無資格の要求も 403
      await expectProblem(world.session.getState(null, game.gameId), 'forbidden');
    });

    it('応答は自分の役割の投影だけで、他役割の値と将来の需要を含まない', async () => {
      const world = createWorld();
      const game = await world.startedGame({ demandSeries: [7, 8, 9, 1, 2, 3] });
      const view = await world.session.getState(game.players.wholesaler1.principal, game.gameId);
      const text = JSON.stringify(view);
      expect(view.viewerKind).toBe('participant');
      expect(view.role).toBe('wholesaler1');
      expect(view.mine?.role).toBe('wholesaler1');
      expect(view).not.toHaveProperty('roles');
      expect(view).not.toHaveProperty('assignments');
      expect(view).not.toHaveProperty('demandSeries');
      expect(text).not.toContain('wholesaler2');
      expect(text).not.toContain('retailer');
      expect(text).not.toContain('factory');
      // 一次卸には顧客需要の値は出ない（小売店だけが当週の需要を見る）
      expect(view.mine?.ordersReceived).toBe(4);
    });

    it('小売店は当週の顧客需要だけを受注として見る（将来の需要は見ない）', async () => {
      const world = createWorld();
      const game = await world.startedGame({ demandSeries: [7, 8, 9, 1, 2, 3] });
      const view = await world.session.getState(game.players.retailer.principal, game.gameId);
      expect(view.mine?.ordersReceived).toBe(7);
      const text = JSON.stringify(view);
      expect(text).not.toContain('8,9');
    });

    it('他の役割の入力状況は、入力済みの数だけを返す', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.session.submitDecision(
        game.players.factory.principal,
        game.gameId,
        1,
        'factory',
        { quantity: 6 },
        newKey(),
      );
      const view = await world.session.getState(game.players.retailer.principal, game.gameId);
      expect(view.inputsDone).toBe(1);
      expect(view.mine?.decision).toBeNull();
      // 進行役には役割別に示す
      const facilitatorView = await world.session.getState(game.facilitator, game.gameId);
      expect(facilitatorView.roles?.factory.decided).toBe(true);
      expect(facilitatorView.missingInputRoles).toEqual(['wholesaler1', 'wholesaler2', 'retailer']);
    });
  });

  describe('AC1.4.2 不正な入力は拒否する', () => {
    it.each([
      ['小数', 2.5],
      ['負数', -1],
      ['空欄', ''],
      ['文字', 'abc'],
      ['未指定', undefined],
      ['null', null],
      ['上限超過', 10000],
      ['非常に大きい数', 1e21],
    ])(
      'Given 発注数の入力欄 / When %s を入力する / Then 拒否され、入力済みの他の値は残る',
      async (_label, quantity) => {
        const world = createWorld();
        const game = await world.startedGame();
        const factory = game.players.factory.principal;
        await world.session.submitDecision(
          factory,
          game.gameId,
          1,
          'factory',
          { quantity: 5 },
          newKey(),
        );
        const error = await expectProblem(
          world.session.submitDecision(
            game.players.retailer.principal,
            game.gameId,
            1,
            'retailer',
            { quantity },
            newKey(),
          ),
          'validation',
        );
        expect(error.problem.fields?.[0]?.path).toBe('quantity');
        expect(error.problem.hint).toContain('9999');
        const view = await world.session.getState(factory, game.gameId);
        expect(view.mine?.decision).toBe(5);
      },
    );
  });

  describe('AC1.4.3 0 は有効な入力', () => {
    it('Given 同じ入力欄 / When 0 を入力する / Then 受け付ける', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.session.submitDecision(
        game.players.retailer.principal,
        game.gameId,
        1,
        'retailer',
        { quantity: 0 },
        newKey(),
      );
      const view = await world.session.getState(game.players.retailer.principal, game.gameId);
      expect(view.mine?.decision).toBe(0);
      expect(view.inputsDone).toBe(1);
    });

    it('上限の 9999 は受け付ける', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await expect(
        world.session.submitDecision(
          game.players.retailer.principal,
          game.gameId,
          1,
          'retailer',
          { quantity: 9999 },
          newKey(),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('AC1.4.4 確定前は上書きできる', () => {
    it('Given 第 1 週で発注数 10 を入力済みで、まだ週が確定していない / When 12 に変更する / Then 12 が有効になる', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const retailer = game.players.retailer.principal;
      await world.session.submitDecision(
        retailer,
        game.gameId,
        1,
        'retailer',
        { quantity: 10 },
        newKey(),
      );
      await world.session.submitDecision(
        retailer,
        game.gameId,
        1,
        'retailer',
        { quantity: 12 },
        newKey(),
      );
      const view = await world.session.getState(retailer, game.gameId);
      expect(view.mine?.decision).toBe(12);
      expect(view.inputsDone).toBe(1);
    });
  });

  describe('BR4.5 入力は進行中のゲームの当週に対してだけ', () => {
    it('当週でない週・準備中のゲームへの入力は 409 state', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const retailer = game.players.retailer.principal;
      await expectProblem(
        world.session.submitDecision(
          retailer,
          game.gameId,
          2,
          'retailer',
          { quantity: 4 },
          newKey(),
        ),
        'state',
      );
      const preparing = await world.createGame();
      const taro = await world.joinOne(preparing.joinCode, '太郎');
      await world.session.assignRole(
        preparing.facilitator,
        preparing.gameId,
        taro.participantId,
        'retailer',
      );
      const principal = await world.as(taro.token);
      await expectProblem(
        world.session.submitDecision(
          principal,
          preparing.gameId,
          1,
          'retailer',
          { quantity: 4 },
          newKey(),
        ),
        'state',
      );
    });

    it('役割が未割当ての参加者は入力できない', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const taro = await world.joinOne(game.joinCode, '太郎');
      await expectProblem(
        world.session.submitDecision(
          taro.principal,
          game.gameId,
          1,
          'retailer',
          { quantity: 4 },
          newKey(),
        ),
        'forbidden',
      );
    });
  });

  describe('BR4.7 / BR4.8 再送と判定の順（認可、再送、状態、検証）', () => {
    it('Idempotency-Key が無い・短すぎる・長すぎるときは 422（認可のあと）', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const retailer = game.players.retailer.principal;
      for (const key of [undefined, 'short', 'x'.repeat(129)]) {
        const error = await expectProblem(
          world.session.submitDecision(retailer, game.gameId, 1, 'retailer', { quantity: 4 }, key),
          'validation',
        );
        expect(error.problem.fields?.[0]?.path).toBe('Idempotency-Key');
      }
      // 認可が先: 権限のない人は、識別子が欠けていても forbidden
      await expectProblem(
        world.session.submitDecision(
          retailer,
          game.gameId,
          1,
          'factory',
          { quantity: 4 },
          undefined,
        ),
        'forbidden',
      );
    });

    it('同じ識別子・同じ内容の再送は前回の結果を返し、重複して処理しない', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const retailer = game.players.retailer.principal;
      const key = newKey('retry');
      const first = await world.session.submitDecision(
        retailer,
        game.gameId,
        1,
        'retailer',
        { quantity: 7 },
        key,
      );
      // 間に別の入力が入っても、再送は前回の結果を返し、値を巻き戻さない
      await world.session.submitDecision(
        retailer,
        game.gameId,
        1,
        'retailer',
        { quantity: 9 },
        newKey(),
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
      const view = await world.session.getState(retailer, game.gameId);
      expect(view.mine?.decision).toBe(9);
    });

    it('同じ識別子で内容が違う再送は 409 conflict', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const retailer = game.players.retailer.principal;
      const key = newKey('retry');
      await world.session.submitDecision(
        retailer,
        game.gameId,
        1,
        'retailer',
        { quantity: 7 },
        key,
      );
      await expectProblem(
        world.session.submitDecision(retailer, game.gameId, 1, 'retailer', { quantity: 8 }, key),
        'conflict',
      );
    });

    it('別の人の記録の結果は返さない（呼び出した人ごとに照合する）', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const key = newKey('shared');
      const a = await world.session.submitDecision(
        game.players.retailer.principal,
        game.gameId,
        1,
        'retailer',
        { quantity: 7 },
        key,
      );
      const b = await world.session.submitDecision(
        game.players.factory.principal,
        game.gameId,
        1,
        'factory',
        { quantity: 7 },
        key,
      );
      expect(a.role).toBe('retailer');
      expect(b.role).toBe('factory');
    });

    it('確定後に遅れて届いた入力の再送は、409 にせず前回の結果を返す（再送の照合が状態の検査より先）', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const key = newKey('late');
      const first = await world.session.submitDecision(
        game.players.retailer.principal,
        game.gameId,
        1,
        'retailer',
        { quantity: 4 },
        key,
      );
      for (const role of ROLES.filter((r) => r !== 'retailer')) {
        await world.session.submitDecision(
          game.players[role].principal,
          game.gameId,
          1,
          role,
          { quantity: 4 },
          newKey(),
        );
      }
      await world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey());
      const replay = await world.session.submitDecision(
        game.players.retailer.principal,
        game.gameId,
        1,
        'retailer',
        { quantity: 4 },
        key,
      );
      expect(replay).toEqual(first);
      // 同じ週への新しい識別子の入力は、状態の検査で 409
      await expectProblem(
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
    });

    it('状態の検査は入力の検証より先（当週でない週への不正な値は state）', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await expectProblem(
        world.session.submitDecision(
          game.players.retailer.principal,
          game.gameId,
          3,
          'retailer',
          { quantity: -1 },
          newKey(),
        ),
        'state',
      );
    });
  });

  describe('NFR5.1 / BR4.4 入力は入力した時点で保存する', () => {
    it('入力の直後に別の画面（別の読み取り）で見える', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.session.submitDecision(
        game.players.retailer.principal,
        game.gameId,
        1,
        'retailer',
        { quantity: 6 },
        newKey(),
      );
      const snapshot = await world.store.readSnapshot(game.gameId);
      const record = snapshot?.weekRecords.find((r) => r.role === 'retailer' && r.week === 1);
      expect(record?.decision).toBe(6);
      expect(record?.isConfirmed).toBe(false);
    });

    it('入力のたびに GameStateView.version が増え、画面が差分を検出できる', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const before = await world.session.getState(game.players.retailer.principal, game.gameId);
      await world.session.submitDecision(
        game.players.factory.principal,
        game.gameId,
        1,
        'factory',
        { quantity: 6 },
        newKey(),
      );
      const after = await world.session.getState(game.players.retailer.principal, game.gameId);
      expect(after.version).toBeGreaterThan(before.version);
      expect(after.inputsDone).toBe(before.inputsDone + 1);
    });
  });
});
