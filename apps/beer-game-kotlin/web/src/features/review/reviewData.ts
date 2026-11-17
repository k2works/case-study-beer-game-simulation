import type { Review, Role, RoleWeekResult } from '../../api/types';

/** 振り返りで切り替える指標。値は、`RoleWeekResult` の項目。 */
export type Metric = 'order' | 'inventory' | 'backlog' | 'shipment' | 'cost';

export const METRICS: readonly { key: Metric; label: string }[] = [
    { key: 'order', label: '注文' },
    { key: 'inventory', label: '在庫' },
    { key: 'backlog', label: '受注残' },
    { key: 'shipment', label: '出荷' },
    { key: 'cost', label: '費用' },
];

/** 系列の識別子。需要（顧客からの注文）と、4 役割。 */
export type SeriesKey = Role | 'DEMAND';

export interface Series {
    key: SeriesKey;
    /** 週ごとの値（週 1 から。結果が無い週は null）。 */
    values: (number | null)[];
}

/** 週の一覧（結果にある週を昇順で）。 */
export const weeksOf = (results: readonly RoleWeekResult[]): number[] =>
    [...new Set(results.map((result) => result.week))].sort((a, b) => a - b);

/**
 * 指標ごとの系列。表とグラフは、同じ系列から作る（同じ値を併記する）。
 * 需要は、小売店の `orders`（顧客からの注文）。指標が何であっても同じ。
 */
export function seriesOf(review: Review, metric: Metric): Series[] {
    const weeks = weeksOf(review.results);
    const valueOf = (role: Role, week: number, pick: (r: RoleWeekResult) => number) => {
        const found = review.results.find((r) => r.role === role && r.week === week);
        return found === undefined ? null : pick(found);
    };
    return [
        { key: 'DEMAND', values: weeks.map((week) => valueOf('RETAILER', week, (r) => r.orders)) },
        ...(['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'] as const).map((role): Series => ({
            key: role,
            values: weeks.map((week) => valueOf(role, week, (r) => r[metric])),
        })),
    ];
}
