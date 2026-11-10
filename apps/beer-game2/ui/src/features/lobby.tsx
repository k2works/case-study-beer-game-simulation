import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { Role } from '../api/types.js';
import { ErrorMessage, Page } from '../components.js';
import { useApi, useLiveSnapshot } from '../hooks.js';
import { ROLE_LABEL, ROLE_ORDER } from '../labels.js';

export function LobbyScreen() {
  const { id = '' } = useParams();
  const api = useApi();
  const navigate = useNavigate();
  const {
    data: lobby,
    error,
    reload,
  } = useLiveSnapshot(id, () => api.lobby(id));
  const [actionError, setActionError] = useState<unknown>(null);

  const facilitator = lobby?.viewer.kind === 'FACILITATOR';
  useEffect(() => {
    if (lobby?.status === 'STARTED') {
      navigate(facilitator ? `/games/${id}/console` : `/games/${id}/play`, {
        replace: true,
      });
    }
  }, [lobby?.status, facilitator, id, navigate]);

  async function act(work: () => Promise<void>, then?: () => void) {
    setActionError(null);
    try {
      await work();
      if (then) return then();
      await reload();
    } catch (e) {
      setActionError(e);
    }
  }

  if (!lobby) {
    return (
      <Page title="ロビー">
        {error ? (
          <ErrorMessage error={new Error(error)} />
        ) : (
          <p>読み込み中です</p>
        )}
      </Page>
    );
  }

  const roleOf = (participantId: string): Role | '' =>
    ROLE_ORDER.find((r) => lobby.assignments[r] === participantId) ?? '';

  const nameOf = (participantId?: string) =>
    lobby.participants.find((p) => p.id === participantId)?.displayName ?? '';
  const heldByOther = (role: Role, participantId: string) =>
    lobby.assignments[role] !== undefined &&
    lobby.assignments[role] !== participantId;

  return (
    <Page title="ロビー">
      <ErrorMessage error={actionError} />
      {lobby.joinCode && (
        <p>
          参加コード: <strong>{lobby.joinCode}</strong>
        </p>
      )}
      <p>{lobby.finalWeek} 週のゲームです。</p>
      <h2>参加者</h2>
      <ul>
        {lobby.participants.map((p) => (
          <li key={p.id}>
            {facilitator ? (
              <label>
                {p.displayName} の役割
                <select
                  value={roleOf(p.id)}
                  onChange={(e) => {
                    const role = e.target.value as Role;
                    const current = roleOf(p.id);
                    void act(async () => {
                      // 1 人に複数の役割は持てないため、付け替えは「解除してから割り当て」
                      if (current) await api.unassign(id, p.id);
                      if (role) await api.assign(id, p.id, role);
                    });
                  }}
                >
                  <option value="">未割り当て</option>
                  {ROLE_ORDER.map((r) => (
                    <option key={r} value={r} disabled={heldByOther(r, p.id)}>
                      {ROLE_LABEL[r]}
                      {heldByOther(r, p.id) &&
                        `（${nameOf(lobby.assignments[r])}）`}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                {p.displayName}
                {roleOf(p.id) && `（${ROLE_LABEL[roleOf(p.id) as Role]}）`}
              </>
            )}
          </li>
        ))}
      </ul>
      {facilitator ? (
        <>
          {lobby.missingRoles.length > 0 && (
            <p>
              足りない役割:{' '}
              {lobby.missingRoles.map((r) => ROLE_LABEL[r]).join('、')}
            </p>
          )}
          <button
            type="button"
            disabled={lobby.missingRoles.length > 0}
            onClick={() =>
              void act(
                () => api.start(id),
                () => navigate(`/games/${id}/console`),
              )
            }
          >
            開始する
          </button>
        </>
      ) : (
        <p>開始を待っています</p>
      )}
    </Page>
  );
}
