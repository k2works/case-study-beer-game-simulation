import { Link } from 'react-router';
import { describeProblem, type ProblemContext } from '../api/problems';

/**
 * 失敗の通知。フォーカスを移さない通知なので role="alert"。原因の区分の文言と、相関 ID（問い合わせ用）を示す。
 * 権限が無いときは、参加の画面への導線を出す。
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
    const shown = describeProblem(error, context);
    return (
        <div role="alert" className="notice notice-error">
            <p>
                {shown.text}
                {extra ? ` ${extra}` : ''}
            </p>
            {shown.correlationId ? <p className="muted">相関 ID: {shown.correlationId}</p> : null}
            {shown.unauthorized ? <Link to="/join">参加の画面へ</Link> : null}
        </div>
    );
}
