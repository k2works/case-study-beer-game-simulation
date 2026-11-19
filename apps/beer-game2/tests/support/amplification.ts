import { ROLES, type Role } from '../../src/domain/role.js';
import {
  initialRoleStates,
  simulateWeek,
} from '../../src/domain/simulate-week.js';
import type { ReviewRow } from '../../src/domain/review.js';

/**
 * 増幅（ブルウィップ効果）が現れる固定のシナリオ。
 * 需要は 4 週は 4、5 週目から 8。発注は、受注・受注残・在庫の差で決める基点在庫方式の結果（固定値）。
 * 上流ほど注文が大きく揺れる: 小売店の最大 24 に対し、一次卸 84、二次卸 80。
 */
export const AMPLIFICATION_DEMAND = [4, 4, 4, 4, 8, 8, 8, 8, 8, 8, 8, 8];
export const AMPLIFICATION_ORDERS: Record<Role, number[]> = {
  FACTORY: [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 8, 24],
  DISTRIBUTOR: [4, 4, 4, 4, 4, 4, 4, 4, 8, 20, 44, 84],
  WHOLESALER: [4, 4, 4, 4, 4, 4, 8, 16, 28, 44, 64, 80],
  RETAILER: [4, 4, 4, 4, 8, 12, 16, 20, 24, 24, 20, 24],
};

/** 固定のシナリオを simulateWeek で回して、振り返りの入力（役割別の週結果の行）を作る */
export function amplificationRows(): ReviewRow[] {
  let states = initialRoleStates();
  const rows: ReviewRow[] = [];
  AMPLIFICATION_DEMAND.forEach((demand, i) => {
    const orders = Object.fromEntries(
      ROLES.map((r) => [r, AMPLIFICATION_ORDERS[r][i]!]),
    ) as Record<Role, number>;
    const out = simulateWeek(states, demand, orders, {
      holdingCostMinor: 50,
      backlogCostMinor: 100,
    });
    states = out.states;
    for (const role of ROLES) {
      const r = out.results[role];
      rows.push({
        week: i + 1,
        role,
        demand: r.demand,
        received: r.received,
        shipped: r.shipped,
        order: orders[role],
        endingInventory: r.endingInventory,
        endingBacklog: r.endingBacklog,
        weeklyCostMinor: r.weeklyCostMinor,
        cumulativeCostMinor: r.cumulativeCostMinor,
      });
    }
  });
  return rows;
}
