import { ROLES, type Role } from './role.js';
import { DomainError } from './values.js';

/** 確定した週の、役割別の記録（`week_role_results` の 1 行） */
export interface ReviewRow {
  week: number;
  role: Role;
  /** その役割が受けた注文（小売店は顧客需要） */
  demand: number;
  received: number;
  shipped: number;
  /** その週の発注（工場は生産要請） */
  order: number;
  endingInventory: number;
  endingBacklog: number;
  weeklyCostMinor: number;
  cumulativeCostMinor: number;
}

export const METRICS = [
  'order',
  'inventory',
  'backlog',
  'shipped',
  'cost',
] as const;
export type Metric = (typeof METRICS)[number];

export interface Review {
  /** 週の軸（1 から連続） */
  weeks: number[];
  /** 顧客需要（小売店が受けた注文） */
  demand: number[];
  /** 指標 → 役割 → 週ごとの値。費用は最小単位（セント） */
  series: Record<Metric, Record<Role, number[]>>;
}

const FIELD: Record<Metric, (r: ReviewRow) => number> = {
  order: (r) => r.order,
  inventory: (r) => r.endingInventory,
  backlog: (r) => r.endingBacklog,
  shipped: (r) => r.shipped,
  cost: (r) => r.weeklyCostMinor,
};

/**
 * 開示の判定。振り返りは、ゲームが終了してから開示する（プレイ中は、他の役割の値と将来の需要を隠すため）。
 * 判定はここ 1 か所に集める。
 *
 * @landmark 情報の制約の要。振り返りを開示してよいかの判定が、この 1 か所に集まっている（終了後だけ）。他の経路から漏れないよう、判定を散らさない。
 */
export function canDisclose(
  sessionStatus: 'ACTIVE' | 'PAUSED' | 'ENDED' | null,
): boolean {
  return sessionStatus === 'ENDED';
}

/** 役割別の週結果の行から、振り返りの時系列を作る（純粋な関数）。行の順序には依存しない */
export function buildReview(rows: readonly ReviewRow[]): Review {
  const byWeek = new Map<number, Map<Role, ReviewRow>>();
  for (const row of rows) {
    const roles = byWeek.get(row.week) ?? new Map<Role, ReviewRow>();
    roles.set(row.role, row);
    byWeek.set(row.week, roles);
  }
  const weeks = [...byWeek.keys()].sort((a, b) => a - b);
  weeks.forEach((week, i) => {
    if (week !== i + 1) {
      throw new DomainError(
        `週の記録が連続していません（${i + 1} 週目がありません）`,
      );
    }
    const missing = ROLES.filter((r) => !byWeek.get(week)?.has(r));
    if (missing.length > 0) {
      throw new DomainError(
        `${week} 週目の記録が不足しています: ${missing.join('、')}`,
      );
    }
  });

  const series = Object.fromEntries(
    METRICS.map((metric) => [
      metric,
      Object.fromEntries(
        ROLES.map((role) => [
          role,
          weeks.map((w) => FIELD[metric](byWeek.get(w)!.get(role)!)),
        ]),
      ),
    ]),
  ) as Review['series'];

  return {
    weeks,
    demand: weeks.map((w) => byWeek.get(w)!.get('RETAILER')!.demand),
    series,
  };
}
