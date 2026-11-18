import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { ApiError } from '../../api/errors';
import { describeProblem } from '../../api/problems';
import { ErrorNotice } from '../../components/ErrorNotice';
import { PageHeading } from '../../components/PageHeading';
import { ResultsTable } from '../../components/ResultsTable';
import { SettingsNote } from '../../components/SettingsNote';
import { useLoad } from '../../components/useLoad';
import { RetentionNotice } from '../retention/RetentionNotice';
import { ExportButtons } from './ExportButtons';
import { METRICS, seriesOf, weeksOf, type Metric, type SeriesKey } from './reviewData';
import { TrendChart, seriesLabel } from './TrendChart';

const ALL_SERIES: readonly SeriesKey[] = [
    'DEMAND',
    'RETAILER',
    'WHOLESALER',
    'DISTRIBUTOR',
    'FACTORY',
];

/** S08 振り返り（役割別）。終了後に、需要と 4 役割の推移を、指標・役割を切り替えて比較する（US4.2）。 */
export function ReviewPage() {
    const { gameId = '' } = useParams();
    const api = useApi();
    const { state } = useLoad(() => api.getReview(gameId));
    // 進行役だけが、結果を出力できる（進行役の項目 joinCode を持つ投影）。取得できなければ、出力のボタンだけを示さない
    const { state: whoAmI } = useLoad(() =>
        api.getGameState(gameId).then(
            (game) => game.joinCode !== undefined,
            () => false,
        ),
    );
    const [metric, setMetric] = useState<Metric>('order');
    const [shown, setShown] = useState<ReadonlySet<SeriesKey>>(new Set(ALL_SERIES));

    if (state.status === 'loading') return <p role="status">振り返りを読み込み中…</p>;
    if (state.status === 'error') {
        const notEnded = state.error instanceof ApiError && state.error.code === 'game.not_ended';
        return (
            <>
                <PageHeading title="振り返り" />
                {notEnded ? (
                    <p role="status">{describeProblem(state.error).text}</p>
                ) : (
                    <ErrorNotice error={state.error} />
                )}
            </>
        );
    }

    const review = state.data;
    const weeks = weeksOf(review.results);
    const metricLabel = METRICS.find((m) => m.key === metric)?.label ?? '';

    if (review.results.length === 0) {
        return (
            <>
                <PageHeading title="振り返り" />
                <p>データなし</p>
            </>
        );
    }

    const series = seriesOf(review, metric).filter((s) => shown.has(s.key));

    function toggle(key: SeriesKey) {
        const next = new Set(shown);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        setShown(next);
    }

    return (
        <>
            <PageHeading title="振り返り" />
            {whoAmI.status === 'ready' && whoAmI.data ? <RetentionNotice gameId={gameId} /> : null}
            <SettingsNote kind={review.settingsKind} changed={review.changedSettings} />

            <fieldset>
                <legend>指標</legend>
                {METRICS.map((m) => (
                    <label key={m.key}>
                        <input
                            type="radio"
                            name="metric"
                            checked={metric === m.key}
                            onChange={() => setMetric(m.key)}
                        />
                        {m.label}
                    </label>
                ))}
            </fieldset>
            <fieldset>
                <legend>役割</legend>
                {ALL_SERIES.map((key) => (
                    <label key={key}>
                        <input
                            type="checkbox"
                            checked={shown.has(key)}
                            onChange={() => toggle(key)}
                        />
                        {seriesLabel(key)}
                    </label>
                ))}
            </fieldset>

            <TrendChart weeks={weeks} series={series} metricLabel={metricLabel} />

            <div className="table-scroll">
                <table className="results-table" aria-label="週次推移の表">
                    <caption>{metricLabel}の週次推移（グラフと同じ値）</caption>
                    <thead>
                        <tr>
                            <th scope="col">週</th>
                            {series.map((s) => (
                                <th key={s.key} scope="col">
                                    {seriesLabel(s.key)}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {weeks.map((week, index) => (
                            <tr key={week}>
                                <td>{week}</td>
                                {series.map((s) => (
                                    <td key={s.key}>{s.values[index] ?? '—'}</td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <h2>全週の結果</h2>
            <p className="muted">指標や役割の切り替えに関わらず、全役割・全指標を示します。</p>
            <ResultsTable results={review.results} label="全週の結果の表" newestFirst={false} />
            {whoAmI.status === 'ready' && whoAmI.data ? <ExportButtons gameId={gameId} /> : null}
            <p>
                <Link to="/">はじめるへ戻る</Link>
            </p>
        </>
    );
}
