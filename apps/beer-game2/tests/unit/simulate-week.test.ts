import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  KIT_CONDITIONS,
  type Conditions,
} from '../../src/domain/conditions.js';
import { ROLES, downstreamOf, type Role } from '../../src/domain/role.js';
import {
  initialRoleStates,
  simulateWeek,
  type RoleStates,
  type WeekSettings,
} from '../../src/domain/simulate-week.js';

const costs: WeekSettings = { holdingCostMinor: 50, backlogCostMinor: 100 };
const same = (n: number): Record<Role, number> => ({
  FACTORY: n,
  DISTRIBUTOR: n,
  WHOLESALER: n,
  RETAILER: n,
});

function run(demand: number[], decisions: Record<Role, number>[]) {
  let states = initialRoleStates();
  const history = [];
  for (const [i, d] of demand.entries()) {
    const out = simulateWeek(states, d, decisions[i] ?? same(4), costs);
    states = out.states;
    history.push(out.results);
  }
  return { states, history };
}

describe('simulateWeek: golden（改訂版キット。初期在庫 12、パイプライン 4、遅延 2 週）', () => {
  it('[US2.3/AC2.3.4] 需要 4 で発注 4 なら、全役割が在庫 12・費用 $0.50×12=$6 で定常', () => {
    const { history } = run([4, 4, 4, 4], []);
    for (const week of history) {
      for (const role of ROLES) {
        expect(week[role]).toMatchObject({
          shipped: 4,
          endingInventory: 12,
          endingBacklog: 0,
          weeklyCostMinor: 600,
        });
      }
    }
  });

  it('[US2.3/AC2.3.4] 需要が 4→8 に増え、発注が 4 のままなら、小売店の在庫が 12→8→4→0 と減る（BR-05〜BR-08）', () => {
    const { history } = run([4, 8, 8, 8], []);
    const retailer = history.map((w) => w.RETAILER);
    expect(retailer.map((r) => r.endingInventory)).toEqual([12, 8, 4, 0]);
    expect(retailer.map((r) => r.weeklyCostMinor)).toEqual([600, 400, 200, 0]);
    expect(retailer.map((r) => r.cumulativeCostMinor)).toEqual([
      600, 1000, 1200, 1200,
    ]);
    expect(history[3]!.WHOLESALER.cumulativeCostMinor).toBe(2400);
  });

  it('[US2.3/AC2.3.4] 在庫が足りないと、受注残が生まれ、翌週に持ち越される（BR-06〜BR-08）', () => {
    const { history } = run([20, 4], []);
    expect(history[0]!.RETAILER).toMatchObject({
      demand: 20,
      shipped: 16,
      endingInventory: 0,
      endingBacklog: 4,
      weeklyCostMinor: 400,
    });
    expect(history[1]!.RETAILER).toMatchObject({
      shipped: 4,
      endingInventory: 0,
      endingBacklog: 4,
      cumulativeCostMinor: 800,
    });
  });

  it('[US2.3/AC2.3.5] 出荷は 2 週後に下流へ届く（BR-02）', () => {
    // 1 週目に小売店の発注が 4→ 卸が 2 週後に受け取る。ここでは小売店の発注 10 が 3 週目に卸の需要になる
    const decisions = [{ ...same(4), RETAILER: 10 }];
    const { history } = run([4, 4, 4, 4], decisions);
    expect(history[2]!.WHOLESALER.demand).toBe(10);
    expect(history[1]!.WHOLESALER.demand).toBe(4);
  });

  it('[US2.3/AC2.3.4] 工場の生産要請は 2 週後に工場在庫へ入る（BR-04）', () => {
    const decisions = [{ ...same(4), FACTORY: 10 }];
    const { history } = run([4, 4, 4, 4], decisions);
    // 3 週目に 10 が入り、在庫 12 + 10 - 4 = 18
    expect(history[2]!.FACTORY.endingInventory).toBe(18);
    expect(history[1]!.FACTORY.endingInventory).toBe(12);
  });
});

describe('simulateWeek: 性質（fast-check）', () => {
  const qty = fc.integer({ min: 0, max: 1000 });
  const decisions = fc.record({
    FACTORY: qty,
    DISTRIBUTOR: qty,
    WHOLESALER: qty,
    RETAILER: qty,
  });
  const scenario = fc.array(fc.tuple(qty, decisions), {
    minLength: 1,
    maxLength: 20,
  });

  function play(sc: [number, Record<Role, number>][]) {
    let states: RoleStates = initialRoleStates();
    const steps = [];
    for (const [demand, d] of sc) {
      const before = states;
      const out = simulateWeek(states, demand, d, costs);
      steps.push({ before, demand, d, ...out });
      states = out.states;
    }
    return steps;
  }

  it('[US2.3/AC2.3.4] 決定論: 同じ入力は同じ結果', () => {
    fc.assert(
      fc.property(scenario, (sc) => {
        expect(play(sc)).toEqual(play(sc));
      }),
    );
  });

  it('[US2.3/AC2.3.4] 在庫と受注残は負にならず、どちらか一方は 0（BR-08）', () => {
    fc.assert(
      fc.property(scenario, (sc) => {
        for (const s of play(sc)) {
          for (const r of ROLES) {
            const x = s.results[r];
            expect(x.endingInventory).toBeGreaterThanOrEqual(0);
            expect(x.endingBacklog).toBeGreaterThanOrEqual(0);
            expect(Math.min(x.endingInventory, x.endingBacklog)).toBe(0);
          }
        }
      }),
    );
  });

  it('[US2.3/AC2.3.4] 保存則: 在庫の増減 = 入荷 − 出荷、受注残の増減 = 受注 − 出荷（BR-05〜BR-07）', () => {
    fc.assert(
      fc.property(scenario, (sc) => {
        for (const s of play(sc)) {
          for (const r of ROLES) {
            const before = s.before[r];
            const x = s.results[r];
            expect(x.endingInventory - before.inventory).toBe(
              x.received - x.shipped,
            );
            expect(x.endingBacklog - before.backlog).toBe(x.demand - x.shipped);
            expect(x.shipped).toBeLessThanOrEqual(
              before.inventory + x.received,
            );
          }
        }
      }),
    );
  });

  it('[US2.3/AC2.3.4] 費用: 週次 = 在庫×単価 + 受注残×単価、累積は合計（BR-09）', () => {
    fc.assert(
      fc.property(scenario, (sc) => {
        const cum: Record<Role, number> = same(0);
        for (const s of play(sc)) {
          for (const r of ROLES) {
            const x = s.results[r];
            expect(x.weeklyCostMinor).toBe(
              x.endingInventory * costs.holdingCostMinor +
                x.endingBacklog * costs.backlogCostMinor,
            );
            cum[r] += x.weeklyCostMinor;
            expect(x.cumulativeCostMinor).toBe(cum[r]);
          }
        }
      }),
    );
  });

  it('[US2.3/AC2.3.4] 遅延: 出荷は 2 週後に、下流の入荷になる（BR-02）', () => {
    fc.assert(
      fc.property(scenario, (sc) => {
        const steps = play(sc);
        for (const [i, s] of steps.entries()) {
          const later = steps[i + 2];
          if (!later) continue;
          for (const r of ROLES) {
            const down = downstreamOf(r);
            if (down)
              expect(later.results[down].received).toBe(s.results[r].shipped);
          }
        }
      }),
    );
  });

  it('[US2.3/AC2.3.4] 遅延: 発注は 2 週後に、上流の受注になる（BR-03）', () => {
    fc.assert(
      fc.property(scenario, (sc) => {
        const steps = play(sc);
        for (const [i, s] of steps.entries()) {
          const later = steps[i + 2];
          if (!later) continue;
          expect(later.results.WHOLESALER.demand).toBe(s.d.RETAILER);
          expect(later.results.DISTRIBUTOR.demand).toBe(s.d.WHOLESALER);
          expect(later.results.FACTORY.demand).toBe(s.d.DISTRIBUTOR);
          expect(later.results.FACTORY.received).toBe(s.d.FACTORY);
        }
      }),
    );
  });

  it('[US2.3/AC2.3.4] チームの合計 = 役割別の合計', () => {
    fc.assert(
      fc.property(scenario, (sc) => {
        const steps = play(sc);
        const last = steps[steps.length - 1]!;
        const team = ROLES.reduce(
          (a, r) => a + last.results[r].cumulativeCostMinor,
          0,
        );
        const byWeek = steps.reduce(
          (a, s) =>
            a + ROLES.reduce((b, r) => b + s.results[r].weeklyCostMinor, 0),
          0,
        );
        expect(team).toBe(byWeek);
      }),
    );
  });
});

describe('initialRoleStates: 条件（初期在庫・遅延）', () => {
  it('[US1.1/AC1.1.4] 既定はキット: 初期在庫 12、待ち行列は 2 段で各 4', () => {
    expect(initialRoleStates()).toEqual(initialRoleStates(KIT_CONDITIONS));
    expect(initialRoleStates().RETAILER).toMatchObject({
      inventory: 12,
      incomingGoods: [4, 4],
      outgoingOrders: [4, 4],
    });
  });

  it('[US1.1/AC1.1.4] 遅延の週数だけの段を作る。工場の入荷の段は生産の遅延', () => {
    const s = initialRoleStates({
      ...KIT_CONDITIONS,
      initialInventory: 20,
      orderDelayWeeks: 1,
      shipmentDelayWeeks: 3,
      productionDelayWeeks: 4,
    });
    expect(s.RETAILER).toMatchObject({
      inventory: 20,
      incomingGoods: [4, 4, 4],
      outgoingOrders: [4],
    });
    expect(s.FACTORY).toMatchObject({
      inventory: 20,
      incomingGoods: [4, 4, 4, 4],
      outgoingOrders: [],
    });
  });
});

describe('simulateWeek: 可変の遅延の性質（fast-check）', () => {
  const qty = fc.integer({ min: 0, max: 1000 });
  const delay = fc.integer({ min: 1, max: 4 });
  const conditions = fc.record({
    initialInventory: fc.integer({ min: 0, max: 100 }),
    orderDelayWeeks: delay,
    shipmentDelayWeeks: delay,
    productionDelayWeeks: delay,
    holdingCostMinor: fc.integer({ min: 0, max: 1000 }),
    backlogCostMinor: fc.integer({ min: 0, max: 1000 }),
    disclosure: fc.constant('TEAM_TOTAL' as const),
  });
  const decisions = fc.record({
    FACTORY: qty,
    DISTRIBUTOR: qty,
    WHOLESALER: qty,
    RETAILER: qty,
  });
  const scenario = fc.array(fc.tuple(qty, decisions), {
    minLength: 1,
    maxLength: 20,
  });

  function play(c: Conditions, sc: [number, Record<Role, number>][]) {
    let states: RoleStates = initialRoleStates(c);
    const steps = [];
    for (const [demand, d] of sc) {
      const before = states;
      const out = simulateWeek(states, demand, d, c);
      steps.push({ before, d, ...out });
      states = out.states;
    }
    return steps;
  }

  it('[US1.1/AC1.1.4] 出荷は配送の遅延の週数の後に、下流の入荷になる（BR-02）', () => {
    fc.assert(
      fc.property(conditions, scenario, (c, sc) => {
        const steps = play(c, sc);
        for (const [i, s] of steps.entries()) {
          const later = steps[i + c.shipmentDelayWeeks];
          if (!later) continue;
          for (const r of ROLES) {
            const down = downstreamOf(r);
            if (down)
              expect(later.results[down].received).toBe(s.results[r].shipped);
          }
        }
      }),
    );
  });

  it('[US1.1/AC1.1.4] 発注は注文の遅延の後に上流の受注に、生産要請は生産の遅延の後に工場の入荷になる（BR-03・BR-04）', () => {
    fc.assert(
      fc.property(conditions, scenario, (c, sc) => {
        const steps = play(c, sc);
        for (const [i, s] of steps.entries()) {
          const ordered = steps[i + c.orderDelayWeeks];
          if (ordered) {
            expect(ordered.results.WHOLESALER.demand).toBe(s.d.RETAILER);
            expect(ordered.results.FACTORY.demand).toBe(s.d.DISTRIBUTOR);
          }
          const produced = steps[i + c.productionDelayWeeks];
          if (produced)
            expect(produced.results.FACTORY.received).toBe(s.d.FACTORY);
        }
      }),
    );
  });

  it('[US1.1/AC1.1.4] 遅延と初期在庫を変えても、保存則・非負・費用の式が保たれる（BR-05〜BR-09）', () => {
    fc.assert(
      fc.property(conditions, scenario, (c, sc) => {
        for (const s of play(c, sc)) {
          for (const r of ROLES) {
            const before = s.before[r];
            const x = s.results[r];
            expect(x.endingInventory - before.inventory).toBe(
              x.received - x.shipped,
            );
            expect(x.endingBacklog - before.backlog).toBe(x.demand - x.shipped);
            expect(Math.min(x.endingInventory, x.endingBacklog)).toBe(0);
            expect(x.weeklyCostMinor).toBe(
              x.endingInventory * c.holdingCostMinor +
                x.endingBacklog * c.backlogCostMinor,
            );
          }
        }
      }),
    );
  });

  it('待ち行列の段の数は、週を進めても遅延の週数のまま', () => {
    fc.assert(
      fc.property(conditions, scenario, (c, sc) => {
        for (const s of play(c, sc)) {
          for (const r of ROLES) {
            const st = s.states[r];
            expect(st.incomingGoods).toHaveLength(
              r === 'FACTORY' ? c.productionDelayWeeks : c.shipmentDelayWeeks,
            );
            expect(st.outgoingOrders).toHaveLength(
              r === 'FACTORY' ? 0 : c.orderDelayWeeks,
            );
          }
        }
      }),
    );
  });
});
