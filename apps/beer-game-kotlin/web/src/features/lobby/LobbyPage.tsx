import { useEffect, useId, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useApi, useCatchUp } from '../../api/ApiContext';
import { fetchCaughtUp } from '../../api/catchUp';
import { ApiError } from '../../api/errors';
import type { Lobby, LobbyParticipant, Role, StreamVersions } from '../../api/types';
import { Dialog } from '../../components/Dialog';
import { ErrorNotice } from '../../components/ErrorNotice';
import { PageHeading } from '../../components/PageHeading';
import { SettingsNote } from '../../components/SettingsNote';
import { useLoad } from '../../components/useLoad';
import { ROLE_LABELS, ROLE_ORDER } from '../../labels';

const missingRolesText = (roles: readonly Role[]) =>
    `各役割に 1 人以上が必要です。（不足: ${roles.map((role) => ROLE_LABELS[role]).join('、')}）`;

const nameOf = (participant: LobbyParticipant) => participant.displayName ?? '（表示名なし）';

/** 他の人の参加を反映するため、準備中のロビーを取り直す間隔（ミリ秒）。 */
export const LOBBY_POLL_MS = 3000;

interface Pending {
    participant: LobbyParticipant;
    target: Role;
}

/** S04 ロビー（進行役）。B1 の範囲: 参加者の一覧、役割の割り当て（付け替えの確認）、不足の表示、開始。 */
export function LobbyPage() {
    const { gameId = '' } = useParams();
    const api = useApi();
    const catchUp = useCatchUp();
    const navigate = useNavigate();
    const { state, setData } = useLoad(() => api.getLobby(gameId));
    const [selected, setSelected] = useState<Record<string, Role | ''>>({});
    const [pending, setPending] = useState<Pending | null>(null);
    const [failure, setFailure] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);
    const idPrefix = useId();

    // 準備中は、他の人の参加を反映するため、一定の間隔でロビーを取り直す。
    // 操作中（busy）と確認ダイアログの表示中は取り直さない。失敗は黙って次の回へ回す（表示中のロビーを消さない）。
    // 資格がなくなった（403）ときは、黙らず失敗を示し、取り直しをやめる（別の人として参加したブラウザなど）。
    const unauthorized = failure instanceof ApiError && failure.status === 403;
    const polling = state.status === 'ready' && state.data.status === 'PREPARING' && !unauthorized;
    const paused = busy || pending !== null;
    useEffect(() => {
        if (!polling || paused) return undefined;
        let cancelled = false;
        const timer = setInterval(() => {
            api.getLobby(gameId).then(
                (latest) => {
                    if (!cancelled) setData(latest);
                },
                (error: unknown) => {
                    if (!cancelled && error instanceof ApiError && error.status === 403) {
                        setFailure(error);
                    }
                },
            );
        }, LOBBY_POLL_MS);
        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [api, gameId, polling, paused, setData]);

    if (state.status === 'loading') return <p role="status">ロビーを読み込み中…</p>;
    if (state.status === 'error') {
        return (
            <>
                <PageHeading title="ロビー" />
                <ErrorNotice error={state.error} />
            </>
        );
    }
    const lobby = state.data;

    const assignedRoles = new Set(lobby.participants.flatMap((p) => (p.role ? [p.role] : [])));
    const missing = ROLE_ORDER.filter((role) => !assignedRoles.has(role));

    async function assign(participant: LobbyParticipant, role: Role) {
        setBusy(true);
        setFailure(null);
        setPending(null);
        try {
            const result = await api.assignRole(gameId, participant.participantId, role);
            // 応答は versions だけ。表示は、追いついた取得の結果から作る
            const { snapshot } = await fetchCaughtUp<Lobby>(
                () => api.getLobby(gameId),
                result.versions,
                catchUp,
            );
            setData(snapshot);
        } catch (error) {
            setFailure(error);
        } finally {
            setBusy(false);
        }
    }

    function requestAssign(participant: LobbyParticipant) {
        const target = selected[participant.participantId];
        if (!target) return;
        if (participant.role !== null && participant.role !== target) {
            setPending({ participant, target }); // 黙って付け替えず、移動元と移動先を示す確認を挟む
        } else {
            void assign(participant, target);
        }
    }

    /**
     * 開発用。不足する役割ごとにダミーの参加者を作り、その役割に割り当てる。
     * 参加は Cookie を受け取らない窓口で行う（進行役の資格を上書きしないため）。
     */
    async function fillWithDummies() {
        setBusy(true);
        setFailure(null);
        try {
            const dummyName = (role: Role) => `ダミー${ROLE_LABELS[role]}`;
            let latest: StreamVersions | undefined;
            for (const role of missing) {
                const joined = await api.joinWithoutSession({
                    joinCode: lobby.joinCode ?? '',
                    displayName: dummyName(role),
                });
                latest = joined.versions;
            }
            const { snapshot: joinedLobby } = await fetchCaughtUp<Lobby>(
                () => api.getLobby(gameId),
                latest ?? lobby.versions,
                catchUp,
            );
            for (const role of missing) {
                const dummy = joinedLobby.participants.find(
                    (p) => p.displayName === dummyName(role) && p.role === null,
                );
                if (dummy) {
                    latest = (await api.assignRole(gameId, dummy.participantId, role)).versions;
                }
            }
            const { snapshot } = await fetchCaughtUp<Lobby>(
                () => api.getLobby(gameId),
                latest ?? joinedLobby.versions,
                catchUp,
            );
            setData(snapshot);
        } catch (error) {
            setFailure(error);
        } finally {
            setBusy(false);
        }
    }

    async function start() {
        setBusy(true);
        setFailure(null);
        try {
            await api.startGame(gameId);
            navigate(`/games/${gameId}/console`);
        } catch (error) {
            setFailure(error);
            setBusy(false);
        }
    }

    const startError =
        failure instanceof ApiError && failure.code === 'game.start_condition_not_met';
    const dialogTitleId = `${idPrefix}-dialog-title`;

    return (
        <>
            <PageHeading title="ロビー" />
            <SettingsNote kind={lobby.settingsKind} changed={lobby.changedSettings} />
            <p>
                参加コード: <strong>{lobby.joinCode}</strong>
            </p>
            <p>
                状態:{' '}
                {lobby.status === 'PREPARING'
                    ? '準備中'
                    : lobby.status === 'STARTED'
                      ? '進行中'
                      : '終了'}
            </p>

            {failure ? (
                startError ? (
                    <div role="alert" className="notice notice-error">
                        <p>{missingRolesText((failure as ApiError).missingRoles)}</p>
                    </div>
                ) : (
                    <ErrorNotice error={failure} />
                )
            ) : null}

            <h2>各役割の担当</h2>
            <ul>
                {ROLE_ORDER.map((role) => {
                    const names = lobby.participants.filter((p) => p.role === role).map(nameOf);
                    return (
                        <li
                            key={role}
                        >{`${ROLE_LABELS[role]}: ${names.length > 0 ? names.join('、') : '（未割り当て）'}`}</li>
                    );
                })}
            </ul>

            <h2>参加者</h2>
            <ul className="participants">
                {lobby.participants.map((participant) => {
                    const nameId = `${idPrefix}-name-${participant.participantId}`;
                    const choice = selected[participant.participantId] ?? '';
                    return (
                        <li key={participant.participantId} aria-labelledby={nameId}>
                            <span id={nameId}>{nameOf(participant)}</span>{' '}
                            <span>
                                {participant.role ? ROLE_LABELS[participant.role] : '未割り当て'}
                            </span>{' '}
                            <select
                                aria-label="役割を選ぶ"
                                value={choice}
                                onChange={(event) =>
                                    setSelected({
                                        ...selected,
                                        [participant.participantId]: event.target.value as
                                            Role | '',
                                    })
                                }
                            >
                                <option value="">選択してください</option>
                                {ROLE_ORDER.map((role) => (
                                    <option key={role} value={role}>
                                        {ROLE_LABELS[role]}
                                    </option>
                                ))}
                            </select>{' '}
                            <button
                                type="button"
                                disabled={busy || choice === '' || choice === participant.role}
                                onClick={() => requestAssign(participant)}
                            >
                                割り当てる
                            </button>
                        </li>
                    );
                })}
            </ul>

            {missing.length > 0 ? <p>{missingRolesText(missing)}</p> : null}
            <button
                type="button"
                disabled={busy || missing.length > 0}
                onClick={() => void start()}
            >
                開始する
            </button>

            {import.meta.env.DEV && missing.length > 0 ? (
                <section aria-labelledby="dev-tools-heading">
                    <h2 id="dev-tools-heading">開発用</h2>
                    <p className="muted">
                        1 人で試すためのダミー参加者です。開発サーバーでだけ表示します。
                    </p>
                    <button type="button" disabled={busy} onClick={() => void fillWithDummies()}>
                        ダミー参加者で不足の役割を埋める
                    </button>
                </section>
            ) : null}

            {pending ? (
                <Dialog labelledBy={dialogTitleId} onClose={() => setPending(null)}>
                    <h2 id={dialogTitleId}>割り当ての付け替え</h2>
                    <p>
                        {`${nameOf(pending.participant)}さんは${ROLE_LABELS[pending.participant.role as Role]}に割り当て済みです。${ROLE_LABELS[pending.target]}へ移しますか。`}
                    </p>
                    <div className="actions">
                        <button type="button" onClick={() => setPending(null)}>
                            戻って確認
                        </button>
                        <button
                            type="button"
                            onClick={() => void assign(pending.participant, pending.target)}
                        >
                            移す
                        </button>
                    </div>
                </Dialog>
            ) : null}
        </>
    );
}
