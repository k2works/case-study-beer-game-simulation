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

/**
 * 累計。表示中の役割（需要は含めない）の値を週ごとに合計し、第 1 週からの累計にする。結果が無い週の値は 0 として足す。
 * 棒グラフと累計の表は、同じ値から作る。
 */
export function cumulativeOf(series: readonly Series[]): number[] {
    const roles = series.filter((s) => s.key !== 'DEMAND');
    const weekCount = Math.max(0, ...roles.map((s) => s.values.length));
    let total = 0;
    return Array.from({ length: weekCount }, (_, index) => {
        total += roles.reduce((sum, s) => sum + (s.values[index] ?? 0), 0);
        return total;
    });
}
