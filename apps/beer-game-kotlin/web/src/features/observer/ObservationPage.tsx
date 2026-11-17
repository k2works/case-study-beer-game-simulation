import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { ApiError } from '../../api/errors';
import type { Observation, ObservationWeek } from '../../api/types';
import { ErrorNotice } from '../../components/ErrorNotice';
import { PageHeading } from '../../components/PageHeading';
import { useLoad } from '../../components/useLoad';
import { SESSION_STATUS_LABELS } from '../../labels';

/** プレイ中の観察を取り直す間隔（ミリ秒）。終了後は取り直さない。 */
export const OBSERVATION_POLL_MS = 3000;

const ROLE_COUNT = 4;

const GAME_STATUS_LABELS = {
    PREPARING: '準備中',
    STARTED: '進行中',
    ENDED: '終了',
} as const;

const isHidden = (week: ObservationWeek): boolean => week.hidden === true;

/**
 * S07 観察。現在週・完了状況（入力済みの役割数）・確定した週のチーム合計だけを示す（US4.1）。
 * 役割別の値・将来の需要・参加コードは、API が返さない。合計を出さない理由（公開範囲、寄与者数）は、値の代わりに示す。
 * 観察者の画面は読み取り専用で、操作の部品を持たない。
 */
export function ObservationPage() {
    const { gameId = '' } = useParams();
    const api = useApi();
    const { state, setData } = useLoad(() => api.getObservation(gameId));

    // プレイ中は、確定や入力の進みを反映するため、一定の間隔で取り直す。失敗は黙って次の回へ回す（表示中の内容を消さない）
    const polling = state.status === 'ready' && state.data.status !== 'ENDED';
    useEffect(() => {
        if (!polling) return undefined;
        let cancelled = false;
        const timer = setInterval(() => {
            api.getObservation(gameId).then(
                (latest) => {
                    if (!cancelled) setData(latest);
                },
                () => undefined,
            );
        }, OBSERVATION_POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [api, gameId, polling, setData]);

    if (state.status === 'loading') return <p role="status">観察を読み込み中…</p>;
    if (state.status === 'error') {
        const unauthorized = state.error instanceof ApiError && state.error.status === 403;
        return (
            <>
                <PageHeading title="観察" />
                <ErrorNotice error={state.error} />
                {unauthorized ? <Link to="/observe">観察者として参加する</Link> : null}
            </>
        );
    }
    return <ObservationView observation={state.data} gameId={gameId} />;
}

function ObservationView({ observation, gameId }: { observation: Observation; gameId: string }) {
    const { totals } = observation;
    const sessionLabel =
        observation.sessionStatus === undefined
            ? null
            : SESSION_STATUS_LABELS[observation.sessionStatus];
    return (
        <>
            <PageHeading title="観察" />
            <dl>
                <dt>状態</dt>
                <dd>{GAME_STATUS_LABELS[observation.status]}</dd>
                {observation.week !== undefined ? (
                    <>
                        <dt>現在週</dt>
                        <dd>
                            第 {observation.week} 週（全 {observation.finalWeek} 週）
                            {sessionLabel ? ` ${sessionLabel}` : ''}
                        </dd>
                        <dt>完了状況</dt>
                        <dd>
                            入力済み {observation.submittedRoleCount ?? 0} / {ROLE_COUNT} 役割
                        </dd>
                    </>
                ) : null}
            </dl>

            <h2>チーム合計（確定した週）</h2>
            {totals.hiddenReason === 'DISCLOSURE_NONE' ? (
                <p role="status">進行役の設定により、プレイ中のチーム合計は公開されていません。</p>
            ) : totals.weeks.length === 0 ? (
                <p>まだ確定した週はありません。</p>
            ) : (
                <>
                    <table aria-label="チーム合計の表">
                        <caption>4 役割の合計（役割別の値は表示されません）</caption>
                        <thead>
                            <tr>
                                <th scope="col">週</th>
                                <th scope="col">注文</th>
                                <th scope="col">在庫</th>
                                <th scope="col">受注残</th>
                            </tr>
                        </thead>
                        <tbody>
                            {totals.weeks.map((week) => (
                                <tr key={week.week}>
                                    <td>{week.week}</td>
                                    {isHidden(week) ? (
                                        <td colSpan={3}>非表示（※）</td>
                                    ) : (
                                        <>
                                            <td>{week.order}</td>
                                            <td>{week.inventory}</td>
                                            <td>{week.backlog}</td>
                                        </>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {totals.weeks.some(isHidden) ? (
                        <p className="muted">
                            ※ 合計の対象が 1
                            役割だけの週は、個別の値が分かってしまうため、合計を表示しません。
                        </p>
                    ) : null}
                </>
            )}

            {observation.status === 'ENDED' ? (
                <p>
                    終了しました。<Link to={`/games/${gameId}/review`}>振り返りを見る</Link>
                </p>
            ) : null}
            <p className="muted">
                観察者は、読み取り専用です。役割別の非公開の情報は見られません。
            </p>
        </>
    );
}
