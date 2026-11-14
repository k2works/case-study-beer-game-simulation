import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { useApi, useCatchUp } from '../../api/ApiContext';
import { fetchCaughtUp } from '../../api/catchUp';
import { ApiError } from '../../api/errors';
import { weekAdvancedText } from '../../api/problems';
import type { GameState, SessionState } from '../../api/types';
import { ErrorNotice } from '../../components/ErrorNotice';
import { PageHeading } from '../../components/PageHeading';
import { ROLE_LABELS, WEEK_SEPARATOR, decisionFieldLabel } from '../../labels';

const STEPS = ['1. 状況を確認', '2. 入力', '3. 確定待ち'] as const;

interface Carried {
    week: number;
    value: string;
}

/**
 * S05 プレイ（参加者）。B1 の範囲: 自分の役割の状況、数量の入力と保存、確定待ち、週が進んだ場合の表示。
 * 更新は、手動更新と、保存・確定の応答の後の取得だけ（SSE による自動更新は B1 の範囲外）。
 */
export function PlayPage() {
    const { gameId = '' } = useParams();
    const api = useApi();
    const catchUp = useCatchUp();

    const [game, setGame] = useState<GameState | null>(null);
    const [session, setSession] = useState<SessionState | null>(null);
    const [loading, setLoading] = useState(true);
    const [failure, setFailure] = useState<unknown>(null);
    const [draft, setDraft] = useState('');
    const [fieldError, setFieldError] = useState<string | null>(null);
    const [carried, setCarried] = useState<Carried | null>(null);
    const [advancedWeek, setAdvancedWeek] = useState<number | null>(null);
    const [slow, setSlow] = useState(false);
    const [busy, setBusy] = useState(false);

    // 週が変わったときの判定に、描画の値でなく最新の値を使う
    const sessionRef = useRef<SessionState | null>(null);
    const draftRef = useRef('');
    draftRef.current = draft;
    const noticeRef = useRef<HTMLHeadingElement>(null);

    /** 取得したスナップショットを反映する。週が変わっていたら、入力欄を空にし、直前の値を参考に残す。 */
    const applySession = useCallback((next: SessionState) => {
        const previous = sessionRef.current;
        if (previous !== null && previous.week !== next.week) {
            const typed = draftRef.current;
            setCarried(typed === '' ? null : { week: previous.week, value: typed });
            setDraft('');
            setFieldError(null);
        }
        sessionRef.current = next;
        setSession(next);
    }, []);

    const refresh = useCallback(async () => {
        setLoading(true);
        setFailure(null);
        try {
            const latest = await api.getGameState(gameId);
            setGame(latest);
            if (latest.sessionId !== null) {
                applySession(await api.getSessionState(latest.sessionId));
            }
        } catch (error) {
            setFailure(error);
        } finally {
            setLoading(false);
        }
    }, [api, gameId, applySession]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    useEffect(() => {
        if (advancedWeek !== null) noticeRef.current?.focus();
    }, [advancedWeek]);

    async function save(event: FormEvent) {
        event.preventDefault();
        if (session === null || session.roleStatus === undefined) return;
        const role = session.role ?? game?.role;
        if (role === undefined) return;
        if (!/^\d+$/.test(draft)) {
            setFieldError(`${decisionFieldLabel(role)}は 0〜1000 の整数で入力してください。`);
            return;
        }
        setBusy(true);
        setFieldError(null);
        setFailure(null);
        setAdvancedWeek(null);
        setSlow(false);
        const sessionId = session.sessionId;
        try {
            const result = await api.saveDecision(
                sessionId,
                { week: session.week, quantity: Number(draft) },
                session.roleStatus.decisionVersion,
            );
            // 応答は versions だけ。表示は、追いついた取得の結果から作る
            const { snapshot, caughtUp } = await fetchCaughtUp(
                () => api.getSessionState(sessionId),
                result.versions,
                catchUp,
            );
            applySession(snapshot);
            setSlow(!caughtUp);
        } catch (error) {
            await handleSaveFailure(error, role, session);
        } finally {
            setBusy(false);
        }
    }

    async function handleSaveFailure(
        error: unknown,
        role: NonNullable<SessionState['role']>,
        at: SessionState,
    ) {
        if (
            error instanceof ApiError &&
            error.status === 422 &&
            error.errors.some((e) => e.field === 'quantity')
        ) {
            setFieldError(`${decisionFieldLabel(role)}は 0〜1000 の整数で入力してください。`);
        } else if (error instanceof ApiError && error.code === 'session.week_advanced') {
            setAdvancedWeek(at.week);
            try {
                applySession(await api.getSessionState(at.sessionId));
            } catch (reloadError) {
                setFailure(reloadError);
            }
        } else {
            setFailure(error);
        }
    }

    if (loading && session === null && game === null)
        return <p role="status">プレイ画面を読み込み中…</p>;
    if (failure && game === null) {
        return (
            <>
                <PageHeading title="プレイ" />
                <ErrorNotice error={failure} />
            </>
        );
    }

    const role = session?.role ?? game?.role;
    const status = session?.status ?? (game?.status === 'ENDED' ? 'ENDED' : undefined);
    const roleStatus = session?.roleStatus;

    return (
        <>
            <PageHeading title="プレイ" />
            {failure ? <ErrorNotice error={failure} /> : null}
            <button type="button" onClick={() => void refresh()} disabled={loading}>
                手動更新
            </button>

            {session === null || role === undefined ? (
                <p role="status">進行役が開始するまでお待ちください。</p>
            ) : (
                <>
                    {advancedWeek !== null ? (
                        <section className="notice">
                            <h2 ref={noticeRef} tabIndex={-1}>
                                {weekAdvancedText(advancedWeek)}
                            </h2>
                            <p>{`第 ${session.week} 週が始まっています。最新の状況を表示しました。`}</p>
                        </section>
                    ) : null}
                    <p>{`第 ${session.week} 週${WEEK_SEPARATOR}${ROLE_LABELS[role]}`}</p>
                    <ol aria-label="週の進行" className="steps">
                        {STEPS.map((step, index) => {
                            // 入力前は「入力」、保存した後は「確定待ち」（進行役の確定を待つ）
                            const current =
                                roleStatus?.decision === null || roleStatus === undefined ? 1 : 2;
                            return (
                                <li
                                    key={step}
                                    aria-current={index === current ? 'step' : undefined}
                                >
                                    {step}
                                </li>
                            );
                        })}
                    </ol>
                    {slow ? (
                        <p aria-live="polite">
                            保存は完了しています。更新に時間がかかっています。「手動更新」を押してください。
                        </p>
                    ) : null}

                    {status === 'ENDED' || roleStatus === undefined ? (
                        <p>終了しました。入力できません。</p>
                    ) : (
                        <>
                            <dl className="status-list">
                                <dt>在庫</dt>
                                <dd>{roleStatus.inventory}</dd>
                                <dt>受注残</dt>
                                <dd>{roleStatus.backlog}</dd>
                                <dt>入荷</dt>
                                <dd>{roleStatus.arrivals}</dd>
                                <dt>受注</dt>
                                <dd>{roleStatus.orders}</dd>
                                {roleStatus.customerDemand !== undefined ? (
                                    <>
                                        <dt>顧客需要</dt>
                                        <dd>{roleStatus.customerDemand}</dd>
                                    </>
                                ) : null}
                            </dl>
                            <h2>{role === 'FACTORY' ? '生産要請' : '発注'}</h2>
                            <p>{`現在の入力: ${roleStatus.decision ?? '未入力'}`}</p>
                            {carried ? (
                                <p>{`第 ${carried.week} 週に入力していた値: ${carried.value}（未保存）`}</p>
                            ) : null}
                            <form onSubmit={save} noValidate>
                                <div className="field">
                                    <label htmlFor="quantity">{decisionFieldLabel(role)}</label>
                                    <input
                                        id="quantity"
                                        inputMode="numeric"
                                        value={draft}
                                        onChange={(event) => setDraft(event.target.value)}
                                        aria-invalid={fieldError ? true : undefined}
                                        aria-describedby={fieldError ? 'quantity-error' : undefined}
                                    />
                                    {fieldError ? (
                                        <p id="quantity-error" className="field-error">
                                            {fieldError}
                                        </p>
                                    ) : null}
                                </div>
                                <button type="submit" disabled={busy}>
                                    発注を保存
                                </button>
                            </form>
                        </>
                    )}
                </>
            )}
        </>
    );
}
