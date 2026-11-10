import { ROLES, downstreamOf, upstreamOf, type Role } from './role.js';

/**
 * 1 役割の状態。
 * - incomingGoods: これから届く品物。[0] が当週に届く（工場では生産中の分）
 * - outgoingOrders: 上流へ送った発注。[0] が当週に上流へ届く（工場は使わない）
 * 遅延は 2 週（BR-02〜BR-04）。
 */
export interface RoleState {
  inventory: number;
  backlog: number;
  incomingGoods: readonly number[];
  outgoingOrders: readonly number[];
  cumulativeCostMinor: number;
}
export type RoleStates = Readonly<Record<Role, RoleState>>;

export interface WeekSettings {
  holdingCostMinor: number;
  backlogCostMinor: number;
}

/** 役割別の週結果（US2.3/AC2.3.5 で保存する単位）。 */
export interface RoleWeekResult {
  role: Role;
  demand: number;
  received: number;
  shipped: number;
  endingInventory: number;
  endingBacklog: number;
  weeklyCostMinor: number;
  cumulativeCostMinor: number;
}
export type WeekResults = Readonly<Record<Role, RoleWeekResult>>;

export const INITIAL_INVENTORY = 12;
export const INITIAL_PIPELINE = 4;

export function initialRoleStates(): RoleStates {
  const make = (role: Role): RoleState => ({
    inventory: INITIAL_INVENTORY,
    backlog: 0,
    incomingGoods: [INITIAL_PIPELINE, INITIAL_PIPELINE],
    outgoingOrders:
      role === 'FACTORY' ? [] : [INITIAL_PIPELINE, INITIAL_PIPELINE],
    cumulativeCostMinor: 0,
  });
  return Object.fromEntries(ROLES.map((r) => [r, make(r)])) as RoleStates;
}

/**
 * 1 週の計算（純粋関数）。改訂版キットの順序:
 * 入荷 → 受注 → 出荷 → 在庫・受注残の更新 → 発注 → 遅延の前進 → 費用。
 */
export function simulateWeek(
  prior: RoleStates,
  customerDemand: number,
  decisions: Readonly<Record<Role, number>>,
  settings: WeekSettings,
): { states: RoleStates; results: WeekResults } {
  const states = {} as Record<Role, RoleState>;
  const results = {} as Record<Role, RoleWeekResult>;
  const shipped = {} as Record<Role, number>;

  for (const role of ROLES) {
    const s = prior[role];
    const received = s.incomingGoods[0] ?? 0;
    const downstream = downstreamOf(role);
    const demand = downstream
      ? (prior[downstream].outgoingOrders[0] ?? 0)
      : customerDemand;

    const available = s.inventory + received; // BR-05
    const owed = s.backlog + demand; // BR-06
    const ship = Math.min(available, owed); // BR-07
    const endingInventory = Math.max(0, available - owed); // BR-08
    const endingBacklog = Math.max(0, owed - available);
    const weeklyCostMinor =
      endingInventory * settings.holdingCostMinor +
      endingBacklog * settings.backlogCostMinor; // BR-09
    const cumulativeCostMinor = s.cumulativeCostMinor + weeklyCostMinor;

    shipped[role] = ship;
    results[role] = {
      role,
      demand,
      received,
      shipped: ship,
      endingInventory,
      endingBacklog,
      weeklyCostMinor,
      cumulativeCostMinor,
    };
    states[role] = {
      inventory: endingInventory,
      backlog: endingBacklog,
      incomingGoods: s.incomingGoods.slice(1),
      outgoingOrders:
        s.outgoingOrders.length > 0
          ? [...s.outgoingOrders.slice(1), decisions[role]]
          : [],
      cumulativeCostMinor,
    };
  }

  for (const role of ROLES) {
    const s = states[role];
    const upstream = upstreamOf(role);
    // 品物の流入: 工場は自分の生産要請、他は上流の出荷（どちらも 2 週後に届く）
    const inflow = upstream ? shipped[upstream] : decisions[role];
    states[role] = { ...s, incomingGoods: [...s.incomingGoods, inflow] };
  }

  return { states, results };
}
