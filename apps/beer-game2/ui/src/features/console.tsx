import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import type { CredentialTarget, Role } from '../api/types.js';
import {
  ConfirmDialog,
  ErrorMessage,
  Page,
  RecoveryCodeNote,
  SettingsSummary,
} from '../components.js';
import { useApi, useLiveSnapshot } from '../hooks.js';
import { ROLE_LABEL, ROLE_ORDER } from '../labels.js';

const newKey = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

/** 確認ダイアログで確かめる操作 */
type Pending =
  | { kind: 'commit' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'proxy'; role: Role; quantity: number }
  | { kind: 'reissue'; target: CredentialTarget; name: string };

export function ConsoleScreen() {
  const { id = '' } = useParams();
  const api = useApi();
  const {
    data: view,
    error,
    reload,
  } = useLiveSnapshot(id, () => api.console(id));
  const [pending, setPending] = useState<Pending | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [proxyRole, setProxyRole] = useState<Role>('FACTORY');
  const [proxyQuantity, setProxyQuantity] = useState('');
  const [reissueTarget, setReissueTarget] = useState('');
  const [newCode, setNewCode] = useState<string | null>(null);
  const [participants, setParticipants] = useState<
    { id: string; displayName: string }[]
  >([]);

  // 再発行の対象の一覧（参加者の表示名）。読めなくても、進行役自身は選べる
  useEffect(() => {
    api
      .lobby(id)
      .then((l) => setParticipants(l.participants))
      .catch(() => setParticipants([]));
  }, [api, id]);

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
  const paused = view.status === 'PAUSED';
  const allIn = ROLE_ORDER.every((r) => view.submitted[r]);

  async function run(work: () => Promise<unknown>) {
    setActionError(null);
    try {
      await work();
    } catch (e) {
      setActionError(e);
    } finally {
      setPending(null);
      await reload();
    }
  }

  function perform(p: Pending) {
    switch (p.kind) {
      case 'commit':
        return run(() =>
          api.commit(id, view!.week, view!.sessionVersion, newKey()),
        );
      case 'pause':
        return run(() => api.pause(id));
      case 'resume':
        return run(() => api.resume(id));
      case 'proxy':
        return run(async () => {
          await api.proxyDecision(
            id,
            p.role,
            p.quantity,
            view!.versions[p.role],
          );
          setProxyQuantity('');
        });
      case 'reissue':
        return run(async () => {
          setNewCode((await api.reissue(id, p.target)).recoveryCode);
        });
    }
  }

  function confirmProxy(e: FormEvent) {
    e.preventDefault();
    setActionError(null);
    if (!/^\d+$/.test(proxyQuantity.trim())) {
      setActionError(new Error('数量は 0 以上の整数を入力してください'));
      return;
    }
    setPending({
      kind: 'proxy',
      role: proxyRole,
      quantity: Number(proxyQuantity),
    });
  }

  function confirmReissue(e: FormEvent) {
    e.preventDefault();
    setNewCode(null);
    const target: CredentialTarget =
      reissueTarget === 'FACILITATOR'
        ? { kind: 'FACILITATOR' }
        : { kind: 'PARTICIPANT', participantId: reissueTarget };
    const name =
      target.kind === 'FACILITATOR'
        ? '進行役（あなた）'
        : (participants.find((p) => p.id === reissueTarget)?.displayName ?? '');
    setPending({ kind: 'reissue', target, name });
  }

  return (
    <Page title="進行役コンソール">
      {ended ? (
        <p>
          ゲームは終了しました。
          <Link to={`/games/${id}/review`}>振り返りを見る</Link>
        </p>
      ) : (
        <p>
          {view.week} 週目の入力状況
          {paused && '（停止中。参加者は入力できません）'}
        </p>
      )}
      <SettingsSummary settings={view.settings} />
      <p>
        確定方式:{' '}
        {view.commitMode === 'AUTO'
          ? '自動（4 役割の入力がそろうと確定します）'
          : '進行役が確定'}
        {!ended && (
          <button
            type="button"
            onClick={() =>
              void run(() =>
                api.changeCommitMode(
                  id,
                  view.commitMode === 'AUTO' ? 'MANUAL' : 'AUTO',
                ),
              )
            }
          >
            {view.commitMode === 'AUTO'
              ? '自動確定を無効にする'
              : '自動確定を有効にする'}
          </button>
        )}
      </p>
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
        disabled={ended || paused || !allIn}
        onClick={() => setPending({ kind: 'commit' })}
      >
        週を確定する
      </button>
      {!ended &&
        (paused ? (
          <button type="button" onClick={() => setPending({ kind: 'resume' })}>
            再開する
          </button>
        ) : (
          <button type="button" onClick={() => setPending({ kind: 'pause' })}>
            停止する
          </button>
        ))}

      {pending?.kind === 'commit' && (
        <ConfirmDialog
          label="週の確定の確認"
          confirm="確定する"
          onConfirm={() => void perform(pending)}
          onCancel={() => setPending(null)}
        >
          <p>{view.week} 週目を確定します。確定後は、入力を変更できません。</p>
        </ConfirmDialog>
      )}
      {pending?.kind === 'pause' && (
        <ConfirmDialog
          label="停止の確認"
          confirm="停止する"
          onConfirm={() => void perform(pending)}
          onCancel={() => setPending(null)}
        >
          <p>
            セッションを停止します。停止中は、参加者は入力できず、週も確定できません。保存済みの入力は残ります。
          </p>
        </ConfirmDialog>
      )}
      {pending?.kind === 'resume' && (
        <ConfirmDialog
          label="再開の確認"
          confirm="再開する"
          onConfirm={() => void perform(pending)}
          onCancel={() => setPending(null)}
        >
          <p>
            セッションを再開します。参加者は {view.week}{' '}
            週目の入力を続けられます。
          </p>
        </ConfirmDialog>
      )}
      {pending?.kind === 'proxy' && (
        <ConfirmDialog
          label="代理入力の確認"
          confirm="代理入力する"
          onConfirm={() => void perform(pending)}
          onCancel={() => setPending(null)}
        >
          <p>
            {ROLE_LABEL[pending.role]}の {view.week} 週目の入力を{' '}
            {pending.quantity}{' '}
            にします。進行役による代理入力として、値と時刻を記録します。
          </p>
        </ConfirmDialog>
      )}
      {pending?.kind === 'reissue' && (
        <ConfirmDialog
          label="再発行の確認"
          confirm="失効して再発行"
          onConfirm={() => void perform(pending)}
          onCancel={() => setPending(null)}
        >
          <p>
            {pending.name}
            の資格（ブラウザのログイン状態と復帰コード）をすべて失効させ、新しい復帰コードを発行します。
            古い資格では、もう操作できません。
          </p>
        </ConfirmDialog>
      )}
      <ErrorMessage error={actionError} />

      {!ended && (
        <form aria-label="代理入力" onSubmit={confirmProxy}>
          <h2>代理入力</h2>
          <p>不在の参加者に代わって入力します。停止中でも入力できます。</p>
          <label>
            役割
            <select
              value={proxyRole}
              onChange={(e) => setProxyRole(e.target.value as Role)}
            >
              {ROLE_ORDER.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
          <label>
            数量
            <input
              type="text"
              inputMode="numeric"
              value={proxyQuantity}
              onChange={(e) => setProxyQuantity(e.target.value)}
            />
          </label>
          <button type="submit">代理入力を確認</button>
        </form>
      )}

      <form aria-label="資格の再発行" onSubmit={confirmReissue}>
        <h2>資格の再発行</h2>
        <p>
          資格（復帰コードなど）が漏れたときに、失効させて新しい復帰コードを発行します。
        </p>
        <label>
          対象
          <select
            value={reissueTarget}
            required
            onChange={(e) => setReissueTarget(e.target.value)}
          >
            <option value="" disabled>
              選んでください
            </option>
            <option value="FACILITATOR">進行役（あなた）</option>
            {participants.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={reissueTarget === ''}>
          失効して再発行
        </button>
      </form>
      {newCode && <RecoveryCodeNote label="新しい復帰コード" code={newCode} />}

      <p>
        <Link to={`/games/${id}/play`}>参加者として遊ぶ</Link>
        （この画面の進行役が、役割も担当しているとき）
      </p>
    </Page>
  );
}
