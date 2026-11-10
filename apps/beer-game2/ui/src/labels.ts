import type { Role } from './api/types.js';

export const ROLE_ORDER: Role[] = [
  'FACTORY',
  'DISTRIBUTOR',
  'WHOLESALER',
  'RETAILER',
];

export const ROLE_LABEL: Record<Role, string> = {
  FACTORY: '工場',
  DISTRIBUTOR: '一次卸',
  WHOLESALER: '二次卸',
  RETAILER: '小売店',
};

/** 工場は「発注」ではなく「生産要請」を決める */
export const DECISION_LABEL = (role: Role) =>
  role === 'FACTORY' ? '生産要請数' : '発注数';

export const formatMoney = (minor: number) => `$${(minor / 100).toFixed(2)}`;
