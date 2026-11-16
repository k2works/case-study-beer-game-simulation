import { ROLES, type DecisionEditor, type Role, type SessionStatus } from './api/types';

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

/**
 * 保存の時刻を「時:分」（24 時間）で示す。[timeZone] を省くと、ブラウザの時刻帯。
 * 例: 「鈴木さんが 10:42 に保存」。秒と日付は、共同入力の判断に要らないので出さない。
 */
export const formatClock = (iso: string, timeZone?: string): string =>
    new Intl.DateTimeFormat('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        ...(timeZone === undefined ? {} : { timeZone }),
    }).format(new Date(iso));

/**
 * 保存した人の呼び名。自分なら「あなた」、進行役の代理入力なら「進行役（代理入力）」、共同担当なら「○○さん」。
 * 表示名はサーバーが、同じ役割の共同担当と進行役にだけ返す（無いときは「共同担当」）。
 */
export const editorName = (editor: DecisionEditor): string => {
    if (editor.isSelf) return 'あなた';
    if (editor.kind === 'FACILITATOR_PROXY') return '進行役（代理入力）';
    return `${editor.displayName ?? '共同担当'}さん`;
};

/** 入力欄の名称。工場は「生産要請数」、流通役は「発注数」。 */
export const decisionFieldLabel = (role: Role): string =>
    role === 'FACTORY' ? '生産要請数' : '発注数';
