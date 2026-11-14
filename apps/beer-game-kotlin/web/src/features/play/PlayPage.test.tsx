import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import type { Role, SessionState } from '../../api/types';
import { GAME_ID, fakeApi, gameState, roleStatus, versions } from '../../testing/fakeApi';
import { renderApp } from '../../testing/render';

type Overrides = Partial<SessionState> & { status?: SessionState['status'] };

function playerState(role: Role, overrides: Overrides = {}): SessionState {
    return {
        sessionId: GAME_ID,
        status: 'ACTIVE',
        week: 3,
        submittedRoleCount: 0,
        participantId: 'p-1',
        role,
        roleStatus: roleStatus({ inventory: 12, backlog: 4, arrivals: 6, orders: 8 }),
        versions: versions(5),
        ...overrides,
    };
}

const PATH = `/games/${GAME_ID}/play`;

describe('S05 プレイ', () => {
    it('第 N 週・役割・3 段階の週の進行・自分の役割の状況を示す', async () => {
        const api = fakeApi({
            getGameState: () =>
                Promise.resolve(gameState({ role: 'WHOLESALER', participantId: 'p-1' })),
            getSessionState: () => Promise.resolve(playerState('WHOLESALER')),
        });
        renderApp(api, PATH);

        expect(await screen.findByRole('heading', { name: 'プレイ' })).toBeInTheDocument();
        expect(screen.getByText(/^第 3 週\s+二次卸$/)).toBeInTheDocument();
        expect(screen.getByText(/2\. 入力/).closest('li')).toHaveAttribute('aria-current', 'step');
        expect(screen.getByText(/1\. 状況を確認/).closest('li')).not.toHaveAttribute(
            'aria-current',
        );
        expect(screen.getByText('在庫').nextSibling).toHaveTextContent('12');
        expect(screen.getByText('受注残').nextSibling).toHaveTextContent('4');
        expect(screen.getByText('入荷').nextSibling).toHaveTextContent('6');
        expect(screen.getByText('受注').nextSibling).toHaveTextContent('8');
        expect(screen.getByLabelText('発注数')).toBeInTheDocument();
        expect(screen.queryByText('顧客需要')).not.toBeInTheDocument();
    });

    it('工場の入力欄は「生産要請数」と呼ぶ', async () => {
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'FACTORY' })),
            getSessionState: () => Promise.resolve(playerState('FACTORY')),
        });
        renderApp(api, PATH);
        expect(await screen.findByLabelText('生産要請数')).toBeInTheDocument();
        expect(screen.queryByLabelText('発注数')).not.toBeInTheDocument();
    });

    it('小売店だけに、当週の顧客需要を示す', async () => {
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
            getSessionState: () =>
                Promise.resolve(
                    playerState('RETAILER', {
                        roleStatus: roleStatus({ customerDemand: 8, orders: 8 }),
                    }),
                ),
        });
        renderApp(api, PATH);
        expect((await screen.findByText('顧客需要')).nextSibling).toHaveTextContent('8');
    });

    it('保存すると、意思決定の版を添えて送り、応答ではなく取得し直した状態から「現在の入力」を表示する', async () => {
        const user = userEvent.setup();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let saved = false;
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
            getSessionState: () =>
                Promise.resolve(
                    playerState('RETAILER', {
                        roleStatus: roleStatus({
                            decision: saved ? 10 : null,
                            decisionVersion: saved ? 1 : 0,
                        }),
                        versions: versions(saved ? 6 : 5),
                    }),
                ),
            saveDecision: async () => {
                await gate;
                saved = true;
                return { versions: versions(6) };
            },
        });
        renderApp(api, PATH);
        await user.type(await screen.findByLabelText('発注数'), '10');
        await user.click(screen.getByRole('button', { name: '発注を保存' }));

        // 保存の応答の前は、サーバーの結果を待ち、画面の値を書き換えない（楽観的な表示をしない）
        expect(screen.getByText('現在の入力: 未入力')).toBeInTheDocument();
        release();
        expect(await screen.findByText('現在の入力: 10')).toBeInTheDocument();
        // 保存した後は、進行役の確定を待つ段階になる
        expect(screen.getByText(/3\. 確定待ち/).closest('li')).toHaveAttribute(
            'aria-current',
            'step',
        );
        expect(api.saveDecision).toHaveBeenCalledWith(GAME_ID, { week: 3, quantity: 10 }, 0);
    });

    it('スナップショットが応答の versions に追いつくまで再取得し、追いつかなければ手動更新を促す', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
            getSessionState: () =>
                Promise.resolve(playerState('RETAILER', { versions: versions(5) })),
            saveDecision: () => Promise.resolve({ versions: versions(6) }),
        });
        renderApp(api, PATH);
        await user.type(await screen.findByLabelText('発注数'), '10');
        await user.click(screen.getByRole('button', { name: '発注を保存' }));

        const status = await screen.findByText(
            '保存は完了しています。更新に時間がかかっています。「手動更新」を押してください。',
        );
        expect(status.closest('[aria-live]')).toHaveAttribute('aria-live', 'polite');
        // 初回の取得（1）＋追いつきの再取得（上限 3）
        expect(api.getSessionState.mock.calls.length).toBeGreaterThanOrEqual(1 + 3);
    });

    it.each([['abc'], ['1.5'], ['-1'], ['']])(
        '整数でない入力（%j）は、送らずに、入力欄の誤りとして示し、入力を保持する',
        async (typed) => {
            const user = userEvent.setup();
            const api = fakeApi({
                getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
                getSessionState: () => Promise.resolve(playerState('RETAILER')),
            });
            renderApp(api, PATH);
            const input = await screen.findByLabelText('発注数');
            if (typed !== '') await user.type(input, typed);
            await user.click(screen.getByRole('button', { name: '発注を保存' }));
            expect(
                await screen.findByText('発注数は 0〜1000 の整数で入力してください。'),
            ).toBeInTheDocument();
            expect(input).toHaveAttribute('aria-invalid', 'true');
            expect(input).toHaveValue(typed);
            expect(api.saveDecision).not.toHaveBeenCalled();
        },
    );

    it('範囲外（サーバーの 422）は、工場なら「生産要請数」の文言で示し、入力を保持する', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'FACTORY' })),
            getSessionState: () => Promise.resolve(playerState('FACTORY')),
            saveDecision: () =>
                Promise.reject(
                    new ApiError(422, {
                        type: '/problems/validation.invalid_input',
                        code: 'validation.invalid_input',
                        errors: [{ field: 'quantity', message: '数量は範囲外です。' }],
                    }),
                ),
        });
        renderApp(api, PATH);
        const input = await screen.findByLabelText('生産要請数');
        await user.type(input, '1001');
        await user.click(screen.getByRole('button', { name: '発注を保存' }));
        expect(
            await screen.findByText('生産要請数は 0〜1000 の整数で入力してください。'),
        ).toBeInTheDocument();
        expect(input).toHaveValue('1001');
    });

    it('保存の前に週が確定されていたら、週が進んだ旨を示し、入力欄を空にして、直前の値を参考に示す', async () => {
        const user = userEvent.setup();
        let advanced = false;
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
            getSessionState: () =>
                Promise.resolve(
                    playerState('RETAILER', {
                        week: advanced ? 4 : 3,
                        versions: versions(advanced ? 8 : 5),
                    }),
                ),
            saveDecision: () => {
                advanced = true;
                return Promise.reject(
                    new ApiError(409, {
                        type: '/problems/session.week_advanced',
                        code: 'session.week_advanced',
                    }),
                );
            },
        });
        renderApp(api, PATH);
        const input = await screen.findByLabelText('発注数');
        await user.type(input, '10');
        await user.click(screen.getByRole('button', { name: '発注を保存' }));

        expect(await screen.findByText('第 3 週はすでに確定されています。')).toBeInTheDocument();
        expect(screen.getByText('第 3 週に入力していた値: 10（未保存）')).toBeInTheDocument();
        expect(screen.getByText(/^第 4 週\s+小売店$/)).toBeInTheDocument();
        expect(screen.getByLabelText('発注数')).toHaveValue('');
        // フォーカスを移して伝える通知は、role="alert" を併用しない
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('手動更新で週が変わったときは、打ちかけの値を空にして参考に示す。同じ週なら保持する', async () => {
        const user = userEvent.setup();
        let week = 3;
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
            getSessionState: () => Promise.resolve(playerState('RETAILER', { week })),
        });
        renderApp(api, PATH);
        const input = await screen.findByLabelText('発注数');
        await user.type(input, '7');

        await user.click(screen.getByRole('button', { name: '手動更新' }));
        await waitFor(() => expect(api.getSessionState).toHaveBeenCalledTimes(2));
        expect(screen.getByLabelText('発注数')).toHaveValue('7');

        week = 4;
        await user.click(screen.getByRole('button', { name: '手動更新' }));
        expect(await screen.findByText('第 3 週に入力していた値: 7（未保存）')).toBeInTheDocument();
        expect(screen.getByLabelText('発注数')).toHaveValue('');
    });

    it('開始前は、開始を待つ旨を示し、手動更新で開始後の画面に切り替わる', async () => {
        const user = userEvent.setup();
        let started = false;
        const api = fakeApi({
            getGameState: () =>
                Promise.resolve(
                    started
                        ? gameState({ role: 'RETAILER' })
                        : gameState({
                              status: 'PREPARING',
                              sessionId: null,
                              role: 'RETAILER',
                              versions: versions(null, 3),
                          }),
                ),
            getSessionState: () => Promise.resolve(playerState('RETAILER')),
        });
        renderApp(api, PATH);
        expect(await screen.findByText('進行役が開始するまでお待ちください。')).toBeInTheDocument();
        expect(api.getSessionState).not.toHaveBeenCalled();

        started = true;
        await user.click(screen.getByRole('button', { name: '手動更新' }));
        expect(await screen.findByLabelText('発注数')).toBeInTheDocument();
    });

    it('終了後は、入力できない旨を示し、保存のボタンを出さない', async () => {
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER', status: 'ENDED' })),
            getSessionState: () => Promise.resolve(playerState('RETAILER', { status: 'ENDED' })),
        });
        renderApp(api, PATH);
        expect(await screen.findByText('終了しました。入力できません。')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: '発注を保存' })).not.toBeInTheDocument();
    });

    it('権限が無ければ（無効な資格）、権限の文言と参加の画面への導線を示す', async () => {
        const api = fakeApi({
            getGameState: () =>
                Promise.reject(
                    new ApiError(403, {
                        type: '/problems/app.unauthorized',
                        code: 'app.unauthorized',
                    }),
                ),
        });
        renderApp(api, PATH);
        expect(await screen.findByText('この画面を開く権限がありません。')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: '参加の画面へ' })).toHaveAttribute('href', '/join');
    });

    it('取得の失敗は、区分と相関 ID を role="alert" で示す', async () => {
        const api = fakeApi({
            getGameState: () =>
                Promise.reject(
                    new ApiError(500, {
                        type: '/problems/app.internal',
                        code: 'app.internal',
                        correlationId: 'corr-5',
                    }),
                ),
        });
        renderApp(api, PATH);
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('corr-5');
    });
});
