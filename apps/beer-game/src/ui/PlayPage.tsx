import { useEffect, useRef, useState } from 'react';
import { BrowserApi, type RoleState } from './browser-api.js';
import { LiveStateAdapter } from './LiveStateAdapter.js';

const STEPS = [
  '週を確認',
  '到着を確認',
  '受注を確認',
  '在庫を確認',
  '受注残を確認',
  '出荷を確認',
  '発注量を考える',
  '入力する',
  '入力を確認',
  '発注を保存',
  '全役割を待つ',
  '週確定を確認',
];

export function RoleDecisionForm({
  state,
  api,
  onSaved,
}: {
  state: RoleState;
  api: BrowserApi;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const active = state.status === 'ACTIVE';
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    const value = Number(draft);
    if (!/^\d+$/.test(draft) || !Number.isSafeInteger(value) || value > 1000) {
      setError('発注量は 0〜1000 の整数で入力してください。');
      return;
    }
    setBusy(true);
    try {
      await api.decision(state.sessionId, value, state.decisionVersion, crypto.randomUUID());
      setNotice('発注を保存しました。');
      onSaved();
    } catch (failure) {
      if (failure instanceof Error || (typeof failure === 'object' && failure !== null)) {
        const details = failure as { status?: number };
        if (details.status === 412) {
          try {
            const latest = await api.state(state.sessionId);
            setError(
              `競合しました。あなたの未保存値は ${draft}、最新の入力版 ${latest.decisionVersion} です。確認して再入力してください。`,
            );
          } catch {
            setError('競合しました。未保存値を保持しています。手動更新してください。');
          }
        } else setError('発注を保存できませんでした。未保存値を保持しています。');
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      <h3>発注</h3>
      {state.status === 'PAUSED' && <p>停止中です。進行役の再開を待ってください。</p>}
      {state.status === 'ENDED' && <p>終了しました。発注できません。</p>}
      {error && (
        <div ref={errorRef} role="alert" tabIndex={-1}>
          {error}
        </div>
      )}
      {notice && (
        <div role="status" aria-live="polite">
          {notice}
        </div>
      )}
      <label>
        発注量
        <input
          type="text"
          inputMode="numeric"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-invalid={Boolean(error)}
          disabled={!active || busy}
        />
      </label>
      <button type="submit" disabled={!active || busy || state.decisionComplete}>
        発注を保存
      </button>
    </form>
  );
}

export function PlayPage({
  api,
  gameId,
  sessionId,
  onReview,
}: {
  api: BrowserApi;
  gameId: string;
  sessionId: string;
  onReview: () => void;
}) {
  const [state, setState] = useState<RoleState>();
  const [error, setError] = useState('');
  const [automatic, setAutomatic] = useState(true);
  const [connection, setConnection] = useState<'connected' | 'polling'>('connected');
  const adapterRef = useRef<LiveStateAdapter<RoleState> | undefined>(undefined);
  async function refresh() {
    try {
      const next = await api.state(sessionId);
      setState((previous) => (!previous || next.version >= previous.version ? next : previous));
      setError('');
    } catch {
      setError('状態を取得できませんでした。');
    }
  }
  useEffect(() => {
    if (!automatic) return;
    const adapter = new LiveStateAdapter<RoleState>(
      `/api/v1/games/${encodeURIComponent(gameId)}/events`,
      () => api.state(sessionId),
      (next) => {
        setState(next);
        setError('');
      },
      undefined,
      setConnection,
    );
    adapterRef.current = adapter;
    void adapter.start().catch(() => setError('状態を取得できませんでした。'));
    return () => {
      adapter.stop();
      if (adapterRef.current === adapter) adapterRef.current = undefined;
    };
  }, [api, gameId, sessionId, automatic]);
  return (
    <section aria-labelledby="play-title">
      <h2 id="play-title">週次プレイ</h2>
      {error && <div role="alert">{error}</div>}
      {!state ? (
        <p>読み込み中…</p>
      ) : (
        <>
          <p>第 {state.week} 週</p>
          <p>{state.own.role}</p>
          <ol aria-label="週の 12 ステップ">
            {STEPS.map((step, index) => (
              <li
                key={step}
                aria-current={index === (state.decisionComplete ? 10 : 7) ? 'step' : undefined}
              >
                {step}
              </li>
            ))}
          </ol>
          <dl>
            <dt>在庫</dt>
            <dd>{state.own.inventory}</dd>
            <dt>受注残</dt>
            <dd>{state.own.backlog}</dd>
            <dt>入荷</dt>
            <dd>{state.own.arrivals}</dd>
            <dt>受注</dt>
            <dd>{state.own.order}</dd>
          </dl>
          <RoleDecisionForm state={state} api={api} onSaved={() => void refresh()} />
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
          {state.status === 'ENDED' && (
            <button type="button" onClick={onReview}>
              振り返りを見る
            </button>
          )}
        </>
      )}
      <span className="visually-hidden">ゲーム {gameId}</span>
    </section>
  );
}
