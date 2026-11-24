import type { ObservationWeek } from '../../api/types';

const WIDTH = 640;
const HEIGHT = 280;
const PAD = { left: 48, right: 72, top: 16, bottom: 32 };

type Metric = 'order' | 'inventory' | 'backlog';

/** チーム合計の系列。色だけに頼らないよう、線の種類も変える。 */
const SERIES: readonly { key: Metric; label: string; color: string; dash?: string }[] = [
    { key: 'order', label: '注文', color: '#1b6ca8' },
    { key: 'inventory', label: '在庫', color: '#2f7d32', dash: '8 4' },
    { key: 'backlog', label: '受注残', color: '#c2570c', dash: '2 4' },
];

/**
 * チーム合計（注文・在庫・受注残）の週次推移の折れ線。値は、併記する表と同じ週ごとの合計から作る。
 * 合計の対象が 1 役割だけの週（非表示）は、点を打たない。役割別の値は、API が返さないので出ない。
 */
export function TeamTotalChart({ weeks }: { weeks: readonly ObservationWeek[] }) {
    const ordered = [...weeks].sort((a, b) => a.week - b.week);
    const shown = ordered.filter((week) => week.hidden !== true);
    const max = Math.max(1, ...shown.flatMap((week) => SERIES.map((s) => week[s.key] ?? 0)));
    const x = (index: number) =>
        PAD.left +
        (ordered.length <= 1 ? 0 : (index / (ordered.length - 1)) * (WIDTH - PAD.left - PAD.right));
    const y = (value: number) =>
        HEIGHT - PAD.bottom - (value / max) * (HEIGHT - PAD.top - PAD.bottom);

    return (
        <svg
            role="img"
            aria-label={`チーム合計の週次推移（${SERIES.map((s) => s.label).join('、')}）。値は下の表と同じです。`}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="trend-chart"
        >
            <line x1={PAD.left} y1={y(0)} x2={WIDTH - PAD.right} y2={y(0)} stroke="#888" />
            <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={y(0)} stroke="#888" />
            <text x={PAD.left - 6} y={y(max) + 4} textAnchor="end" fontSize="11">
                {max}
            </text>
            <text x={PAD.left - 6} y={y(0) + 4} textAnchor="end" fontSize="11">
                0
            </text>
            {ordered.map((week, index) => (
                <text
                    key={week.week}
                    x={x(index)}
                    y={HEIGHT - 10}
                    textAnchor="middle"
                    fontSize="11"
                >
                    {week.week}
                </text>
            ))}
            {SERIES.map((s) => {
                const points = ordered
                    .map((week, index) =>
                        week.hidden === true ? null : { x: x(index), y: y(week[s.key] ?? 0) },
                    )
                    .filter((p): p is { x: number; y: number } => p !== null);
                const last = points.at(-1);
                return (
                    <g key={s.key}>
                        <polyline
                            points={points.map((p) => `${p.x},${p.y}`).join(' ')}
                            fill="none"
                            stroke={s.color}
                            strokeWidth="2"
                            strokeDasharray={s.dash}
                        />
                        {last ? (
                            <text x={last.x + 6} y={last.y + 4} fontSize="11" fill={s.color}>
                                {s.label}
                            </text>
                        ) : null}
                    </g>
                );
            })}
        </svg>
    );
}
