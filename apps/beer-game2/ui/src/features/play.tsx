import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import type { CommitResult } from '../api/types.js';
import { ErrorMessage, Page } from '../components.js';
import { useApi, useLiveSnapshot } from '../hooks.js';
import { DECISION_LABEL, ROLE_LABEL, formatMoney } from '../labels.js';

/**
 * @guidedTour walking-skeleton 10 入口。参加者が発注を保存する画面。`api.saveDecision` を、画面が持つ「版」とともに呼ぶ（他の操作で更新されていたら、黙って上書きしないため）。画面は HTTP を知らず、`ApiClient`（実装は `ui/src/api/http-client.ts`、テストでは偽物）だけに依存する。次は、サーバー側の入口。
 */
export function PlayScreen() {
  const { id = '' } = useParams();
  const api = useApi();
  const { data: view, error, reload } = useLiveSnapshot(id, () => api.me(id));
  const [draft, setDraft] = useState<string | null>(null);
  const [savedWeek, setSavedWeek] = useState<number | null>(null);
  const [committed, setCommitted] = useState<CommitResult | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);

  if (!view) {
    return (
      <Page title="プレイ">
        {error ? (
          <ErrorMessage error={new Error(error)} />
        ) : (
          <p>読み込み中です</p>
        )}
      </Page>
    );
  }

  const ended = view.status === 'ENDED';
  const paused = view.status === 'PAUSED';
  const value = draft ?? (view.decision ? String(view.decision.quantity) : '');

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaveError(null);
    setSavedWeek(null);
    setCommitted(null);
    if (!/^\d+$/.test(value.trim())) {
      setSaveError(new Error('0 以上の整数を入力してください'));
      return;
    }
    try {
      const result = await api.saveDecision(
        id,
        view!.role,
        Number(value),
        view!.decision?.version ?? 0,
      );
      setSavedWeek(view!.week);
      setCommitted(result.committed ?? null);
      setDraft(null);
      await reload();
    } catch (err) {
      setSaveError(err);
    }
  }

  return (
    <Page title={`${ROLE_LABEL[view.role]}の画面`}>
      {ended ? (
        <p>
          ゲームは終了しました。
          <Link to={`/games/${id}/review`}>振り返りを見る</Link>
        </p>
      ) : (
        <p>{view.week} 週目</p>
      )}
      {paused && (
        <p role="status">停止中です。進行役の再開を待ってください。</p>
      )}
      <dl>
        <dt>在庫</dt>
        <dd>{view.inventory}</dd>
        <dt>受注残</dt>
        <dd>{view.backlog}</dd>
        <dt>入荷の予定（来週・再来週）</dt>
        <dd>{view.incomingGoods.join('、')}</dd>
        {view.customerDemand !== undefined && (
          <>
            <dt>今週の顧客需要</dt>
            <dd>{view.customerDemand}</dd>
          </>
        )}
      </dl>
      {!ended && (
        <form onSubmit={save}>
          <label>
            {DECISION_LABEL(view.role)}
            <input
              type="number"
              min={0}
              value={value}
              disabled={paused}
              onChange={(e) => {
                setDraft(e.target.value);
                setSavedWeek(null);
              }}
            />
          </label>
          <button type="submit" disabled={paused}>
            保存する
          </button>
          {savedWeek === view.week && <p role="status">保存しました</p>}
        </form>
      )}
      {committed && (
        <p role="status">
          {committed.status === 'ENDED'
            ? '全員の発注がそろい、ゲームが終了しました。'
            : `全員の発注がそろい、${committed.nextWeek} 週目に進みました。`}
        </p>
      )}
      {!ended && view.decision && (
        <p data-testid="waiting">
          今週の発注 {view.decision.quantity} を保存済みです。
          {view.commitMode === 'AUTO' ? (
            'ほかの役割の入力がそろうと、自動で次の週に進みます（この画面は自動で更新されます）。'
          ) : (
            <>
              ほかの役割の入力がそろい、進行役が週を確定すると、次の週に進みます（この画面は自動で更新されます）。
              進行役の方は{' '}
              <Link to={`/games/${id}/console`}>進行役コンソール</Link>{' '}
              で確定してください。
            </>
          )}
        </p>
      )}
      <ErrorMessage error={saveError} />
      <table aria-label="週ごとの結果">
        <thead>
          <tr>
            <th>週</th>
            <th>需要</th>
            <th>入荷</th>
            <th>出荷</th>
            <th>{DECISION_LABEL(view.role)}</th>
            <th>在庫</th>
            <th>受注残</th>
            <th>週次費用</th>
            <th>累積費用</th>
          </tr>
        </thead>
        <tbody>
          {view.history.map((h) => (
            <tr key={h.week}>
              <td>{h.week}</td>
              <td>{h.demand}</td>
              <td>{h.received}</td>
              <td>{h.shipped}</td>
              <td>{h.order}</td>
              <td>{h.endingInventory}</td>
              <td>{h.endingBacklog}</td>
              <td>{formatMoney(h.weeklyCostMinor)}</td>
              <td>{formatMoney(h.cumulativeCostMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Page>
  );
}
