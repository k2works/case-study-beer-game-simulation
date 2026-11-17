import { useApi } from '../../api/ApiContext';
import { useLoad } from '../../components/useLoad';
import { deleteDateText } from './deleteDate';

/**
 * 削除予定日の注記（進行役にだけ示す。振り返りの見出しの近く）。事前に作成した研修では、終了から削除までの猶予が短くなりうるため。
 * 補助の情報なので、取得に失敗したら何も示さない（振り返りそのものの表示を妨げない。失敗の原因は S09 で示す）。
 */
export function RetentionNotice({ gameId }: { gameId: string }) {
    const api = useApi();
    const { state } = useLoad(() => api.getRetention(gameId));
    if (state.status !== 'ready') return null;
    return <p className="muted">{deleteDateText(state.data, new Date())}</p>;
}
