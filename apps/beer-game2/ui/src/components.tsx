import { useEffect, useRef, type ReactNode } from 'react';
import { ApiError, type Issue } from './api/types.js';

/** 画面の見出し。題名を設定し、画面の切り替わりで見出しにフォーカスを移す */
export function Page({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = `${title} - ビールゲーム`;
    ref.current?.focus();
  }, [title]);
  return (
    <main>
      <h1 ref={ref} tabIndex={-1}>
        {title}
      </h1>
      {children}
    </main>
  );
}

const describeIssue = (i: Issue) =>
  `${i.week ? `${i.week} 週目: ` : ''}${i.problem}。${i.fix}`;

export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  const issues = error instanceof ApiError ? error.issues : [];
  return (
    <div role="alert" className="error">
      <p>{message}</p>
      {issues.length > 0 && (
        <ul>
          {issues.map((i, n) => (
            <li key={n}>{describeIssue(i)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 取り返しがつかない操作の前の確認。対象と影響を示す */
export function ConfirmDialog({
  label,
  confirm,
  onConfirm,
  onCancel,
  children,
}: {
  label: string;
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <div role="dialog" aria-modal="true" aria-label={label}>
      {children}
      <button type="button" onClick={onConfirm}>
        {confirm}
      </button>
      <button type="button" onClick={onCancel}>
        キャンセル
      </button>
    </div>
  );
}

/** 復帰コード。Cookie を失ったときに戻るための値で、表示はこの場限り */
export function RecoveryCodeNote({
  label,
  code,
}: {
  label: string;
  code: string;
}) {
  return (
    <aside role="note" aria-label={label} className="recovery">
      <p>
        {label}: <strong>{code}</strong>
      </p>
      <p>
        ブラウザを閉じたり、別の端末に移ったりしたときに、「参加・復帰」の画面で使います。
        この画面でだけ表示します。控えてください（他の人に見せないでください）。
      </p>
    </aside>
  );
}
