import { useCallback, useEffect, useRef, useState } from 'react';

export type LoadState<T> =
    { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: unknown };

/**
 * 画面のデータの取得。最初の取得と、手動の再取得（reload）をまとめる。
 * 失敗は握りつぶさず、state.error に持つ（画面が原因の区分と相関 ID を示す）。
 */
export function useLoad<T>(load: () => Promise<T>) {
    const [state, setState] = useState<LoadState<T>>({ status: 'loading' });
    const loadRef = useRef(load);
    loadRef.current = load;

    const reload = useCallback(async () => {
        try {
            setState({ status: 'ready', data: await loadRef.current() });
        } catch (error) {
            setState({ status: 'error', error });
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        loadRef.current().then(
            (data) => {
                if (!cancelled) setState({ status: 'ready', data });
            },
            (error: unknown) => {
                if (!cancelled) setState({ status: 'error', error });
            },
        );
        return () => {
            cancelled = true;
        };
    }, []);

    const setData = useCallback((data: T) => setState({ status: 'ready', data }), []);
    return { state, reload, setData };
}
