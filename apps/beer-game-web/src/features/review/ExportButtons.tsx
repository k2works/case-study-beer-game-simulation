import { useState } from 'react';
import { useApi } from '../../api/ApiContext';
import type { ExportFormat } from '../../api/types';
import { ErrorNotice } from '../../components/ErrorNotice';
import { downloadFile } from '../../components/downloadFile';

/**
 * 結果の出力（US4.3）。進行役だけに示す。サーバーが全体を組み立て終えたときだけファイルを受け取り、ダウンロードする。
 * 失敗したときは、何も保存せず、原因の区分と相関 ID を示す（部分的な結果を完全な出力として示さない）。
 * 出力している間は、二重の要求を防ぐため、2 つのボタンを押せない。
 */
export function ExportButtons({ gameId }: { gameId: string }) {
    const api = useApi();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<unknown>(undefined);

    async function run(format: ExportFormat) {
        setPending(true);
        setError(undefined);
        try {
            downloadFile(await api.exportResult(gameId, format));
        } catch (cause) {
            setError(cause);
        } finally {
            setPending(false);
        }
    }

    return (
        <section aria-label="結果の出力">
            <p>設定・役割別の値・意思決定を含みます。</p>
            <p>
                <button type="button" disabled={pending} onClick={() => void run('csv')}>
                    CSV を出力
                </button>{' '}
                <button type="button" disabled={pending} onClick={() => void run('json')}>
                    JSON を出力
                </button>
            </p>
            {error === undefined ? null : <ErrorNotice error={error} />}
        </section>
    );
}
