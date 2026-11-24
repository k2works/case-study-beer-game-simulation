import { Link, useParams } from 'react-router';
import { describeProblem, type ProblemContext } from '../api/problems';

/**
 * 失敗の通知。フォーカスを移さない通知なので role="alert"。原因の区分の文言と、相関 ID（問い合わせ用）を示す。
 * 権限が無いときは、参加・復帰の画面への導線を出す。いまの画面がゲームの URL なら、ゲームの ID を導線に持たせ、
 * 復帰の画面が、ゲーム ID を入れ直させずに済むようにする。
 * 資格を送った操作（参加・復帰。context.credential がある）は、すでに参加・復帰の画面にいるので、導線を出さない。
 */
export function ErrorNotice({
    error,
    context,
    extra,
}: {
    error: unknown;
    context?: ProblemContext;
    /** 文言の後ろに足す案内（例: 再操作の案内）。 */
    extra?: string;
}) {
    const { gameId } = useParams();
    const shown = describeProblem(error, context);
    const showLink = shown.unauthorized && context?.credential === undefined;
    return (
        <div role="alert" className="notice notice-error">
            <p>
                {shown.text}
                {extra ? ` ${extra}` : ''}
            </p>
            {shown.correlationId ? <p className="muted">相関 ID: {shown.correlationId}</p> : null}
            {showLink ? (
                <Link to={gameId ? `/join?gameId=${encodeURIComponent(gameId)}` : '/join'}>
                    参加・復帰の画面へ
                </Link>
            ) : null}
        </div>
    );
}
