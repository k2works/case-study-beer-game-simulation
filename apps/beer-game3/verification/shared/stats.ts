/** タイムアウトと接続の失敗を、標本から落とさずに入れる値（ミリ秒。要求のタイムアウトと同じ 5 秒）。 */
export const TIMEOUT_SAMPLE_MS = 5000;

/** 新しい週が 10 秒たっても現れなかった画面の標本の値（ミリ秒）。 */
export const MISSING_REFLECTION_SAMPLE_MS = 10000;

/** 要求のタイムアウト（ミリ秒）。 */
export const REQUEST_TIMEOUT_MS = TIMEOUT_SAMPLE_MS;

/** 最近順位法（昇順に並べた n 件の ceil(p × n) 番目）の百分位。標本がなければ null。入力は書き換えない。 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

export interface Stat {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export function summarize(values: readonly number[]): Stat {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
  };
}
