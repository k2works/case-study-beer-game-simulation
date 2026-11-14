import type { Role } from '../server/domain/types.js';
import type { ResultsView } from './api.js';

type ResultWeek = ResultsView['roles'][number]['weeks'][number];

export type MarkerShape = 'circle' | 'square' | 'triangle' | 'diamond';

export interface SeriesStyle {
  /** 線と印の色。白い背景に対して 3:1 以上（補助。色を取り除いても線種と印で区別できる） */
  color: string;
  /** SVG の stroke-dasharray（none は実線） */
  dash: string;
  marker: MarkerShape;
}

/**
 * 役割ごとの線種・印・色の組（BR22.2）。どの指標でも同じ。線種（実線、破線、点線、一点鎖線）と印（丸、四角、三角、ひし形）は
 * 役割ごとに異なり、色を取り除いても 4 つを区別できる。凡例も同じ値を使う。
 */
export const SERIES_STYLES: Record<Role, SeriesStyle> = {
  factory: { color: '#0b5cad', dash: 'none', marker: 'circle' },
  wholesaler1: { color: '#b04a00', dash: '8 4', marker: 'square' },
  wholesaler2: { color: '#1b7f3b', dash: '2 4', marker: 'triangle' },
  retailer: { color: '#8a2c7a', dash: '8 3 2 3', marker: 'diamond' },
};

export type MetricId = 'demand' | 'order' | 'inventory' | 'backlog' | 'shipped' | 'cost';
export type CostMode = 'weekly' | 'cumulative';

export interface MetricDef {
  id: MetricId;
  label: string;
  /** 表の見出しに入れる単位 */
  unit: string;
}

/** 指標の 6 つ（BR22.1）。初期の指標は費用。 */
export const METRICS: readonly MetricDef[] = [
  { id: 'demand', label: '需要', unit: '個（各役割が受けた注文。小売店は顧客需要）' },
  { id: 'order', label: '注文', unit: '個（発注。工場は生産要請）' },
  { id: 'inventory', label: '在庫', unit: '個（週末）' },
  { id: 'backlog', label: '受注残', unit: '個（週末）' },
  { id: 'shipped', label: '出荷', unit: '個' },
  { id: 'cost', label: '費用', unit: 'ドル' },
];

export const COST_MODES: ReadonlyArray<{ id: CostMode; label: string }> = [
  { id: 'cumulative', label: '累積' },
  { id: 'weekly', label: '週ごと' },
];

/** 指標に対応する値を、1 週・1 役割の記録から取り出す。費用は整数のセント。 */
export function valueOf(week: ResultWeek, metric: MetricId, costMode: CostMode): number {
  switch (metric) {
    case 'demand':
      return week.ordersReceived;
    case 'order':
      return week.decision;
    case 'inventory':
      return week.inventory;
    case 'backlog':
      return week.backlog;
    case 'shipped':
      return week.shipped;
    case 'cost':
      return costMode === 'weekly' ? week.weeklyCost : week.cumulativeCost;
  }
}

/** 縦軸の上端（最大値以上の、読みやすい値）。 */
export function niceCeiling(max: number): number {
  if (max <= 0) {
    return 1;
  }
  const unit = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * unit >= max) {
      return step * unit;
    }
  }
  return 10 * unit;
}

/** 印を描く週。25 週を超えるときは 5 週ごと（と最初と最後）に間引く。線は全点を結ぶ（NFR8.2）。 */
export function showMarker(week: number, weekCount: number): boolean {
  return weekCount <= 25 || week === 1 || week === weekCount || week % 5 === 0;
}

/** 横軸の目盛りの週。15 週までは毎週、それを超えるときは 5 週ごと（と最初）。 */
export function weekTicks(weekCount: number): number[] {
  const weeks = Array.from({ length: weekCount }, (_, i) => i + 1);
  return weekCount <= 15 ? weeks : weeks.filter((w) => w === 1 || w % 5 === 0);
}
