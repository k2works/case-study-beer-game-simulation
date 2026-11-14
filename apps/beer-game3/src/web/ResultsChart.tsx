import type { ReactElement } from 'react';
import { ROLES, ROLE_LABELS, type Role } from '../server/domain/types.js';
import { SERIES_STYLES, niceCeiling, showMarker, weekTicks, type MarkerShape } from './chart.js';
import { formatCents } from './format.js';

export interface ChartSeries {
  role: Role;
  /** 第 1 週から順に、4 役割で同じ長さ */
  values: number[];
}

interface Props {
  series: ChartSeries[];
  /** グラフの題（例: 累積費用） */
  title: string;
  /** 縦軸が金額（整数のセント）のとき true */
  money: boolean;
  /** 縦軸の説明（単位） */
  axisLabel: string;
}

const WIDTH = 640;
const HEIGHT = 320;
const MARGIN = { left: 68, right: 16, top: 16, bottom: 44 };

/** 系列の色。ダークテーマでは CSS の変数が明るい色に替える（既定は白い背景で 3:1 以上の色）。 */
const colorOf = (role: Role): string => `var(--series-${role}, ${SERIES_STYLES[role].color})`;

/** 印（丸、四角、三角、ひし形）。線種と合わせて、色を取り除いても系列を区別できる（BR22.2）。 */
export function Marker({
  shape,
  x,
  y,
  color,
}: {
  shape: MarkerShape;
  x: number;
  y: number;
  color: string;
}): ReactElement {
  const common = { fill: color, stroke: 'var(--bg)', strokeWidth: 1, 'data-marker': shape };
  switch (shape) {
    case 'circle':
      return <circle cx={x} cy={y} r={4} {...common} />;
    case 'square':
      return <rect x={x - 4} y={y - 4} width={8} height={8} {...common} />;
    case 'triangle':
      return <polygon points={`${x},${y - 5} ${x - 5},${y + 4} ${x + 5},${y + 4}`} {...common} />;
    case 'diamond':
      return (
        <polygon points={`${x},${y - 5} ${x + 5},${y} ${x},${y + 5} ${x - 5},${y}`} {...common} />
      );
  }
}

/** 凡例: 役割ごとに、グラフと同じ線種・印と、役割名を示す。 */
export function Legend(): ReactElement {
  return (
    <ul data-testid="legend" aria-label="凡例" className="legend">
      {ROLES.map((role) => {
        const style = SERIES_STYLES[role];
        return (
          <li key={role} data-testid={`legend-${role}`}>
            <svg width={56} height={16} aria-hidden="true" focusable="false">
              <line
                x1={2}
                y1={8}
                x2={54}
                y2={8}
                stroke={colorOf(role)}
                strokeWidth={2}
                strokeDasharray={style.dash}
                data-dash={style.dash}
              />
              <Marker shape={style.marker} x={28} y={8} color={colorOf(role)} />
            </svg>{' '}
            <span>{ROLE_LABELS[role]}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 折れ線グラフ（SVG、BR22.1）。横軸が週、縦軸が選んだ指標。4 役割の系列を同じ軸に重ね、
 * 線種と印と凡例で区別する。グラフと同じ数値の表が下にあり、グラフが読めない人も同じ情報を得られる（BR22.4）。
 */
export function ResultsChart({ series, title, money, axisLabel }: Props): ReactElement {
  const weeks = series[0]?.values.length ?? 0;
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const max = niceCeiling(Math.max(0, ...series.flatMap((s) => s.values)));
  const x = (week: number): number =>
    MARGIN.left + (weeks <= 1 ? plotWidth / 2 : ((week - 1) / (weeks - 1)) * plotWidth);
  const y = (value: number): number => MARGIN.top + plotHeight - (value / max) * plotHeight;
  const label = (value: number): string =>
    money ? formatCents(Math.round(value)) : String(Math.round(value * 10) / 10);
  const grid = [0, 1, 2, 3, 4].map((i) => (max * i) / 4);

  return (
    <svg
      data-testid="results-chart"
      role="img"
      aria-label={`${title}の折れ線グラフ。横軸は週、縦軸は${axisLabel}。4 役割の系列を重ねています。同じ数値は下の表にあります`}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="chart"
    >
      <g aria-hidden="true">
        {grid.map((value) => (
          <g key={value}>
            <line
              x1={MARGIN.left}
              x2={WIDTH - MARGIN.right}
              y1={y(value)}
              y2={y(value)}
              className="chart-grid"
            />
            <text x={MARGIN.left - 6} y={y(value) + 4} textAnchor="end" className="chart-text">
              {label(value)}
            </text>
          </g>
        ))}
        {weekTicks(weeks).map((week) => (
          <text
            key={week}
            x={x(week)}
            y={HEIGHT - MARGIN.bottom + 18}
            textAnchor="middle"
            className="chart-text"
            data-axis="week"
          >
            {week}
          </text>
        ))}
        <text
          x={MARGIN.left + plotWidth / 2}
          y={HEIGHT - 6}
          textAnchor="middle"
          className="chart-text"
        >
          週
        </text>
      </g>
      {series.map(({ role, values }) => {
        const style = SERIES_STYLES[role];
        return (
          <g key={role} data-testid={`series-${role}`}>
            <polyline
              data-testid={`line-${role}`}
              data-values={values.join(',')}
              points={values
                .map((value, i) => `${x(i + 1).toFixed(1)},${y(value).toFixed(1)}`)
                .join(' ')}
              fill="none"
              stroke={colorOf(role)}
              strokeWidth={2}
              strokeDasharray={style.dash}
            />
            {values.map((value, i) =>
              showMarker(i + 1, weeks) ? (
                <Marker
                  key={i}
                  shape={style.marker}
                  x={x(i + 1)}
                  y={y(value)}
                  color={colorOf(role)}
                />
              ) : null,
            )}
          </g>
        );
      })}
    </svg>
  );
}
