import type { GameStatus, Lobby, LobbyParticipant, Role } from '../../api/types';
import { ROLE_LABELS, ROLE_ORDER } from '../../labels';

const STATUS_LABELS: Record<GameStatus, string> = {
    PREPARING: '準備中',
    STARTED: '進行中',
    ENDED: '終了',
};

export const nameOf = (participant: LobbyParticipant) =>
    participant.displayName ?? '（表示名なし）';

/** ゲームの概要（参加コードと状態）の表。項目名が行見出し。 */
export function SummaryTable({ lobby }: { lobby: Lobby }) {
    return (
        <div className="table-scroll">
            <table className="results-table summary-table" aria-label="ゲームの概要の表">
                <tbody>
                    <tr>
                        <th scope="row">参加コード</th>
                        <td>
                            <strong>{lobby.joinCode}</strong>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">状態</th>
                        <td>{STATUS_LABELS[lobby.status]}</td>
                    </tr>
                </tbody>
            </table>
        </div>
    );
}

/** 各役割の担当の表。役割が行見出しで、人数と担当者（共同担当は並べる）を示す。 */
export function AssignmentsTable({ participants }: { participants: readonly LobbyParticipant[] }) {
    return (
        <div className="table-scroll">
            <table className="results-table summary-table" aria-label="各役割の担当の表">
                <thead>
                    <tr>
                        <th scope="col">役割</th>
                        <th scope="col">人数</th>
                        <th scope="col">担当者</th>
                    </tr>
                </thead>
                <tbody>
                    {ROLE_ORDER.map((role) => {
                        const names = participants.filter((p) => p.role === role).map(nameOf);
                        return (
                            <tr key={role}>
                                <th scope="row">{ROLE_LABELS[role]}</th>
                                <td>{names.length}</td>
                                <td>{names.length > 0 ? names.join('、') : '（未割り当て）'}</td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

/** 参加者の表。表示名が行見出しで、現在の役割と、役割の変更（選択と「割り当てる」）を持つ。 */
export function ParticipantsTable({
    participants,
    selected,
    busy,
    onSelect,
    onAssign,
}: {
    participants: readonly LobbyParticipant[];
    selected: Record<string, Role | ''>;
    busy: boolean;
    onSelect: (participantId: string, role: Role | '') => void;
    onAssign: (participant: LobbyParticipant) => void;
}) {
    return (
        <div className="table-scroll">
            <table className="results-table participants-table" aria-label="参加者の表">
                <thead>
                    <tr>
                        <th scope="col">表示名</th>
                        <th scope="col">現在の役割</th>
                        <th scope="col">役割の変更</th>
                    </tr>
                </thead>
                <tbody>
                    {participants.map((participant) => {
                        const choice = selected[participant.participantId] ?? '';
                        return (
                            <tr key={participant.participantId}>
                                <th scope="row">{nameOf(participant)}</th>
                                <td>
                                    {participant.role
                                        ? ROLE_LABELS[participant.role]
                                        : '未割り当て'}
                                </td>
                                <td>
                                    <select
                                        aria-label="役割を選ぶ"
                                        value={choice}
                                        onChange={(event) =>
                                            onSelect(
                                                participant.participantId,
                                                event.target.value as Role | '',
                                            )
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
                                        disabled={
                                            busy || choice === '' || choice === participant.role
                                        }
                                        onClick={() => onAssign(participant)}
                                    >
                                        割り当てる
                                    </button>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
