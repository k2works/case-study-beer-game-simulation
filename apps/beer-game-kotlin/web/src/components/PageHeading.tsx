import { useEffect, useRef } from 'react';

/** 画面の見出し（H1）。画面の切り替えで、題名（document.title）を更新し、見出しへフォーカスを移す。 */
export function PageHeading({ title }: { title: string }) {
    const ref = useRef<HTMLHeadingElement>(null);
    useEffect(() => {
        document.title = `${title} - ビールゲーム`;
        ref.current?.focus();
    }, [title]);
    return (
        <h1 ref={ref} tabIndex={-1}>
            {title}
        </h1>
    );
}
