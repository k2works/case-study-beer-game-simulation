import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/server/errors.js';
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

describe('ゲームの作成（US1.1）', () => {
  describe('AC1.1.1 週数は 1〜50', () => {
    it.each([0, 51, 2.5, -3])(
      'Given 進行役がゲーム作成画面を開いている / When 週数に %s を入力して保存する / Then 範囲外として拒否し、1〜50 を案内する',
      async (weekCount) => {
        const world = createWorld();
        const error = await expectProblem(
          world.session.createGame({ name: 'テスト', weekCount }),
          'validation',
        );
        expect(error.problem.fields?.map((f) => f.path)).toContain('weekCount');
        expect(error.problem.hint).toContain('1〜50');
      },
    );

    it('1 と 50 は受け付ける', async () => {
      const world = createWorld();
      await expect(world.createGame({ weekCount: 1 })).resolves.toBeDefined();
      await expect(world.createGame({ weekCount: 50 })).resolves.toBeDefined();
    });

    it('拒否のとき、他の項目の誤りも同時に示し、ゲームは作られない', async () => {
      const world = createWorld();
      const error = await expectProblem(
        world.session.createGame({ name: '', weekCount: 0, initialInventory: -1 }),
        'validation',
      );
      expect(error.problem.fields?.map((f) => f.path).sort()).toEqual([
        'initialInventory',
        'name',
        'weekCount',
      ]);
    });
  });

  describe('AC1.1.2 需要系列の長さは週数と同じ', () => {
    it('Given 週数 50 のゲーム設定 / When 需要系列を 49 週分だけ入力して保存する / Then 長さ不一致として拒否する', async () => {
      const world = createWorld();
      const error = await expectProblem(
        world.session.createGame({
          name: 'テスト',
          weekCount: 50,
          demandSeries: Array.from({ length: 49 }, () => 4),
        }),
        'validation',
      );
      expect(error.problem.fields?.[0]?.path).toBe('demandSeries');
      expect(error.problem.reason).toContain('50');
    });

    it('負数・小数の値は拒否する', async () => {
      const world = createWorld();
      await expectProblem(
        world.session.createGame({ name: 'テスト', weekCount: 3, demandSeries: [4, -1, 4] }),
        'validation',
      );
      await expectProblem(
        world.session.createGame({ name: 'テスト', weekCount: 3, demandSeries: [4, 2.5, 4] }),
        'validation',
      );
    });
  });

  describe('AC1.1.3 初期値は非負の整数で、遅延の週数は設定できない', () => {
    it('Given 進行役が初期在庫に負数を入力する / When 保存する / Then 拒否し、非負の整数を案内する', async () => {
      const world = createWorld();
      const error = await expectProblem(
        world.session.createGame({ name: 'テスト', weekCount: 5, initialInventory: -1 }),
        'validation',
      );
      expect(error.problem.hint).toContain('0 以上の整数');
    });

    it('初期パイプライン数量の項目があり、負数は拒否する', async () => {
      const world = createWorld();
      await expectProblem(
        world.session.createGame({ name: 'テスト', weekCount: 5, initialPipelineQuantity: -2 }),
        'validation',
      );
      const game = await world.createGame({ initialPipelineQuantity: 7 });
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot?.settings.initialPipelineQuantity).toBe(7);
    });

    it('遅延の週数を設定する項目は受け付けない', async () => {
      const world = createWorld();
      const error = await expectProblem(
        world.session.createGame({ name: 'テスト', weekCount: 5, deliveryDelayWeeks: 3 }),
        'validation',
      );
      expect(error.problem.fields?.[0]?.path).toBe('deliveryDelayWeeks');
    });
  });

  describe('AC1.1.4 正しい設定でゲームが作られ、推測困難なコードが発行される', () => {
    it('Given 正しい設定 / When 保存する / Then 準備中のゲームと 3 種類のコードが発行される', async () => {
      const world = createWorld();
      const created = await world.session.createGame({ name: '授業用', weekCount: 12 });
      expect(created.status).toBe('preparing');
      expect(created.currentWeek).toBe(1);
      expect(created.weekCount).toBe(12);
      // NFR6.1: 参加コードは 8 文字以上の英数字、他は 128 ビット以上
      expect(created.codes.joinCode).toMatch(/^[A-Z0-9]{8,}$/);
      const facilitatorSecret = created.codes.facilitatorCode.replace(/^fac_/, '');
      const observerSecret = created.codes.observerCode.replace(/^obs_/, '');
      expect(Buffer.from(facilitatorSecret, 'base64url').length).toBeGreaterThanOrEqual(16);
      expect(Buffer.from(observerSecret, 'base64url').length).toBeGreaterThanOrEqual(16);
      expect(new Set([created.codes.joinCode, created.codes.facilitatorCode]).size).toBe(2);
    });

    it('コードは重ならず、ゲームごとに違う', async () => {
      const world = createWorld();
      const a = await world.createGame();
      const b = await world.createGame();
      expect(a.joinCode).not.toBe(b.joinCode);
      expect(a.facilitatorCode).not.toBe(b.facilitatorCode);
    });

    it('BR1.7 種別は常にカスタム、BR1.6 需要系列が無ければ仮の既定（週 1〜4 は 4、週 5 以降は 8）', async () => {
      const world = createWorld();
      const game = await world.createGame({ weekCount: 6 });
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot?.game.setupKind).toBe('custom');
      expect(snapshot?.settings.isProvisionalDefault).toBe(true);
      expect(snapshot?.settings.demandSeries).toEqual([4, 4, 4, 4, 8, 8]);
    });

    it('指定した需要系列はそのまま保存し、仮の既定ではない', async () => {
      const world = createWorld();
      const game = await world.createGame({ weekCount: 3, demandSeries: [1, 2, 3] });
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot?.settings.demandSeries).toEqual([1, 2, 3]);
      expect(snapshot?.settings.isProvisionalDefault).toBe(false);
    });

    it('BR1.8 既定の初期値と単価は整数の最小単位（初期在庫 12・パイプライン 4・50 と 100）', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const settings = (await world.store.readSnapshot(game.gameId))?.settings;
      expect(settings).toMatchObject({
        initialInventory: 12,
        initialPipelineQuantity: 4,
        inventoryUnitCost: 50,
        backlogUnitCost: 100,
      });
    });

    it('NFR6.3 保存された値から平文のコードを復元できない（進行役用コードはハッシュのみ）', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const facilitator = await world.store.getAccessCode(game.gameId, 'facilitator');
      const join = await world.store.getAccessCode(game.gameId, 'join');
      expect(facilitator?.codeHash).not.toContain(game.facilitatorCode);
      expect(facilitator?.codeSealed).toBeNull();
      expect(join?.codeHash).not.toContain(game.joinCode);
      expect(join?.codeSealed).not.toBeNull();
      expect(join?.codeSealed).not.toContain(game.joinCode);
    });

    it('BR1.4 参加コードと観察者用コードは進行役が何度でも見られ、進行役用コードは再表示しない', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const first = await world.session.getCodes(game.facilitator, game.gameId);
      const second = await world.session.getCodes(game.facilitator, game.gameId);
      expect(first).toEqual({ joinCode: game.joinCode, observerCode: game.observerCode });
      expect(second).toEqual(first);
      expect(JSON.stringify(first)).not.toContain(game.facilitatorCode);
    });
  });

  describe('AC1.1.5 参加コードだけでは進行役の操作ができない', () => {
    it('Given 参加コードだけを持つ人 / When 進行役の操作を要求する / Then 権限がないとして拒否される', async () => {
      const world = createWorld();
      const game = await world.createGame();
      // 参加コードは資格情報として使えない（参加の入口にだけ使う）
      await expect(world.access.authenticate(game.joinCode)).resolves.toBeNull();
      await expectProblem(world.session.startGame(null, game.gameId), 'forbidden');
      // 参加者の token でも進行役の操作はできない
      const player = await world.joinOne(game.joinCode, '太郎');
      await expectProblem(world.session.startGame(player.principal, game.gameId), 'forbidden');
      await expectProblem(world.session.getCodes(player.principal, game.gameId), 'forbidden');
    });

    it('別のゲームの進行役用コードでは操作できない', async () => {
      const world = createWorld();
      const a = await world.createGame();
      const b = await world.createGame();
      await expectProblem(world.session.getCodes(b.facilitator, a.gameId), 'forbidden');
    });
  });
});
