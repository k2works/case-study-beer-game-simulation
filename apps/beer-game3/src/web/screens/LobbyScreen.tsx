import { useEffect, useState } from 'react';
import { ROLES, ROLE_LABELS, type Role } from '../../server/domain/types.js';
import type { ApiClient, Credential, GameStateView } from '../api.js';
import { CopyButton, FieldError, describeError } from '../components.js';
import { roleList } from '../format.js';

interface Props {
  api: ApiClient;
  credential: Credential;
  state: GameStateView;
  refresh: () => void;
}

/** S2 ロビー: 参加者を集め、進行役が役割を割り当てて開始する。参加者は開始を待つ。 */
export function LobbyScreen({ api, credential, state, refresh }: Props) {
  const isFacilitator = state.viewerKind === 'facilitator';
  const [joinCode, setJoinCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isFacilitator) {
      return;
    }
    let alive = true;
    api
      .getCodes(credential)
      .then((codes) => {
        if (alive) {
          setJoinCode(codes.joinCode);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api, credential, isFacilitator]);

  const assign = async (participantId: string, value: string) => {
    setError(null);
    try {
      await api.assign(credential, participantId, value === '' ? null : (value as Role));
      refresh();
    } catch (e) {
      setError(describeError(e));
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.start(credential);
      refresh();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const unassigned = state.unassignedRoles ?? [];
  const roleOf = (participantId: string): Role | undefined =>
    state.assignments?.find((a) => a.participantId === participantId)?.role;

  return (
    <main>
      <h1>ロビー</h1>
      <p>
        状態: 準備中 <span aria-hidden="true">/</span> ゲーム名: {state.name}
      </p>
      {isFacilitator ? (
        <p>
          参加コード: {joinCode ? <strong>{joinCode}</strong> : '取得しています'}{' '}
          {joinCode ? <CopyButton label="参加コード" value={joinCode} /> : null}
        </p>
      ) : null}

      <h2>参加者（{state.participants.length} 人）</h2>
      {state.participants.length === 0 ? <p>参加コードを共有してください</p> : null}
      <ul className="participants">
        {state.participants.map((p) => (
          <li key={`${p.joinOrder}`}>
            <span>{p.label}</span>
            {isFacilitator && p.participantId ? (
              <>
                {' '}
                <select
                  data-testid={`assign-select-${p.participantId}`}
                  aria-label={`${p.label} の役割`}
                  value={roleOf(p.participantId) ?? ''}
                  onChange={(e) => void assign(p.participantId!, e.target.value)}
                >
                  <option value="">未割当て</option>
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
          </li>
        ))}
      </ul>

      {isFacilitator ? (
        <section aria-labelledby="start-heading">
          <h2 id="start-heading">ゲームの開始</h2>
          {unassigned.length > 0 ? (
            <p data-testid="start-blocker">
              開始できません: {roleList(unassigned)}の担当者がいません
            </p>
          ) : (
            <p>4 つの役割がそろっています。開始すると、第 1 週が始まります。</p>
          )}
          <button
            type="button"
            data-testid="start-game"
            disabled={unassigned.length > 0 || busy}
            onClick={() => void start()}
          >
            {busy ? '開始しています' : 'ゲームを開始する'}
          </button>
          <FieldError id="lobby-error" message={error ?? undefined} />
        </section>
      ) : (
        <section>
          {state.self ? (
            <p>
              あなた: {state.self.displayName}（#{state.self.joinOrder}）
            </p>
          ) : null}
          <p>担当: {state.role ? ROLE_LABELS[state.role] : '未割当て'}</p>
          <p role="status">開始を待っています</p>
        </section>
      )}
    </main>
  );
}
