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

export const METRIC_ORDER = [
  'order',
  'inventory',
  'backlog',
  'shipped',
  'cost',
] as const;

export const METRIC_LABEL: Record<(typeof METRIC_ORDER)[number], string> = {
  order: '注文',
  inventory: '在庫',
  backlog: '受注残',
  shipped: '出荷',
  cost: '費用',
};

/** 需要は、数量の指標（注文・出荷）とだけ比べられる */
export const DEMAND_METRICS = new Set(['order', 'shipped']);

export const formatMoney = (minor: number) => `$${(minor / 100).toFixed(2)}`;
