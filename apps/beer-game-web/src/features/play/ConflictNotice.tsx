import { useId, type Ref } from 'react';
import { DECISION_CONFLICT_TEXT, PROXY_OVERWRITE_TEXT } from '../../api/problems';
import type { DecisionEntry } from '../../api/types';
import { editorName, formatClock } from '../../labels';

export interface Conflict {
    /** 競合で知った、最新の入力（数量・版・保存者・保存の時刻）。 */
    latest: DecisionEntry;
    /** 競合した人が入力した値。未保存のまま保持する（黙って失わない）。 */
    mine: number;
}

/**
 * S05 共同入力の競合（ui-design「S05 共同入力の競合」）。最新の値と最後の保存者を示し、入力した値は保持する。
 * 版は画面に出さない（競合の検出に使う内部の番号）。保存者が進行役の代理入力なら、見出しを変える。
 * 色だけに頼らず、見出し・文言で示す。見出しへフォーカスを移して、気づけるようにする。
 */
export function ConflictNotice({
    conflict,
    busy,
    headingRef,
    onUseLatest,
    onResave,
}: {
    conflict: Conflict;
    busy: boolean;
    headingRef: Ref<HTMLHeadingElement>;
    onUseLatest: () => void;
    onResave: () => void;
}) {
    const headingId = useId();
    const { latest, mine } = conflict;
    const clock = formatClock(latest.savedAt);
    const heading =
        latest.editor.kind === 'FACILITATOR_PROXY' ? PROXY_OVERWRITE_TEXT : DECISION_CONFLICT_TEXT;
    return (
        <section aria-labelledby={headingId} className="notice">
            <h2 id={headingId} ref={headingRef} tabIndex={-1}>
                {heading}
            </h2>
            <p>{`最新の入力: ${latest.quantity}`}</p>
            <p>
                {latest.editor.isSelf
                    ? `あなたが ${clock} に保存した値があります。`
                    : `保存者: ${editorName(latest.editor)}（${clock}）`}
            </p>
            <p>{`あなたの入力: ${mine}（未保存。保持しています）`}</p>
            <div className="actions">
                <button type="button" disabled={busy} onClick={onUseLatest}>
                    最新の値を使う
                </button>
                <button type="button" disabled={busy} onClick={onResave}>
                    この値で保存し直す
                </button>
            </div>
        </section>
    );
}
