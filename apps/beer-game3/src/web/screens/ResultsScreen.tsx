import { useEffect, useMemo, useState } from 'react';
import { ROLES, ROLE_LABELS } from '../../server/domain/types.js';
import type { ApiClient, Credential, ResultsView } from '../api.js';
import { COST_MODES, METRICS, valueOf, type CostMode, type MetricId } from '../chart.js';
import { describeError } from '../components.js';
import { formatCents } from '../format.js';
import { RESULTS_MESSAGES } from '../messages.js';
import { Legend, ResultsChart } from '../ResultsChart.js';
import { ExportPanel } from './ExportPanel.js';

interface Props {
  api: ApiClient;
  credential: Credential;
  /** 見出しに示すゲーム名（結果の応答には含まれない） */
  gameName?: string;
  onBack: () => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; view: ResultsView }
  | { status: 'error'; message: string };

const SETUP_LABELS = { kit: 'キット準拠', custom: 'カスタム' } as const;

/**
 * 結果画面（US4.1）。終了したゲームの全役割の時系列を、指標を選んで同じ週の軸に重ねて比較する。
 * 結果は一度だけ取得し、指標や費用の切り替えは再取得しない（NFR8.2）。系列は線種・印・凡例で区別し、
 * グラフと同じ数値の表を併記する。終了前に開こうとしたときは、拒否の理由をそのまま示す（BR22.6）。
 */
export function ResultsScreen({ api, credential, gameName, onBack }: Props) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [metric, setMetric] = useState<MetricId>('cost');
  const [costMode, setCostMode] = useState<CostMode>('cumulative');

  useEffect(() => {
    let alive = true;
    api.getResults(credential).then(
      (view) => {
        if (alive) {
          setLoad({ status: 'ready', view });
        }
      },
      (e: unknown) => {
        if (alive) {
          setLoad({ status: 'error', message: describeError(e) });
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [api, credential]);

  const view = load.status === 'ready' ? load.view : null;
  const def = METRICS.find((m) => m.id === metric)!;
  const isCost = metric === 'cost';
  const title = isCost ? (costMode === 'cumulative' ? '累積費用' : '週ごとの費用') : def.label;
  // 系列の計算は、結果の応答と選択に紐づける（選択を変えたときだけ再計算する）
  const series = useMemo(
    () =>
      view
        ? ROLES.map((role) => ({
            role,
            values: (view.roles.find((r) => r.role === role)?.weeks ?? []).map((week) =>
              valueOf(week, metric, costMode),
            ),
          }))
        : [],
    [view, metric, costMode],
  );

  const facilitator = credential.kind === 'facilitator';

  return (
    <main data-testid={load.status === 'ready' ? 'results-screen' : 'results-pending'}>
      <h1>{RESULTS_MESSAGES.title}</h1>
      <p>
        <button type="button" data-testid="results-back" onClick={onBack}>
          {RESULTS_MESSAGES.back}
        </button>
      </p>

      {load.status === 'loading' ? <p role="status">{RESULTS_MESSAGES.loading}</p> : null}
      {load.status === 'error' ? (
        <p role="alert" data-testid="results-error" className="field-error">
          {load.message}
        </p>
      ) : null}

      {view ? (
        <>
          <p data-testid="results-summary">
            ゲーム: {gameName ?? '—'} / 種別: {SETUP_LABELS[view.setupKind]} / 確定済みの週:{' '}
            {view.confirmedWeeks}（全 {view.weekCount} 週）
          </p>

          {view.confirmedWeeks === 0 ? (
            <p role="status" data-testid="results-empty">
              {RESULTS_MESSAGES.empty}
            </p>
          ) : (
            <>
              <div role="radiogroup" aria-label={RESULTS_MESSAGES.metricGroup} className="choices">
                {METRICS.map((m) => (
                  <label
                    key={m.id}
                    data-testid={`metric-label-${m.id}`}
                    data-selected={metric === m.id}
                    className={metric === m.id ? 'choice selected' : 'choice'}
                  >
                    <input
                      type="radio"
                      name="metric"
                      value={m.id}
                      data-testid={`metric-${m.id}`}
                      checked={metric === m.id}
                      onChange={() => setMetric(m.id)}
                    />{' '}
                    {m.label}
                  </label>
                ))}
              </div>
              {isCost ? (
                <div role="radiogroup" aria-label={RESULTS_MESSAGES.costGroup} className="choices">
                  {COST_MODES.map((mode) => (
                    <label
                      key={mode.id}
                      data-selected={costMode === mode.id}
                      className={costMode === mode.id ? 'choice selected' : 'choice'}
                    >
                      <input
                        type="radio"
                        name="cost-mode"
                        value={mode.id}
                        data-testid={`cost-mode-${mode.id}`}
                        checked={costMode === mode.id}
                        onChange={() => setCostMode(mode.id)}
                      />{' '}
                      {mode.label}
                    </label>
                  ))}
                </div>
              ) : null}

              <ResultsChart
                series={series}
                title={title}
                money={isCost}
                axisLabel={`${title}（${def.unit}）`}
              />
              <Legend />

              <table data-testid="results-table">
                <caption>
                  {title}（{def.unit}）: 週ごと・役割ごと
                </caption>
                <thead>
                  <tr>
                    <th scope="col">週</th>
                    {ROLES.map((role) => (
                      <th key={role} scope="col">
                        {ROLE_LABELS[role]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: view.confirmedWeeks }, (_, index) => (
                    <tr key={index}>
                      <th scope="row">第 {index + 1} 週</th>
                      {series.map(({ role, values }) => (
                        <td key={role}>
                          {isCost ? formatCents(values[index] ?? 0) : String(values[index] ?? 0)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p data-testid="team-total">
                チームの累積費用の合計: <strong>{formatCents(view.teamCumulativeCost)}</strong>
              </p>
            </>
          )}
        </>
      ) : null}

      {facilitator ? <ExportPanel api={api} credential={credential} /> : null}
    </main>
  );
}
