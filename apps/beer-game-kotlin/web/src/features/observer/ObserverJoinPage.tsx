import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { ApiError } from '../../api/errors';
import type { FieldError } from '../../api/types';
import { ErrorNotice } from '../../components/ErrorNotice';
import { PageHeading } from '../../components/PageHeading';
import { ValidationSummary, fieldProps } from '../../components/ValidationSummary';

/** 表示名を省いたときの名前（API は 1 文字以上を要求する）。 */
export const DEFAULT_OBSERVER_NAME = '観察者';

/**
 * S10 観察者の参加。観察用の招待コードと表示名で、観察者として参加し、観察の画面へ進む。
 * 観察者は読み取り専用で、役割別の非公開の情報は見られない。失敗の文言は、送った資格の種類（観察用の招待）から選ぶ。
 */
export function ObserverJoinPage() {
    const api = useApi();
    const navigate = useNavigate();
    const [invitationCode, setInvitationCode] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [busy, setBusy] = useState(false);
    const [errors, setErrors] = useState<FieldError[]>([]);
    const [failure, setFailure] = useState<unknown>(null);

    async function join(event: FormEvent) {
        event.preventDefault();
        setBusy(true);
        setErrors([]);
        setFailure(null);
        try {
            const name = displayName.trim();
            const joined = await api.joinAsObserver({
                invitationCode: invitationCode.trim(),
                displayName: name === '' ? DEFAULT_OBSERVER_NAME : name,
            });
            void navigate(`/games/${joined.gameId}/observation`);
        } catch (error) {
            if (error instanceof ApiError && error.status === 422 && error.errors.length > 0) {
                setErrors(error.errors);
            } else {
                setFailure(error);
            }
            setBusy(false);
        }
    }

    return (
        <>
            <PageHeading title="観察者として参加" />
            <ValidationSummary errors={errors} />
            {failure ? (
                <ErrorNotice error={failure} context={{ credential: 'observerInvitation' }} />
            ) : null}
            <form onSubmit={join} noValidate>
                <div className="field">
                    <label htmlFor="invitationCode">観察用の招待コード</label>
                    <input
                        id="invitationCode"
                        autoComplete="off"
                        value={invitationCode}
                        onChange={(event) => setInvitationCode(event.target.value)}
                        {...fieldProps(errors, 'invitationCode')}
                    />
                </div>
                <div className="field">
                    <label htmlFor="observerName">表示名（任意）</label>
                    <input
                        id="observerName"
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
            <p className="muted">
                観察者は、読み取り専用です。役割別の非公開の情報は見られません。
            </p>
        </>
    );
}
