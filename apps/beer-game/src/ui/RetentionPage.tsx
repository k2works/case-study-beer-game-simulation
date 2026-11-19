import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { BrowserApi } from './browser-api.js';
import { handleDialogKey } from './dialog-focus.js';

const ownerStatus = z.enum(['PENDING', 'COMPLETED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE']);
const deletionSchema = z.object({
  deletionId: z.string(),
  status: z.enum(['PENDING', 'IN_PROGRESS', 'FAILED', 'COMPLETED']),
  attempt: z.number().int(),
  owners: z.record(z.string(), ownerStatus),
  failureCode: z.string().optional(),
});
const retentionSchema = z.object({
  policy: z.object({
    gameId: z.string(),
    retentionDays: z.number().int(),
    retentionStartsAt: z.string(),
    deleteAfter: z.string(),
    policyVersion: z.number().int(),
  }),
  deletion: deletionSchema.nullable(),
});
type RetentionView = z.infer<typeof retentionSchema>;

export class RetentionAdapter {
  constructor(private readonly api: BrowserApi) {}
  async status(gameId: string): Promise<RetentionView> {
    return retentionSchema.parse(await this.api.retention(gameId));
  }
  async retry(gameId: string, attempt: number, key: string) {
    return deletionSchema.parse(await this.api.retryRetention(gameId, attempt, key));
  }
}

export function RetentionPage({ api, gameId }: { api: BrowserApi; gameId: string }) {
  const adapter = useMemo(() => new RetentionAdapter(api), [api]);
  const [view, setView] = useState<RetentionView>();
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) headingRef.current?.focus();
  }, [confirming]);
  async function refresh() {
    try {
      setView(await adapter.status(gameId));
      setError('');
    } catch (failure) {
      setView(undefined);
      setError(
        typeof failure === 'object' &&
          failure !== null &&
          'status' in failure &&
          [401, 403].includes(Number(failure.status))
          ? '保持状態を表示する権限がありません。'
          : '保持状態を取得できませんでした。',
      );
    }
  }
  useEffect(() => {
    void refresh();
  }, [adapter, gameId]);
  function close() {
    setConfirming(false);
    triggerRef.current?.focus();
  }
  async function retry() {
    const attempt = view?.deletion?.attempt;
    if (attempt === undefined) return;
    setBusy(true);
    try {
      const deletion = await adapter.retry(gameId, attempt, crypto.randomUUID());
      setView((current) => (current ? { ...current, deletion } : current));
      setError('');
      close();
    } catch {
      setError('再試行できませんでした。最新状態を確認してください。');
    } finally {
      setBusy(false);
    }
  }
  const deletion = view?.deletion;
  const allComplete =
    deletion &&
    Object.values(deletion.owners).length > 0 &&
    Object.values(deletion.owners).every((status) => status === 'COMPLETED');
  return (
    <section aria-labelledby="retention-title">
      <h2 id="retention-title">保持と削除</h2>
      {error && <div role="alert">{error}</div>}
      {!view && !error && <p>読み込み中…</p>}
      {view && (
        <>
          <dl>
            <dt>保持期間</dt>
            <dd>{view.policy.retentionDays} 日</dd>
            <dt>削除予定日</dt>
            <dd>{view.policy.deleteAfter}</dd>
          </dl>
          {!deletion && <p>削除待ち</p>}
          {deletion && (
            <>
              <p>
                {deletion.status === 'COMPLETED' && allComplete
                  ? '削除完了'
                  : `削除状態: ${deletion.status}`}
              </p>
              <ul>
                {Object.entries(deletion.owners).map(([owner, status]) => (
                  <li key={owner}>
                    {owner}: {status}
                  </li>
                ))}
              </ul>
              {deletion.status === 'FAILED' && (
                <>
                  <p>
                    失敗コード: <strong>{deletion.failureCode ?? 'UNKNOWN'}</strong>
                  </p>
                  <p>未完了の owner を確認し、必要に応じて運営者へ連絡してください。</p>
                  <button ref={triggerRef} type="button" onClick={() => setConfirming(true)}>
                    手動再試行
                  </button>
                </>
              )}
            </>
          )}
          <button type="button" onClick={() => void refresh()}>
            手動更新
          </button>
        </>
      )}
      {confirming && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="retry-title"
          onKeyDown={(event) => handleDialogKey(event, close)}
        >
          <h3 id="retry-title" tabIndex={-1} ref={headingRef}>
            削除の再試行を確認
          </h3>
          <p>未完了の owner へ削除依頼を再送します。結果を確認してから続けてください。</p>
          <button type="button" disabled={busy} onClick={close}>
            キャンセル
          </button>
          <button type="button" disabled={busy} onClick={() => void retry()}>
            再試行を確定
          </button>
        </div>
      )}
    </section>
  );
}
