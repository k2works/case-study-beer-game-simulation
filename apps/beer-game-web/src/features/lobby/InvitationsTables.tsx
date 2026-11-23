import type { LobbyInvitation, LobbyObserver } from '../../api/types';
import { formatDateTime } from '../../labels';

/** 招待の表の 1 行。状態の文言と、失効できるか（有効なとき）は、呼び出し側が現在時刻から決める。 */
export interface InvitationRow {
    invitation: LobbyInvitation;
    /** 「招待 1」のような、行の名前。 */
    label: string;
    statusLabel: string;
    revocable: boolean;
}

/** 観察用の招待の表。招待が行見出しで、状態・作成・期限と、有効な招待の「失効」を示す。 */
export function InvitationsTable({
    rows,
    busy,
    onRevoke,
}: {
    rows: readonly InvitationRow[];
    busy: boolean;
    onRevoke: (invitation: LobbyInvitation) => void;
}) {
    return (
        <div className="table-scroll">
            <table className="results-table invitations-table" aria-label="観察用の招待の表">
                <thead>
                    <tr>
                        <th scope="col">招待</th>
                        <th scope="col">状態</th>
                        <th scope="col">作成</th>
                        <th scope="col">期限</th>
                        <th scope="col">操作</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map(({ invitation, label, statusLabel, revocable }) => (
                        <tr key={invitation.invitationId}>
                            <th scope="row">{label}</th>
                            <td>{statusLabel}</td>
                            <td>{formatDateTime(invitation.createdAt)}</td>
                            <td>{formatDateTime(invitation.expiresAt)}</td>
                            <td>
                                {revocable ? (
                                    <button
                                        type="button"
                                        disabled={busy}
                                        aria-label={`${label}を失効`}
                                        onClick={() => onRevoke(invitation)}
                                    >
                                        失効
                                    </button>
                                ) : null}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

/** 観察者の表。表示名が行見出しで、参加日時を示す。 */
export function ObserversTable({ observers }: { observers: readonly LobbyObserver[] }) {
    return (
        <div className="table-scroll">
            <table className="results-table observers-table" aria-label="観察者の表">
                <thead>
                    <tr>
                        <th scope="col">表示名</th>
                        <th scope="col">参加日時</th>
                    </tr>
                </thead>
                <tbody>
                    {observers.map((observer) => (
                        <tr key={observer.observerId}>
                            <th scope="row">{observer.displayName ?? '（表示名なし）'}</th>
                            <td>{formatDateTime(observer.joinedAt)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
