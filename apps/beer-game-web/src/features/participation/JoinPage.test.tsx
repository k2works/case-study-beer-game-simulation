import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import { expectNoStructuralA11yViolations } from '../../testing/a11y';
import { GAME_ID, fakeApi, gameState, lobby, versions } from '../../testing/fakeApi';
import { renderApp } from '../../testing/render';

async function fill(user: ReturnType<typeof userEvent.setup>, code: string, name: string) {
    await user.type(screen.getByLabelText('参加コード'), code);
    await user.type(screen.getByLabelText('表示名'), name);
    await user.click(screen.getByRole('button', { name: '参加する' }));
}

const unauthorized = () =>
    new ApiError(403, {
        type: '/problems/app.unauthorized',
        code: 'app.unauthorized',
        correlationId: 'c-9',
    });

describe('S03 参加', () => {
    it('参加コードと表示名で参加し、応答のゲームの ID で、プレイの画面へ進む（参加後に止まらない）', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            joinGame: () => Promise.resolve({ versions: versions(null, 2), gameId: GAME_ID }),
            getGameState: () =>
                Promise.resolve(gameState({ status: 'PREPARING', sessionId: null })),
        });
        renderApp(api, '/join');
        await fill(user, 'ABCDEFGH2345', '田中');
        expect(api.joinGame).toHaveBeenCalledWith({
            joinCode: 'ABCDEFGH2345',
            displayName: '田中',
        });
        expect(await screen.findByRole('heading', { name: 'プレイ' })).toBeInTheDocument();
        expect(api.getGameState).toHaveBeenCalledWith(GAME_ID);
        expect(await screen.findByText('進行役が開始するまでお待ちください。')).toBeVisible();
    });

    it('無効な参加コードは、送った資格の種類（参加コード）から選んだ文言を示し、入力を保持する', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            joinGame: () =>
                Promise.reject(
                    new ApiError(403, {
                        type: '/problems/game.invitation_invalid',
                        code: 'game.invitation_invalid',
                        correlationId: 'c-2',
                    }),
                ),
        });
        renderApp(api, '/join');
        await fill(user, 'WRONGCODE', '田中');
        expect(await screen.findByRole('alert')).toHaveTextContent(
            '参加コードが無効です。進行役に確認してください。',
        );
        expect(screen.getByLabelText('参加コード')).toHaveValue('WRONGCODE');
        expect(screen.getByLabelText('表示名')).toHaveValue('田中');
    });

    it('受付が終了したゲームは、受付の終了という理由を示す', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            joinGame: () =>
                Promise.reject(
                    new ApiError(409, {
                        type: '/problems/game.not_preparing',
                        code: 'game.not_preparing',
                    }),
                ),
        });
        renderApp(api, '/join');
        await fill(user, 'ABCDEFGH2345', '山本');
        expect(await screen.findByRole('alert')).toHaveTextContent('参加の受付は終了しています。');
    });

    it('参加の試行が多すぎる（429）ときは、少し待つ旨を示し、入力を保持する', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            joinGame: () =>
                Promise.reject(
                    new ApiError(429, {
                        type: '/problems/app.rate_limited',
                        code: 'app.rate_limited',
                    }),
                ),
        });
        renderApp(api, '/join');
        await fill(user, 'ABCDEFGH2345', '山本');
        expect(await screen.findByRole('alert')).toHaveTextContent(
            '試行が多すぎます。しばらく待って、もう一度お試しください。',
        );
        expect(screen.getByLabelText('参加コード')).toHaveValue('ABCDEFGH2345');
    });

    it('形式の誤り（422）は、誤りを示し、入力を保持する', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            joinGame: () =>
                Promise.reject(
                    new ApiError(422, {
                        type: '/problems/validation.invalid_input',
                        code: 'validation.invalid_input',
                        errors: [{ field: 'displayName', message: '表示名を入力してください。' }],
                    }),
                ),
        });
        renderApp(api, '/join');
        await user.type(screen.getByLabelText('参加コード'), 'ABCDEFGH2345');
        await user.click(screen.getByRole('button', { name: '参加する' }));
        expect(await screen.findByText('表示名を入力してください。')).toBeInTheDocument();
        expect(screen.getByLabelText('参加コード')).toHaveValue('ABCDEFGH2345');
        expect(screen.getByLabelText('表示名')).toHaveAttribute('aria-invalid', 'true');
    });
});

describe('S03 復帰', () => {
    it('見出しは「参加・復帰」で、参加の入力と復帰の入力を、別の領域に分けて示す', () => {
        renderApp(fakeApi(), '/join');
        expect(screen.getByRole('heading', { level: 1, name: '参加・復帰' })).toBeInTheDocument();
        expect(screen.getByRole('region', { name: '参加する' })).toBeInTheDocument();
        expect(screen.getByRole('region', { name: '復帰する' })).toBeInTheDocument();
    });

    it('URL の gameId を、復帰のゲーム ID に入れておく（権限の無い画面からの導線）', () => {
        renderApp(fakeApi(), `/join?gameId=${GAME_ID}`);
        expect(screen.getByLabelText('ゲーム ID')).toHaveValue(GAME_ID);
    });

    it('復帰コードを空にすると、復帰コードを送らず（Cookie の復帰資格で復帰する）、進行中の参加者はプレイの画面へ戻る', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            recoverParticipation: () =>
                Promise.resolve({
                    versions: versions(3, 5),
                    gameId: GAME_ID,
                    kind: 'PARTICIPANT',
                    role: 'FACTORY',
                }),
            getGameState: () => Promise.resolve(gameState({ status: 'STARTED', role: 'FACTORY' })),
            getSessionState: () =>
                Promise.reject(new Error('プレイの画面の取得（試験では止める）')),
        });
        renderApp(api, `/join?gameId=${GAME_ID}`);
        await user.click(screen.getByRole('button', { name: '復帰する' }));
        expect(api.recoverParticipation).toHaveBeenCalledWith({ gameId: GAME_ID });
        expect(await screen.findByRole('heading', { name: 'プレイ' })).toBeInTheDocument();
    });

    it('復帰コードを入力すると、復帰コードを本文に付けて送る。進行中の進行役は、コンソールへ戻る', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            recoverParticipation: () =>
                Promise.resolve({
                    versions: versions(3, 5),
                    gameId: GAME_ID,
                    kind: 'FACILITATOR',
                }),
            getGameState: () => Promise.resolve(gameState({ status: 'STARTED' })),
            getSessionState: () => Promise.reject(new Error('コンソールの取得（試験では止める）')),
        });
        renderApp(api, '/join');
        await user.type(screen.getByLabelText('ゲーム ID'), GAME_ID);
        await user.type(screen.getByLabelText('復帰コード'), 'RC-ABC');
        await user.click(screen.getByRole('button', { name: '復帰する' }));
        expect(api.recoverParticipation).toHaveBeenCalledWith({
            gameId: GAME_ID,
            recoveryCode: 'RC-ABC',
        });
        expect(
            await screen.findByRole('heading', { name: '進行役のコンソール' }),
        ).toBeInTheDocument();
    });

    it('準備中の進行役は、ロビーへ戻る', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            recoverParticipation: () =>
                Promise.resolve({
                    versions: versions(null, 5),
                    gameId: GAME_ID,
                    kind: 'FACILITATOR',
                }),
            getGameState: () =>
                Promise.resolve(gameState({ status: 'PREPARING', sessionId: null })),
            getLobby: () => Promise.resolve(lobby()),
        });
        renderApp(api, `/join?gameId=${GAME_ID}`);
        await user.click(screen.getByRole('button', { name: '復帰する' }));
        expect(await screen.findByRole('heading', { name: 'ロビー' })).toBeInTheDocument();
    });

    it('準備中の参加者は、プレイの画面で開始を待つ', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            recoverParticipation: () =>
                Promise.resolve({
                    versions: versions(null, 5),
                    gameId: GAME_ID,
                    kind: 'PARTICIPANT',
                    role: 'RETAILER',
                }),
            getGameState: () =>
                Promise.resolve(gameState({ status: 'PREPARING', sessionId: null })),
        });
        renderApp(api, `/join?gameId=${GAME_ID}`);
        await user.click(screen.getByRole('button', { name: '復帰する' }));
        expect(await screen.findByText('進行役が開始するまでお待ちください。')).toBeVisible();
    });

    it('無効な復帰資格は、送った資格の種類（復帰用の資格）から選んだ文言を示し、入力を保持する', async () => {
        const user = userEvent.setup();
        const api = fakeApi({ recoverParticipation: () => Promise.reject(unauthorized()) });
        renderApp(api, '/join');
        await user.type(screen.getByLabelText('ゲーム ID'), GAME_ID);
        await user.type(screen.getByLabelText('復帰コード'), 'WRONG');
        await user.click(screen.getByRole('button', { name: '復帰する' }));
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('復帰用の資格が無効です。進行役に確認してください。');
        expect(alert).toHaveTextContent('相関 ID: c-9');
        expect(screen.getByLabelText('ゲーム ID')).toHaveValue(GAME_ID);
        expect(screen.getByLabelText('復帰コード')).toHaveValue('WRONG');
        // 参加の画面にいるので、同じ画面への導線は出さない
        expect(within(alert).queryByRole('link')).not.toBeInTheDocument();
    });

    it('進行役への確認方法（復帰コードの再発行の依頼）を、復帰の領域に示す（AC3.2.2）', () => {
        renderApp(fakeApi(), '/join');
        expect(screen.getByRole('region', { name: '復帰する' })).toHaveTextContent(
            '復帰コードが分からない場合は、進行役に、復帰コードの再発行を依頼してください。',
        );
    });

    it('復帰コードの試行が多すぎる（429）ときは、少し待つ旨を示す', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            recoverParticipation: () =>
                Promise.reject(
                    new ApiError(429, {
                        type: '/problems/app.rate_limited',
                        code: 'app.rate_limited',
                    }),
                ),
        });
        renderApp(api, `/join?gameId=${GAME_ID}`);
        await user.click(screen.getByRole('button', { name: '復帰する' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(
            '試行が多すぎます。しばらく待って、もう一度お試しください。',
        );
    });

    it('ゲーム ID の形式の誤り（422）は、項目の近くに示す', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            recoverParticipation: () =>
                Promise.reject(
                    new ApiError(422, {
                        type: '/problems/validation.invalid_input',
                        code: 'validation.invalid_input',
                        errors: [
                            { field: 'gameId', message: 'ゲーム ID の形式が正しくありません。' },
                        ],
                    }),
                ),
        });
        renderApp(api, '/join');
        await user.type(screen.getByLabelText('ゲーム ID'), 'not-a-uuid');
        await user.click(screen.getByRole('button', { name: '復帰する' }));
        expect(await screen.findByText('ゲーム ID の形式が正しくありません。')).toBeInTheDocument();
        expect(screen.getByLabelText('ゲーム ID')).toHaveAttribute('aria-invalid', 'true');
    });

    it('復帰のあとの、復帰先の状態の取得が失敗しても、握りつぶさず示す', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            recoverParticipation: () =>
                Promise.resolve({
                    versions: versions(3, 5),
                    gameId: GAME_ID,
                    kind: 'FACILITATOR',
                }),
            getGameState: () => Promise.reject(unauthorized()),
        });
        renderApp(api, `/join?gameId=${GAME_ID}`);
        await user.click(screen.getByRole('button', { name: '復帰する' }));
        expect(await screen.findByRole('alert')).toBeInTheDocument();
    });

    it('構造のアクセシビリティ（名前・参照先・見出し・題名）に違反が無い', async () => {
        const user = userEvent.setup();
        const api = fakeApi({ recoverParticipation: () => Promise.reject(unauthorized()) });
        renderApp(api, '/join');
        expectNoStructuralA11yViolations();
        await user.click(screen.getByRole('button', { name: '復帰する' }));
        await screen.findByRole('alert');
        expectNoStructuralA11yViolations();
    });
});
