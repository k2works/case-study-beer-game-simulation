import type { ObserverView } from '../api.js';
import { formatMoney } from '../format.js';

interface Props {
  state: ObserverView;
}

const STATUS_LABELS: Record<ObserverView['status'], string> = {
  preparing: '準備中',
  running: '進行中',
  paused: '一時停止中',
  ended: '終了',
};

/** 観察画面: 現在週と、チーム全体の合計だけを示す。役割別の値は返らず、入力欄も持たない（BR15.2、BR15.3）。 */
export function ObserverScreen({ state }: Props) {
  return (
    <main data-testid="observer-view">
      <h1>ビールゲーム（観察）</h1>
      <p>{state.name}</p>
      <p data-testid="observer-week">
        第 {state.currentWeek} 週 / {state.weekCount}
      </p>
      <p data-testid="observer-status">状態: {STATUS_LABELS[state.status]}</p>
      <p data-testid="observer-inputs">入力: 4 役割のうち {state.inputsDone} が入力済み</p>

      <section aria-labelledby="observer-totals-heading">
        <h2 id="observer-totals-heading">チーム全体の合計</h2>
        <table aria-label="チーム全体の合計">
          <thead>
            <tr>
              <th scope="col">項目</th>
              <th scope="col">値</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">週の費用</th>
              <td data-testid="observer-cost-week">{formatMoney(state.teamWeeklyCost)}</td>
            </tr>
            <tr>
              <th scope="row">累積費用</th>
              <td data-testid="observer-cost-total">{formatMoney(state.teamCumulativeCost)}</td>
            </tr>
            <tr>
              <th scope="row">在庫</th>
              <td data-testid="observer-inventory">{state.teamInventory}</td>
            </tr>
            <tr>
              <th scope="row">受注残</th>
              <td data-testid="observer-backlog">{state.teamBacklog}</td>
            </tr>
          </tbody>
        </table>
        <p className="hint">
          最新の確定済みの週の週末の値です。確定済みの週がまだないときは、初期状態の値です。役割別の値は表示しません。
        </p>
      </section>
    </main>
  );
}
