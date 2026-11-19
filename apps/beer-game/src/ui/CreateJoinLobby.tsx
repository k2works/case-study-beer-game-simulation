import { useEffect, useRef, useState } from 'react';
import { BrowserApi, type LobbyState, type Role } from './browser-api.js';
import { LiveStateAdapter } from './LiveStateAdapter.js';

const ROLES: Role[] = ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'];

export function CreateGameForm({
  api,
  onLobby,
}: {
  api: BrowserApi;
  onLobby: (gameId: string) => void;
}) {
  const [mode, setMode] = useState<'kit' | 'custom'>('kit');
  const [finalWeek, setFinalWeek] = useState('12');
  const [demand, setDemand] = useState(Array(12).fill('4').join(', '));
  const [retentionDays, setRetentionDays] = useState('90');
  const [created, setCreated] = useState<{ gameId: string; joinCode: string }>();
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{
    weeks?: string;
    demand?: string;
    retention?: string;
  }>({});
  const [busy, setBusy] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (created) codeRef.current?.focus();
  }, [created]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setFieldErrors({});
    const weeks = mode === 'kit' ? 12 : Number(finalWeek);
    const series =
      mode === 'kit'
        ? (Array(12).fill(4) as number[])
        : demand.split(',').map((value) => Number(value.trim()));
    const retention = Number(retentionDays);
    const problems = {
      ...(!Number.isInteger(weeks) || weeks < 1 || weeks > 52
        ? { weeks: '最終週は 1〜52 の整数が必要です。' }
        : {}),
      ...(series.length < weeks ||
      series.some((value) => !Number.isInteger(value) || value < 0 || value > 1000)
        ? { demand: '需要系列は最終週までの 0〜1000 の整数が必要です。' }
        : {}),
      ...(!Number.isInteger(retention) || retention < 1 || retention > 3650
        ? { retention: '保持期間は 1〜3650 日の整数が必要です。' }
        : {}),
    };
    if (Object.keys(problems).length) {
      setFieldErrors(problems);
      setError(
        '最終週、需要系列、保持期間を確認してください。需要系列は最終週までの 0〜1000 の整数が必要です。',
      );
      return;
    }
    setBusy(true);
    try {
      const result = await api.createGame(
        { finalWeek: weeks, demand: series, retentionDays: retention },
        crypto.randomUUID(),
      );
      setCreated({ gameId: result.gameId, joinCode: result.joinCode });
    } catch {
      setError('ゲームを作成できませんでした。入力内容を確認して再試行してください。');
    } finally {
      setBusy(false);
    }
  }

  if (created)
    return (
      <section aria-labelledby="created-title">
        <h2 id="created-title">ゲームを作成しました</h2>
        <p>
          参加コード:{' '}
          <strong ref={codeRef} tabIndex={-1}>
            {created.joinCode}
          </strong>
        </p>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(created.joinCode)}>
          参加コードをコピー
        </button>
        <button type="button" onClick={() => onLobby(created.gameId)}>
          ロビーへ
        </button>
      </section>
    );

  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      <h2>ゲームを作成</h2>
      {error && (
        <div ref={errorRef} role="alert" tabIndex={-1}>
          {error}
        </div>
      )}
      <fieldset>
        <legend>条件</legend>
        <label>
          <input
            type="radio"
            name="mode"
            checked={mode === 'kit'}
            onChange={() => setMode('kit')}
          />
          キット準拠
        </label>
        <label>
          <input
            type="radio"
            name="mode"
            checked={mode === 'custom'}
            onChange={() => setMode('custom')}
          />
          カスタム条件
        </label>
      </fieldset>
      {mode === 'custom' && (
        <>
          <label>
            最終週
            <input
              type="text"
              inputMode="numeric"
              value={finalWeek}
              onChange={(event) => setFinalWeek(event.target.value)}
              aria-invalid={Boolean(fieldErrors.weeks)}
              aria-describedby={fieldErrors.weeks ? 'final-week-error' : undefined}
            />
          </label>
          {fieldErrors.weeks && <p id="final-week-error">{fieldErrors.weeks}</p>}
          <label>
            需要系列（カンマ区切り）
            <textarea
              value={demand}
              onChange={(event) => setDemand(event.target.value)}
              aria-invalid={Boolean(fieldErrors.demand)}
              aria-describedby={fieldErrors.demand ? 'demand-error' : undefined}
            />
          </label>
          {fieldErrors.demand && <p id="demand-error">{fieldErrors.demand}</p>}
          <p>カスタム条件</p>
        </>
      )}
      <label>
        保持期間（日）
        <input
          type="text"
          inputMode="numeric"
          value={retentionDays}
          onChange={(event) => setRetentionDays(event.target.value)}
          aria-invalid={Boolean(fieldErrors.retention)}
          aria-describedby={fieldErrors.retention ? 'retention-error' : undefined}
        />
      </label>
      {fieldErrors.retention && <p id="retention-error">{fieldErrors.retention}</p>}
      <button type="submit" disabled={busy}>
        {busy ? '作成中…' : 'ゲームを作成'}
      </button>
    </form>
  );
}

export function JoinAndRecovery({
  api,
  onJoined,
  onRecovered,
}: {
  api: BrowserApi;
  onJoined: (gameId: string) => void;
  onRecovered: (gameId: string, sessionId: string) => void;
}) {
  const [joinCode, setJoinCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function join(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (!joinCode.trim() || !displayName.trim()) {
      setError('参加コードと表示名を入力してください。');
      return;
    }
    setBusy(true);
    try {
      const result = await api.join(
        joinCode.trim().toUpperCase(),
        displayName.trim(),
        crypto.randomUUID(),
      );
      onJoined(result.gameId);
    } catch {
      setError('参加できませんでした。コードとロビーの状態を確認してください。');
    } finally {
      setBusy(false);
    }
  }
  async function recover() {
    setError('');
    setBusy(true);
    try {
      const result = await api.recover();
      onRecovered(result.gameId, result.state.sessionId);
    } catch {
      setError('復帰できませんでした。進行役に確認してください。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="join-title">
      <h2 id="join-title">ゲームに参加</h2>
      {error && (
        <div ref={errorRef} role="alert" tabIndex={-1}>
          {error}
        </div>
      )}
      <form onSubmit={(event) => void join(event)} noValidate>
        <label>
          参加コード
          <input
            value={joinCode}
            autoComplete="off"
            onChange={(event) => setJoinCode(event.target.value)}
          />
        </label>
        <label>
          表示名
          <input
            value={displayName}
            maxLength={80}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>
          参加する
        </button>
      </form>
      <button type="button" disabled={busy} onClick={() => void recover()}>
        復帰する
      </button>
    </section>
  );
}

export function Lobby({
  api,
  gameId,
  facilitator,
  onStarted,
}: {
  api: BrowserApi;
  gameId: string;
  facilitator: boolean;
  onStarted: (sessionId: string) => void;
}) {
  const [state, setState] = useState<LobbyState>();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Record<string, Role>>({});
  const [busy, setBusy] = useState(false);
  const [automatic, setAutomatic] = useState(true);
  const [connection, setConnection] = useState<'connected' | 'polling'>('connected');
  const started = useRef(false);
  async function refresh() {
    try {
      setState(await api.lobby(gameId));
      setError('');
    } catch {
      setError('ロビーを更新できませんでした。');
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
    void adapter.start().catch(() => setError('ロビーを更新できませんでした。'));
    return () => adapter.stop();
  }, [api, gameId, automatic]);
  useEffect(() => {
    if (!facilitator && state?.status === 'ACTIVE' && !started.current) {
      started.current = true;
      onStarted(state.sessionId);
    }
  }, [facilitator, state, onStarted]);
  const assigned = new Set(
    state?.participants.map((participant) => participant.role).filter(Boolean),
  );
  const canStart = assigned.size === 4 && state?.status === 'LOBBY';
  async function assign(participantId: string) {
    if (!state || !selected[participantId]) return;
    setBusy(true);
    try {
      await api.assignRole(
        gameId,
        participantId,
        selected[participantId],
        state.version,
        crypto.randomUUID(),
      );
      await refresh();
    } catch {
      setError('役割を割り当てられませんでした。最新状態を確認してください。');
    } finally {
      setBusy(false);
    }
  }
  async function start() {
    if (!state || !canStart) return;
    setBusy(true);
    try {
      await api.lifecycle(state.sessionId, 'start', state.version, crypto.randomUUID());
      onStarted(state.sessionId);
    } catch {
      setError('開始できませんでした。役割と最新状態を確認してください。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="lobby-title">
      <h2 id="lobby-title">ロビー</h2>
      {error && <div role="alert">{error}</div>}
      {!state ? (
        <p>読み込み中…</p>
      ) : (
        <>
          {facilitator && state.joinCode && (
            <p>
              参加コード: <strong>{state.joinCode}</strong>
            </p>
          )}
          <p>状態: {state.status}</p>
          {automatic && connection === 'polling' && (
            <p role="status" aria-live="polite">
              再接続中です。1 秒ごとに更新しています。
            </p>
          )}
          {!automatic && <p>自動更新を停止しています。</p>}
          <ul>
            {state.participants.map((participant) => (
              <li key={participant.participantId}>
                <span>{participant.displayName}</span> <span>{participant.role ?? '役割待ち'}</span>
                {facilitator && (
                  <>
                    <label>
                      {participant.displayName} の役割
                      <select
                        value={selected[participant.participantId] ?? participant.role ?? ''}
                        onChange={(event) =>
                          setSelected({
                            ...selected,
                            [participant.participantId]: event.target.value as Role,
                          })
                        }
                      >
                        <option value="">選択してください</option>
                        {ROLES.map((role) => (
                          <option key={role} value={role}>
                            {role}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void assign(participant.participantId)}
                    >
                      割り当てる
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => setAutomatic(!automatic)}>
            {automatic ? '自動更新を停止' : '自動更新を再開'}
          </button>
          <button type="button" onClick={() => void refresh()}>
            更新する
          </button>
          {facilitator && (
            <>
              <p>{canStart ? '開始できます。' : '役割が 4 つ揃うと開始できます。'}</p>
              <button type="button" disabled={!canStart || busy} onClick={() => void start()}>
                開始する
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
