import {
  ROLES,
  type Role,
  type RoleState,
  type SessionSnapshot,
  type WeekResult,
} from './types.js';

export interface SimulationSettings {
  holdingCostMinor: number;
  backlogCostMinor: number;
  quantityUpperBound: number;
}

const downstream: Record<Role, Role | null> = {
  FACTORY: 'DISTRIBUTOR',
  DISTRIBUTOR: 'WHOLESALER',
  WHOLESALER: 'RETAILER',
  RETAILER: null,
};

function assertQuantity(value: number, upperBound: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > upperBound) {
    throw new RangeError(`quantity must be an integer in 0..${upperBound}`);
  }
}

/** Pure JSD weekly calculation. Array shifts make the two-period delays explicit. */
export function simulateWeek(
  prior: SessionSnapshot,
  decisions: Record<Role, number>,
  settings: SimulationSettings,
): { snapshot: SessionSnapshot; result: WeekResult } {
  if (prior.status !== 'ACTIVE') throw new Error('session is not active');
  const customerDemand = prior.demand[prior.week - 1];
  if (customerDemand === undefined) throw new Error('demand is missing for current week');
  for (const role of ROLES) assertQuantity(decisions[role], settings.quantityUpperBound);

  // JSD order: receive inventory; receive order; ship; update backlog/inventory;
  // place order; advance order delay; advance shipment delay; schedule production;
  // advance production delay; calculate cost; accumulate cost; advance week.
  const nextRoles = {} as Record<Role, RoleState>;
  const results = {} as WeekResult['roles'];
  for (const role of ROLES) {
    const state = prior.roles[role];
    const received = state.incomingShipments[0] ?? 0;
    const requested = downstream[role]
      ? (prior.roles[downstream[role]!].incomingOrders[0] ?? 0)
      : customerDemand;
    const available = state.inventory + received;
    const totalDemand = state.backlog + requested;
    const shipped = Math.min(available, totalDemand);
    const endingInventory = available - shipped;
    const endingBacklog = totalDemand - shipped;
    const incomingOrders = [...state.incomingOrders.slice(1), decisions[role]];
    const incomingShipments = [...state.incomingShipments.slice(1), 0];
    const production = [...state.production];
    if (role === 'FACTORY') {
      incomingShipments[incomingShipments.length - 1] = production[0] ?? 0;
      production.splice(0, 1);
      production.push(decisions.FACTORY);
    }
    const weeklyCostMinor =
      endingInventory * settings.holdingCostMinor + endingBacklog * settings.backlogCostMinor;
    const cumulativeCostMinor = state.cumulativeCostMinor + weeklyCostMinor;
    nextRoles[role] = {
      ...state,
      inventory: endingInventory,
      backlog: endingBacklog,
      incomingOrders,
      incomingShipments,
      production,
      cumulativeCostMinor,
    };
    results[role] = {
      role,
      demand: requested,
      shipped,
      endingInventory,
      endingBacklog,
      weeklyCostMinor,
      cumulativeCostMinor,
    };
  }

  // Shipments flow upstream-to-downstream with the configured two-week delay.
  for (const role of ROLES) {
    const target = downstream[role];
    if (target) nextRoles[target].incomingShipments[1] = results[role].shipped;
  }
  const nextWeek = prior.week + 1;
  const snapshot: SessionSnapshot = {
    ...prior,
    week: nextWeek,
    status: prior.week >= prior.finalWeek ? 'ENDED' : 'ACTIVE',
    version: prior.version + 1,
    roles: nextRoles,
  };
  return {
    snapshot,
    result: {
      sessionId: prior.sessionId,
      week: prior.week,
      roles: results,
      version: snapshot.version,
    },
  };
}

export function initialRoleState(role: Role): RoleState {
  return {
    role,
    inventory: 12,
    backlog: 0,
    incomingOrders: [4, 4],
    incomingShipments: [4, 4],
    production: role === 'FACTORY' ? [4, 4] : [],
    cumulativeCostMinor: 0,
  };
}
