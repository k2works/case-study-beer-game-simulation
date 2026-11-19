import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useApi, useCatchUp } from '../../api/ApiContext';
import { fetchCaughtUp } from '../../api/catchUp';
import { ApiError } from '../../api/errors';
import { latestOf, weekAdvancedText } from '../../api/problems';
import type { GameState, Role, SessionState } from '../../api/types';
import { ErrorNotice } from '../../components/ErrorNotice';
import { PageHeading } from '../../components/PageHeading';
import {
    ROLE_LABELS,
    WEEK_SEPARATOR,
    decisionFieldLabel,
    editorName,
    formatClock,
} from '../../labels';
import { ConflictNotice, type Conflict } from './ConflictNotice';
import { StatusTable } from './StatusTable';

const STEPS = ['1. 状況を確認', '2. 入力', '3. 確定待ち'] as const;

/** プレイ中に、状態を取り直す間隔（ミリ秒）。終了後は取り直さない。 */
export const PLAY_POLL_MS = 3000;

interface Carried {
    week: number;
    value: string;
}

/** 共同担当の行（2 人以上のときだけ）。自分には「あなた」を添える。 */
const coHoldersText = (coHolders: SessionState['coHolders']): string | null =>
    coHolders !== undefined && coHolders.length >= 2
        ? `共同担当: ${coHolders
              .map((h) => `${h.displayName ?? '共同担当'}${h.isSelf ? '（あなた）' : ''}`)
              .join('、')}`
        : null;

/** 現在の入力の行。最後の保存者と時刻があれば添える（「鈴木さんが 10:42 に保存」）。 */
const currentDecisionText = (status: NonNullable<SessionState['roleStatus']>): string => {
    const base = `現在の入力: ${status.decision ?? '未入力'}`;
    return status.decisionEditor && status.decisionSavedAt
        ? `${base}（${editorName(status.decisionEditor)}が ${formatClock(status.decisionSavedAt)} に保存）`
        : base;
};

/**
 * S05 プレイ（参加者）。B1 の範囲: 自分の役割の状況、数量の入力と保存、確定待ち、週が進んだ場合の表示。
 * 更新は、一定の間隔の自動更新（[PLAY_POLL_MS]）と、手動更新と、保存・確定の応答の後の取得（SSE は B1 の範囲外）。
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
    const [conflict, setConflict] = useState<Conflict | null>(null);

    // 週が変わったときの判定に、描画の値でなく最新の値を使う
    const sessionRef = useRef<SessionState | null>(null);
    const draftRef = useRef('');
    draftRef.current = draft;
    const noticeRef = useRef<HTMLHeadingElement>(null);
    const conflictRef = useRef<HTMLHeadingElement>(null);

    /** 取得したスナップショットを反映する。週が変わっていたら、入力欄を空にし、直前の値を参考に残す。 */
    const applySession = useCallback((next: SessionState) => {
        const previous = sessionRef.current;
        if (previous !== null && previous.week !== next.week) {
            const typed = draftRef.current;
            setCarried(typed === '' ? null : { week: previous.week, value: typed });
            setDraft('');
            setFieldError(null);
            setConflict(null); // 競合は、その週の入力の話。週が進んだら閉じる
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

    // 自動更新: 一定の間隔で、黙って状態を取り直す（ゲーム全体の状態と、自分の役割の状況）。
    // 保存中は取り直さない（保存の応答の取り直しと競合させない）。失敗は表示を消さず、次の回へ回す。終了後は取り直さない。
    const loaded = game !== null;
    const ended = session?.status === 'ENDED' || (session === null && game?.status === 'ENDED');
    const busyRef = useRef(false);
    busyRef.current = busy;
    useEffect(() => {
        if (ended || !loaded) return undefined;
        let cancelled = false;
        const timer = setInterval(() => {
            if (busyRef.current) return;
            void (async () => {
                try {
                    const latestGame = await api.getGameState(gameId);
                    const latestSession =
                        latestGame.sessionId === null
                            ? null
                            : await api.getSessionState(latestGame.sessionId);
                    if (cancelled || busyRef.current) return;
                    setGame(latestGame);
                    if (latestSession !== null) applySession(latestSession);
                } catch {
                    // 次の回で取り直す。表示中の内容は消さない
                }
            })();
        }, PLAY_POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [api, gameId, applySession, ended, loaded]);

    useEffect(() => {
        if (advancedWeek !== null) noticeRef.current?.focus();
    }, [advancedWeek]);

    // 競合の通知が出たら、見出しへフォーカスを移す（気づけるように）
    const conflicted = conflict !== null;
    useEffect(() => {
        if (conflicted) conflictRef.current?.focus();
    }, [conflicted]);

    async function save(event: FormEvent) {
        event.preventDefault();
        if (session === null || session.roleStatus === undefined) return;
        const role = session.role ?? game?.role;
        if (role === undefined) return;
        if (!/^\d+$/.test(draft)) {
            setFieldError(`${decisionFieldLabel(role)}は 0〜1000 の整数で入力してください。`);
            return;
        }
        await submit(session, role, Number(draft), session.roleStatus.decisionVersion);
    }

    /** 数量を、期待する意思決定の版を添えて保存する。競合したときは、入力した値を保持して、競合の通知を出す。 */
    async function submit(at: SessionState, role: Role, quantity: number, expectedVersion: number) {
        setBusy(true);
        setFieldError(null);
        setFailure(null);
        setAdvancedWeek(null);
        setSlow(false);
        const sessionId = at.sessionId;
        try {
            const result = await api.saveDecision(
                sessionId,
                { week: at.week, quantity },
                expectedVersion,
            );
            // 応答は versions だけ。表示は、追いついた取得の結果から作る
            const { snapshot, caughtUp } = await fetchCaughtUp(
                () => api.getSessionState(sessionId),
                result.versions,
                catchUp,
            );
            applySession(snapshot);
            setSlow(!caughtUp);
            setConflict(null);
        } catch (error) {
            await handleSaveFailure(error, role, at, quantity);
        } finally {
            setBusy(false);
        }
    }

    async function handleSaveFailure(
        error: unknown,
        role: NonNullable<SessionState['role']>,
        at: SessionState,
        quantity: number,
    ) {
        const latest =
            error instanceof ApiError && error.code === 'session.decision_conflict'
                ? latestOf(error)
                : null;
        if (latest !== null) {
            // 共同担当が先に保存した。黙って上書きせず、最新の値・保存者を示し、入力した値は保持する
            setConflict({ latest, mine: quantity });
            try {
                applySession(await api.getSessionState(at.sessionId));
            } catch (reloadError) {
                setFailure(reloadError);
            }
        } else if (
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
        } else if (error instanceof ApiError && error.code === 'session.paused') {
            // 保存の直前に停止された。文言を示し、最新の状態（停止中）へ切り替える。入力中の値は保持する
            setFailure(error);
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
                    {coHoldersText(session.coHolders) ? (
                        <p>{coHoldersText(session.coHolders)}</p>
                    ) : null}
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
                        <>
                            <p>終了しました。入力できません。</p>
                            <Link to={`/games/${gameId}/review`}>振り返りを見る</Link>
                        </>
                    ) : (
                        <>
                            <StatusTable roleStatus={roleStatus} />
                            <h2>{role === 'FACTORY' ? '生産要請' : '発注'}</h2>
                            {status === 'PAUSED' ? (
                                <p role="status">停止中です。進行役の再開を待ってください。</p>
                            ) : null}
                            <p>{currentDecisionText(roleStatus)}</p>
                            {conflict ? (
                                <ConflictNotice
                                    conflict={conflict}
                                    busy={busy}
                                    headingRef={conflictRef}
                                    onUseLatest={() => {
                                        setDraft(String(conflict.latest.quantity));
                                        setFieldError(null);
                                        setConflict(null);
                                    }}
                                    onResave={() =>
                                        void submit(
                                            session,
                                            role,
                                            conflict.mine,
                                            conflict.latest.version,
                                        )
                                    }
                                />
                            ) : null}
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
                                        disabled={status === 'PAUSED'}
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
                                <button type="submit" disabled={busy || status === 'PAUSED'}>
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
