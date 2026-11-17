import { useId, useState } from 'react';
import { useApi, useCatchUp } from '../../api/ApiContext';
import { fetchCaughtUp } from '../../api/catchUp';
import type { InviteObserverResponse, Lobby, LobbyInvitation } from '../../api/types';
import { Dialog } from '../../components/Dialog';
import { ErrorNotice } from '../../components/ErrorNotice';
import { formatDateTime } from '../../labels';

type InvitationStatus = 'VALID' | 'REVOKED' | 'EXPIRED';

/** 失効が先（失効した招待は、期限が残っていても、失効と示す）。 */
export function invitationStatus(invitation: LobbyInvitation, now: Date): InvitationStatus {
    if (invitation.revoked) return 'REVOKED';
    return new Date(invitation.expiresAt) <= now ? 'EXPIRED' : 'VALID';
}

const STATUS_LABELS: Record<InvitationStatus, string> = {
    VALID: '有効',
    REVOKED: '失効',
    EXPIRED: '期限切れ',
};

/**
 * ロビーの、観察用の招待（進行役）。招待を発行し、招待コードを一度だけ示す（保存はダイジェストだけで、再表示できない）。
 * 招待の一覧（状態と期限）と、参加した観察者（役割なし）を示す。失効は確認を挟み、すでに参加した観察者には影響しないと伝える。
 */
export function InvitationsPanel({
    gameId,
    lobby,
    onLobby,
}: {
    gameId: string;
    lobby: Lobby;
    onLobby: (lobby: Lobby) => void;
}) {
    const api = useApi();
    const catchUp = useCatchUp();
    const [issued, setIssued] = useState<InviteObserverResponse | null>(null);
    const [pending, setPending] = useState<LobbyInvitation | null>(null);
    const [failure, setFailure] = useState<unknown>(null);
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const dialogTitleId = `${useId()}-revoke-title`;
    const now = new Date();

    async function refresh(versions: InviteObserverResponse['versions']) {
        const { snapshot } = await fetchCaughtUp<Lobby>(
            () => api.getLobby(gameId),
            versions,
            catchUp,
        );
        onLobby(snapshot);
    }

    async function invite() {
        setBusy(true);
        setFailure(null);
        setCopied(false);
        try {
            const result = await api.inviteObserver(gameId);
            setIssued(result);
            await refresh(result.versions);
        } catch (error) {
            setFailure(error);
        } finally {
            setBusy(false);
        }
    }

    async function revoke(invitation: LobbyInvitation) {
        setBusy(true);
        setFailure(null);
        setPending(null);
        try {
            const result = await api.revokeObserverInvitation(gameId, invitation.invitationId);
            await refresh(result.versions);
        } catch (error) {
            setFailure(error);
        } finally {
            setBusy(false);
        }
    }

    async function copy(code: string) {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
        } catch {
            setCopied(false); // コピーできない環境では、表示した招待コードを選んでコピーする
        }
    }

    return (
        <section aria-labelledby="invitations-heading">
            <h2 id="invitations-heading">観察用の招待</h2>
            <p className="muted">
                観察者は、読み取り専用で、役割を持ちません。招待コードは、参加コードとは別の値です。
            </p>
            {failure ? <ErrorNotice error={failure} /> : null}
            {issued ? (
                <div role="status" className="notice">
                    <p>
                        招待コード: <strong>{issued.invitationCode}</strong>{' '}
                        <button type="button" onClick={() => void copy(issued.invitationCode)}>
                            招待コードをコピー
                        </button>
                    </p>
                    <p className="muted">
                        この招待コードは、いま一度だけ表示します（期限{' '}
                        {formatDateTime(issued.expiresAt)}
                        ）。観察者へ伝えてください。
                    </p>
                    {copied ? <p>コピーしました。</p> : null}
                </div>
            ) : null}
            <button type="button" disabled={busy} onClick={() => void invite()}>
                観察用の招待を発行
            </button>

            {lobby.invitations.length > 0 ? (
                <ul aria-label="観察用の招待の一覧">
                    {lobby.invitations.map((invitation, index) => {
                        const status = invitationStatus(invitation, now);
                        const label = `招待 ${index + 1}`;
                        return (
                            <li key={invitation.invitationId} aria-label={label}>
                                {label}: {STATUS_LABELS[status]}（期限{' '}
                                {formatDateTime(invitation.expiresAt)}）{' '}
                                {status === 'VALID' ? (
                                    <button
                                        type="button"
                                        disabled={busy}
                                        aria-label={`${label}を失効`}
                                        onClick={() => setPending(invitation)}
                                    >
                                        失効
                                    </button>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            ) : null}

            <h3>観察者</h3>
            {lobby.observers.length === 0 ? (
                <p>観察者はまだいません。</p>
            ) : (
                <ul aria-label="観察者の一覧">
                    {lobby.observers.map((observer) => (
                        <li key={observer.observerId}>
                            {observer.displayName ?? '（表示名なし）'}
                        </li>
                    ))}
                </ul>
            )}

            {pending ? (
                <Dialog labelledBy={dialogTitleId} onClose={() => setPending(null)}>
                    <h2 id={dialogTitleId}>観察用の招待の失効</h2>
                    <p>
                        この招待を失効させると、この招待での新しい参加はできなくなります。すでに参加した観察者は、観察を続けられます。
                    </p>
                    <div className="actions">
                        <button type="button" onClick={() => setPending(null)}>
                            戻る
                        </button>
                        <button type="button" onClick={() => void revoke(pending)}>
                            失効させる
                        </button>
                    </div>
                </Dialog>
            ) : null}
        </section>
    );
}
