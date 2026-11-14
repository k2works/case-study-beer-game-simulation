import { ApiError, NetworkError } from './errors';
import type { ErrorCode } from './types';

/**
 * エラーの code から、画面の文言を引く辞書。正本は docs/design/beer-game-kotlin/ui-design.md の
 * 「エラーの code と表示の辞書」。`Record<ErrorCode, ...>` なので、code が増えると型エラーで漏れが分かる。
 * null は、設計書が文言を定めていない code（一般の文言と相関 ID を示す）。
 */
export const DECISIONS_CHANGED_TEXT = '確定の前に入力が変わりました。最新の値を確認してください。';

const TEXTS: Record<ErrorCode, string | null> = {
    'session.decision_conflict': '他の人が先に保存しました。',
    'session.week_advanced': null, // 週が要るので、下で組み立てる
    'session.decisions_changed': DECISIONS_CHANGED_TEXT,
    'session.already_started': 'すでに開始されています。',
    'session.already_ended': '終了しました。入力できません。',
    'session.not_active': null,
    'session.incomplete_decisions': null,
    'game.invitation_invalid': null, // 送った資格の種類から選ぶので、下で組み立てる
    // 設計書に文言が無い。受付の終了という理由（Gherkin AC1.2.2）を示す仮置き
    'game.not_preparing': '参加の受付は終了しています。',
    'game.already_created': null,
    'game.participant_not_found': null,
    'game.start_condition_not_met': '各役割に 1 人以上が必要です。',
    'validation.invalid_input': null,
    'app.retry_exhausted': '操作が混み合っています。もう一度お試しください。',
    'app.idempotency_key_reused': '操作を確認できませんでした。もう一度操作してください。',
    'app.unauthorized': 'この画面を開く権限がありません。',
    'app.internal': '問題が発生しました。時間をおいて、もう一度お試しください。',
    'app.not_ready': null,
    'app.rate_limited': null,
    'request.too_large': null,
    'request.not_found': null,
    'request.method_not_allowed': null,
};

const INVITATION_TEXTS = {
    joinCode: '参加コードが無効です。進行役に確認してください。',
    observerInvitation: '招待が無効です（失効または期限切れ）。進行役に確認してください。',
    returnCredential: '復帰用の資格が無効です。進行役に確認してください。',
} as const;

/** 失敗の文言を選ぶときの文脈。 */
export interface ProblemContext {
    /** 要求した週（session.week_advanced の文言に入れる）。 */
    week?: number;
    /** 画面が送った資格の種類（game.invitation_invalid の文言を選ぶ）。 */
    credential?: keyof typeof INVITATION_TEXTS;
}

export interface ShownProblem {
    text: string;
    correlationId?: string;
    /** 権限が無い（参加の画面への導線を出す）。 */
    unauthorized: boolean;
}

export const weekAdvancedText = (week: number): string => `第 ${week} 週はすでに確定されています。`;

function isErrorCode(code: string | undefined): code is ErrorCode {
    return code !== undefined && Object.hasOwn(TEXTS, code);
}

function fallbackText(status: number | undefined): string {
    if (status === undefined) return '通信に失敗しました。接続を確認して、もう一度お試しください。';
    if (status === 401 || status === 403) return '権限がありません。';
    if (status >= 500)
        return 'サーバーで問題が発生しました。時間をおいて、もう一度お試しください。';
    return '処理できませんでした。';
}

/**
 * 失敗を、利用者に見せる文言にする。辞書に無い code や、code の無い応答は、HTTP の区分（通信、権限、サーバー）の
 * 一般の文言にし、相関 ID を返す。想定外の例外も、握りつぶさず一般の文言にする。
 */
export function describeProblem(error: unknown, context: ProblemContext = {}): ShownProblem {
    if (error instanceof ApiError) {
        const code = error.code;
        const unauthorized =
            code === 'app.unauthorized' || error.status === 401 || error.status === 403;
        let text: string | null = null;
        if (code === 'session.week_advanced' && context.week !== undefined) {
            text = weekAdvancedText(context.week);
        } else if (code === 'game.invitation_invalid' && context.credential) {
            text = INVITATION_TEXTS[context.credential];
        } else if (code === 'game.invitation_invalid') {
            text = '無効な資格です。進行役に確認してください。';
        } else if (isErrorCode(code)) {
            text = TEXTS[code];
        }
        return {
            text: text ?? fallbackText(error.status),
            correlationId: error.correlationId,
            unauthorized,
        };
    }
    if (error instanceof NetworkError) {
        return { text: fallbackText(undefined), unauthorized: false };
    }
    return { text: '予期しない問題が発生しました。', unauthorized: false };
}
