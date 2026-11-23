import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { DisclosurePolicy, Recovered } from '../api/types.js';
import { DISCLOSURE_LABEL } from '../labels.js';
import { useApi } from '../hooks.js';
import { ErrorMessage, Page } from '../components.js';

export function Home() {
  return (
    <Page title="ビールゲーム">
      <p>遅延と意思決定が、需要の変動を増幅する過程を体験するゲームです。</p>
      <nav>
        <Link to="/new">ゲームを作る</Link> / <Link to="/join">参加する</Link>
      </nav>
    </Page>
  );
}

export function NewGame() {
  const api = useApi();
  const navigate = useNavigate();
  const [weeks, setWeeks] = useState('20');
  // 自動確定の既定は無効（AC1.1.6）
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  // 条件（キット準拠の値で始める）。費用はドルで入力し、送るときに最小単位（セント）へ直す
  const [form, setForm] = useState({
    initialInventory: '12',
    orderDelayWeeks: '2',
    shipmentDelayWeeks: '2',
    productionDelayWeeks: '2',
    holdingCost: '0.50',
    backlogCost: '1.00',
  });
  const [disclosure, setDisclosure] = useState<DisclosurePolicy>('TEAM_TOTAL');
  const [retentionDays, setRetentionDays] = useState('90');
  const field = (name: keyof typeof form, label: string, step = '1') => (
    <label>
      {label}
      <input
        type="number"
        step={step}
        value={form[name]}
        onChange={(e) => setForm({ ...form, [name]: e.target.value })}
      />
    </label>
  );
  // 0.29 × 100 が 28.999… になる誤差を丸める（整数でない値は、そのまま送り、サーバーで拒否される）
  const toMinor = (dollars: string) =>
    Number((Number(dollars) * 100).toFixed(6));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.createGame({
        weeks: Number(weeks),
        commitMode: auto ? 'AUTO' : 'MANUAL',
        conditions: {
          initialInventory: Number(form.initialInventory),
          orderDelayWeeks: Number(form.orderDelayWeeks),
          shipmentDelayWeeks: Number(form.shipmentDelayWeeks),
          productionDelayWeeks: Number(form.productionDelayWeeks),
          holdingCostMinor: toMinor(form.holdingCost),
          backlogCostMinor: toMinor(form.backlogCost),
          disclosure,
        },
        retentionDays: Number(retentionDays),
      });
      // 復帰コードはロビーで一度だけ示す（履歴の state で渡し、表示後に消す）
      navigate(`/games/${created.gameId}/lobby`, {
        state: { recoveryCode: created.recoveryCode },
      });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="ゲームを作る">
      <form onSubmit={submit}>
        <label>
          週数
          <input
            type="number"
            value={weeks}
            min={1}
            max={50}
            onChange={(e) => setWeeks(e.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
          />
          全員が保存したら自動で次の週に進む
        </label>
        <p>外すと、進行役が「週を確定する」を押すまで進みません。</p>
        <label>
          保持期間（日）
          <input
            type="number"
            min={1}
            max={3650}
            value={retentionDays}
            onChange={(e) => setRetentionDays(e.target.value)}
          />
        </label>
        <p>期間が過ぎると、ゲームの記録を削除します（1〜3650 日）。</p>
        <fieldset>
          <legend>条件（キット準拠から変えられます）</legend>
          <p>
            既定は改訂版キットの標準です。変えると「カスタム」として記録し、ロビーに変更した項目を示します。
          </p>
          {field('initialInventory', '初期在庫')}
          {field('orderDelayWeeks', '注文の遅延（週）')}
          {field('shipmentDelayWeeks', '配送の遅延（週）')}
          {field('productionDelayWeeks', '生産の遅延（週）')}
          {field('holdingCost', '在庫の費用（1 個・1 週、ドル）', '0.01')}
          {field('backlogCost', '受注残の費用（1 個・1 週、ドル）', '0.01')}
          <label>
            公開範囲（観察者）
            <select
              value={disclosure}
              onChange={(e) =>
                setDisclosure(e.target.value as DisclosurePolicy)
              }
            >
              {(['TEAM_TOTAL', 'PROGRESS_ONLY'] as const).map((d) => (
                <option key={d} value={d}>
                  {DISCLOSURE_LABEL[d]}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        <button type="submit" disabled={busy}>
          作成する
        </button>
      </form>
      <ErrorMessage error={error} />
    </Page>
  );
}

export function Join() {
  const api = useApi();
  const navigate = useNavigate();
  const location = useLocation();
  const redirected = (location.state as { message?: string } | null)?.message;
  const [joinCode, setJoinCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<unknown>(
    redirected ? new Error(redirected) : null,
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const joined = await api.join({ joinCode, displayName });
      navigate(`/games/${joined.gameId}/lobby`, {
        state: { recoveryCode: joined.recoveryCode },
      });
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Page title="参加する">
      <form onSubmit={submit}>
        <label>
          参加コード
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value)}
          />
        </label>
        <label>
          表示名
          <input
            value={displayName}
            maxLength={20}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <button type="submit">参加する</button>
      </form>
      <ErrorMessage error={error} />
      <Recover />
    </Page>
  );
}

/** 復帰先: 準備中はロビー、開始後は進行役ならコンソール、参加者なら自分の画面 */
const destinationOf = (back: Recovered) =>
  back.gameStatus === 'PREPARING'
    ? `/games/${back.gameId}/lobby`
    : back.kind === 'FACILITATOR'
      ? `/games/${back.gameId}/console`
      : `/games/${back.gameId}/play`;

/** 復帰コードで戻る（Cookie を失ったとき） */
function Recover() {
  const api = useApi();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      navigate(destinationOf(await api.recover(code.trim())));
    } catch (err) {
      setError(err);
    }
  }

  return (
    <section aria-labelledby="recover-heading">
      <h2 id="recover-heading">復帰する</h2>
      <p>
        ブラウザを閉じた後などは、参加・作成のときに表示された復帰コードで、同じゲームの画面に戻れます。
      </p>
      <form onSubmit={submit}>
        <label>
          復帰コード
          <input
            value={code}
            autoComplete="off"
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <button type="submit">復帰する</button>
      </form>
      <ErrorMessage error={error} />
    </section>
  );
}
