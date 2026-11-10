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
