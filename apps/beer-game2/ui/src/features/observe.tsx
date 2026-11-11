import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { ObservationView } from '../api/types.js';
import { ErrorMessage, Page } from '../components.js';
import { useApi, useLiveSnapshot } from '../hooks.js';
import { ROLE_LABEL, ROLE_ORDER, STEP_LABEL } from '../labels.js';

/** S10 観察者の参加。観察用の招待コードで参加する（参加コードとは別） */
export function ObserveJoin() {
  const api = useApi();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const joined = await api.observe({
        code: code.trim(),
        displayName: displayName.trim(),
      });
      navigate(`/games/${joined.gameId}/observation`);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Page title="観察者として参加">
      <form onSubmit={submit}>
        <label>
          観察用の招待コード
          <input
            value={code}
            autoComplete="off"
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <label>
          表示名（任意）
          <input
            value={displayName}
            maxLength={20}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <button type="submit">観察者として参加</button>
      </form>
      <p>観察者は、読み取り専用です。役割別の非公開の情報は見られません。</p>
      <ErrorMessage error={error} />
    </Page>
  );
}

const value = (v: number | null, hidden: string) =>
  v === null ? hidden : String(v);

function Totals({
  totals,
}: {
  totals: NonNullable<ObservationView['totals']>;
}) {
  const week = totals.lastCommittedWeek;
  const after = week === null ? '' : `（${week} 週目の終わり）`;
  const none = 'まだ確定した週がありません';
  return (
    <ul aria-label="チーム合計">
      <li>
        在庫{after}: {value(totals.inventory, none)}
      </li>
      <li>
        受注残{after}: {value(totals.backlog, none)}
      </li>
      <li>
        注文（当週の入力済み）:{' '}
        {value(totals.orders, '非表示（入力済みが 2 役割未満）')}
      </li>
    </ul>
  );
}

/** S07 観察。逆算できないチーム合計と、進行状況だけを示す（読み取り専用） */
export function ObservationScreen() {
  const { id = '' } = useParams();
  const api = useApi();
  const { data: view, error } = useLiveSnapshot(id, () => api.observation(id));

  if (!view) {
    return (
      <Page title="観察">
        {error ? (
          <ErrorMessage error={new Error(error)} />
        ) : (
          <p>読み込み中です</p>
        )}
      </Page>
    );
  }

  return (
    <Page title="観察">
      {view.status === 'ENDED' ? (
        <p>
          ゲームは終了しました。
          <Link to={`/games/${id}/review`}>振り返りを見る</Link>
        </p>
      ) : (
        <p>
          {view.week} 週目（{STEP_LABEL[view.step]}）
        </p>
      )}
      <table aria-label="完了状況">
        <tbody>
          {ROLE_ORDER.map((r) => (
            <tr key={r}>
              <th scope="row">{ROLE_LABEL[r]}</th>
              <td>{view.submitted[r] ? '入力済み' : '未入力'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.totals ? (
        <Totals totals={view.totals} />
      ) : (
        <p>このゲームの公開範囲は「進行状況だけ」です。</p>
      )}
      <p>役割別の値と需要は、ゲームの終了後に振り返りで見られます。</p>
    </Page>
  );
}
