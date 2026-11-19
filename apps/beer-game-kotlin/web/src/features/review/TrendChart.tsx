import { ROLE_LABELS } from '../../labels';
import type { Series, SeriesKey } from './reviewData';

const WIDTH = 640;
const HEIGHT = 280;
const PAD = { left: 48, right: 72, top: 16, bottom: 32 };

/** 色だけに頼らないよう、系列ごとに線の種類を変える。 */
const DASH: Record<SeriesKey, string | undefined> = {
    DEMAND: '2 4',
    RETAILER: undefined,
    WHOLESALER: '8 4',
    DISTRIBUTOR: '4 3',
    FACTORY: '10 3 2 3',
};
const COLOR: Record<SeriesKey, string> = {
    DEMAND: '#555555',
    RETAILER: '#1b6ca8',
    WHOLESALER: '#c2570c',
    DISTRIBUTOR: '#2f7d32',
    FACTORY: '#8e3b8e',
};

export const seriesLabel = (key: SeriesKey) => (key === 'DEMAND' ? '需要' : ROLE_LABELS[key]);

/** 週次推移の折れ線。線の種類と、終点の直接のラベルで区別する。値は、併記する表と同じ系列から作る。 */
export function TrendChart({
    weeks,
    series,
    metricLabel,
    cumulative = [],
}: {
    weeks: readonly number[];
    series: readonly Series[];
    metricLabel: string;
    /** 週ごとの累計。あれば、折れ線の後ろに棒グラフで重ねる（縦軸は折れ線と別で、最大値を右上に示す）。 */
    cumulative?: readonly number[];
}) {
    const cumulativeMax = Math.max(1, ...cumulative);
    const barWidth = Math.max(
        2,
        ((WIDTH - PAD.left - PAD.right) / Math.max(weeks.length, 1)) * 0.5,
    );
    const values = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
    const max = Math.max(1, ...values);
    const min = Math.min(0, ...values);
    const x = (index: number) =>
        PAD.left +
        (weeks.length <= 1 ? 0 : (index / (weeks.length - 1)) * (WIDTH - PAD.left - PAD.right));
    const y = (value: number) =>
        HEIGHT - PAD.bottom - ((value - min) / (max - min)) * (HEIGHT - PAD.top - PAD.bottom);

    return (
        <svg
            role="img"
            aria-label={`${metricLabel}の週次推移（${series.map((s) => seriesLabel(s.key)).join('、')}）${cumulative.length > 0 ? 'と累計の棒グラフ' : ''}。値は下の表と同じです。`}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="trend-chart"
        >
            {cumulative.map((value, index) => {
                const top =
                    HEIGHT - PAD.bottom - (value / cumulativeMax) * (HEIGHT - PAD.top - PAD.bottom);
                return (
                    <rect
                        key={weeks[index] ?? index}
                        className="cumulative-bar"
                        x={x(index) - barWidth / 2}
                        y={top}
                        width={barWidth}
                        height={HEIGHT - PAD.bottom - top}
                        fill="#9aa5b1"
                        fillOpacity="0.45"
                    />
                );
            })}
            {cumulative.length > 0 ? (
                <text x={WIDTH - PAD.right + 6} y={PAD.top + 4} fontSize="10" fill="#555">
                    {`累計の最大 ${cumulativeMax}`}
                </text>
            ) : null}
            <line x1={PAD.left} y1={y(min)} x2={WIDTH - PAD.right} y2={y(min)} stroke="#888" />
            <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={y(min)} stroke="#888" />
            <text x={PAD.left - 6} y={y(max) + 4} textAnchor="end" fontSize="11">
                {max}
            </text>
            <text x={PAD.left - 6} y={y(min) + 4} textAnchor="end" fontSize="11">
                {min}
            </text>
            {weeks.map((week, index) => (
                <text key={week} x={x(index)} y={HEIGHT - 10} textAnchor="middle" fontSize="11">
                    {week}
                </text>
            ))}
            {series.map((s) => {
                const points = s.values
                    .map((value, index) => (value === null ? null : `${x(index)},${y(value)}`))
                    .filter((p): p is string => p !== null);
                const last = s.values.findLastIndex((v) => v !== null);
                return (
                    <g key={s.key}>
                        <polyline
                            points={points.join(' ')}
                            fill="none"
                            stroke={COLOR[s.key]}
                            strokeWidth="2"
                            strokeDasharray={DASH[s.key]}
                        />
                        {last >= 0 ? (
                            <text
                                x={x(last) + 6}
                                y={y(s.values[last] ?? 0) + 4}
                                fontSize="11"
                                fill={COLOR[s.key]}
                            >
                                {seriesLabel(s.key)}
                            </text>
                        ) : null}
                    </g>
                );
            })}
        </svg>
    );
}
