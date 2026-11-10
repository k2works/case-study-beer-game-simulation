export interface ChartSeries {
  key: string;
  label: string;
  values: number[];
}

interface Props {
  title: string;
  weeks: number[];
  series: ChartSeries[];
  format?: (n: number) => string;
}

const W = 680;
const H = 320;
const M = { left: 52, right: 84, top: 16, bottom: 36 };

/** 色に頼らず区別するための線の種類（系列の順に割り当てる） */
const DASHES = ['', '8 4', '2 3', '10 3 2 3', '1 5'];
const COLORS = [
  'var(--s1)',
  'var(--s2)',
  'var(--s3)',
  'var(--s4)',
  'var(--s5)',
];

const niceMax = (max: number) => {
  if (max <= 5) return 5;
  const pow = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / pow) * pow;
};

/** 週次の折れ線グラフ（手書きの SVG）。同じ値の表を、必ず併記すること */
export function LineChart({ title, weeks, series, format = String }: Props) {
  const n = weeks.length;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const x = (i: number) =>
    M.left + (n <= 1 ? plotW / 2 : (plotW * i) / (n - 1));
  const y = (v: number) => M.top + plotH - (plotH * v) / max;
  const step = Math.max(1, Math.ceil(n / 12));
  const summary = series
    .map(
      (s) =>
        `${s.label}は最大 ${format(Math.max(...s.values))}（最後の週 ${format(s.values[n - 1] ?? 0)}）`,
    )
    .join('、');

  return (
    <svg
      role="img"
      aria-label={`${title}。${weeks[0]}〜${weeks[n - 1]} 週。${summary}`}
      viewBox={`0 0 ${W} ${H}`}
      className="chart"
    >
      <title>{title}</title>
      {[0, 0.5, 1].map((t) => (
        <g key={t}>
          <line
            x1={M.left}
            x2={W - M.right}
            y1={y(max * t)}
            y2={y(max * t)}
            className="grid"
          />
          <text x={M.left - 6} y={y(max * t) + 4} textAnchor="end">
            {format(max * t)}
          </text>
        </g>
      ))}
      {weeks.map((w, i) =>
        i % step === 0 ? (
          <text key={w} x={x(i)} y={H - 12} textAnchor="middle">
            {w}
          </text>
        ) : null,
      )}
      <text x={W - M.right} y={H - 2} textAnchor="end" className="axis-name">
        週
      </text>
      {series.map((s, k) => (
        <g key={s.key}>
          <polyline
            fill="none"
            stroke={COLORS[k % COLORS.length]}
            strokeWidth={2.5}
            {...(DASHES[k % DASHES.length]
              ? { strokeDasharray: DASHES[k % DASHES.length] }
              : {})}
            points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
            data-label={s.label}
            data-values={s.values.map(format).join(',')}
          />
          {/* 直接のラベル（色に頼らない） */}
          <text
            x={x(n - 1) + 6}
            y={y(s.values[n - 1] ?? 0) + 4}
            fill="currentColor"
            className="series-label"
          >
            {s.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
