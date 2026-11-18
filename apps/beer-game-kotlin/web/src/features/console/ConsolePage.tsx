import { useEffect, useId, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApi, useCatchUp } from '../../api/ApiContext';
import { fetchCaughtUp } from '../../api/catchUp';
import { ApiError } from '../../api/errors';
import { DECISIONS_CHANGED_TEXT, weekAdvancedText } from '../../api/problems';
import type { CommitMode, GameState, Role, RoleWeekResult, SessionState } from '../../api/types';
import { Dialog } from '../../components/Dialog';
import { ErrorNotice } from '../../components/ErrorNotice';
import { PageHeading } from '../../components/PageHeading';
import { SettingsNote } from '../../components/SettingsNote';
import { useLoad } from '../../components/useLoad';
import { ROLE_LABELS, ROLE_ORDER, SESSION_STATUS_LABELS, WEEK_SEPARATOR } from '../../labels';

interface ConsoleData {
    game: GameState;
    /** ゲームが開始される前は null。 */
    session: SessionState | null;
}

/** 確認ダイアログが覚えているもの。開いた時点の週と、各役割の入力の値と版（basis）。 */
interface Confirm {
    week: number;
    values: Record<Role, number | null>;
    basis: Record<Role, number>;
    /** 確定の前に入力が変わって、更新した値で開き直したとき。 */
    reopened: boolean;
}

function confirmFrom(session: SessionState, reopened: boolean): Confirm {
    const values = {} as Record<Role, number | null>;
    const basis = {} as Record<Role, number>;
    for (const role of ROLE_ORDER) {
        values[role] = session.roles?.[role]?.decision ?? null;
        basis[role] = session.roles?.[role]?.decisionVersion ?? 0;
    }
    return { week: session.week, values, basis, reopened };
}

/** 開発用の代理入力の数量の既定。キットの需要の既定（4）。 */
const DEFAULT_DUMMY_QUANTITY = '4';

const MAX_QUANTITY = 1000;

/** 代理入力の数量の入力を、0〜1000 の整数に読む。読めなければ null（サーバーの検証と同じ範囲）。 */
function parseDummyQuantity(text: string): number | null {
    const trimmed = text.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const value = Number(trimmed);
    return value <= MAX_QUANTITY ? value : null;
}

const resultText = (r: RoleWeekResult) =>
    `${ROLE_LABELS[r.role]} 第 ${r.week} 週の結果: 受注 ${r.orders}、発注 ${r.order}、在庫 ${r.inventory}、受注残 ${r.backlog}、出荷 ${r.shipment}、費用 ${r.cost}（累計 ${r.cumulativeCost}）`;

const sortedResults = (results: RoleWeekResult[]) =>
    [...results].sort(
        (a, b) => b.week - a.week || ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role),
    );

/** 停止・再開の確認ダイアログが開いているときの操作。 */
type Control = 'pause' | 'resume';

/**
 * S06 進行役のコンソール。範囲: 各役割の入力状況、「週を確定」と確認ダイアログ、状態の表示、停止・再開（B5 Step 7）。
 * 終了、代理入力、資格の失効・再発行は、B5 の範囲外（判断項目 13。B6 以降）。
 */
export function ConsolePage() {
    const { gameId = '' } = useParams();
    const api = useApi();
    const catchUp = useCatchUp();
    const { state, setData } = useLoad<ConsoleData>(async () => {
        const game = await api.getGameState(gameId);
        return {
            game,
            session: game.sessionId === null ? null : await api.getSessionState(game.sessionId),
        };
    });
    const [confirm, setConfirm] = useState<Confirm | null>(null);
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<unknown>(null);
    const [advancedText, setAdvancedText] = useState<string | null>(null);
    const [control, setControl] = useState<Control | null>(null);
    const [dummyQuantity, setDummyQuantity] = useState(DEFAULT_DUMMY_QUANTITY);
    const [dummyError, setDummyError] = useState<string | null>(null);
    const titleId = useId();
    const controlTitleId = useId();
    const titleRef = useRef<HTMLHeadingElement>(null);
    const noticeRef = useRef<HTMLHeadingElement>(null);
    const controlTitleRef = useRef<HTMLHeadingElement>(null);

    // 停止・再開の確認ダイアログを開いたときは、見出しへフォーカスを移す
    const controlOpened = control !== null;
    useEffect(() => {
        if (controlOpened) controlTitleRef.current?.focus();
    }, [controlOpened]);

    // 確認ダイアログを開いたときは見出しへ、更新した値で開き直したときは通知の見出しへ、フォーカスを移す
    const opened = confirm !== null;
    const reopened = confirm?.reopened === true;
    useEffect(() => {
        if (!opened) return;
        (reopened ? noticeRef : titleRef).current?.focus();
    }, [opened, reopened, confirm?.values]);

    if (state.status === 'loading') return <p role="status">進行役のコンソールを読み込み中…</p>;
    if (state.status === 'error') {
        return (
            <>
                <PageHeading title="進行役のコンソール" />
                <ErrorNotice error={state.error} />
            </>
        );
    }
    const { game, session } = state.data;

    if (session === null) {
        return (
            <>
                <PageHeading title="進行役のコンソール" />
                <p>ゲームはまだ開始されていません。</p>
                <Link to={`/games/${gameId}/lobby`}>ロビーへ</Link>
            </>
        );
    }

    const sessionId = session.sessionId;
    const decided = ROLE_ORDER.filter((role) => session.roles?.[role]?.decision != null);
    const allDecided = decided.length === ROLE_ORDER.length;
    const canCommit = session.status === 'ACTIVE' && allDecided;

    async function commit(target: Confirm) {
        setBusy(true);
        setFailure(null);
        setAdvancedText(null);
        try {
            const result = await api.commitWeek(sessionId, {
                requestedWeek: target.week,
                basis: target.basis,
            });
            // 応答は versions だけ。週の進行と結果は、追いついた取得の結果から表示する
            const { snapshot } = await fetchCaughtUp(
                () => api.getSessionState(sessionId),
                result.versions,
                catchUp,
            );
            setData({ game, session: snapshot });
            setConfirm(null);
        } catch (error) {
            await handleCommitFailure(error, target);
        } finally {
            setBusy(false);
        }
    }

    /**
     * 停止・再開。応答は versions だけ。状態は、追いついた取得の結果から表示する。
     * すでに停止中・停止中でなかった（session.paused・session.not_paused）ときは、その文言を示し、最新の状態へ切り替える。
     */
    async function changeSessionStatus(target: Control) {
        setBusy(true);
        setFailure(null);
        setAdvancedText(null);
        try {
            const result =
                target === 'pause'
                    ? await api.pauseSession(sessionId)
                    : await api.resumeSession(sessionId);
            const { snapshot } = await fetchCaughtUp(
                () => api.getSessionState(sessionId),
                result.versions,
                catchUp,
            );
            setData({ game, session: snapshot });
        } catch (error) {
            setFailure(error);
            if (
                error instanceof ApiError &&
                (error.code === 'session.paused' || error.code === 'session.not_paused')
            ) {
                try {
                    setData({ game, session: await api.getSessionState(sessionId) });
                } catch (reloadError) {
                    setFailure(reloadError);
                }
            }
        } finally {
            setControl(null);
            setBusy(false);
        }
    }

    /**
     * 確定方式の変更（進行中でも停止中でも。AC2.4.5）。有効にしたとき、そろっていれば同じ追記で週が確定するので、
     * 状態と確定方式の両方を、追いついた取得の結果から取り直す。
     */
    async function changeCommitMode(next: CommitMode) {
        setBusy(true);
        setFailure(null);
        setAdvancedText(null);
        try {
            const result = await api.setCommitMode(sessionId, next);
            const { snapshot } = await fetchCaughtUp(
                () => api.getSessionState(sessionId),
                result.versions,
                catchUp,
            );
            setData({ game: await api.getGameState(game.gameId), session: snapshot });
        } catch (error) {
            setFailure(error);
        } finally {
            setBusy(false);
        }
    }

    /**
     * 開発用。未入力の役割を、指定した数量（既定 4）で、現在の週に代理入力する。1 人で週を進めるため。
     * 数量が 0〜1000 の整数でなければ、送らずに範囲を案内する（サーバーの検証と同じ範囲）。
     */
    async function fillWithProxyDecisions(current: SessionState) {
        const quantity = parseDummyQuantity(dummyQuantity);
        if (quantity === null) {
            setDummyError('数量は 0〜1000 の整数で入力してください。');
            return;
        }
        setDummyError(null);
        setBusy(true);
        setFailure(null);
        setAdvancedText(null);
        try {
            let latest = current.versions;
            for (const role of ROLE_ORDER.filter((r) => !decided.includes(r))) {
                const result = await api.submitProxyDecision(sessionId, role, {
                    requestedWeek: current.week,
                    quantity,
                });
                latest = result.versions;
            }
            const { snapshot } = await fetchCaughtUp(
                () => api.getSessionState(sessionId),
                latest,
                catchUp,
            );
            setData({ game, session: snapshot });
        } catch (error) {
            setFailure(error);
        } finally {
            setBusy(false);
        }
    }

    async function handleCommitFailure(error: unknown, target: Confirm) {
        if (error instanceof ApiError && error.code === 'session.decisions_changed') {
            // 更新した値で、確認ダイアログを開き直す（確認してから、もう一度確定する）
            try {
                const latest = await api.getSessionState(sessionId);
                setData({ game, session: latest });
                setConfirm(confirmFrom(latest, true));
            } catch (reloadError) {
                setConfirm(null);
                setFailure(reloadError);
            }
            return;
        }
        setConfirm(null);
        if (error instanceof ApiError && error.code === 'session.week_advanced') {
            setAdvancedText(weekAdvancedText(target.week));
            try {
                setData({ game, session: await api.getSessionState(sessionId) });
            } catch (reloadError) {
                setFailure(reloadError);
            }
            return;
        }
        setFailure(error);
    }

    const results = sortedResults(session.results ?? []);

    return (
        <>
            <PageHeading title="進行役のコンソール" />
            <SettingsNote kind={game.settingsKind} changed={game.changedSettings} />
            {failure ? (
                <ErrorNotice error={failure} extra="最新状態を確認して、再度操作してください。" />
            ) : null}
            {advancedText ? <p role="status">{advancedText}</p> : null}

            <p>{`第 ${session.week} 週${WEEK_SEPARATOR}${SESSION_STATUS_LABELS[session.status]}`}</p>

            {session.status === 'ACTIVE' || session.status === 'PAUSED' ? (
                <p>
                    <span>{`自動確定: ${game.commitMode === 'AUTO' ? '有効' : '無効'}`}</span>{' '}
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                            void changeCommitMode(game.commitMode === 'AUTO' ? 'MANUAL' : 'AUTO')
                        }
                    >
                        {game.commitMode === 'AUTO'
                            ? '自動確定を無効にする'
                            : '自動確定を有効にする'}
                    </button>
                </p>
            ) : null}

            <h2>各役割の入力状況</h2>
            <ul className="roles">
                {ROLE_ORDER.map((role) => {
                    const decision = session.roles?.[role]?.decision ?? null;
                    const labelId = `${titleId}-role-${role}`;
                    return (
                        <li key={role} aria-labelledby={labelId}>
                            <span id={labelId}>{ROLE_LABELS[role]}</span>{' '}
                            <span>{decision === null ? '未入力' : `入力済み: ${decision}`}</span>
                        </li>
                    );
                })}
            </ul>

            {session.status === 'ACTIVE' ? (
                <>
                    <button
                        type="button"
                        disabled={!canCommit || busy}
                        onClick={() => setConfirm(confirmFrom(session, false))}
                    >
                        週を確定
                    </button>
                    {!canCommit ? <p>4 役割の入力が揃うと、週を確定できます。</p> : null}
                    <button type="button" disabled={busy} onClick={() => setControl('pause')}>
                        停止する
                    </button>
                </>
            ) : null}
            {import.meta.env.DEV && session.status === 'ACTIVE' && !allDecided ? (
                <section aria-labelledby="dev-tools-heading">
                    <h2 id="dev-tools-heading">開発用</h2>
                    <p className="muted">
                        1 人で試すための代理入力です。未入力の役割すべてに、指定した数量（0〜1000
                        の整数）を入れます。開発サーバーでだけ表示します。
                    </p>
                    <div className="field">
                        <label htmlFor="dummy-quantity">代理入力の数量</label>
                        <input
                            id="dummy-quantity"
                            inputMode="numeric"
                            value={dummyQuantity}
                            aria-invalid={dummyError !== null}
                            aria-describedby={
                                dummyError === null ? undefined : 'dummy-quantity-error'
                            }
                            onChange={(event) => setDummyQuantity(event.target.value)}
                        />
                        {dummyError === null ? null : (
                            <span id="dummy-quantity-error" className="field-error">
                                {dummyError}
                            </span>
                        )}
                    </div>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={() => void fillWithProxyDecisions(session)}
                    >
                        未入力のダミーの役割を代理入力で埋める
                    </button>
                </section>
            ) : null}
            <p>
                <Link to={`/games/${game.gameId}/retention`}>保持状態を見る</Link>
            </p>
            {session.status === 'ENDED' ? (
                <p>
                    終了しました。<Link to={`/games/${game.gameId}/review`}>振り返りを見る</Link>
                </p>
            ) : null}
            {session.status === 'PAUSED' ? (
                <>
                    <p role="status">停止中です。再開するまで、週を確定できません。</p>
                    <button type="button" disabled={busy} onClick={() => setControl('resume')}>
                        再開する
                    </button>
                </>
            ) : null}

            {results.length > 0 ? (
                <section aria-label="確定した週の結果">
                    <h2>確定した週の結果</h2>
                    <ul>
                        {results.map((result) => (
                            <li key={`${result.week}-${result.role}`}>{resultText(result)}</li>
                        ))}
                    </ul>
                </section>
            ) : null}

            {control ? (
                <Dialog labelledBy={controlTitleId} onClose={() => setControl(null)}>
                    <h2 id={controlTitleId} ref={controlTitleRef} tabIndex={-1}>
                        {control === 'pause'
                            ? `第 ${session.week} 週を一時停止`
                            : `第 ${session.week} 週を再開`}
                    </h2>
                    {control === 'pause' ? (
                        <>
                            <p>
                                {`停止すると、参加者は入力できなくなり、週を確定できなくなります。再開するまで、第 ${session.week} 週のままです。`}
                            </p>
                            <p>入力済みの値は、失われません。</p>
                        </>
                    ) : (
                        <p>{`再開すると、参加者は第 ${session.week} 週の入力を再開できます。`}</p>
                    )}
                    <div className="actions">
                        <button type="button" disabled={busy} onClick={() => setControl(null)}>
                            戻る
                        </button>
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => void changeSessionStatus(control)}
                        >
                            {busy ? '確定中' : control === 'pause' ? '一時停止する' : '再開する'}
                        </button>
                    </div>
                </Dialog>
            ) : null}

            {confirm ? (
                <Dialog labelledBy={titleId} onClose={() => setConfirm(null)}>
                    <h2 id={titleId} ref={titleRef} tabIndex={-1}>
                        {`第 ${confirm.week} 週を確定`}
                    </h2>
                    {confirm.reopened ? (
                        <h3 ref={noticeRef} tabIndex={-1}>
                            {DECISIONS_CHANGED_TEXT}
                        </h3>
                    ) : null}
                    <p>4 役割の入力が揃いました。確定後は編集できません。</p>
                    <ul>
                        {ROLE_ORDER.map((role) => (
                            <li
                                key={role}
                            >{`${ROLE_LABELS[role]}: ${confirm.values[role] ?? '未入力'}`}</li>
                        ))}
                    </ul>
                    <p>
                        次に起きること: 遅延を進め、出荷・在庫・受注残・費用を計算して保存します。
                    </p>
                    <div className="actions">
                        <button type="button" disabled={busy} onClick={() => setConfirm(null)}>
                            戻って確認
                        </button>
                        <button type="button" disabled={busy} onClick={() => void commit(confirm)}>
                            {busy ? '確定中' : `第 ${confirm.week} 週を確定`}
                        </button>
                    </div>
                </Dialog>
            ) : null}
        </>
    );
}
