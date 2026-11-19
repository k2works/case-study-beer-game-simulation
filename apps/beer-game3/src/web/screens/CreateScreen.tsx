import { useState, type FormEvent } from 'react';
import { ApiError, type ApiClient, type CreatedGame, type Credential } from '../api.js';
import { CopyButton, FieldError } from '../components.js';
import { parseDollarsToCents, parseNonNegativeInt } from '../format.js';

interface Props {
  api: ApiClient;
  onEnterLobby: (credential: Credential) => void;
  onCancel: () => void;
}

interface Form {
  name: string;
  weekCount: string;
  demand: string;
  initialInventory: string;
  initialPipelineQuantity: string;
  inventoryUnitCost: string;
  backlogUnitCost: string;
}

const INITIAL: Form = {
  name: '',
  weekCount: '50',
  demand: '',
  initialInventory: '12',
  initialPipelineQuantity: '4',
  inventoryUnitCost: '0.50',
  backlogUnitCost: '1.00',
};

type Errors = Partial<Record<keyof Form | 'general', string>>;

const WEEK_MESSAGE = '週数は 1〜50 の整数で入力してください';

function fieldFromApi(path: string): keyof Form | null {
  const map: Record<string, keyof Form> = {
    name: 'name',
    weekCount: 'weekCount',
    demandSeries: 'demand',
    initialInventory: 'initialInventory',
    initialPipelineQuantity: 'initialPipelineQuantity',
    inventoryUnitCost: 'inventoryUnitCost',
    backlogUnitCost: 'backlogUnitCost',
  };
  return map[path] ?? null;
}

/** 画面で確かめられる誤りを先に示す（サーバーが最終の判定）。送る形に直して返す。 */
function validate(form: Form): { errors: Errors; body?: Record<string, unknown> } {
  const errors: Errors = {};
  if (form.name.trim() === '') {
    errors.name = 'ゲーム名を入力してください';
  }
  const weekCount = parseNonNegativeInt(form.weekCount);
  if (weekCount === null) {
    errors.weekCount = WEEK_MESSAGE;
  }
  const initialInventory = parseNonNegativeInt(form.initialInventory);
  if (initialInventory === null) {
    errors.initialInventory = '初期在庫は 0 以上の整数で入力してください';
  }
  const initialPipelineQuantity = parseNonNegativeInt(form.initialPipelineQuantity);
  if (initialPipelineQuantity === null) {
    errors.initialPipelineQuantity = '初期パイプライン数量は 0 以上の整数で入力してください';
  }
  const inventoryUnitCost = parseDollarsToCents(form.inventoryUnitCost);
  if (inventoryUnitCost === null) {
    errors.inventoryUnitCost = '在庫単価は 0.50 のように、小数 2 桁までのドルで入力してください';
  }
  const backlogUnitCost = parseDollarsToCents(form.backlogUnitCost);
  if (backlogUnitCost === null) {
    errors.backlogUnitCost = '受注残単価は 1.00 のように、小数 2 桁までのドルで入力してください';
  }
  let demandSeries: number[] | undefined;
  if (form.demand.trim() !== '') {
    const parts = form.demand.trim().split(/[\s,、]+/);
    const values = parts.map(parseNonNegativeInt);
    if (values.some((v) => v === null)) {
      errors.demand = '需要系列は 0 以上の整数を、カンマ区切りで入力してください';
    } else {
      demandSeries = values as number[];
    }
  }
  if (Object.keys(errors).length > 0) {
    return { errors };
  }
  return {
    errors,
    body: {
      name: form.name.trim(),
      weekCount,
      initialInventory,
      initialPipelineQuantity,
      inventoryUnitCost,
      backlogUnitCost,
      ...(demandSeries ? { demandSeries } : {}),
    },
  };
}

/** S1 ゲーム作成: 設定を入れて作成し、コードを 1 度だけ示す。 */
export function CreateScreen({ api, onEnterLobby, onCancel }: Props) {
  const [form, setForm] = useState<Form>(INITIAL);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedGame | null>(null);

  const set = (key: keyof Form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) {
      return;
    }
    const checked = validate(form);
    setErrors(checked.errors);
    if (!checked.body) {
      return;
    }
    setBusy(true);
    try {
      setCreated(await api.createGame(checked.body));
    } catch (e) {
      const next: Errors = {};
      if (e instanceof ApiError && e.problem?.fields?.length) {
        for (const field of e.problem.fields) {
          const key = fieldFromApi(field.path);
          if (key) {
            next[key] = field.message;
          } else {
            next.general = field.message;
          }
        }
      } else if (e instanceof ApiError && e.kind === 'network') {
        next.general = '通信できませんでした。接続を確かめて、もう一度操作してください';
      } else if (e instanceof ApiError && e.problem) {
        next.general = `${e.problem.reason}。${e.problem.hint}`;
      } else {
        next.general = '想定外の問題が起きました。もう一度操作してください';
      }
      setErrors(next);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    const { codes } = created;
    return (
      <main>
        <h1>ゲームを作成しました</h1>
        <p>コードは、この画面でだけ表示します。参加者には参加コードだけを伝えてください。</p>
        <dl className="codes">
          <dt>参加コード</dt>
          <dd>
            <code>{codes.joinCode}</code> <CopyButton label="参加コード" value={codes.joinCode} />
          </dd>
          <dt>進行役用コード</dt>
          <dd>
            <code>{codes.facilitatorCode}</code>{' '}
            <CopyButton label="進行役用コード" value={codes.facilitatorCode} />
          </dd>
          <dt>観察者用コード</dt>
          <dd>
            <code>{codes.observerCode}</code>{' '}
            <CopyButton label="観察者用コード" value={codes.observerCode} />
          </dd>
        </dl>
        <p>
          進行役用コードは再発行できません。失くすと進行役の操作ができなくなるため、控えを保管してください。進行役用コードを持つ人だけが、ゲームの開始・役割の割当て・週の確定ができます。
        </p>
        <button
          type="button"
          data-testid="enter-lobby"
          onClick={() =>
            onEnterLobby({
              kind: 'facilitator',
              secret: codes.facilitatorCode,
              gameId: created.gameId,
            })
          }
        >
          ロビーへ
        </button>
      </main>
    );
  }

  const text = (key: keyof Form, label: string, hint?: string) => (
    <div className="field" key={key}>
      <label htmlFor={`create-${key}`}>{label}</label>
      <input
        id={`create-${key}`}
        data-testid={`create-${key}`}
        value={form[key]}
        onChange={(e) => set(key)(e.target.value)}
        autoComplete="off"
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={`create-${key}-error`}
      />
      {hint ? <span className="hint">{hint}</span> : null}
      <FieldError id={`create-${key}-error`} message={errors[key]} />
    </div>
  );

  return (
    <main>
      <h1>ゲームを作成する</h1>
      <p>設定の種類: カスタム（需要系列が未確定の間は「カスタム」になります）</p>
      <form onSubmit={(e) => void submit(e)} noValidate>
        {text('name', 'ゲーム名')}
        {text('weekCount', '週数', '1〜50')}
        <div className="field">
          <label htmlFor="create-demand">需要系列（省略すると仮の既定になります）</label>
          <textarea
            id="create-demand"
            data-testid="create-demand"
            value={form.demand}
            onChange={(e) => set('demand')(e.target.value)}
            rows={2}
            aria-invalid={errors.demand ? true : undefined}
            aria-describedby="create-demand-error"
          />
          <span className="hint">週数と同じ長さの、0 以上の整数をカンマ区切りで</span>
          <FieldError id="create-demand-error" message={errors.demand} />
        </div>
        {text('initialInventory', '初期在庫')}
        {text('initialPipelineQuantity', '初期パイプライン数量')}
        {text('inventoryUnitCost', '在庫単価（ドル）')}
        {text('backlogUnitCost', '受注残単価（ドル）')}
        <p>遅延の週数は固定です（配送 2 週、注文 2 週、生産 2 段階）</p>
        {errors.general ? (
          <p role="alert" className="field-error">
            {errors.general}
          </p>
        ) : null}
        <button type="submit" data-testid="create-submit" disabled={busy}>
          {busy ? '作成しています' : '作成する'}
        </button>{' '}
        <button type="button" data-testid="create-cancel" onClick={onCancel}>
          戻る
        </button>
      </form>
    </main>
  );
}
