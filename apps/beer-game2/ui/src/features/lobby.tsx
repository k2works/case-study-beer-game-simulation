import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router';
import type { Role } from '../api/types.js';
import {
  ConfirmDialog,
  ErrorMessage,
  Page,
  RecoveryCodeNote,
  RetentionNote,
  SettingsSummary,
} from '../components.js';
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
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  // 作成・参加の直後だけ、復帰コードを示す。履歴の state は消し、再読み込みでは再表示しない
  const location = useLocation();
  const [recoveryCode] = useState(
    (location.state as { recoveryCode?: string } | null)?.recoveryCode,
  );
  useEffect(() => {
    if (recoveryCode)
      navigate(location.pathname, { replace: true, state: null });
  }, [recoveryCode, location.pathname, navigate]);

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
    ROLE_ORDER.find((r) => lobby.assignments[r]?.includes(participantId)) ?? '';

  const nameOf = (participantId: string) =>
    lobby.participants.find((p) => p.id === participantId)?.displayName ?? '';
  /** 同じ役割の、自分以外の担当の表示名（共同担当） */
  const othersIn = (role: Role, participantId: string) =>
    (lobby.assignments[role] ?? [])
      .filter((id) => id !== participantId)
      .map(nameOf);

  return (
    <Page title="ロビー">
      {recoveryCode && (
        <RecoveryCodeNote label="復帰コード" code={recoveryCode} />
      )}
      <ErrorMessage error={actionError} />
      {lobby.joinCode && (
        <p>
          参加コード: <strong>{lobby.joinCode}</strong>
        </p>
      )}
      <p>{lobby.finalWeek} 週のゲームです。</p>
      <SettingsSummary settings={lobby.settings} detailed />
      {lobby.retention && <RetentionNote retention={lobby.retention} />}
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
                      // 1 人に複数の役割は持てないため、付け替えは「解除してから割り当て」。同じ役割に複数人は持てる（共同担当）
                      if (current) await api.unassign(id, p.id);
                      if (role) await api.assign(id, p.id, role);
                    });
                  }}
                >
                  <option value="">未割り当て</option>
                  {ROLE_ORDER.map((r) => {
                    const others = othersIn(r, p.id);
                    return (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                        {others.length > 0 &&
                          `（共同担当: ${others.join('、')}）`}
                      </option>
                    );
                  })}
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
      {facilitator && (
        <section aria-labelledby="observers-heading">
          <h2 id="observers-heading">観察用の招待</h2>
          <p>観察者: {lobby.observerCount} 人</p>
          <ul>
            {(lobby.observerInvitations ?? []).map((inv) => (
              <li key={inv.id}>
                有効な招待（期限{' '}
                {new Date(inv.expiresAt).toLocaleString('ja-JP')}）
                <button type="button" onClick={() => setRevoking(inv.id)}>
                  招待を失効
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() =>
              void act(async () => {
                setInviteCode((await api.issueObserverInvitation(id)).code);
              })
            }
          >
            観察用の招待を発行
          </button>
          {inviteCode && (
            <aside role="note" aria-label="観察用の招待コード">
              <p>
                観察用の招待コード: <strong>{inviteCode}</strong>
              </p>
              <p>
                観察者に伝えてください（「観察者として参加」の画面で使います）。この画面でだけ表示します。参加コードとは別の値です。
              </p>
            </aside>
          )}
          {revoking && (
            <ConfirmDialog
              label="招待の失効の確認"
              confirm="失効する"
              onConfirm={() => {
                const target = revoking;
                setRevoking(null);
                void act(() => api.revokeObserverInvitation(id, target));
              }}
              onCancel={() => setRevoking(null)}
            >
              <p>
                この招待での新しい参加をできなくします。参加済みの観察者は、そのまま観察できます。
              </p>
            </ConfirmDialog>
          )}
        </section>
      )}
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
