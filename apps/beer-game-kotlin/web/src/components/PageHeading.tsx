import { useLayoutEffect, useRef } from 'react';

/**
 * 画面の見出し（H1）。画面の切り替えで、題名（document.title）を更新し、見出しへフォーカスを移す。
 * 見出しが DOM に現れた時点で題名も更新済みであるよう、描画の反映と同時に実行する（useLayoutEffect）。
 * useEffect だと、見出しを見つけた直後の検査が、題名の更新より先に走って、間欠的に失敗する。
 */
export function PageHeading({ title }: { title: string }) {
    const ref = useRef<HTMLHeadingElement>(null);
    useLayoutEffect(() => {
        document.title = `${title} - ビールゲーム`;
        ref.current?.focus();
    }, [title]);
    return (
        <h1 ref={ref} tabIndex={-1}>
            {title}
        </h1>
    );
}
