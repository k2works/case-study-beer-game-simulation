import { useEffect, useState } from 'react';

/** 操作を想定する最小の幅（CSS px）。beer-game2 の UI 設計の差分 13: 操作は 1024px 以上。 */
const MIN_WIDTH_PX = 1024;
const NARROW_QUERY = `(max-width: ${MIN_WIDTH_PX - 1}px)`;

function isNarrow(): boolean {
    return typeof window.matchMedia === 'function' && window.matchMedia(NARROW_QUERY).matches;
}

/**
 * 狭い画面（1024px 未満）の案内。パソコンでの利用を想定していることを伝える。操作は止めない。閉じられる。
 * 幅を調べられない環境では出さない。
 */
export function NarrowScreenNotice() {
    const [narrow, setNarrow] = useState(isNarrow);
    const [dismissed, setDismissed] = useState(false);

    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return undefined;
        const query = window.matchMedia(NARROW_QUERY);
        const update = () => setNarrow(query.matches);
        query.addEventListener('change', update);
        return () => query.removeEventListener('change', update);
    }, []);

    if (!narrow || dismissed) return null;
    return (
        <aside role="note" aria-label="画面の大きさについて" className="notice">
            <p>
                この画面は {MIN_WIDTH_PX}px
                以上の幅（パソコン）での利用を想定しています。幅が狭いと、一部の表示が崩れることがあります。
            </p>
            <button type="button" onClick={() => setDismissed(true)}>
                案内を閉じる
            </button>
        </aside>
    );
}
