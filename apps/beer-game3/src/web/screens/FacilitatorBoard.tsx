import { useRef, useState, type FormEvent } from 'react';
import { MAX_DECISION, ROLES, ROLE_LABELS, type Role } from '../../server/domain/types.js';
import {
  ApiError,
  newIdempotencyKey,
  type ApiClient,
  type Credential,
  type GameStateView,
  type HistoryView,
  type ReplacementResult,
} from '../api.js';
import { FieldError, describeError } from '../components.js';
import {
  actorLabel,
  formatMoney,
  historyDetail,
  historyKindLabel,
  historyTime,
  parseNonNegativeInt,
  roleLabel,
  roleList,
} from '../format.js';

interface Props {
  api: ApiClient;
  credential: Credential;
  state: GameStateView;
  refresh: () => void;
}

const STATUS_LABELS = {
  preparing: '準備中',
  running: '進行中',
  paused: '一時停止中',
  ended: '終了',
};

/**
 * S4 進行管理: 4 役割の入力完了状況と現在の状態を見て、週の確定、一時停止・再開・終了、
 * 代理入力、担当者の入れ替え、操作の履歴の閲覧ができる。入力値そのものは示さない（BR14.2）。
 */
export function FacilitatorBoard({ api, credential, state, refresh }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [ending, setEnding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<{ week: number; key: string } | null>(null);

  const week = state.currentWeek;
  const ended = state.status === 'ended';
  const paused = state.status === 'paused';
  const missing = state.missingInputRoles ?? [];
  const labelsOf = (role: Role): string =>
    (state.assignees ?? [])
      .filter((a) => a.role === role)
      .map((a) => a.label)
      .join('、') || '—';

  const confirm = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    const key = pendingKey && pendingKey.week === week ? pendingKey.key : newIdempotencyKey();
    setPendingKey({ week, key });
    try {
      const done = await api.confirmWeek(credential, week, key);
      setConfirming(false);
      setPendingKey(null);
      setResult(`第 ${done.week} 週を確定しました（チーム費用 ${formatMoney(done.teamCost)}）`);
      refresh();
    } catch (e) {
      setConfirming(false);
      const detail =
        e instanceof ApiError && e.problem
          ? `${e.problem.reason}。${e.problem.hint}`
          : '通信できませんでした。';
      // 失敗したときは確定前の状態のまま。再実行できる
      setError(`第 ${week} 週の確定に失敗しました。確定前の状態のままです。${detail}`);
    } finally {
      setBusy(false);
    }
  };

  /** 一時停止・再開・終了。成功したら状態を取り直し、失敗したら理由と直し方を示す。 */
  const control = async (action: (c: Credential) => Promise<unknown>) => {
    setBusy(true);
    setControlError(null);
    try {
      await action(credential);
      setEnding(false);
      refresh();
    } catch (e) {
      setEnding(false);
      setControlError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main>
      <h1>進行管理</h1>
      <p>
        第 {week} 週 / {state.weekCount} <span aria-hidden="true">/</span> 状態:{' '}
        <strong data-testid="game-status">{STATUS_LABELS[state.status]}</strong>
      </p>
      {paused ? (
        <p role="status" data-testid="paused-banner" className="banner">
          一時停止中です。入力、代理入力、週の確定はできません。再開すると続けられます
        </p>
      ) : null}

      {!ended ? (
        <section aria-labelledby="control-heading">
          <h2 id="control-heading">ゲームの操作</h2>
          {paused ? (
            <button
              type="button"
              data-testid="resume-game"
              disabled={busy}
              onClick={() => void control(api.resume)}
            >
              再開する
            </button>
          ) : (
            <button
              type="button"
              data-testid="pause-game"
              disabled={busy}
              onClick={() => void control(api.pause)}
            >
              一時停止する
            </button>
          )}{' '}
          <button
            type="button"
            data-testid="end-game"
            disabled={busy}
            onClick={() => setEnding(true)}
          >
            ゲームを終了する
          </button>
          {ending ? (
            <div role="group" aria-label="終了の確認" className="confirm">
              <p>ゲームを終了します。終了後は入力も再開もできません</p>
              <button
                type="button"
                data-testid="end-game-yes"
                disabled={busy}
                onClick={() => void control(api.end)}
              >
                終了する
              </button>{' '}
              <button type="button" data-testid="end-game-cancel" onClick={() => setEnding(false)}>
                やめる
              </button>
            </div>
          ) : null}
          <FieldError id="control-error" message={controlError ?? undefined} />
        </section>
      ) : null}

      <RolesTable
        state={state}
        labelsOf={labelsOf}
        proxy={state.status === 'running' ? { api, credential, week, onDone: refresh } : null}
      />

      {ended ? (
        <p role="status">ゲームは終了しました</p>
      ) : (
        <section aria-labelledby="confirm-heading">
          <h2 id="confirm-heading">週の確定</h2>
          <p aria-live="polite">{state.inputsDone} / 4 役割が入力済み</p>
          {missing.length > 0 ? (
            <p data-testid="input-missing">未入力: {roleList(missing)}</p>
          ) : null}
          {paused ? <p>一時停止中は週を確定できません</p> : null}
          <button
            type="button"
            data-testid="confirm-week"
            disabled={missing.length > 0 || busy || paused}
            onClick={() => setConfirming(true)}
          >
            第 {week} 週を確定する
          </button>
          {confirming ? (
            <div role="group" aria-label="確定の確認" className="confirm">
              <p>第 {week} 週を確定します。確定後は変更できません</p>
              <button
                type="button"
                data-testid="confirm-week-yes"
                disabled={busy}
                onClick={() => void confirm()}
              >
                {busy ? '確定しています' : '確定する'}
              </button>{' '}
              <button
                type="button"
                data-testid="confirm-week-cancel"
                onClick={() => setConfirming(false)}
              >
                やめる
              </button>
            </div>
          ) : null}
          <FieldError id="confirm-error" message={error ?? undefined} />
          {result ? <p role="status">{result}</p> : null}
        </section>
      )}

      {!ended ? (
        <ReplacePanel api={api} credential={credential} state={state} refresh={refresh} />
      ) : null}
      <HistoryPanel api={api} credential={credential} />
    </main>
  );
}

interface ProxyContext {
  api: ApiClient;
  credential: Credential;
  week: number;
  onDone: () => void;
}

function RolesTable({
  state,
  labelsOf,
  proxy,
}: {
  state: GameStateView;
  labelsOf: (role: Role) => string;
  proxy: ProxyContext | null;
}) {
  const [values, setValues] = useState<Partial<Record<Role, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Partial<Record<Role, string>>>({});
  const [saving, setSaving] = useState<Role | null>(null);
  const pending = useRef<{ role: Role; week: number; quantity: number; key: string } | null>(null);

  const submit = async (event: FormEvent, role: Role) => {
    event.preventDefault();
    if (!proxy || saving) {
      return;
    }
    const quantity = parseNonNegativeInt(values[role] ?? '');
    if (quantity === null || quantity > MAX_DECISION) {
      setError(
        `${roleLabel(role)}の代理入力は 0 以上 ${MAX_DECISION} 以下の整数で入力してください`,
      );
      return;
    }
    setError(null);
    setSaving(role);
    const current = pending.current;
    const key =
      current &&
      current.role === role &&
      current.week === proxy.week &&
      current.quantity === quantity
        ? current.key
        : newIdempotencyKey();
    pending.current = { role, week: proxy.week, quantity, key };
    try {
      await proxy.api.submitDecision(proxy.credential, proxy.week, role, quantity, key);
      pending.current = null;
      setDone((prev) => ({
        ...prev,
        [role]: `${roleLabel(role)} 第 ${proxy.week} 週に ${quantity} を入力しました`,
      }));
      setValues((prev) => ({ ...prev, [role]: '' }));
      proxy.onDone();
    } catch (e) {
      if (!(e instanceof ApiError) || e.kind !== 'unavailable') {
        pending.current = null;
      }
      setError(describeError(e));
    } finally {
      setSaving(null);
    }
  };

  return (
    <section aria-labelledby="roles-heading">
      <h2 id="roles-heading">役割別の状況</h2>
      <table aria-label="役割別の状況">
        <thead>
          <tr>
            <th scope="col">役割</th>
            <th scope="col">担当者</th>
            <th scope="col">入力</th>
            <th scope="col">在庫</th>
            <th scope="col">受注残</th>
            <th scope="col">今週の受注</th>
            <th scope="col">入荷</th>
            {proxy ? <th scope="col">代理入力</th> : null}
          </tr>
        </thead>
        <tbody>
          {ROLES.map((role) => {
            const overview = state.roles?.[role];
            const missingInput = (state.missingInputRoles ?? []).includes(role);
            return (
              <tr
                key={role}
                data-testid={`role-row-${role}`}
                data-missing={missingInput ? 'true' : 'false'}
                className={missingInput ? 'missing' : undefined}
              >
                <td>{ROLE_LABELS[role]}</td>
                <td>{labelsOf(role)}</td>
                <td>
                  {overview?.decided ? '入力済み' : '未入力'}
                  {missingInput ? <span aria-hidden="true"> ◀ 入力待ち</span> : null}
                </td>
                <td>{overview?.inventory ?? '—'}</td>
                <td>{overview?.backlog ?? '—'}</td>
                <td>{overview?.ordersReceived ?? '—'}</td>
                <td>{overview?.receipt ?? '—'}</td>
                {proxy ? (
                  <td>
                    <form onSubmit={(e) => void submit(e, role)} noValidate>
                      <input
                        data-testid={`proxy-input-${role}`}
                        aria-label={`${ROLE_LABELS[role]}の代理入力`}
                        inputMode="numeric"
                        autoComplete="off"
                        value={values[role] ?? ''}
                        onChange={(e) => setValues((prev) => ({ ...prev, [role]: e.target.value }))}
                        size={6}
                      />{' '}
                      <button
                        type="submit"
                        data-testid={`proxy-submit-${role}`}
                        disabled={saving !== null}
                      >
                        代理入力
                      </button>
                      {done[role] ? (
                        <span role="status" data-testid={`proxy-result-${role}`}>
                          {' '}
                          {done[role]}
                        </span>
                      ) : null}
                    </form>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      <FieldError id="proxy-error" message={error ?? undefined} />
    </section>
  );
}

function ReplacePanel({
  api,
  credential,
  state,
  refresh,
}: {
  api: ApiClient;
  credential: Credential;
  state: GameStateView;
  refresh: () => void;
}) {
  const [target, setTarget] = useState<{ participantId: string; role: Role; label: string } | null>(
    null,
  );
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 新しい復帰用 token の平文。この画面の状態にだけ置き、閉じたら捨てる（NFR6.2）
  const [issued, setIssued] = useState<ReplacementResult | null>(null);
  const assignees = state.assignees ?? [];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!target || busy) {
      return;
    }
    const displayName = name.trim();
    if (displayName === '' || [...displayName].length > 40) {
      setError('新しい担当者の表示名を 1〜40 文字で入力してください');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await api.replaceAssignee(
        credential,
        target.role,
        target.participantId,
        displayName,
      );
      setIssued(result);
      setTarget(null);
      setName('');
      refresh();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="replace-heading">
      <h2 id="replace-heading">担当者の入れ替え</h2>
      <ul className="participants">
        {assignees.map((a) => (
          <li key={a.participantId}>
            {roleLabel(a.role)}: {a.label}{' '}
            <button
              type="button"
              data-testid={`replace-open-${a.participantId}`}
              onClick={() => {
                setTarget({ participantId: a.participantId, role: a.role, label: a.label });
                setError(null);
                setIssued(null);
              }}
            >
              入れ替える
            </button>
          </li>
        ))}
      </ul>
      {target ? (
        <form onSubmit={(e) => void submit(e)} noValidate aria-label="担当者の入れ替え">
          <p>
            {roleLabel(target.role)}の {target.label}{' '}
            を入れ替えます。同じ役割のまま、新しい担当者に替わります
          </p>
          <div className="field">
            <label htmlFor="replace-name">新しい担当者の表示名</label>
            <input
              id="replace-name"
              data-testid="replace-name"
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <button type="submit" data-testid="replace-submit" disabled={busy}>
            {busy ? '入れ替えています' : '入れ替える'}
          </button>{' '}
          <button
            type="button"
            data-testid="replace-cancel"
            onClick={() => {
              setTarget(null);
              setError(null);
            }}
          >
            やめる
          </button>
        </form>
      ) : null}
      <FieldError id="replace-error" message={error ?? undefined} />
      {issued ? (
        <div
          role="group"
          aria-label="新しい復帰用 token"
          data-testid="replacement-token"
          className="confirm"
        >
          <p>
            {roleLabel(issued.role)}の新しい担当者 {issued.label} の復帰用 token です。この token
            は、もう一度は表示されません。新しい担当者に伝えてください
          </p>
          <p>
            <code>{issued.token}</code>
          </p>
          <button
            type="button"
            data-testid="replacement-token-close"
            onClick={() => setIssued(null)}
          >
            閉じる
          </button>
        </div>
      ) : null}
    </section>
  );
}

function HistoryPanel({ api, credential }: { api: ApiClient; credential: Credential }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<HistoryView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setError(null);
    try {
      setHistory(await api.getHistory(credential));
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <section aria-labelledby="history-heading">
      <h2 id="history-heading">操作の履歴</h2>
      <button
        type="button"
        data-testid="history-toggle"
        aria-expanded={open}
        onClick={() => void toggle()}
      >
        履歴{open ? 'を閉じる' : 'を開く'}
      </button>
      <FieldError id="history-error" message={error ?? undefined} />
      {open && history ? (
        history.entries.length === 0 ? (
          <p>まだ履歴がありません</p>
        ) : (
          <table aria-label="操作の履歴">
            <thead>
              <tr>
                <th scope="col">番号</th>
                <th scope="col">時刻</th>
                <th scope="col">誰が</th>
                <th scope="col">種類</th>
                <th scope="col">内容</th>
              </tr>
            </thead>
            <tbody>
              {history.entries.map((entry) => (
                <tr key={entry.sequence}>
                  <td>{entry.sequence}</td>
                  <td>
                    <time dateTime={entry.occurredAt}>{historyTime(entry.occurredAt)}</time>
                  </td>
                  <td>{actorLabel(entry)}</td>
                  <td>{historyKindLabel(entry)}</td>
                  <td>{historyDetail(entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}
    </section>
  );
}
