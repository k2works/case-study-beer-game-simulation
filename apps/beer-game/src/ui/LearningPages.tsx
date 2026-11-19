import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { BrowserApi } from './browser-api.js';

const observationSchema = z.object({
  currentWeek: z.number().int(),
  completionStatus: z.record(z.string(), z.boolean()),
  suppressionReasons: z.array(z.string()),
  safeTeamTotals: z
    .object({ inventory: z.number(), backlog: z.number(), orders: z.number() })
    .optional(),
});

export class LearningAdapter {
  constructor(private readonly api: BrowserApi) {}
  async observation(gameId: string) {
    return observationSchema.parse(await this.api.observation(gameId));
  }
  review(gameId: string) {
    return this.api.review(gameId);
  }
  createExport(gameId: string, key: string) {
    return this.api.createExport(gameId, key);
  }
  exportStatus(gameId: string, exportId: string) {
    return this.api.exportStatus(gameId, exportId);
  }
  exportUrl(gameId: string, exportId: string, format: 'csv' | 'json') {
    return this.api.exportUrl(gameId, exportId, format);
  }
}

export function ObservationPage({ api, gameId }: { api: BrowserApi; gameId: string }) {
  const adapter = useMemo(() => new LearningAdapter(api), [api]);
  const [state, setState] = useState<z.infer<typeof observationSchema>>();
  const [error, setError] = useState('');
  async function refresh() {
    try {
      setState(await adapter.observation(gameId));
      setError('');
    } catch {
      setError('観察状態を読み込めませんでした。');
    }
  }
  useEffect(() => {
    void refresh();
  }, [adapter, gameId]);
  return (
    <section aria-labelledby="observation-title">
      <h2 id="observation-title">観察</h2>
      {error && <div role="alert">{error}</div>}
      {!state ? (
        <p>読み込み中…</p>
      ) : (
        <>
          <p>第 {state.currentWeek} 週</p>
          <ul>
            {Object.entries(state.completionStatus).map(([role, complete]) => (
              <li key={role}>
                {role}: {complete ? '入力済み' : '未入力'}
              </li>
            ))}
          </ul>
          {state.safeTeamTotals && state.suppressionReasons.length === 0 ? (
            <dl>
              <dt>在庫合計</dt>
              <dd>{state.safeTeamTotals.inventory}</dd>
              <dt>受注残合計</dt>
              <dd>{state.safeTeamTotals.backlog}</dd>
              <dt>注文合計</dt>
              <dd>{state.safeTeamTotals.orders}</dd>
            </dl>
          ) : (
            <p>情報保護のため非表示</p>
          )}
        </>
      )}
      <button type="button" onClick={() => void refresh()}>
        手動更新
      </button>
    </section>
  );
}

type WeekRow = Awaited<ReturnType<BrowserApi['review']>>['weeklySeries'][number];
const METRICS: { key: keyof Omit<WeekRow, 'week'>; label: string; color: string }[] = [
  { key: 'demand', label: '需要', color: '#1b4f91' },
  { key: 'orders', label: '注文', color: '#9b3200' },
  { key: 'inventory', label: '在庫', color: '#1b6a36' },
  { key: 'backlog', label: '受注残', color: '#7e3794' },
  { key: 'shipments', label: '出荷', color: '#915b00' },
  { key: 'costMinor', label: '費用（minor）', color: '#374151' },
];

export function ReviewPage({
  api,
  gameId,
  facilitator,
}: {
  api: BrowserApi;
  gameId: string;
  facilitator: boolean;
}) {
  const adapter = useMemo(() => new LearningAdapter(api), [api]);
  const [rows, setRows] = useState<WeekRow[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    void adapter
      .review(gameId)
      .then((result) => {
        setRows(result.weeklySeries);
        setError('');
      })
      .catch(() => setError('振り返りを読み込めませんでした。'));
  }, [adapter, gameId]);
  const max = Math.max(
    1,
    ...(rows ?? []).flatMap((row) => METRICS.map((metric) => row[metric.key])),
  );
  return (
    <section aria-labelledby="review-title">
      <h2 id="review-title">振り返り</h2>
      {error && <div role="alert">{error}</div>}
      {!rows && !error && <p>読み込み中…</p>}
      {rows?.length === 0 && <p>データなし</p>}
      {rows && rows.length > 0 && (
        <>
          <a href="#review-table">表へ移動</a>
          <svg role="img" aria-label="週次推移グラフ" viewBox="0 0 500 220" width="100%">
            {METRICS.map((metric) => (
              <g key={metric.key}>
                <polyline
                  fill="none"
                  stroke={metric.color}
                  strokeWidth="2"
                  points={rows
                    .map(
                      (row, index) =>
                        `${20 + (index * 460) / Math.max(1, rows.length - 1)},${190 - (row[metric.key] * 160) / max}`,
                    )
                    .join(' ')}
                />
                <text x="20" y={12 + METRICS.indexOf(metric) * 18} fill={metric.color}>
                  {metric.label}
                </text>
              </g>
            ))}
          </svg>
          <table id="review-table">
            <caption>週次データ</caption>
            <thead>
              <tr>
                <th scope="col">週</th>
                {METRICS.map((metric) => (
                  <th key={metric.key} scope="col">
                    {metric.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.week}>
                  <th scope="row">{row.week}</th>
                  {METRICS.map((metric) => (
                    <td key={metric.key}>{row[metric.key]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {facilitator && <ExportPanel api={api} gameId={gameId} />}
    </section>
  );
}

export function ExportPanel({ api, gameId }: { api: BrowserApi; gameId: string }) {
  const adapter = useMemo(() => new LearningAdapter(api), [api]);
  const [exportState, setExportState] = useState<{
    exportId: string;
    status: string;
    schemaVersion: string;
  }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function create() {
    setError('');
    setBusy(true);
    try {
      setExportState(await adapter.createExport(gameId, crypto.randomUUID()));
    } catch {
      setError('出力を作成できませんでした。');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (exportState?.status !== 'PENDING') return;
    const timer = setInterval(() => {
      void adapter
        .exportStatus(gameId, exportState.exportId)
        .then(setExportState)
        .catch(() => {
          setError('出力状態を取得できませんでした。');
        });
    }, 1000);
    return () => clearInterval(timer);
  }, [adapter, gameId, exportState?.exportId, exportState?.status]);
  return (
    <section aria-labelledby="export-title">
      <h3 id="export-title">データ出力</h3>
      <button type="button" disabled={busy} onClick={() => void create()}>
        出力を作成
      </button>
      {error && <div role="alert">{error}</div>}
      {exportState && (
        <>
          <p>schema {exportState.schemaVersion}</p>
          {exportState.status === 'PENDING' && (
            <p role="status" aria-live="polite">
              生成中
            </p>
          )}
          {exportState.status === 'FAILED' && <p role="alert">出力に失敗しました。</p>}
          {exportState.status === 'COMPLETE' && (
            <p>
              <a href={adapter.exportUrl(gameId, exportState.exportId, 'csv')}>
                CSV をダウンロード
              </a>{' '}
              <a href={adapter.exportUrl(gameId, exportState.exportId, 'json')}>
                JSON をダウンロード
              </a>
            </p>
          )}
        </>
      )}
    </section>
  );
}
