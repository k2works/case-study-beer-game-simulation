import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  ApiError,
  type Metric,
  type ReviewView,
  type Role,
} from '../api/types.js';
import { ErrorMessage, Page } from '../components.js';
import { LineChart, type ChartSeries } from '../components/line-chart.js';
import { useApi } from '../hooks.js';
import {
  DEMAND_METRICS,
  METRIC_LABEL,
  METRIC_ORDER,
  ROLE_LABEL,
  ROLE_ORDER,
  formatMoney,
} from '../labels.js';

/** 下流（小売店）から上流（工場）の順。ブルウィップ効果が見えるよう、需要を最後に置く */
const ROLES_DOWNSTREAM_FIRST: Role[] = [...ROLE_ORDER].reverse();
type SeriesKey = Role | 'DEMAND';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; review: ReviewView }
  | { kind: 'locked'; message: string }
  | { kind: 'failed' };

export function ReviewScreen() {
  const { id = '' } = useParams();
  const api = useApi();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [metric, setMetric] = useState<Metric>('order');
  const [selected, setSelected] = useState<Set<SeriesKey>>(
    new Set([...ROLES_DOWNSTREAM_FIRST, 'DEMAND']),
  );

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      setState({ kind: 'ready', review: await api.review(id) });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        navigate('/join', { state: { message: e.message } });
        return;
      }
      if (e instanceof ApiError && e.status === 403) {
        setState({ kind: 'locked', message: e.message });
      } else {
        setState({ kind: 'failed' });
      }
    }
  }, [api, id, navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (key: SeriesKey) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (state.kind === 'loading') {
    return (
      <Page title="振り返り">
        <p>読み込み中です</p>
      </Page>
    );
  }
  if (state.kind === 'locked') {
    return (
      <Page title="振り返り">
        <p role="status">
          {state.message}。終了したら、ここで役割別に見比べられます。
        </p>
      </Page>
    );
  }
  if (state.kind === 'failed') {
    return (
      <Page title="振り返り">
        <ErrorMessage error={new Error('振り返りを読み込めませんでした。')} />
        <button type="button" onClick={() => void load()}>
          再読み込み
        </button>
      </Page>
    );
  }

  const { review } = state;
  if (review.weeks.length === 0) {
    return (
      <Page title="振り返り">
        <p role="status">データなし</p>
      </Page>
    );
  }

  const isCost = metric === 'cost';
  const format = (n: number) => (isCost ? formatMoney(n) : String(n));
  const showDemand = DEMAND_METRICS.has(metric);
  const series: ChartSeries[] = [
    ...ROLES_DOWNSTREAM_FIRST.filter((r) => selected.has(r)).map((r) => ({
      key: r,
      label: ROLE_LABEL[r],
      values: review.series[metric][r],
    })),
    ...(showDemand && selected.has('DEMAND')
      ? [{ key: 'DEMAND', label: '需要', values: review.demand }]
      : []),
  ];
  const label = METRIC_LABEL[metric];

  return (
    <Page title="振り返り">
      <p>
        需要と、役割ごとの推移を、同じ週の軸で比べます。上流ほど注文が大きく揺れていないか、見てみましょう。
      </p>
      <fieldset>
        <legend>指標</legend>
        {METRIC_ORDER.map((m) => (
          <label key={m} className="inline">
            <input
              type="radio"
              name="metric"
              checked={metric === m}
              onChange={() => setMetric(m)}
            />
            {METRIC_LABEL[m]}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>表示する系列</legend>
        {ROLES_DOWNSTREAM_FIRST.map((r) => (
          <label key={r} className="inline">
            <input
              type="checkbox"
              checked={selected.has(r)}
              onChange={() => toggle(r)}
            />
            {ROLE_LABEL[r]}
          </label>
        ))}
        {showDemand && (
          <label className="inline">
            <input
              type="checkbox"
              checked={selected.has('DEMAND')}
              onChange={() => toggle('DEMAND')}
            />
            需要
          </label>
        )}
      </fieldset>
      {series.length === 0 ? (
        <p role="status">表示する系列を選んでください</p>
      ) : (
        <>
          <LineChart
            title={`${label}の週次推移`}
            weeks={review.weeks}
            series={series}
            format={format}
          />
          <table aria-label={`${label}の週次の値（グラフと同じ値）`}>
            <thead>
              <tr>
                <th scope="col">週</th>
                {series.map((s) => (
                  <th key={s.key} scope="col">
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {review.weeks.map((w, i) => (
                <tr key={w}>
                  <th scope="row">{w}</th>
                  {series.map((s) => (
                    <td key={s.key}>{format(s.values[i] ?? 0)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Page>
  );
}
