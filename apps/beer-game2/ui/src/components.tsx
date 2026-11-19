import { useEffect, useRef, type ReactNode } from 'react';
import {
  ApiError,
  type Issue,
  type RetentionView,
  type SettingsView,
} from './api/types.js';
import { CONDITION_LABEL, DISCLOSURE_LABEL, formatMoney } from './labels.js';

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

/** 条件の要約: キット準拠か、カスタム（変更した項目）か。`detailed` なら値の一覧も示す */
export function SettingsSummary({
  settings,
  detailed = false,
}: {
  settings: SettingsView;
  detailed?: boolean;
}) {
  return (
    <>
      <p>
        {settings.kind === 'KIT'
          ? '条件: キット準拠'
          : `条件: カスタム（変更: ${settings.changes.map((c) => CONDITION_LABEL[c]).join('、')}）`}
      </p>
      {detailed && (
        <ul aria-label="条件の値">
          <li>初期在庫: {settings.initialInventory}</li>
          <li>
            遅延: 注文 {settings.orderDelayWeeks} 週・配送{' '}
            {settings.shipmentDelayWeeks} 週・生産{' '}
            {settings.productionDelayWeeks} 週
          </li>
          <li>在庫の費用: {formatMoney(settings.holdingCostMinor)}</li>
          <li>受注残の費用: {formatMoney(settings.backlogCostMinor)}</li>
          <li>公開範囲: {DISCLOSURE_LABEL[settings.disclosure]}</li>
        </ul>
      )}
    </>
  );
}

/** 保持方針（運営者へ示す）。削除予定日と、削除後もバックアップに残る期間 */
export function RetentionNote({ retention }: { retention: RetentionView }) {
  return (
    <aside role="note" aria-label="保持方針">
      <p>
        保持期間 {retention.days} 日（
        {new Date(retention.deleteAfter).toLocaleDateString('ja-JP')}{' '}
        に削除します）。
      </p>
      <p>
        データベースのバックアップには、削除後も最大 {retention.backupDays}{' '}
        日残ります。
      </p>
    </aside>
  );
}
