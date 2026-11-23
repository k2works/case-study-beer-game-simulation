/** 需要系列の作り方。一定・増加・減少。 */
export type DemandPattern = 'CONSTANT' | 'INCREASE' | 'DECREASE';

export const DEMAND_PATTERN_LABELS: Record<DemandPattern, string> = {
    CONSTANT: '一定',
    INCREASE: '増加',
    DECREASE: '減少',
};

/** 需要の下限・上限（サーバーの検証と同じ範囲）。 */
const MIN_DEMAND = 0;
const MAX_DEMAND = 1000;

/**
 * 1 週目を [start] とし、増加・減少なら週ごとに [step] ずつ変えて、[weeks] 週分の需要系列を作る。
 * 一定は [step] を使わない。値は 0〜1000 に収める（超える週は上限・下限で止まる）。
 */
export function buildDemand(
    pattern: DemandPattern,
    start: number,
    step: number,
    weeks: number,
): number[] {
    const delta = pattern === 'INCREASE' ? step : pattern === 'DECREASE' ? -step : 0;
    return Array.from({ length: weeks }, (_, week) =>
        Math.min(MAX_DEMAND, Math.max(MIN_DEMAND, start + delta * week)),
    );
}
