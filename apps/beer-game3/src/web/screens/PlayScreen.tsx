import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MAX_DECISION, ROLE_LABELS } from '../../server/domain/types.js';
import {
  ApiError,
  newIdempotencyKey,
  type ApiClient,
  type Credential,
  type GameStateView,
} from '../api.js';
import { FieldError, StepProgress } from '../components.js';
import { formatMoney, parseNonNegativeInt } from '../format.js';

interface Props {
  api: ApiClient;
  credential: Credential;
  state: GameStateView;
  refresh: () => void;
}

const INPUT_MESSAGE = `0 以上 ${MAX_DECISION} 以下の整数で入力してください`;

/** S3 役割別プレイ: 自分の役割の状況を見て、発注数（工場は生産要請数）を入力する。 */
export function PlayScreen({ api, credential, state, refresh }: Props) {
  const mine = state.mine;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedWeek, setSavedWeek] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // 失敗した送信の再実行で同じ識別子を使う（重複して処理させない）
  const pending = useRef<{ week: number; quantity: number; key: string } | null>(null);
  const week = mine?.week ?? state.currentWeek;

  useEffect(() => {
    setDraft(null);
    setError(null);
    setSavedWeek(null);
    pending.current = null;
  }, [week]);

  // 共同担当の置き換わりの検出（BR12.2）。自分が最後に見た版を基準にし、
  // 最初に受け取った版（再読み込み・復帰・入れ替え直後）では通知を出さない。
  const selfId = state.self?.participantId;
  const baseline = useRef<{ week: number; revision: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!mine) {
      return;
    }
    const seen = baseline.current;
    if (!seen || seen.week !== mine.week) {
      baseline.current = { week: mine.week, revision: mine.decisionRevision };
      setNotice(null);
      return;
    }
    if (mine.decisionRevision !== seen.revision) {
      baseline.current = { week: mine.week, revision: mine.decisionRevision };
      const by = mine.decidedBy;
      setNotice(
        by && by.participantId !== selfId && mine.decision !== null
          ? `${by.label} が ${mine.decision} に変更しました`
          : null,
      );
    }
  }, [mine, selfId]);

  if (!mine || !state.role) {
    return (
      <main>
        <h1>ビールゲーム</h1>
        <p>役割が割り当てられていません。進行役に確かめてください。</p>
      </main>
    );
  }

  const ended = state.status === 'ended';
  const paused = state.status === 'paused';
  const isFactory = state.role === 'factory';
  const inputLabel = isFactory ? '生産要請数' : '発注数';
  const ordersLabel = isFactory
    ? '受注（一次卸からの注文）'
    : state.role === 'retailer'
      ? '受注（今週の顧客需要）'
      : '受注';
  const value = draft ?? (mine.decision !== null ? String(mine.decision) : '');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) {
      return;
    }
    const quantity = parseNonNegativeInt(value);
    if (quantity === null || quantity > MAX_DECISION) {
      setError(`${inputLabel}は ${INPUT_MESSAGE}`);
      return;
    }
    setError(null);
    setSaving(true);
    const current = pending.current;
    const key =
      current && current.week === week && current.quantity === quantity
        ? current.key
        : newIdempotencyKey();
    pending.current = { week, quantity, key };
    try {
      await api.submitDecision(credential, week, state.role!, quantity, key);
      pending.current = null;
      setSavedWeek(week);
      refresh();
    } catch (e) {
      setSavedWeek(null);
      if (e instanceof ApiError && e.problem) {
        const field = e.fieldMessage('quantity');
        setError(field ?? `${e.problem.reason}。${e.problem.hint}`);
        if (e.kind !== 'unavailable') {
          // 内容を決めて拒否されたものは、同じ識別子を使い回さない
          pending.current = null;
        }
      } else {
        setError('通信できませんでした。接続を確かめて、もう一度操作してください');
      }
    } finally {
      setSaving(false);
    }
  };

  const saveStatus =
    savedWeek === week
      ? '入力: 保存済み'
      : mine.decision !== null
        ? `入力: 保存済み（${mine.decision}）`
        : '入力: 未入力';

  const history = [...mine.history].sort((a, b) => b.week - a.week);

  return (
    <main>
      <h1>ビールゲーム</h1>
      <p>
        第 {week} 週 / {state.weekCount}
      </p>
      <p>役割: {ROLE_LABELS[state.role]}</p>
      <p>状態: {ended ? '終了' : paused ? '一時停止中' : '進行中'}</p>
      {paused ? (
        <p role="status" data-testid="paused-notice" className="banner">
          ゲームは一時停止中です。進行役が再開するまで入力できません。保存済みの入力は残っています
        </p>
      ) : null}
      {!ended ? <StepProgress current={11} /> : null}

      <section aria-labelledby="status-heading">
        <h2 id="status-heading">今週の状況</h2>
        <dl data-testid="status-panel" className="status">
          <dt>入荷</dt>
          <dd>{mine.receipt}</dd>
          <dt>{ordersLabel}</dt>
          <dd>{mine.ordersReceived}</dd>
          <dt>在庫</dt>
          <dd>{mine.inventory}</dd>
          <dt>受注残</dt>
          <dd>{mine.backlog}</dd>
        </dl>
        <p>
          累積費用 <strong>{formatMoney(mine.cumulativeCost)}</strong>
        </p>
      </section>

      {state.customerDemand && state.customerDemand.length > 0 ? (
        <section aria-labelledby="demand-heading" data-testid="customer-demand">
          <h2 id="demand-heading">顧客需要</h2>
          <table aria-label="顧客需要">
            <thead>
              <tr>
                <th scope="col">週</th>
                <th scope="col">顧客需要</th>
              </tr>
            </thead>
            <tbody>
              {state.customerDemand.map((demand, index) => (
                <tr key={index}>
                  <td>第 {index + 1} 週</td>
                  <td>{demand}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">当週までの値です。先の週の需要は見えません。</p>
        </section>
      ) : null}

      {ended ? (
        <section>
          <p role="status">ゲームは終了しました</p>
          <p>「結果を見る」から、全役割の時系列を比べられます。</p>
        </section>
      ) : (
        <section aria-labelledby="input-heading">
          <h2 id="input-heading">{inputLabel}を入力する</h2>
          <form onSubmit={(e) => void submit(e)} noValidate>
            <div className="field">
              <label htmlFor="decision-input">{inputLabel}</label>
              <input
                id="decision-input"
                data-testid="decision-input"
                inputMode="numeric"
                autoComplete="off"
                value={value}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setSavedWeek(null);
                }}
                disabled={paused}
                aria-invalid={error ? true : undefined}
                aria-describedby="decision-hint decision-error"
              />
              <span id="decision-hint" className="hint">
                （{INPUT_MESSAGE}）
              </span>
              <FieldError id="decision-error" message={error ?? undefined} />
            </div>
            <button type="submit" data-testid="decision-submit" disabled={saving || paused}>
              {saving ? '保存しています' : `${inputLabel}を保存する`}
            </button>
            <p role="status">{saveStatus}</p>
            {notice ? (
              <p role="status" aria-live="polite" data-testid="replaced-notice" className="banner">
                {notice}
              </p>
            ) : null}
          </form>
          <p aria-live="polite">ほかの役割: 4 役割のうち {state.inputsDone} が入力済み</p>
        </section>
      )}

      <section>
        <button
          type="button"
          data-testid="history-toggle"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          履歴{historyOpen ? 'を閉じる' : 'を開く'}
        </button>
        {historyOpen ? (
          history.length === 0 ? (
            <p>まだ履歴がありません</p>
          ) : (
            <table aria-label="履歴">
              <thead>
                <tr>
                  <th scope="col">週</th>
                  <th scope="col">入荷</th>
                  <th scope="col">受注</th>
                  <th scope="col">出荷</th>
                  <th scope="col">在庫</th>
                  <th scope="col">受注残</th>
                  <th scope="col">{inputLabel}</th>
                  <th scope="col">費用</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.week}>
                    <td>{row.week}</td>
                    <td>{row.receipt}</td>
                    <td>{row.ordersReceived}</td>
                    <td>{row.shipped}</td>
                    <td>{row.inventory}</td>
                    <td>{row.backlog}</td>
                    <td>{row.decision}</td>
                    <td>{formatMoney(row.weeklyCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </section>
    </main>
  );
}
