import { ROLE_LABELS, type Role } from '../server/domain/types.js';
import type { HistoryEntryView } from '../server/session/history.js';

/** 最小単位（セント）を「$4.00」の形にする。整数だけで計算し、浮動小数点を使わない。 */
export function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** 結果画面の金額（BR22.5）。整数のセントを $ と小数 2 桁の形にする。formatMoney と同じ（整数の割り算と剰余だけ）。 */
export const formatCents = formatMoney;

/** 「0.5」「1」「1.25」のようなドルの入力を、最小単位（セント）の整数にする。形式が違えば null。 */
export function parseDollarsToCents(text: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) {
    return null;
  }
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || '0');
}

export function parseNonNegativeInt(text: string): number | null {
  return /^\d{1,9}$/.test(text.trim()) ? Number(text.trim()) : null;
}

export const roleLabel = (role: Role): string => ROLE_LABELS[role];

export const roleList = (roles: readonly Role[]): string => roles.map(roleLabel).join('、');

const KIND_LABELS = {
  setting: '設定',
  roleChange: '役割変更',
  proxyInput: '代理入力',
  weekConfirm: '週の確定',
  pause: '一時停止',
  resume: '再開',
  end: '終了',
} as const;

const END_REASON_LABELS = {
  facilitator: '進行役の終了',
  finalWeek: '最終週の確定',
  autoEnd: '自動終了',
} as const;

export const historyKindLabel = (entry: HistoryEntryView): string => KIND_LABELS[entry.kind];

export const actorLabel = (entry: HistoryEntryView): string =>
  entry.actorKind === 'system' ? 'システム' : '進行役';

/** 履歴の時刻（UTC）。ISO 8601 を「2026-11-12 09:00:00 UTC」の形にする。 */
export const historyTime = (iso: string): string => `${iso.slice(0, 19).replace('T', ' ')} UTC`;

/** 履歴の「何を」を、日本語の 1 行にする。値は参加者のラベルと数量だけ（資格情報は持たない）。 */
export function historyDetail(entry: HistoryEntryView): string {
  switch (entry.kind) {
    case 'setting': {
      const d = entry.detail;
      return `週数 ${d.weekCount}、初期在庫 ${d.initialInventory}、初期パイプライン ${d.initialPipelineQuantity}、在庫単価 ${formatMoney(d.inventoryUnitCost)}、受注残単価 ${formatMoney(d.backlogUnitCost)}、${d.setupKind === 'kit' ? 'キット準拠' : 'カスタム'}`;
    }
    case 'roleChange': {
      const d = entry.detail;
      const to = d.toRole ? roleLabel(d.toRole) : '未割当て';
      if (d.change === 'replace') {
        return `${d.replacedParticipantLabel ?? ''} から ${d.participantLabel} に入れ替え（${to}）`;
      }
      if (d.change === 'reassign') {
        return `${d.participantLabel} を ${d.fromRole ? roleLabel(d.fromRole) : ''} から ${to} へ付け替え`;
      }
      if (d.change === 'unassign') {
        return `${d.participantLabel} を未割当てに戻す`;
      }
      return `${d.participantLabel} を ${to} に割り当て`;
    }
    case 'proxyInput': {
      const d = entry.detail;
      return `${entry.role ? roleLabel(entry.role) : ''} 第 ${entry.week ?? ''} 週に ${d.value} を入力`;
    }
    case 'weekConfirm':
      return `第 ${entry.week ?? ''} 週を確定`;
    case 'pause':
    case 'resume':
      return `第 ${entry.week ?? ''} 週`;
    case 'end': {
      const d = entry.detail;
      return `${END_REASON_LABELS[d.reason]}（第 ${d.week} 週）`;
    }
  }
}
