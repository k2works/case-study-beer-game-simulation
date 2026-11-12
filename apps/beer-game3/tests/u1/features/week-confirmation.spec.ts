import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/server/errors.js';
import { ROLES } from '../../../src/server/domain/types.js';
import { createWorld, newKey, type StartedGame, type World } from '../support/world.js';

async function expectProblem(promise: Promise<unknown>, kind: string): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).problem.kind).toBe(kind);
  return error as AppError;
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

describe('週の確定（US1.5）', () => {
  describe('AC1.5.1 入力がそろっていなければ確定できない', () => {
    it('Given 第 1 週で小売店の発注数だけが未入力 / When 週の確定を要求する / Then 拒否され、未入力の役割として小売店を示す', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      for (const role of ['factory', 'wholesaler1', 'wholesaler2'] as const) {
        await world.session.submitDecision(
          game.players[role].principal,
          game.gameId,
          1,
          role,
          { quantity: 4 },
          newKey(),
        );
      }
      const error = await expectProblem(
        world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey()),
        'state',
      );
      expect(error.problem.missingRoles).toEqual(['retailer']);
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot?.game.currentWeek).toBe(1);
    });
  });

  describe('AC1.5.2 入荷数の確認の操作は確定の条件ではない', () => {
    it('Given 4 役割すべての入力が済み、確認の操作をしていない / When 週の確定を要求する / Then 確定できる', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await inputAll(world, game, 1);
      const result = await world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey());
      expect(result.week).toBe(1);
      expect(result.currentWeek).toBe(2);
      expect(result.status).toBe('running');
    });
  });

  describe('週の計算の結果が保存と表示に反映される', () => {
    it('第 1 週の確定で、全役割の結果が記録され、次の週の入力が始まる', async () => {
      const world = createWorld();
      const game = await world.startedGame({ demandSeries: [8, 4, 4, 4, 4, 4] });
      const result = await world.playWeek(game, 1);
      const retailer = result.results.find((r) => r.role === 'retailer');
      // 在庫 12 + 入荷 4 - 受注 8 = 8
      expect(retailer).toMatchObject({
        receipt: 4,
        ordersReceived: 8,
        shipped: 8,
        inventory: 8,
        backlog: 0,
        weeklyCost: 400,
      });
      expect(result.teamCost).toBe(600 * 3 + 400);
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot?.game).toMatchObject({ currentWeek: 2, status: 'running' });
      expect(snapshot?.weekRecords.filter((r) => r.week === 2)).toHaveLength(4);
      expect(
        snapshot?.weekRecords.filter((r) => r.week === 2).every((r) => r.decision === null),
      ).toBe(true);
      // 第 2 週の画面は、前週末の在庫と履歴を示す
      const view = await world.session.getState(game.players.retailer.principal, game.gameId);
      expect(view.currentWeek).toBe(2);
      expect(view.mine).toMatchObject({
        inventory: 8,
        backlog: 0,
        receipt: 4,
        cumulativeCost: 400,
      });
      expect(view.mine?.history).toHaveLength(1);
      expect(view.mine?.history[0]).toMatchObject({ week: 1, shipped: 8, decision: 4 });
      expect(view.inputsDone).toBe(0);
    });

    it('既知系列（金額の累積）: 需要 4・4・4・4・8・8、全員 4 を発注する 6 週のゲーム', async () => {
      const world = createWorld();
      const game = await world.startedGame({ weekCount: 6, demandSeries: [4, 4, 4, 4, 8, 8] });
      const teamCosts: number[] = [];
      const retailerInventory: number[] = [];
      let last;
      for (let week = 1; week <= 6; week += 1) {
        last = await world.playWeek(game, week);
        teamCosts.push(last.teamCost);
        retailerInventory.push(last.results.find((r) => r.role === 'retailer')!.inventory);
      }
      expect(retailerInventory).toEqual([12, 12, 12, 12, 8, 4]);
      expect(teamCosts).toEqual([2400, 2400, 2400, 2400, 2200, 2000]);
      expect(last?.results.find((r) => r.role === 'retailer')?.cumulativeCost).toBe(
        600 * 4 + 400 + 200,
      );
      expect(last?.status).toBe('ended');
    });

    it('2 週の遅延: 第 1 週に小売店が 10 と発注すると、第 3 週に二次卸の受注になる', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.playWeek(game, 1, { retailer: 10 });
      await world.playWeek(game, 2, { retailer: 4 });
      const view = await world.session.getState(game.players.wholesaler2.principal, game.gameId);
      expect(view.currentWeek).toBe(3);
      expect(view.mine?.ordersReceived).toBe(10);
    });
  });

  describe('AC1.5.8 / BR5.7 確定の再送は結果を変えない', () => {
    it('Given 第 1 週の確定が完了している / When 同じ週の確定が同じ識別子でもう一度届く / Then 状態は変わらず、前回と同じ結果を返す', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await inputAll(world, game, 1);
      const key = newKey('confirm');
      const first = await world.session.confirmWeek(game.facilitator, game.gameId, 1, key);
      await world.playWeek(game, 2);
      const before = await world.store.readSnapshot(game.gameId);
      const replay = await world.session.confirmWeek(game.facilitator, game.gameId, 1, key);
      const after = await world.store.readSnapshot(game.gameId);
      expect(replay).toEqual(first);
      expect(after).toEqual(before);
    });

    it('同じ識別子で週が違う確定は 409 conflict', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await inputAll(world, game, 1);
      const key = newKey('confirm');
      await world.session.confirmWeek(game.facilitator, game.gameId, 1, key);
      await expectProblem(
        world.session.confirmWeek(game.facilitator, game.gameId, 2, key),
        'conflict',
      );
    });

    it('BR5.11 識別子が違う、確定済みの過去の週や未来の週の確定は 409 state（状態は変わらない）', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await world.playWeek(game, 1);
      await inputAll(world, game, 2);
      await expectProblem(
        world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey()),
        'state',
      );
      await expectProblem(
        world.session.confirmWeek(game.facilitator, game.gameId, 3, newKey()),
        'state',
      );
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot?.game.currentWeek).toBe(2);
    });

    it('準備中のゲームの確定は 409 state', async () => {
      const world = createWorld();
      const game = await world.createGame();
      await expectProblem(
        world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey()),
        'state',
      );
    });
  });

  describe('認可と識別子（BR1.5、BR4.8）', () => {
    it('参加者の token では確定できない。識別子の検査は認可のあと', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await inputAll(world, game, 1);
      await expectProblem(
        world.session.confirmWeek(game.players.retailer.principal, game.gameId, 1, newKey()),
        'forbidden',
      );
      await expectProblem(world.session.confirmWeek(null, game.gameId, 1, undefined), 'forbidden');
      await expectProblem(
        world.session.confirmWeek(game.facilitator, game.gameId, 1, undefined),
        'validation',
      );
      await expectProblem(
        world.session.confirmWeek(game.facilitator, game.gameId, 1, 'short'),
        'validation',
      );
    });
  });

  describe('BR5.10 最終週の確定でゲームが終了する', () => {
    it('Given 週数が 1 のゲーム / When 第 1 週を確定する / Then 終了になり、currentWeek は weekCount のまま', async () => {
      const world = createWorld();
      const game = await world.startedGame({ weekCount: 1 });
      const result = await world.playWeek(game, 1);
      expect(result.status).toBe('ended');
      expect(result.currentWeek).toBe(1);
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot?.game).toMatchObject({ status: 'ended', currentWeek: 1 });
      expect(snapshot?.game.endedAt).toEqual(world.clock.now());
      expect(snapshot?.weekRecords).toHaveLength(4);
    });

    it('終了後は入力も確定も受け付けず、同じ識別子の確定の再送だけが前回の結果を返す', async () => {
      const world = createWorld();
      const game = await world.startedGame({ weekCount: 2 });
      await world.playWeek(game, 1);
      await inputAll(world, game, 2);
      const key = newKey('final');
      const final = await world.session.confirmWeek(game.facilitator, game.gameId, 2, key);
      expect(final.status).toBe('ended');
      // 終了済みでも、同じ識別子の再送は前回の結果を返す（BR5.7）
      await expect(
        world.session.confirmWeek(game.facilitator, game.gameId, 2, key),
      ).resolves.toEqual(final);
      // 新しい識別子での最終週の確定は、409 state（U2 の BR7.1 で U1 の分岐を改めた。前回の結果は識別子が同じときだけ返す）
      const beforeRetry = await world.store.readSnapshot(game.gameId);
      await expectProblem(
        world.session.confirmWeek(game.facilitator, game.gameId, 2, newKey()),
        'state',
      );
      expect(await world.store.readSnapshot(game.gameId)).toEqual(beforeRetry);
      await expectProblem(
        world.session.submitDecision(
          game.players.retailer.principal,
          game.gameId,
          2,
          'retailer',
          { quantity: 4 },
          newKey(),
        ),
        'state',
      );
      const view = await world.session.getState(game.players.retailer.principal, game.gameId);
      expect(view.status).toBe('ended');
      expect(view.mine?.history).toHaveLength(2);
    });
  });

  describe('NFR2.1 / BR5.9 確定は 1 回の保存で行い、失敗したら確定前の状態のまま', () => {
    it('保存の途中で失敗したら、記録・枠・週の進行のどれも残らない', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await inputAll(world, game, 1);
      const before = await world.store.readSnapshot(game.gameId);
      const store = world.store as unknown as { failNextWriteOn?: string };
      store.failNextWriteOn = 'replaceSlots';
      await expectProblem(
        world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey()),
        'internal',
      );
      const after = await world.store.readSnapshot(game.gameId);
      expect(after).toEqual(before);
      // 失敗のあとで、同じ操作をやり直せる
      await expect(
        world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey()),
      ).resolves.toBeDefined();
    });
  });

  describe('NFR2.2 版の検査（安全装置）', () => {
    it('版が食い違う保存は拒否する', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const outcome = await world.store
        .transact(game.gameId, async (tx) =>
          tx.updateGame({ status: 'ended' }, tx.game().version + 1, []),
        )
        .then(
          () => 'saved',
          (error: Error) => error.name,
        );
      expect(outcome).toBe('VersionConflictError');
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot?.game.status).toBe('preparing');
    });

    it('保存のたびに版が 1 増える', async () => {
      const world = createWorld();
      const game = await world.createGame();
      const version0 = (await world.store.readSnapshot(game.gameId))!.game.version;
      const taro = await world.joinOne(game.joinCode, '太郎');
      await world.session.assignRole(game.facilitator, game.gameId, taro.participantId, 'factory');
      const version1 = (await world.store.readSnapshot(game.gameId))!.game.version;
      expect(version1).toBeGreaterThan(version0);
    });
  });

  describe('NFR2.3 / BR4.6 同時の確定でも週は一度だけ確定され、別のゲームは待たされない', () => {
    it('同じ週の確定を同時に 2 つ要求しても、確定は 1 回だけ（片方は 409 または同じ結果）', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await inputAll(world, game, 1);
      const outcomes = await Promise.allSettled([
        world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey('a')),
        world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey('b')),
      ]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
      expect((rejected.reason as AppError).problem.kind).toBe('state');
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot?.game.currentWeek).toBe(2);
    });

    it('同じ識別子の同時の確定は、どちらも同じ結果を返し、一度だけ確定する', async () => {
      const world = createWorld();
      const game = await world.startedGame();
      await inputAll(world, game, 1);
      const key = newKey('same');
      const [a, b] = await Promise.all([
        world.session.confirmWeek(game.facilitator, game.gameId, 1, key),
        world.session.confirmWeek(game.facilitator, game.gameId, 1, key),
      ]);
      expect(a).toEqual(b);
      expect((await world.store.readSnapshot(game.gameId))!.game.currentWeek).toBe(2);
    });

    it('NFR3.7 順番待ちが上限を超えたら unavailable（503）で返す', async () => {
      const world = createWorld({ lockTimeoutMs: 50 });
      const game = await world.startedGame();
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = world.store.transact(game.gameId, async () => {
        await hold;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await expectProblem(
        world.session.submitDecision(
          game.players.retailer.principal,
          game.gameId,
          1,
          'retailer',
          { quantity: 4 },
          newKey(),
        ),
        'unavailable',
      );
      release();
      await holder;
      // 解放後は処理できる
      await expect(
        world.session.submitDecision(
          game.players.retailer.principal,
          game.gameId,
          1,
          'retailer',
          { quantity: 4 },
          newKey(),
        ),
      ).resolves.toBeDefined();
    });

    it('NFR4.2 / NFR4.4 別のゲームの処理は待たされず、読み取りは書き込みの占有に待たされない', async () => {
      const world = createWorld({ lockTimeoutMs: 50 });
      const a = await world.startedGame();
      const b = await world.startedGame();
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = world.store.transact(a.gameId, async () => {
        await hold;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(
        world.session.submitDecision(
          b.players.retailer.principal,
          b.gameId,
          1,
          'retailer',
          { quantity: 4 },
          newKey(),
        ),
      ).resolves.toBeDefined();
      await expect(
        world.session.getState(a.players.retailer.principal, a.gameId),
      ).resolves.toBeDefined();
      release();
      await holder;
    });
  });

  describe('NFR3.3 週の確定の処理時間', () => {
    it('50 週のゲームの後半の週でも、確定の処理は 500 ミリ秒以内（メモリ上の保存での目安）', async () => {
      const world = createWorld();
      const game = await world.startedGame({ weekCount: 50 });
      for (let week = 1; week <= 49; week += 1) {
        await world.playWeek(game, week);
      }
      await inputAll(world, game, 50);
      const started = performance.now();
      await world.session.confirmWeek(game.facilitator, game.gameId, 50, newKey());
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(500);
      // NFR4.3: 保存の大きさは 50 週 × 4 役割の記録で上限が決まる
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot?.weekRecords).toHaveLength(200);
    });
  });
});
