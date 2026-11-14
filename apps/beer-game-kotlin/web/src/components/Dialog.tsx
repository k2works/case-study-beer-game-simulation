import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

const FOCUSABLE =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 確認ダイアログ。Tab はダイアログの中を循環し、Escape で閉じ、閉じたら元のボタンへフォーカスを戻す。
 * 開いたときのフォーカスは、中の見出しが自分で取る（開き直しの通知を、見出しへ移して伝えるため）。
 */
export function Dialog({
    labelledBy,
    onClose,
    children,
}: {
    labelledBy: string;
    onClose: () => void;
    children: ReactNode;
}) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const opener =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        return () => opener?.focus();
    }, []);

    function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
            return;
        }
        if (event.key !== 'Tab' || ref.current === null) return;
        const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        const first = items[0];
        const last = items[items.length - 1];
        if (first === undefined || last === undefined) return;
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    return (
        <div className="dialog-backdrop">
            <div
                ref={ref}
                role="dialog"
                aria-modal="true"
                aria-labelledby={labelledBy}
                className="dialog"
                onKeyDown={onKeyDown}
            >
                {children}
            </div>
        </div>
    );
}
