import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/server/errors.js';
import { ROLES } from '../../../src/server/domain/types.js';
import { createWorld } from '../support/world.js';

async function expectProblem(promise: Promise<unknown>, kind: string): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).problem.kind).toBe(kind);
  return error as AppError;
}

describe('参加（US1.2）', () => {
  describe('AC1.2.1 準備中のゲームに参加する', () => {
    it('Given 準備中のゲームの有効な参加コード / When 参加者が表示名を入力して参加する / Then ロビーの一覧に表示名が加わり、token が発行される', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const joined = await world.session.joinGame({ joinCode: game.joinCode, displayName: '太郎' });
      expect(joined.joinOrder).toBe(1);
      expect(joined.token).toMatch(/^tok_/);
      const state = await world.session.getState(game.facilitator, game.gameId);
      expect(state.participants.map((p) => p.displayName)).toEqual(['太郎']);
      // 保存されるのは token のハッシュだけ（BR2.6）
      const resolved = await world.store.findTokenByHash(joined.token);
      expect(resolved).toBeNull();
    });

    it('参加コードは大文字小文字・ハイフン・空白を区別せずに受け付ける', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const sloppy = ` ${game.joinCode.slice(0, 4).toLowerCase()}-${game.joinCode.slice(4)} `;
      await expect(
        world.session.joinGame({ joinCode: sloppy, displayName: '次郎' }),
      ).resolves.toBeDefined();
    });

    it('同じ表示名の参加者を許し、参加順の番号で区別する（BR2.5）', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const a = await world.joinOne(game.joinCode, '太郎');
      const b = await world.joinOne(game.joinCode, '太郎');
      expect([a.joinOrder, b.joinOrder]).toEqual([1, 2]);
      expect(a.participantId).not.toBe(b.participantId);
    });

    it.each(['', '   ', 'あ'.repeat(41)])(
      '表示名 %j は拒否する（1〜40 文字）',
      async (displayName) => {
        const world = createWorld();
        const game = await world.createGame();
        const error = await expectProblem(
          world.session.joinGame({ joinCode: game.joinCode, displayName }),
          'validation',
        );
        expect(error.problem.fields?.[0]?.path).toBe('displayName');
      },
    );

    it('40 文字ちょうどの表示名は受け付け、HTML に見える文字列もそのまま保存する（出力時にエスケープ）', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const name = '<script>alert(1)</script>';
      const joined = await world.joinOne(game.joinCode, name);
      expect(joined.displayName).toBe(name);
      await expect(world.joinOne(game.joinCode, 'あ'.repeat(40))).resolves.toBeDefined();
    });
  });

  describe('AC1.2.2 終了済みのゲームには参加できない', () => {
    it('Given 終了済みのゲームの参加コード / When 参加を試みる / Then 「終了済み」という理由で拒否される', async () => {
      const world = createWorld();
      const game = await world.startedGame({ weekCount: 1 });
      await world.playWeek(game, 1);
      const error = await expectProblem(
        world.session.joinGame({ joinCode: game.joinCode, displayName: '遅刻' }),
        'state',
      );
      expect(error.problem.reason).toContain('終了済み');
    });
  });

  describe('AC1.2.3 進行中のゲームには新しい人は参加できない', () => {
    it('Given 進行中のゲームの参加コード / When 新しい人が参加を試みる / Then 「進行中のため参加できない」という理由で拒否される', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      const error = await expectProblem(
        world.session.joinGame({ joinCode: game.joinCode, displayName: '新人' }),
        'state',
      );
      expect(error.problem.reason).toContain('進行中のため参加できない');
    });
  });

  describe('AC1.2.4 無効なコードでは参加できない', () => {
    it('Given 無効なコード / When 参加を試みる / Then 拒否され、理由が示される。存在しないコードも失敗の形は同じ', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const unknown = await expectProblem(
        world.session.joinGame({ joinCode: 'ZZZZZZZZ99', displayName: '太郎' }),
        'forbidden',
      );
      const garbage = await expectProblem(
        world.session.joinGame({ joinCode: '!!', displayName: '太郎' }),
        'forbidden',
      );
      expect(unknown.problem.reason).toContain('参加コード');
      expect(garbage.problem).toEqual(unknown.problem);
      // 進行役用コードは参加には使えない
      await expectProblem(
        world.session.joinGame({ joinCode: game.facilitatorCode, displayName: '太郎' }),
        'forbidden',
      );
    });

    it('コードが欠けた要求は 422 の validation', async () => {
      const world = createWorld();
      await expectProblem(world.session.joinGame({ displayName: '太郎' }), 'validation');
      await expectProblem(world.session.joinGame('not-an-object'), 'validation');
    });
  });
});

describe('役割の割当てと開始（US1.3）', () => {
  describe('AC1.3.1 4 役割がそろっていなければ開始できない', () => {
    it('Given 4 役割のうち 1 つが未割当て / When 進行役がゲームを開始する / Then 開始できず、未割当ての役割を示す', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const players = await Promise.all(
        ['A', 'B', 'C'].map((name) => world.joinOne(game.joinCode, name)),
      );
      await world.session.assignRole(
        game.facilitator,
        game.gameId,
        players[0]!.participantId,
        'factory',
      );
      await world.session.assignRole(
        game.facilitator,
        game.gameId,
        players[1]!.participantId,
        'wholesaler1',
      );
      await world.session.assignRole(
        game.facilitator,
        game.gameId,
        players[2]!.participantId,
        'retailer',
      );
      const error = await expectProblem(
        world.session.startGame(game.facilitator, game.gameId),
        'state',
      );
      expect(error.problem.missingRoles).toEqual(['wholesaler2']);
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot?.game.status).toBe('preparing');
    });

    it('参加者がいなければ 4 役割すべてが未割当てとして示される', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const error = await expectProblem(
        world.session.startGame(game.facilitator, game.gameId),
        'state',
      );
      expect(error.problem.missingRoles).toEqual([...ROLES]);
    });
  });

  describe('AC1.3.2 準備中は役割を移せる', () => {
    it('Given ゲームが準備中 / When 進行役が参加者を別の役割へ移す / Then 変更できる', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const taro = await world.joinOne(game.joinCode, '太郎');
      await world.session.assignRole(game.facilitator, game.gameId, taro.participantId, 'factory');
      await world.session.assignRole(game.facilitator, game.gameId, taro.participantId, 'retailer');
      const state = await world.session.getState(game.facilitator, game.gameId);
      expect(state.assignments).toEqual([{ participantId: taro.participantId, role: 'retailer' }]);
      // 未割当てに戻すこともできる
      await world.session.assignRole(game.facilitator, game.gameId, taro.participantId, null);
      const after = await world.session.getState(game.facilitator, game.gameId);
      expect(after.assignments).toEqual([]);
    });

    it('1 つの役割の定員は 4 人。5 人目は拒否する', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const players = [];
      for (let i = 0; i < 5; i += 1) {
        players.push(await world.joinOne(game.joinCode, `P${i}`));
      }
      for (const player of players.slice(0, 4)) {
        await world.session.assignRole(
          game.facilitator,
          game.gameId,
          player.participantId,
          'retailer',
        );
      }
      const error = await expectProblem(
        world.session.assignRole(
          game.facilitator,
          game.gameId,
          players[4]!.participantId,
          'retailer',
        ),
        'state',
      );
      expect(error.problem.reason).toContain('4 人');
      // すでに就いている役割への再割当ては定員に数えない
      await expect(
        world.session.assignRole(
          game.facilitator,
          game.gameId,
          players[0]!.participantId,
          'retailer',
        ),
      ).resolves.toBeUndefined();
    });

    it('存在しない役割・参加者は拒否する。進行役でない人は割り当てられない（AC1.1.5）', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const taro = await world.joinOne(game.joinCode, '太郎');
      await expectProblem(
        world.session.assignRole(game.facilitator, game.gameId, taro.participantId, 'manager'),
        'validation',
      );
      await expectProblem(
        world.session.assignRole(
          game.facilitator,
          game.gameId,
          '00000000-0000-4000-8000-000000000000',
          'factory',
        ),
        'not_found',
      );
      await expectProblem(
        world.session.assignRole(taro.principal, game.gameId, taro.participantId, 'factory'),
        'forbidden',
      );
    });

    it('準備中でないと割り当てられない（担当者の入れ替えは U3）', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await expectProblem(
        world.session.assignRole(
          game.facilitator,
          game.gameId,
          game.players.retailer.participantId,
          'factory',
        ),
        'state',
      );
    });
  });

  describe('AC1.3.3 4 役割がそろえば開始でき、初期状態が固定される', () => {
    it('Given 4 役割がすべて割り当て済み / When 進行役が開始する / Then 進行中になり、第 1 週が始まり、初期状態が固定される', async () => {
      const world = createWorld();
      const game = await world.startedGame({ initialInventory: 10, initialPipelineQuantity: 3 });
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot?.game).toMatchObject({ status: 'running', currentWeek: 1 });
      // 第 1 週の記録は役割ごとに作られ、決定以外は未確定
      expect(snapshot?.weekRecords).toHaveLength(4);
      for (const record of snapshot?.weekRecords ?? []) {
        expect(record).toMatchObject({
          week: 1,
          decision: null,
          isConfirmed: false,
          inventory: null,
        });
      }
      // 遅延の枠: 配送 3 役割、注文 3 役割、生産 1 つの各 2 枠（remainingWeeks 1 と 2）
      expect(snapshot?.slots).toHaveLength((3 + 3 + 1) * 2);
      expect(snapshot?.slots.every((slot) => slot.quantity === 3)).toBe(true);
      expect(snapshot?.slots.filter((s) => s.kind === 'production').map((s) => s.role)).toEqual([
        'factory',
        'factory',
      ]);
    });

    it('開始済みのゲームは、もう一度開始できない', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await expectProblem(world.session.startGame(game.facilitator, game.gameId), 'state');
    });

    it('同じ役割に複数人が就いていても開始できる', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const players = await world.populate(game);
      const extra = await world.joinOne(game.joinCode, '補助');
      await world.session.assignRole(
        game.facilitator,
        game.gameId,
        extra.participantId,
        'retailer',
      );
      await expect(world.session.startGame(game.facilitator, game.gameId)).resolves.toBeDefined();
      expect(players.retailer.participantId).not.toBe(extra.participantId);
    });
  });
});
