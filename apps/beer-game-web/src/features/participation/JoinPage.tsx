import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import { ApiError } from '../../api/errors';
import type { FieldError, GameState, RecoverResponse } from '../../api/types';
import { ErrorNotice } from '../../components/ErrorNotice';
import { PageHeading } from '../../components/PageHeading';
import { ValidationSummary, fieldProps } from '../../components/ValidationSummary';

/**
 * 復帰の行き先（ui-design S03 → S04 / S05 / S06）。進行役は、準備中ならロビー、開始後ならコンソール。
 * 参加者は、プレイの画面（準備中は、プレイの画面が開始を待つ旨を示す。API が参加者にロビーを返さないため）。
 */
export function recoveryDestination(recovered: RecoverResponse, game: GameState): string {
    const base = `/games/${recovered.gameId}`;
    if (recovered.kind === 'PARTICIPANT') return `${base}/play`;
    return game.status === 'PREPARING' ? `${base}/lobby` : `${base}/console`;
}

/** 入力の誤り（422）は項目の近くに示す。それ以外は、握りつぶさず、失敗の通知にする。 */
function splitFailure(error: unknown): { errors: FieldError[]; failure: unknown } {
    if (error instanceof ApiError && error.status === 422 && error.errors.length > 0) {
        return { errors: error.errors, failure: null };
    }
    return { errors: [], failure: error };
}

/**
 * S03 参加・復帰。参加は、参加コードと表示名で参加し、応答のゲームの ID で、プレイの画面へ進む。
 * 復帰は、ゲーム ID と復帰コードで復帰する（復帰コードを省くと、Cookie の復帰資格で復帰する）。
 * 失敗の文言は、送った資格の種類（参加コード、復帰用の資格）から選ぶ。
 */
export function JoinPage() {
    const api = useApi();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();

    const [joinCode, setJoinCode] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [joinBusy, setJoinBusy] = useState(false);
    const [joinErrors, setJoinErrors] = useState<FieldError[]>([]);
    const [joinFailure, setJoinFailure] = useState<unknown>(null);

    const [gameId, setGameId] = useState(searchParams.get('gameId') ?? '');
    const [recoveryCode, setRecoveryCode] = useState('');
    const [recoverBusy, setRecoverBusy] = useState(false);
    const [recoverErrors, setRecoverErrors] = useState<FieldError[]>([]);
    const [recoverFailure, setRecoverFailure] = useState<unknown>(null);

    async function join(event: FormEvent) {
        event.preventDefault();
        setJoinBusy(true);
        setJoinErrors([]);
        setJoinFailure(null);
        setRecoverErrors([]);
        setRecoverFailure(null);
        try {
            const joined = await api.joinGame({
                joinCode: joinCode.trim(),
                displayName: displayName.trim(),
            });
            void navigate(`/games/${joined.gameId}/play`);
        } catch (error) {
            const split = splitFailure(error);
            setJoinErrors(split.errors);
            setJoinFailure(split.failure);
            setJoinBusy(false);
        }
    }

    async function recover(event: FormEvent) {
        event.preventDefault();
        setRecoverBusy(true);
        setRecoverErrors([]);
        setRecoverFailure(null);
        setJoinErrors([]);
        setJoinFailure(null);
        try {
            const code = recoveryCode.trim();
            const recovered = await api.recoverParticipation(
                code === ''
                    ? { gameId: gameId.trim() }
                    : { gameId: gameId.trim(), recoveryCode: code },
            );
            // 復帰の応答で、新しいブラウザセッションが発行された。状態を取って、復帰先の画面を決める
            const game = await api.getGameState(recovered.gameId);
            void navigate(recoveryDestination(recovered, game));
        } catch (error) {
            const split = splitFailure(error);
            setRecoverErrors(split.errors);
            setRecoverFailure(split.failure);
            setRecoverBusy(false);
        }
    }

    return (
        <>
            <PageHeading title="参加・復帰" />
            <section aria-labelledby="join-heading">
                <h2 id="join-heading">参加する</h2>
                <ValidationSummary errors={joinErrors} />
                {joinFailure ? (
                    <ErrorNotice error={joinFailure} context={{ credential: 'joinCode' }} />
                ) : null}
                <form onSubmit={join} noValidate>
                    <div className="field">
                        <label htmlFor="joinCode">参加コード</label>
                        <input
                            id="joinCode"
                            autoComplete="off"
                            value={joinCode}
                            onChange={(event) => setJoinCode(event.target.value)}
                            {...fieldProps(joinErrors, 'joinCode')}
                        />
                    </div>
                    <div className="field">
                        <label htmlFor="displayName">表示名</label>
                        <input
                            id="displayName"
                            autoComplete="off"
                            value={displayName}
                            onChange={(event) => setDisplayName(event.target.value)}
                            {...fieldProps(joinErrors, 'displayName')}
                        />
                    </div>
                    <button type="submit" disabled={joinBusy}>
                        参加する
                    </button>
                </form>
            </section>

            <section aria-labelledby="recover-heading">
                <h2 id="recover-heading">復帰する</h2>
                <p>
                    切断やブラウザの再起動のあとに、元の役割（進行役は進行役のコンソール）へ戻ります。
                    このブラウザに復帰用の資格が残っていれば、復帰コードは要りません。
                </p>
                <ValidationSummary errors={recoverErrors} />
                {recoverFailure ? (
                    <ErrorNotice
                        error={recoverFailure}
                        context={{ credential: 'returnCredential' }}
                    />
                ) : null}
                <form onSubmit={recover} noValidate>
                    <div className="field">
                        <label htmlFor="recoverGameId">ゲーム ID</label>
                        <input
                            id="recoverGameId"
                            autoComplete="off"
                            value={gameId}
                            onChange={(event) => setGameId(event.target.value)}
                            {...fieldProps(recoverErrors, 'gameId')}
                        />
                    </div>
                    <div className="field">
                        <label htmlFor="recoveryCode">復帰コード</label>
                        <input
                            id="recoveryCode"
                            autoComplete="off"
                            value={recoveryCode}
                            onChange={(event) => setRecoveryCode(event.target.value)}
                            {...fieldProps(recoverErrors, 'recoveryCode', 'recoveryCode-hint')}
                        />
                        <span id="recoveryCode-hint" className="muted">
                            任意。端末を替えたときなどに入力します。
                        </span>
                    </div>
                    <button type="submit" disabled={recoverBusy}>
                        復帰する
                    </button>
                </form>
                <p className="muted">
                    復帰コードが分からない場合は、進行役に、復帰コードの再発行を依頼してください。
                </p>
            </section>
        </>
    );
}
