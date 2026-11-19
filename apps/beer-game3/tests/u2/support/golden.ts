import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { ROLES, type Role } from '../../../src/server/domain/types.js';
import type { SlotRow } from '../../../src/server/session/store.js';
import type { World } from '../../u1/support/world.js';

/** fixtures/golden-50-weeks.json の形（derive-golden.mjs が、エンジンとは別の計算で作る）。 */
export interface GoldenRole {
  decision: number;
  receipt: number;
  ordersReceived: number;
  shipped: number;
  inventory: number;
  backlog: number;
  weeklyCost: number;
  cumulativeCost: number;
}
export interface GoldenWeek {
  week: number;
  customerDemand: number;
  roles: Record<Role, GoldenRole>;
  teamCost: number;
  slots: {
    delivery: Record<string, [number, number]>;
    order: Record<string, [number, number]>;
    production: Record<string, [number, number]>;
  };
}
export interface Golden {
  scenario: {
    weekCount: number;
    initialInventory: number;
    initialPipelineQuantity: number;
    inventoryUnitCost: number;
    backlogUnitCost: number;
    demandSeries: number[];
  };
  weeks: GoldenWeek[];
}

export const GOLDEN_SCRIPT = new URL('../fixtures/derive-golden.mjs', import.meta.url);
export const golden = JSON.parse(
  readFileSync(new URL('../fixtures/golden-50-weeks.json', import.meta.url), 'utf8'),
) as Golden;

function slotQuantities(slots: SlotRow[], kind: SlotRow['kind'], role: string): [number, number] {
  const pick = (remainingWeeks: 1 | 2): number => {
    const found = slots.find(
      (s) => s.kind === kind && s.role === role && s.remainingWeeks === remainingWeeks,
    );
    if (!found) {
      throw new Error(`枠が見つかりません: ${kind} ${role} ${remainingWeeks}`);
    }
    return found.quantity;
  };
  return [pick(1), pick(2)];
}

/** 固定した意思決定の系列で 50 週を進め、全週・全役割の結果と週末の枠を期待値と比べる。 */
export async function playAndCompare(world: World): Promise<void> {
  const { scenario } = golden;
  const game = await world.startedGame({
    weekCount: scenario.weekCount,
    initialInventory: scenario.initialInventory,
    initialPipelineQuantity: scenario.initialPipelineQuantity,
    inventoryUnitCost: scenario.inventoryUnitCost,
    backlogUnitCost: scenario.backlogUnitCost,
    demandSeries: scenario.demandSeries,
  });
  for (const expected of golden.weeks) {
    const quantities = Object.fromEntries(
      ROLES.map((role) => [role, expected.roles[role].decision]),
    ) as Record<Role, number>;
    const result = await world.playWeek(game, expected.week, quantities);
    for (const role of ROLES) {
      const actual = result.results.find((r) => r.role === role);
      expect({ week: expected.week, role, ...actual }).toEqual({
        week: expected.week,
        role,
        ...expected.roles[role],
      });
    }
    expect({ week: expected.week, teamCost: result.teamCost }).toEqual({
      week: expected.week,
      teamCost: expected.teamCost,
    });
    const snapshot = await world.store.readSnapshot(game.gameId);
    const slots = snapshot?.slots ?? [];
    for (const [kind, byRole] of Object.entries(expected.slots)) {
      for (const [role, quantities] of Object.entries(byRole)) {
        expect({
          week: expected.week,
          kind,
          role,
          slots: slotQuantities(slots, kind as SlotRow['kind'], role),
        }).toEqual({ week: expected.week, kind, role, slots: quantities });
      }
    }
  }
  const final = await world.store.readSnapshot(game.gameId);
  expect(final?.game).toMatchObject({ status: 'ended', currentWeek: 50 });
}
