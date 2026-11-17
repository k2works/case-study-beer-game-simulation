import { Link, useParams } from 'react-router';
import { useApi } from '../../api/ApiContext';
import type { Retention } from '../../api/types';
import { ErrorNotice } from '../../components/ErrorNotice';
import { PageHeading } from '../../components/PageHeading';
import { useLoad } from '../../components/useLoad';
import { deleteDateText } from './deleteDate';

/** 削除の進行の文言。再試行は自動（手動の再試行は無い）。 */
function progressText(retention: Retention): string {
    switch (retention.status) {
        case 'SCHEDULED':
            return '削除の予定です。';
        case 'IN_PROGRESS':
            return '削除しています。';
        case 'RETRY_PENDING':
            return `削除に失敗しました（${retention.attempt} 回目）。自動で再試行します。次の試行: ${retention.nextAttemptAt ?? '未定'}`;
        case 'ABANDONED':
            return '再試行の上限に達したため、自動の削除をやめました。運営者へ連絡してください。';
    }
}

/**
 * S09 保持状態。進行役だけ。削除予定日・保持期間・削除の進行と、データベースのバックアップに削除後も残る期間を示す
 * （AC5.1.1・5.1.5）。保持の起点は暫定で作成時（設計の未決。人の確認が要る）。事前に作成した研修では、終了から削除までの猶予が
 * 短くなりうるので、振り返りと結果の出力を、削除予定日までに済ませるよう案内する。
 */
export function RetentionPage() {
    const { gameId = '' } = useParams();
    const api = useApi();
    const { state } = useLoad(() => api.getRetention(gameId));

    if (state.status === 'loading') return <p role="status">保持状態を読み込み中…</p>;
    if (state.status === 'error') {
        return (
            <>
                <PageHeading title="保持状態" />
                <ErrorNotice error={state.error} />
            </>
        );
    }
    const retention = state.data;
    return (
        <>
            <PageHeading title="保持状態" />
            <p>{deleteDateText(retention, new Date())}</p>
            <p>{`保持期間: ${retention.retentionDays} 日`}</p>
            <p className="muted">
                保持の起点は、ゲームの作成時です。終了後の振り返りと結果の出力は、削除予定日までに済ませてください。
            </p>
            <p role="status">{progressText(retention)}</p>
            <p>{`データベースのバックアップには、削除後も最大 ${retention.backupRetentionDays} 日残ります。`}</p>
            <p>
                <Link to={`/games/${gameId}/console`}>コンソールへ戻る</Link>
            </p>
        </>
    );
}
