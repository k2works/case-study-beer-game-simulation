import { useEffect, useRef, useState } from 'react';
import { BrowserApi, type LobbyState, type Role } from './browser-api.js';
import { LiveStateAdapter } from './LiveStateAdapter.js';
import { handleDialogKey } from './dialog-focus.js';

const ROLES: Role[] = ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'];
type Action = {
  kind: 'commit' | 'pause' | 'resume' | 'end' | 'proxy';
  role?: Role;
  quantity?: number;
};

export function FacilitatorConsole({
  api,
  gameId,
  sessionId,
  onEnded,
}: {
  api: BrowserApi;
  gameId: string;
  sessionId: string;
  onEnded: () => void;
}) {
  const [state, setState] = useState<LobbyState>();
  const [role, setRole] = useState<Role>('RETAILER');
  const [quantity, setQuantity] = useState('');
  const [pending, setPending] = useState<Action>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [automatic, setAutomatic] = useState(true);
  const [connection, setConnection] = useState<'connected' | 'polling'>('connected');
  const dialogTitle = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (pending) dialogTitle.current?.focus();
  }, [pending]);
  async function refresh() {
    try {
      const next = await api.lobby(gameId);
      setState((previous) => (!previous || next.version >= previous.version ? next : previous));
      setError('');
    } catch {
      setError('進行状態を取得できませんでした。');
    }
  }
  useEffect(() => {
    if (!automatic) return;
    const adapter = new LiveStateAdapter<LobbyState>(
      `/api/v1/games/${encodeURIComponent(gameId)}/events`,
      () => api.lobby(gameId),
      (next) => {
        setState(next);
        setError('');
      },
      undefined,
      setConnection,
    );
    void adapter.start().catch(() => setError('進行状態を取得できませんでした。'));
    return () => adapter.stop();
  }, [api, gameId, automatic]);
  function open(action: Action, event: React.MouseEvent<HTMLButtonElement>) {
    trigger.current = event.currentTarget;
    setPending(action);
  }
  function close() {
    setPending(undefined);
    trigger.current?.focus();
  }
  async function confirm() {
    if (!state || !pending) return;
    setBusy(true);
    try {
      const key = crypto.randomUUID();
      if (pending.kind === 'commit') await api.commit(sessionId, state.week, state.version, key);
      else if (pending.kind === 'proxy')
        await api.proxyDecision(
          sessionId,
          pending.role!,
          pending.quantity!,
          state.decisions?.[pending.role!]?.version ?? 0,
          key,
        );
      else await api.lifecycle(sessionId, pending.kind, state.version, key);
      close();
      if (pending.kind === 'end') onEnded();
      else await refresh();
    } catch {
      setError('操作できませんでした。最新状態を手動更新して確認してください。');
    } finally {
      setBusy(false);
    }
  }
  const allComplete = ROLES.every((item) => state?.decisions?.[item]?.complete);
  return (
    <section aria-labelledby="facilitator-title">
      <h2 id="facilitator-title">進行役</h2>
      {error && <div role="alert">{error}</div>}
      {!state ? (
        <p>読み込み中…</p>
      ) : (
        <>
          <p>
            第 {state.week} 週、状態: {state.status}
          </p>
          <ul>
            {ROLES.map((item) => (
              <li key={item}>
                {item}: {state.decisions?.[item]?.complete ? '入力済み' : '未入力'}
              </li>
            ))}
          </ul>
          {automatic && connection === 'polling' && (
            <p role="status" aria-live="polite">
              再接続中です。1 秒ごとに更新しています。
            </p>
          )}
          {!automatic && <p>自動更新を停止しています。</p>}
          <button type="button" onClick={() => setAutomatic(!automatic)}>
            {automatic ? '自動更新を停止' : '自動更新を再開'}
          </button>
          <button type="button" onClick={() => void refresh()}>
            手動更新
          </button>
          <button
            type="button"
            disabled={!allComplete || state.status !== 'ACTIVE' || busy}
            onClick={(event) => open({ kind: 'commit' }, event)}
          >
            週を確定
          </button>
          <button
            type="button"
            disabled={state.status !== 'ACTIVE' || busy}
            onClick={(event) => open({ kind: 'pause' }, event)}
          >
            停止する
          </button>
          <button
            type="button"
            disabled={state.status !== 'PAUSED' || busy}
            onClick={(event) => open({ kind: 'resume' }, event)}
          >
            再開する
          </button>
          <button
            type="button"
            disabled={state.status === 'ENDED' || busy}
            onClick={(event) => open({ kind: 'end' }, event)}
          >
            終了する
          </button>
          {state.status === 'ENDED' && (
            <button type="button" onClick={onEnded}>
              振り返りを見る
            </button>
          )}
          <fieldset disabled={state.status !== 'ACTIVE' || busy}>
            <legend>代理入力</legend>
            <label>
              代理入力の役割
              <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
                {ROLES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
            <label>
              代理入力の数量
              <input
                type="text"
                inputMode="numeric"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={(event) => {
                if (!/^\d+$/.test(quantity) || Number(quantity) > 1000) {
                  setError('代理入力は 0〜1000 の整数が必要です。');
                  return;
                }
                open({ kind: 'proxy', role, quantity: Number(quantity) }, event);
              }}
            >
              代理入力を確認
            </button>
          </fieldset>
        </>
      )}
      {pending && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          onKeyDown={(event) => handleDialogKey(event, close)}
        >
          <h3 id="confirm-title" ref={dialogTitle} tabIndex={-1}>
            {pending.kind === 'commit' ? '週確定の確認' : '操作の確認'}
          </h3>
          <p>
            {pending.kind === 'commit'
              ? `第 ${state?.week} 週を確定します。元には戻せません。`
              : pending.kind === 'proxy'
                ? `${pending.role} に ${pending.quantity} を代理入力します。`
                : `${pending.kind === 'end' ? '終了' : pending.kind === 'pause' ? '停止' : '再開'}します。`}
          </p>
          <button type="button" disabled={busy} onClick={close}>
            キャンセル
          </button>
          <button type="button" disabled={busy} onClick={() => void confirm()}>
            確定する
          </button>
        </div>
      )}
    </section>
  );
}
