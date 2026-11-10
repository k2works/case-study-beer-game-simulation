import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorMessage, Page } from '../components.js';
import { useApi, useLiveSnapshot } from '../hooks.js';
import { ROLE_LABEL, ROLE_ORDER } from '../labels.js';

const newKey = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

export function ConsoleScreen() {
  const { id = '' } = useParams();
  const api = useApi();
  const {
    data: view,
    error,
    reload,
  } = useLiveSnapshot(id, () => api.console(id));
  const [confirming, setConfirming] = useState(false);
  const [commitError, setCommitError] = useState<unknown>(null);

  if (!view) {
    return (
      <Page title="進行役コンソール">
        {error ? (
          <ErrorMessage error={new Error(error)} />
        ) : (
          <p>読み込み中です</p>
        )}
      </Page>
    );
  }

  const ended = view.status === 'ENDED';
  const allIn = ROLE_ORDER.every((r) => view.submitted[r]);

  async function commit() {
    setCommitError(null);
    try {
      await api.commit(id, view!.week, view!.sessionVersion, newKey());
      setConfirming(false);
      await reload();
    } catch (e) {
      setConfirming(false);
      setCommitError(e);
      await reload();
    }
  }

  return (
    <Page title="進行役コンソール">
      {ended ? (
        <p>ゲームは終了しました。</p>
      ) : (
        <p>{view.week} 週目の入力状況</p>
      )}
      <table aria-label="入力状況">
        <tbody>
          {ROLE_ORDER.map((r) => (
            <tr key={r}>
              <th scope="row">{ROLE_LABEL[r]}</th>
              <td>{view.submitted[r] ? '入力済み' : '未入力'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        disabled={ended || !allIn}
        onClick={() => setConfirming(true)}
      >
        週を確定する
      </button>
      {confirming && (
        <div role="dialog" aria-modal="true" aria-label="週の確定の確認">
          <p>{view.week} 週目を確定します。確定後は、入力を変更できません。</p>
          <button type="button" onClick={() => void commit()}>
            確定する
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            キャンセル
          </button>
        </div>
      )}
      <ErrorMessage error={commitError} />
      <p>
        <Link to={`/games/${id}/play`}>参加者として遊ぶ</Link>
        （この画面の進行役が、役割も担当しているとき）
      </p>
    </Page>
  );
}
