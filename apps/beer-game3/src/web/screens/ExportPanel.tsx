import { useState } from 'react';
import type { ApiClient, Credential, ExportFormat } from '../api.js';
import { describeError } from '../components.js';
import { EXPORT_COLUMN_HELP, EXPORT_NOTICE, EXPORT_ROLE_HELP } from '../messages.js';

interface Props {
  api: ApiClient;
  credential: Credential;
  /** ファイルの保存。既定はブラウザのダウンロード。試験では差し替える */
  download?: (blob: Blob, filename: string) => void;
}

/** Blob をブラウザのダウンロードとして保存する。 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * 出力のパネル（進行役、終了後だけ）。CSV と JSON のボタンの近くに、表計算ソフトで開くときの注意と、
 * 列名の意味・単位、役割の値と役割名の対応を、日本語で常に示す（BR23.9。折りたたまない）。
 * 取得は Authorization ヘッダ付きの要求で、資格情報を URL に載せない（NFR6.6）。
 */
export function ExportPanel({ api, credential, download = saveBlob }: Props) {
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const run = async (format: ExportFormat) => {
    setBusy(format);
    setError(null);
    setSaved(null);
    try {
      const file = await api.exportGame(credential, format);
      download(file.blob, file.filename);
      setSaved(file.filename);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="export-heading" data-testid="export-panel" className="export-panel">
      <h2 id="export-heading">結果の出力</h2>
      <p>
        <button
          type="button"
          data-testid="export-csv"
          disabled={busy !== null}
          onClick={() => void run('csv')}
        >
          CSV で出力
        </button>{' '}
        <button
          type="button"
          data-testid="export-json"
          disabled={busy !== null}
          onClick={() => void run('json')}
        >
          JSON で出力
        </button>
      </p>
      {busy ? <p role="status">出力しています</p> : null}
      {saved ? (
        <p role="status" data-testid="export-done">
          {saved} を保存しました
        </p>
      ) : null}
      {error ? (
        <p role="alert" data-testid="export-error" className="field-error">
          {error}
        </p>
      ) : null}
      <p data-testid="export-notice" className="banner notice">
        {EXPORT_NOTICE}
      </p>
      <table data-testid="export-columns" aria-label="出力の列名の説明">
        <thead>
          <tr>
            <th scope="col">列名</th>
            <th scope="col">意味</th>
            <th scope="col">単位</th>
          </tr>
        </thead>
        <tbody>
          {EXPORT_COLUMN_HELP.map((column) => (
            <tr key={column.name}>
              <td>
                <code>{column.name}</code>
              </td>
              <td>{column.meaning}</td>
              <td>{column.unit}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table data-testid="export-roles" aria-label="役割の値の対応">
        <thead>
          <tr>
            <th scope="col">role の値</th>
            <th scope="col">役割</th>
          </tr>
        </thead>
        <tbody>
          {EXPORT_ROLE_HELP.map((role) => (
            <tr key={role.value}>
              <td>
                <code>{role.value}</code>
              </td>
              <td>{role.label}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">列名と role の値は、読み戻すための識別子として英語のまま出力します。</p>
    </section>
  );
}
