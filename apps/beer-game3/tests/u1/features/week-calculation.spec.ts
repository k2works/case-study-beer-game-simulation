import { describe, expect, it } from 'vitest';
import {
  EngineInputError,
  computeWeek,
  createInitialState,
  type EngineState,
} from '../../../src/server/domain/engine.js';
import type { Decisions, Role } from '../../../src/server/domain/types.js';

const SETTINGS = { inventoryUnitCost: 50, backlogUnitCost: 100 };

const decisions = (overrides: Partial<Decisions> = {}): Decisions => ({
  factory: 4,
  wholesaler1: 4,
  wholesaler2: 4,
  retailer: 4,
  ...overrides,
});

/** 指定の役割の状態だけを書き換えた状態を作る（Given の組み立て用）。 */
function withRole(
  state: EngineState,
  role: Role,
  patch: Partial<EngineState['roles'][Role]>,
): EngineState {
  return { roles: { ...state.roles, [role]: { ...state.roles[role], ...patch } } };
}

describe('週の計算（SimulationEngine）', () => {
  describe('AC1.5.3 在庫が足りず受注残が出る', () => {
    it('Given 前週末在庫 12・当週入荷 4・前週末受注残 0・当週受注 20 / When 週を確定する / Then 出荷 16・週末在庫 0・週末受注残 4', () => {
      // Given
      const state = withRole(createInitialState(12, 4), 'retailer', {
        inventory: 12,
        backlog: 0,
        deliveryPipeline: [4, 4],
      });
      // When
      const { perRole } = computeWeek({
        settings: SETTINGS,
        state,
        customerDemand: 20,
        decisions: decisions(),
      });
      // Then
      expect(perRole.retailer).toMatchObject({
        receipt: 4,
        ordersReceived: 20,
        shipped: 16,
        inventory: 0,
        backlog: 4,
      });
    });
  });

  describe('AC1.5.4 在庫が足りて余る', () => {
    it('Given 前週末在庫 12・当週入荷 0・前週末受注残 0・当週受注 4 / When 週を確定する / Then 出荷 4・週末在庫 8・週末受注残 0', () => {
      const state = withRole(createInitialState(12, 4), 'retailer', {
        inventory: 12,
        backlog: 0,
        deliveryPipeline: [0, 0],
      });
      const { perRole } = computeWeek({
        settings: SETTINGS,
        state,
        customerDemand: 4,
        decisions: decisions(),
      });
      expect(perRole.retailer).toMatchObject({
        receipt: 0,
        ordersReceived: 4,
        shipped: 4,
        inventory: 8,
        backlog: 0,
      });
    });

    it('前週末の受注残は当週の充足対象に加わる', () => {
      const state = withRole(createInitialState(0, 4), 'retailer', {
        inventory: 0,
        backlog: 6,
        deliveryPipeline: [10, 0],
      });
      const { perRole } = computeWeek({
        settings: SETTINGS,
        state,
        customerDemand: 2,
        decisions: decisions(),
      });
      // 利用可能量 10、充足対象 6 + 2 = 8
      expect(perRole.retailer).toMatchObject({ shipped: 8, inventory: 2, backlog: 0 });
    });
  });

  describe('AC1.5.9 週次費用は整数の最小単位で計算し、累積費用に加わる', () => {
    it('Given 週末在庫 8・週末受注残 4 / When 週を確定する / Then チームの費用は 800（$8.00）になり、累積費用に加わる', () => {
      // Given: 小売店は在庫 12 + 入荷 4 - 受注 8 で週末在庫 8。二次卸は在庫 0・入荷 0・受注 4 で週末受注残 4。
      // 一次卸と工場は在庫 0・受注 0 で費用が出ない。
      let state = createInitialState(0, 0);
      state = withRole(state, 'retailer', {
        inventory: 12,
        deliveryPipeline: [4, 0],
        cumulativeCost: 300,
      });
      state = withRole(state, 'wholesaler2', { inventory: 0, orderPipeline: [4, 0] });
      // When
      const result = computeWeek({
        settings: SETTINGS,
        state,
        customerDemand: 8,
        decisions: decisions({ retailer: 0, wholesaler2: 0, wholesaler1: 0, factory: 0 }),
      });
      // Then
      expect(result.perRole.retailer).toMatchObject({ inventory: 8, backlog: 0, weeklyCost: 400 });
      expect(result.perRole.wholesaler2).toMatchObject({
        inventory: 0,
        backlog: 4,
        weeklyCost: 400,
      });
      expect(result.teamCost).toBe(800);
      expect(result.perRole.retailer.cumulativeCost).toBe(700);
      expect(result.state.roles.retailer.cumulativeCost).toBe(700);
    });

    it('端数の出る単価でも整数のまま計算する', () => {
      const state = withRole(createInitialState(0, 0), 'retailer', {
        inventory: 0,
        deliveryPipeline: [0, 0],
      });
      const { perRole } = computeWeek({
        settings: { inventoryUnitCost: 33, backlogUnitCost: 17 },
        state,
        customerDemand: 4,
        decisions: decisions(),
      });
      expect(perRole.retailer).toMatchObject({ backlog: 4, weeklyCost: 68 });
      expect(Number.isInteger(perRole.retailer.weeklyCost)).toBe(true);
    });
  });

  describe('AC1.5.5 配送の遅延は 2 週（第 t 週の出荷は第 t+2 週の入荷）', () => {
    it('Given 第 3 週に工場が一次卸へ出荷した / When 第 4 週を確定する / Then 一次卸の入荷にはまだ加わらず、第 5 週に加わる', () => {
      let state = createInitialState(12, 4);
      const wholesaler1Receipts: number[] = [];
      const factoryShipped: number[] = [];
      for (let week = 1; week <= 5; week += 1) {
        const result = computeWeek({
          settings: SETTINGS,
          state,
          customerDemand: 4,
          // 一次卸の発注を週ごとに変えて、工場の出荷の数量を区別できるようにする
          decisions: decisions({ wholesaler1: 10 + week }),
        });
        wholesaler1Receipts.push(result.perRole.wholesaler1.receipt);
        factoryShipped.push(result.perRole.factory.shipped);
        state = result.state;
      }
      const shippedWeek3 = factoryShipped[2]!;
      expect(shippedWeek3).not.toBe(4);
      // 第 4 週の入荷には第 3 週の出荷は加わらない
      expect(wholesaler1Receipts[3]).toBe(factoryShipped[1]);
      expect(wholesaler1Receipts[3]).not.toBe(shippedWeek3);
      // 第 5 週の入荷に加わる
      expect(wholesaler1Receipts[4]).toBe(shippedWeek3);
    });
  });

  describe('AC1.5.6 注文情報の遅延は 2 週（第 t 週の発注は第 t+2 週の上流の受注）', () => {
    it('Given 第 3 週に小売店が発注した / When 第 4 週を確定する / Then 二次卸の受注にはまだ加わらず、第 5 週に加わる', () => {
      let state = createInitialState(12, 4);
      const wholesaler2Orders: number[] = [];
      const retailerDecisions: number[] = [];
      for (let week = 1; week <= 5; week += 1) {
        const retailerDecision = 20 + week;
        retailerDecisions.push(retailerDecision);
        const result = computeWeek({
          settings: SETTINGS,
          state,
          customerDemand: 4,
          decisions: decisions({ retailer: retailerDecision }),
        });
        wholesaler2Orders.push(result.perRole.wholesaler2.ordersReceived);
        state = result.state;
      }
      // 第 4 週の受注は第 2 週の発注、第 5 週の受注が第 3 週の発注
      expect(wholesaler2Orders[3]).toBe(retailerDecisions[1]);
      expect(wholesaler2Orders[3]).not.toBe(retailerDecisions[2]);
      expect(wholesaler2Orders[4]).toBe(retailerDecisions[2]);
    });

    it('最初の 2 週の受注は初期パイプライン数量になる', () => {
      let state = createInitialState(12, 4);
      const orders: number[] = [];
      for (let week = 1; week <= 3; week += 1) {
        const result = computeWeek({
          settings: SETTINGS,
          state,
          customerDemand: 4,
          decisions: decisions({ retailer: 9 }),
        });
        orders.push(result.perRole.wholesaler2.ordersReceived);
        state = result.state;
      }
      expect(orders).toEqual([4, 4, 9]);
    });
  });

  describe('AC1.5.7 工場は一次卸からの注文を受注として扱い、生産要請は 2 週後に入荷になる', () => {
    it('Given 工場の週 / When 受注のステップに至る / Then 一次卸の発注が受注になり、顧客需要は使わない', () => {
      let state = createInitialState(12, 4);
      const factoryOrders: number[] = [];
      const factoryReceipts: number[] = [];
      for (let week = 1; week <= 4; week += 1) {
        const result = computeWeek({
          settings: SETTINGS,
          state,
          customerDemand: 99,
          decisions: decisions({ wholesaler1: 7, factory: 15 + week }),
        });
        factoryOrders.push(result.perRole.factory.ordersReceived);
        factoryReceipts.push(result.perRole.factory.receipt);
        state = result.state;
      }
      expect(factoryOrders).toEqual([4, 4, 7, 7]);
      // 工場の生産要請は 2 週後に入荷になる（第 1 週の要請 16 は第 3 週）
      expect(factoryReceipts).toEqual([4, 4, 16, 17]);
    });

    it('工場に配送の枠はなく、小売店に注文の枠はない', () => {
      const state = createInitialState(12, 4);
      expect(state.roles.factory.deliveryPipeline).toBeUndefined();
      expect(state.roles.factory.productionPipeline).toEqual([4, 4]);
      expect(state.roles.retailer.orderPipeline).toBeUndefined();
    });
  });

  describe('NFR1.1 / NFR1.2 決定論的で、浮動小数点と副作用を持たない', () => {
    it('同じ入力から 2 回計算すると同じ結果になり、入力を書き換えない', () => {
      const state = createInitialState(12, 4);
      const input = {
        settings: SETTINGS,
        state,
        customerDemand: 8,
        decisions: decisions({ retailer: 6 }),
      };
      const snapshot = structuredClone(input);
      const first = computeWeek(input);
      const second = computeWeek(input);
      expect(second).toEqual(first);
      expect(input).toEqual(snapshot);
    });

    it('4 役割とも負の在庫と負の受注残を返さない', () => {
      let state = createInitialState(0, 0);
      for (let week = 1; week <= 6; week += 1) {
        const result = computeWeek({
          settings: SETTINGS,
          state,
          customerDemand: 50,
          decisions: decisions({ wholesaler2: 30, wholesaler1: 30, factory: 30, retailer: 30 }),
        });
        for (const role of ['factory', 'wholesaler1', 'wholesaler2', 'retailer'] as const) {
          expect(result.perRole[role].inventory).toBeGreaterThanOrEqual(0);
          expect(result.perRole[role].backlog).toBeGreaterThanOrEqual(0);
        }
        state = result.state;
      }
    });

    it('不正な入力（負数・小数・需要の欠け）は型の違反として拒否する', () => {
      const base = {
        settings: SETTINGS,
        state: createInitialState(12, 4),
        customerDemand: 4,
        decisions: decisions(),
      };
      expect(() => computeWeek({ ...base, decisions: decisions({ retailer: -1 }) })).toThrow(
        EngineInputError,
      );
      expect(() => computeWeek({ ...base, decisions: decisions({ retailer: 2.5 }) })).toThrow(
        EngineInputError,
      );
      expect(() => computeWeek({ ...base, customerDemand: -3 })).toThrow(EngineInputError);
    });
  });
});
