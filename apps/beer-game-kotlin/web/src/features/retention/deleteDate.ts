import type { Retention } from '../../api/types';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 削除予定日の表示。日付は UTC の暦日（サーバーの時刻は UTC）。残りの日数は、切り上げて数える
 * （期限まで 2 日と 1 時間なら「あと 3 日」。期限に達していれば「期限に達しています」）。
 */
export function deleteDateText(retention: Pick<Retention, 'deleteAfter'>, now: Date): string {
    const deleteAfter = new Date(retention.deleteAfter);
    const date = deleteAfter.toISOString().slice(0, 10);
    const remaining = deleteAfter.getTime() - now.getTime();
    const note = remaining <= 0 ? '期限に達しています' : `あと ${Math.ceil(remaining / DAY_MS)} 日`;
    return `削除予定日: ${date}（${note}）`;
}
