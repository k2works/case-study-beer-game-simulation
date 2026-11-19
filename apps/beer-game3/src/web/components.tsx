import { useState, type ReactNode } from 'react';
import { ApiError } from './api.js';

/** 欄の下に示す理由。入力欄に aria-describedby で関連づける。 */
export function FieldError({ id, message }: { id: string; message?: string | undefined }) {
  return message ? (
    <p id={id} role="alert" className="field-error">
      {message}
    </p>
  ) : null;
}

/** 操作の失敗を、理由と直し方の文章にする。 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.problem
      ? `${error.problem.reason}。${error.problem.hint}`
      : '通信できませんでした。もう一度操作してください';
  }
  return '想定外の問題が起きました。もう一度操作してください';
}

export function CopyButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // 使えない環境では、表示された値を手で写してもらう
      setCopied(false);
    }
  };
  return (
    <button type="button" onClick={() => void copy()} aria-label={`${label}をコピー`}>
      {copied ? 'コピーしました' : 'コピー'}
    </button>
  );
}

const STEPS = [
  '入荷の確定',
  '入荷数の確認',
  '在庫への加算',
  '配送遅れの前進',
  '受注',
  '受注数の確認',
  '注文情報の処理',
  '在庫と受注残の計算',
  '出荷',
  '注文遅れの前進',
  '発注数の入力',
  '上流への発注',
];

/** 12 ステップの進み具合。完了・現在・これからを、色だけでなく印と文字で区別する。 */
export function StepProgress({ current }: { current: number }): ReactNode {
  return (
    <ol className="steps" aria-label="12 ステップの進み具合">
      {STEPS.map((name, index) => {
        const step = index + 1;
        const state = step < current ? '完了' : step === current ? '入力中' : 'これから';
        const mark = step < current ? '✓' : step === current ? '●' : '○';
        return (
          <li key={name} aria-current={step === current ? 'step' : undefined}>
            <span aria-hidden="true">{mark}</span> {step}. {name}（{state}）
          </li>
        );
      })}
    </ol>
  );
}
