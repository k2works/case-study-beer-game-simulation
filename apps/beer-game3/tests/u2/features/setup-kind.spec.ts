import { describe, expect, it } from 'vitest';
import { ROLES } from '../../../src/server/domain/types.js';
import { createWorld } from '../../u1/support/world.js';
import { TEST_PRESET } from '../support/test-preset.js';

const kitSettings = {
  name: 'キット準拠',
  weekCount: TEST_PRESET.weekCount,
  initialInventory: TEST_PRESET.initialInventory,
  initialPipelineQuantity: TEST_PRESET.initialPipelineQuantity,
  inventoryUnitCost: TEST_PRESET.inventoryUnitCost,
  backlogUnitCost: TEST_PRESET.backlogUnitCost,
  demandSeries: [...(TEST_PRESET.demandSeries ?? [])],
};

describe('ゲームの種別（US1.6）', () => {
  describe('AC1.6.1 / BR6.1 需要系列を指定しない', () => {
    it('Given 需要系列を指定しない / When 作成する / Then 仮の既定の系列が入り、custom になる（プリセットと他の値が同じでも）', async () => {
      const world = createWorld({ kitPreset: TEST_PRESET });
      const created = await world.session.createGame({
        name: '系列なし',
        weekCount: 50,
      });
      expect(created.setupKind).toBe('custom');
      const snapshot = await world.store.readSnapshot(created.gameId);
      expect(snapshot?.settings.isProvisionalDefault).toBe(true);
      expect(snapshot?.settings.demandSeries.slice(0, 5)).toEqual([4, 4, 4, 4, 8]);
      expect(snapshot?.game.setupKind).toBe('custom');
    });
  });

  describe('AC1.6.2 / BR6.2 JSD の既定の需要系列が未提供の間', () => {
    it('Given 実際の KitPreset（需要系列は未提供）/ When キットと同じ値で作成する / Then custom で、キット準拠とは表示されない', async () => {
      const world = createWorld();
      const game = await world.startedGame({ ...kitSettings });
      const view = await world.session.getState(game.facilitator, game.gameId);
      expect(view.setupKind).toBe('custom');
    });
  });

  describe('AC1.6.3 / BR6.3 全項目が一致するときだけ kit', () => {
    it('Given 試験用のプリセットの全項目（仮の系列を含む）と一致する設定 / When 作成する / Then kit で保存される', async () => {
      const world = createWorld({ kitPreset: TEST_PRESET });
      const created = await world.session.createGame({ ...kitSettings });
      expect(created.setupKind).toBe('kit');
      const snapshot = await world.store.readSnapshot(created.gameId);
      expect(snapshot?.game.setupKind).toBe('kit');
    });

    it('Given 1 項目だけ違う設定 / When 作成する / Then custom', async () => {
      const world = createWorld({ kitPreset: TEST_PRESET });
      const created = await world.session.createGame({ ...kitSettings, backlogUnitCost: 101 });
      expect(created.setupKind).toBe('custom');
    });
  });

  describe('AC1.6.4 / BR6.4 区別は画面と出力の元に残る', () => {
    it('Given 週数を 30 週にしたゲーム / When 進行して状態を見る / Then custom のまま残る', async () => {
      const world = createWorld({ kitPreset: TEST_PRESET });
      const game = await world.startedGame({
        ...kitSettings,
        weekCount: 30,
        demandSeries: kitSettings.demandSeries.slice(0, 30),
      });
      await world.playWeek(game, 1);
      const view = await world.session.getState(game.facilitator, game.gameId);
      expect(view.setupKind).toBe('custom');
    });

    it('Given kit のゲーム / When 週を確定して終了まで進める / Then 種別は kit のまま変わらない', async () => {
      const world = createWorld({ kitPreset: TEST_PRESET });
      const game = await world.startedGame({
        ...kitSettings,
        weekCount: 50,
      });
      expect((await world.session.getState(game.facilitator, game.gameId)).setupKind).toBe('kit');
      for (let week = 1; week <= 3; week += 1) {
        await world.playWeek(game, week);
      }
      const snapshot = await world.store.readSnapshot(game.gameId);
      expect(snapshot?.game.setupKind).toBe('kit');
      expect((await world.session.getState(game.facilitator, game.gameId)).setupKind).toBe('kit');
    });
  });

  describe('AC1.6.5 / BR6.5 初期の入荷', () => {
    it('Given kit の直後 / When 第 1 週・第 2 週を確定する / Then 各役割の入荷は枠の 4。第 3 週の入荷から第 1 週の出荷・生産要請が加わる', async () => {
      const world = createWorld({ kitPreset: TEST_PRESET });
      const game = await world.startedGame({ ...kitSettings });
      const week1 = await world.playWeek(game, 1, { factory: 20 });
      const week2 = await world.playWeek(game, 2, { factory: 30 });
      for (const result of [week1, week2]) {
        for (const role of ROLES) {
          expect(result.results.find((r) => r.role === role)?.receipt).toBe(4);
        }
      }
      // 第 3 週の入荷: 工場は第 1 週の生産要請（20）、卸と小売店は上流の第 1 週の出荷
      const week3 = await world.playWeek(game, 3);
      const receipt = (role: (typeof ROLES)[number]) =>
        week3.results.find((r) => r.role === role)?.receipt;
      const shippedWeek1 = (role: (typeof ROLES)[number]) =>
        week1.results.find((r) => r.role === role)?.shipped;
      expect(receipt('factory')).toBe(20);
      expect(receipt('wholesaler1')).toBe(shippedWeek1('factory'));
      expect(receipt('wholesaler2')).toBe(shippedWeek1('wholesaler1'));
      expect(receipt('retailer')).toBe(shippedWeek1('wholesaler2'));
    });
  });
});
