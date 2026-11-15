import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from './errors';
import { describeProblem } from './problems';

function problem(status: number, code: string | undefined, extra: Record<string, unknown> = {}) {
    return new ApiError(status, {
        type: code ? `/problems/${code}` : undefined,
        code,
        correlationId: 'corr-1',
        ...extra,
    });
}

describe('describeProblem（code から表示の文言を引く。ui-design.md の辞書）', () => {
    it('session.week_advanced は、要求した週を入れた文言になる', () => {
        const shown = describeProblem(problem(409, 'session.week_advanced'), { week: 3 });
        expect(shown.text).toBe('第 3 週はすでに確定されています。');
    });

    it('session.decisions_changed は、入力が変わった旨の文言になる', () => {
        const shown = describeProblem(problem(409, 'session.decisions_changed'));
        expect(shown.text).toBe('確定の前に入力が変わりました。最新の値を確認してください。');
    });

    it('session.already_started は「すでに開始されています。」', () => {
        expect(describeProblem(problem(409, 'session.already_started')).text).toBe(
            'すでに開始されています。',
        );
    });

    it('app.retry_exhausted は「もう一度お試しください」で、相関 ID を返す', () => {
        const shown = describeProblem(problem(503, 'app.retry_exhausted'));
        expect(shown.text).toBe('操作が混み合っています。もう一度お試しください。');
        expect(shown.correlationId).toBe('corr-1');
    });

    it('app.idempotency_key_reused は、操作を確認できなかった旨の文言になる', () => {
        expect(describeProblem(problem(409, 'app.idempotency_key_reused')).text).toBe(
            '操作を確認できませんでした。もう一度操作してください。',
        );
    });

    it('app.unauthorized は権限の文言で、参加・復帰への導線が要ることを示す', () => {
        const shown = describeProblem(problem(403, 'app.unauthorized'));
        expect(shown.text).toBe('この画面を開く権限がありません。');
        expect(shown.unauthorized).toBe(true);
    });

    it('game.invitation_invalid は、送った資格の種類（参加コード）から文言を選ぶ', () => {
        const shown = describeProblem(problem(403, 'game.invitation_invalid'), {
            credential: 'joinCode',
        });
        expect(shown.text).toBe('参加コードが無効です。進行役に確認してください。');
    });

    it('復帰の失敗（app.unauthorized）は、送った資格の種類（復帰用の資格）から文言を選ぶ', () => {
        const shown = describeProblem(problem(403, 'app.unauthorized'), {
            credential: 'returnCredential',
        });
        expect(shown.text).toBe('復帰用の資格が無効です。進行役に確認してください。');
    });

    it('復帰の失敗は、不明・失効・期限切れを区別しない（失効と期限切れを示す語を使わない）', () => {
        const shown = describeProblem(problem(403, 'app.unauthorized'), {
            credential: 'returnCredential',
        });
        expect(shown.text).not.toMatch(/失効|期限切れ|不明|存在しない|削除/);
    });

    it('停止中（session.paused）は、停止中である旨と再開を待つ旨を示す（UI 設計の競合の表）', () => {
        expect(describeProblem(problem(409, 'session.paused')).text).toBe(
            '停止中です。進行役の再開を待ってください。',
        );
    });

    it('session.not_paused は、停止中でない旨を示す（提案の文言）', () => {
        expect(describeProblem(problem(409, 'session.not_paused')).text).toBe(
            '停止中ではありません。',
        );
    });

    it('session.not_active は、まだ開始されていない旨を示す（停止中とは区別する）', () => {
        const shown = describeProblem(problem(409, 'session.not_active'));
        expect(shown.text).toBe('ゲームはまだ開始されていません。');
        expect(shown.text).not.toContain('停止');
    });

    it('session.save_limit_reached は、保存回数の上限に達した旨を示す（提案の文言）', () => {
        expect(describeProblem(problem(409, 'session.save_limit_reached')).text).toBe(
            'この週の保存回数の上限に達しました。進行役に確認してください。',
        );
    });

    it('資格の失効・再発行の code は、一般の文言でなく、理由を示す（提案の文言）', () => {
        expect(describeProblem(problem(409, 'game.credential_already_revoked')).text).toBe(
            'この資格はすでに失効しています。',
        );
        expect(describeProblem(problem(409, 'game.credential_not_revoked')).text).toBe(
            '失効していない資格は再発行できません。',
        );
    });

    it('app.rate_limited は、少し待ってやり直す旨を示す（提案の文言）', () => {
        expect(describeProblem(problem(429, 'app.rate_limited')).text).toBe(
            '試行が多すぎます。しばらく待って、もう一度お試しください。',
        );
    });

    it('資格の種類が分からない game.invitation_invalid は、原因を推測しない文言になる', () => {
        const shown = describeProblem(problem(403, 'game.invitation_invalid'));
        expect(shown.text).not.toMatch(/失効|期限切れ/);
    });

    it('session.already_ended は「終了しました。入力できません。」', () => {
        expect(describeProblem(problem(409, 'session.already_ended')).text).toBe(
            '終了しました。入力できません。',
        );
    });

    it('未知の code は、HTTP の区分（サーバー）の一般の文言になり、相関 ID を返す', () => {
        const shown = describeProblem(problem(500, 'unknown.thing'));
        expect(shown.text).toContain('サーバー');
        expect(shown.correlationId).toBe('corr-1');
    });

    it('code の無い 403 は、権限の区分の一般の文言になる', () => {
        expect(describeProblem(problem(403, undefined)).text).toContain('権限');
    });

    it('通信の失敗は、通信の区分の一般の文言になる', () => {
        const shown = describeProblem(new NetworkError('offline'));
        expect(shown.text).toContain('通信');
        expect(shown.correlationId).toBeUndefined();
    });

    it('想定外の例外は、握りつぶさず、一般の文言にする', () => {
        expect(describeProblem(new TypeError('boom')).text).not.toBe('');
    });
});
