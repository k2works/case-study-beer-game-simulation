import { ROLES, type Role, type SessionStatus } from './api/types';

/** 利用者に見せる語は、日本語の表示名の辞書から取る（英語の列挙値を直接表示しない）。 */
export const ROLE_LABELS: Record<Role, string> = {
    RETAILER: '小売店',
    WHOLESALER: '二次卸',
    DISTRIBUTOR: '一次卸',
    FACTORY: '工場',
};

/** 画面に並べる順（小売店から工場へ。画面イメージの順）。 */
export const ROLE_ORDER: readonly Role[] = ROLES;

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
    ACTIVE: '進行中',
    PAUSED: '停止中',
    ENDED: '終了',
};

/** 「第 3 週」と役割・状態の区切り（画面イメージの全角の空白）。ソースに全角の空白を直接書かない（lint）。 */
export const WEEK_SEPARATOR = String.fromCodePoint(0x3000);

/** 入力欄の名称。工場は「生産要請数」、流通役は「発注数」。 */
export const decisionFieldLabel = (role: Role): string =>
    role === 'FACTORY' ? '生産要請数' : '発注数';
