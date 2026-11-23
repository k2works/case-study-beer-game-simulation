import type { ConsoleRole, Role } from '../api/types.js';
import { DECISION_LABEL, ROLE_LABEL, formatMoney } from '../labels.js';

/** 進行役のコンソールの 1 区画: 1 役割の状況（進行役だけが見られる情報） */
export function RolePanel({ role, view }: { role: Role; view: ConsoleRole }) {
  const label = ROLE_LABEL[role];
  return (
    <section role="region" aria-label={`${label}の状況`} className="role-panel">
      <h2>{label}</h2>
      <p>担当: {view.holders.join('、') || '（なし）'}</p>
      <p>
        {view.decision
          ? `入力済み: ${view.decision.quantity}（${view.decision.savedBy}さんが保存）`
          : '未入力'}
      </p>
      <dl>
        <dt>在庫</dt>
        <dd>{view.inventory}</dd>
        <dt>受注残</dt>
        <dd>{view.backlog}</dd>
        <dt>入荷予定（来週・再来週）</dt>
        <dd>{view.incomingGoods.join('、')}</dd>
        <dt>累積費用</dt>
        <dd>{formatMoney(view.cumulativeCostMinor)}</dd>
      </dl>
      <details>
        <summary>週ごとの履歴（{view.history.length} 週）</summary>
        <table aria-label={`${label}の週ごとの結果`}>
          <thead>
            <tr>
              <th>週</th>
              <th>需要</th>
              <th>{DECISION_LABEL(role)}</th>
              <th>在庫</th>
              <th>受注残</th>
              <th>週次費用</th>
            </tr>
          </thead>
          <tbody>
            {view.history.map((h) => (
              <tr key={h.week}>
                <td>{h.week}</td>
                <td>{h.demand}</td>
                <td>{h.order}</td>
                <td>{h.endingInventory}</td>
                <td>{h.endingBacklog}</td>
                <td>{formatMoney(h.weeklyCostMinor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
