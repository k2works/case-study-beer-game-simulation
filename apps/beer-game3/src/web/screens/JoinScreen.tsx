import { useState, type FormEvent } from 'react';
import { ApiError, type ApiClient, type Credential } from '../api.js';
import { FieldError } from '../components.js';
import { DISPLAY_NAME_RULE } from '../messages.js';

interface Props {
  api: ApiClient;
  /** 保存した資格情報が使えなかったときの案内（BR17.3） */
  notice?: string | null;
  onJoined: (credential: Credential) => void;
  onFacilitator: (credential: Credential) => void;
  /** 観察者用コードで入る（BR15.4） */
  onObserver: (credential: Credential) => void;
  onCreate: () => void;
}

function messageOf(error: unknown): { general?: string; fields: Record<string, string> } {
  if (!(error instanceof ApiError)) {
    return { general: '想定外の問題が起きました。もう一度操作してください', fields: {} };
  }
  if (error.kind === 'network') {
    return {
      general: '通信できませんでした。接続を確かめて、もう一度操作してください',
      fields: {},
    };
  }
  const fields: Record<string, string> = {};
  for (const field of error.problem?.fields ?? []) {
    fields[field.path] = field.message;
  }
  if (Object.keys(fields).length > 0) {
    return { fields };
  }
  const problem = error.problem;
  return {
    general: problem
      ? `${problem.reason}。${problem.hint}`
      : '想定外の応答です。もう一度操作してください',
    fields,
  };
}

/** S0 参加入口: 参加コードと表示名で参加する。進行役用コードで入り直すこともできる。 */
export function JoinScreen({ api, notice, onJoined, onFacilitator, onObserver, onCreate }: Props) {
  const [observerCode, setObserverCode] = useState('');
  const [observerError, setObserverError] = useState<string | null>(null);

  const [joinCode, setJoinCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ general?: string; fields: Record<string, string> } | null>(
    null,
  );
  const [facilitatorCode, setFacilitatorCode] = useState('');
  const [facilitatorError, setFacilitatorError] = useState<string | null>(null);

  const ready = joinCode.trim() !== '' && displayName.trim() !== '';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    setFacilitatorError(null);
    try {
      const joined = await api.join({ joinCode: joinCode.trim(), displayName: displayName.trim() });
      onJoined({ kind: 'participant', secret: joined.token, gameId: joined.gameId });
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  };

  const enterAsFacilitator = async (event: FormEvent) => {
    event.preventDefault();
    const secret = facilitatorCode.trim();
    if (!secret) {
      return;
    }
    setError(null);
    setFacilitatorError(null);
    try {
      const me = await api.me(secret);
      if (me.kind !== 'facilitator') {
        setFacilitatorError('進行役用コードを確かめてください');
        return;
      }
      onFacilitator({ kind: 'facilitator', secret, gameId: me.gameId });
    } catch (e) {
      setFacilitatorError(messageOf(e).general ?? '進行役用コードを確かめてください');
    }
  };

  const enterAsObserver = async (event: FormEvent) => {
    event.preventDefault();
    const secret = observerCode.trim();
    if (!secret) {
      return;
    }
    setObserverError(null);
    try {
      const me = await api.me(secret);
      if (me.kind !== 'observer') {
        // 別の種類のコードは、観察者の入口では受け付けない
        setObserverError('観察者用コードが正しくありません');
        return;
      }
      onObserver({ kind: 'observer', secret, gameId: me.gameId });
    } catch (e) {
      setObserverError(
        e instanceof ApiError && e.kind === 'forbidden'
          ? '観察者用コードが正しくありません'
          : (messageOf(e).general ?? '観察者用コードを確かめてください'),
      );
    }
  };

  return (
    <main>
      <h1>ビールゲーム</h1>
      {notice ? (
        <p role="alert" data-testid="credential-notice" className="banner">
          {notice}
        </p>
      ) : null}
      <section aria-labelledby="join-heading">
        <h2 id="join-heading">ゲームに参加する</h2>
        <form onSubmit={(e) => void submit(e)} noValidate>
          <div className="field">
            <label htmlFor="join-code">参加コード</label>
            <input
              id="join-code"
              data-testid="join-code"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              autoComplete="off"
              aria-invalid={error?.fields.joinCode ? true : undefined}
              aria-describedby="join-code-error"
            />
            <FieldError id="join-code-error" message={error?.fields.joinCode} />
          </div>
          <div className="field">
            <label htmlFor="join-name">表示名</label>
            <input
              id="join-name"
              data-testid="join-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="off"
              aria-invalid={error?.fields.displayName ? true : undefined}
              aria-describedby={
                error?.fields.displayName ? 'join-name-rule join-name-error' : 'join-name-rule'
              }
            />
            <p id="join-name-rule" data-testid="join-name-rule" className="hint">
              {DISPLAY_NAME_RULE}
            </p>
            <FieldError id="join-name-error" message={error?.fields.displayName} />
          </div>
          {error?.general ? (
            <p role="alert" className="field-error">
              {error.general}
            </p>
          ) : null}
          {!ready ? <p id="join-hint">参加コードと表示名を入力すると押せます</p> : null}
          <button
            type="submit"
            data-testid="join-submit"
            disabled={!ready || busy}
            aria-describedby={!ready ? 'join-hint' : undefined}
          >
            {busy ? '参加しています' : '参加する'}
          </button>
        </form>
      </section>

      <section aria-labelledby="observer-heading">
        <h2 id="observer-heading">観察者として見る</h2>
        <form onSubmit={(e) => void enterAsObserver(e)} noValidate>
          <div className="field">
            <label htmlFor="observer-code">観察者用コード</label>
            <input
              id="observer-code"
              data-testid="observer-code-input"
              value={observerCode}
              onChange={(e) => setObserverCode(e.target.value)}
              autoComplete="off"
              aria-invalid={observerError ? true : undefined}
              aria-describedby="observer-code-error"
            />
            {observerError ? (
              <p
                id="observer-code-error"
                role="alert"
                data-testid="observer-error"
                className="field-error"
              >
                {observerError}
              </p>
            ) : null}
          </div>
          <button type="submit" data-testid="observer-enter">
            観察者として入る
          </button>
        </form>
      </section>

      <section aria-labelledby="facilitator-heading">
        <h2 id="facilitator-heading">進行役の方</h2>
        <button type="button" data-testid="go-create" onClick={onCreate}>
          ゲームを作成
        </button>
        <form onSubmit={(e) => void enterAsFacilitator(e)} noValidate>
          <div className="field">
            <label htmlFor="facilitator-code">進行役用コード</label>
            <input
              id="facilitator-code"
              data-testid="facilitator-code-input"
              value={facilitatorCode}
              onChange={(e) => setFacilitatorCode(e.target.value)}
              autoComplete="off"
              aria-describedby="facilitator-code-error"
            />
            <FieldError id="facilitator-code-error" message={facilitatorError ?? undefined} />
          </div>
          <button type="submit" data-testid="facilitator-enter">
            進行役として入る
          </button>
        </form>
      </section>
    </main>
  );
}
