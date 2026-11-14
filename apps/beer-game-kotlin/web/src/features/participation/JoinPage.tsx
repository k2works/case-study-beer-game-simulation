import { useState, type FormEvent } from 'react';
import { useApi } from '../../api/ApiContext';
import { ApiError } from '../../api/errors';
import type { FieldError } from '../../api/types';
import { ErrorNotice } from '../../components/ErrorNotice';
import { PageHeading } from '../../components/PageHeading';
import { ValidationSummary, fieldProps } from '../../components/ValidationSummary';

/**
 * S03 参加（B1 の範囲: 参加コードと表示名での参加。復帰は B5）。
 * 参加の応答は versions だけで、ゲームの ID を含まない（API の仕様）。そのため、参加後に、ロビーやプレイの画面の
 * URL（/games/:id/...）へ自動では進めない。ゲームの ID を参加者へ返す手段は未決（bolt_1_plan Step 10 の結果を参照）。
 */
export function JoinPage() {
    const api = useApi();
    const [joinCode, setJoinCode] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [busy, setBusy] = useState(false);
    const [errors, setErrors] = useState<FieldError[]>([]);
    const [failure, setFailure] = useState<unknown>(null);
    const [joined, setJoined] = useState(false);

    async function submit(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setErrors([]);
        setFailure(null);
        try {
            await api.joinGame({ joinCode: joinCode.trim(), displayName: displayName.trim() });
            setJoined(true);
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

    if (joined) {
        return (
            <>
                <PageHeading title="参加" />
                <p role="status">参加しました。進行役が開始するまでお待ちください。</p>
            </>
        );
    }

    return (
        <>
            <PageHeading title="参加" />
            <ValidationSummary errors={errors} />
            {failure ? <ErrorNotice error={failure} context={{ credential: 'joinCode' }} /> : null}
            <form onSubmit={submit} noValidate>
                <div className="field">
                    <label htmlFor="joinCode">参加コード</label>
                    <input
                        id="joinCode"
                        autoComplete="off"
                        value={joinCode}
                        onChange={(event) => setJoinCode(event.target.value)}
                        {...fieldProps(errors, 'joinCode')}
                    />
                </div>
                <div className="field">
                    <label htmlFor="displayName">表示名</label>
                    <input
                        id="displayName"
                        autoComplete="off"
                        value={displayName}
                        onChange={(event) => setDisplayName(event.target.value)}
                        {...fieldProps(errors, 'displayName')}
                    />
                </div>
                <button type="submit" disabled={busy}>
                    参加する
                </button>
            </form>
        </>
    );
}
