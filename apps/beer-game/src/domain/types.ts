export const ROLES = ['FACTORY', 'DISTRIBUTOR', 'WHOLESALER', 'RETAILER'] as const;
export type Role = (typeof ROLES)[number];
export type SessionStatus = 'LOBBY' | 'ACTIVE' | 'ENDED';

export interface RoleState {
  role: Role;
  inventory: number;
  backlog: number;
  incomingOrders: number[];
  incomingShipments: number[];
  production: number[];
  cumulativeCostMinor: number;
}

export interface SessionSnapshot {
  sessionId: string;
  gameId: string;
  week: number;
  finalWeek: number;
  status: SessionStatus;
  version: number;
  demand: number[];
  roles: Record<Role, RoleState>;
}

export interface RoleWeekResult {
  role: Role;
  demand: number;
  shipped: number;
  endingInventory: number;
  endingBacklog: number;
  weeklyCostMinor: number;
  cumulativeCostMinor: number;
}

export interface WeekResult {
  sessionId: string;
  week: number;
  roles: Record<Role, RoleWeekResult>;
  version: number;
}
