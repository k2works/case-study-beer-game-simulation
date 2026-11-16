import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useApi, useCatchUp } from '../../api/ApiContext';
import { fetchCaughtUp } from '../../api/catchUp';
import { ApiError } from '../../api/errors';
import type { FieldError, GameState } from '../../api/types';
import { ErrorNotice } from '../../components/ErrorNotice';
import { PageHeading } from '../../components/PageHeading';
import { ValidationSummary, fieldProps } from '../../components/ValidationSummary';
import { CustomConditionsFields, EMPTY_DRAFT, toConditions } from './CustomConditionsFields';

/** 画面イメージ（S02）の初期値。キットの既定の需要系列は未確定（ASM-01）なので、これは例として置く値。 */
const DEFAULT_FINAL_WEEK = '12';
const DEFAULT_DEMAND = Array.from({ length: 12 }, () => '4').join(', ');
const DEFAULT_RETENTION_DAYS = '90';

/** 整数に読める入力は数にし、読めない入力は文字列のまま送る（サーバーの検証が、誤りを集めて返す）。 */
const toNumberOrRaw = (text: string): number | string => {
    const trimmed = text.trim();
    return /^-?\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
};

/** S02 ゲーム作成 */
export function CreateGamePage() {
    const api = useApi();
    const catchUp = useCatchUp();
    const [finalWeek, setFinalWeek] = useState(DEFAULT_FINAL_WEEK);
    const [demand, setDemand] = useState(DEFAULT_DEMAND);
    const [retentionDays, setRetentionDays] = useState(DEFAULT_RETENTION_DAYS);
    const [custom, setCustom] = useState(false);
    const [draft, setDraft] = useState(EMPTY_DRAFT);
    const [busy, setBusy] = useState(false);
    const [errors, setErrors] = useState<FieldError[]>([]);
    const [failure, setFailure] = useState<unknown>(null);
    const [created, setCreated] = useState<GameState | null>(null);
    /** 作成の応答で、一度だけ示される復帰コード。この画面の状態にだけ持ち、保存しない（再表示しない）。 */
    const [recoveryCode, setRecoveryCode] = useState<string | null>(null);

    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setErrors([]);
        setFailure(null);
        try {
            const result = await api.createGame({
                kind: custom ? 'CUSTOM' : 'KIT',
                finalWeek: toNumberOrRaw(finalWeek),
                demand: demand.split(',').map(toNumberOrRaw),
                retentionDays: toNumberOrRaw(retentionDays),
                ...(custom ? { conditions: toConditions(draft) } : {}),
            });
            // 応答は versions だけ。参加コードは、追いついた取得の結果から表示する
            const { snapshot } = await fetchCaughtUp(
                () => api.getGameState(result.gameId),
                result.versions,
                catchUp,
            );
            setCreated(snapshot);
            setRecoveryCode(result.recoveryCode);
        } catch (error) {
            if (error instanceof ApiError && error.status === 422 && error.errors.length > 0) {
                setErrors(error.errors);
            } else {
                setFailure(error);
            }
        } finally {
            setBusy(false);
        }
    }

    if (created) {
        return (
            <>
                <PageHeading title="ゲームを作成しました" />
                <p>参加コードを、参加者に伝えてください。</p>
                <p className="join-code">
                    参加コード: <strong>{created.joinCode}</strong>
                </p>
                {recoveryCode ? (
                    <section aria-labelledby="recovery-code-heading">
                        <h2 id="recovery-code-heading">復帰コード</h2>
                        <p>
                            復帰コード: <strong>{recoveryCode}</strong>
                        </p>
                        <p>ゲーム ID: {created.gameId}</p>
                        <p>この画面でだけ表示します。控えてください。</p>
                        <p>
                            端末を替えたときなどに、ゲーム ID
                            と復帰コードで、進行役のコンソールへ戻れます。
                        </p>
                    </section>
                ) : null}
                <Link to={`/games/${created.gameId}/lobby`} className="button">
                    ロビーへ
                </Link>
            </>
        );
    }

    return (
        <>
            <PageHeading title="ゲームを作成" />
            <ValidationSummary errors={errors} />
            {failure ? <ErrorNotice error={failure} /> : null}
            <form onSubmit={submit} noValidate>
                <div className="field">
                    <label htmlFor="kind">条件</label>
                    <select
                        id="kind"
                        value={custom ? 'CUSTOM' : 'KIT'}
                        onChange={(event) => setCustom(event.target.value === 'CUSTOM')}
                    >
                        <option value="KIT">キット準拠</option>
                        <option value="CUSTOM">カスタム</option>
                    </select>
                </div>
                {custom ? (
                    <CustomConditionsFields draft={draft} onChange={setDraft} errors={errors} />
                ) : null}
                <div className="field">
                    <label htmlFor="finalWeek">最終週</label>
                    <input
                        id="finalWeek"
                        inputMode="numeric"
                        value={finalWeek}
                        onChange={(event) => setFinalWeek(event.target.value)}
                        {...fieldProps(errors, 'finalWeek', 'finalWeek-hint')}
                    />
                    <span id="finalWeek-hint" className="muted">
                        1〜50
                    </span>
                </div>
                <div className="field">
                    <label htmlFor="demand">需要系列</label>
                    <input
                        id="demand"
                        value={demand}
                        onChange={(event) => setDemand(event.target.value)}
                        {...fieldProps(errors, 'demand', 'demand-hint')}
                    />
                    <span id="demand-hint" className="muted">
                        最終週まで、0〜1000（コンマ区切り）
                    </span>
                </div>
                <div className="field">
                    <label htmlFor="retentionDays">保持期間（日）</label>
                    <input
                        id="retentionDays"
                        inputMode="numeric"
                        value={retentionDays}
                        onChange={(event) => setRetentionDays(event.target.value)}
                        {...fieldProps(errors, 'retentionDays', 'retentionDays-hint')}
                    />
                    <span id="retentionDays-hint" className="muted">
                        1〜3650
                    </span>
                </div>
                <button type="submit" disabled={busy}>
                    ゲームを作成
                </button>
            </form>
        </>
    );
}
