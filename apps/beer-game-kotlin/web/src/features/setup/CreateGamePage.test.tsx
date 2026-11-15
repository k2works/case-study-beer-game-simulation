import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import { GAME_ID, fakeApi, gameState, versions } from '../../testing/fakeApi';
import { renderApp } from '../../testing/render';

const created = {
    gameId: GAME_ID,
    versions: versions(null, 1),
    recoveryCode: 'RC-FACILITATOR-1',
};

describe('S02 ゲーム作成', () => {
    it('作成の応答の復帰コードを、一度だけ示し、控える促しと、再表示しない旨を添える', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            createGame: () => Promise.resolve(created),
            getGameState: () =>
                Promise.resolve(
                    gameState({
                        status: 'PREPARING',
                        sessionId: null,
                        joinCode: 'A1B2C3D4',
                        versions: versions(null, 1),
                    }),
                ),
        });
        renderApp(api, '/new');
        await user.click(screen.getByRole('button', { name: 'ゲームを作成' }));

        const region = await screen.findByRole('region', { name: '復帰コード' });
        expect(region).toHaveTextContent('RC-FACILITATOR-1');
        expect(region).toHaveTextContent('この画面でだけ表示します。控えてください。');
        expect(region).toHaveTextContent(
            '端末を替えたときなどに、ゲーム ID と復帰コードで、進行役のコンソールへ戻れます。',
        );
        expect(region).toHaveTextContent(`ゲーム ID: ${GAME_ID}`);
    });

    it('キット準拠の入力でゲームを作成し、参加コードを大きく表示して、ロビーへの導線を出す', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            createGame: () => Promise.resolve(created),
            getGameState: () =>
                Promise.resolve(
                    gameState({
                        status: 'PREPARING',
                        sessionId: null,
                        joinCode: 'A1B2C3D4',
                        versions: versions(null, 1),
                    }),
                ),
        });
        renderApp(api, '/new');

        expect(screen.getByRole('heading', { name: 'ゲームを作成' })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'ゲームを作成' }));

        expect(await screen.findByText('A1B2C3D4')).toBeInTheDocument();
        expect(api.createGame).toHaveBeenCalledWith({
            kind: 'KIT',
            finalWeek: 12,
            demand: [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4],
            retentionDays: 90,
        });
        expect(api.getGameState).toHaveBeenCalledWith(GAME_ID);
        expect(screen.getByRole('link', { name: 'ロビーへ' })).toHaveAttribute(
            'href',
            `/games/${GAME_ID}/lobby`,
        );
    });

    it('作成の応答（versions だけ）からは表示を作らず、取得し直した状態の参加コードを表示する', async () => {
        const user = userEvent.setup();
        const order: string[] = [];
        const api = fakeApi({
            createGame: () => {
                order.push('create');
                return Promise.resolve(created);
            },
            getGameState: () => {
                order.push('state');
                return Promise.resolve(
                    gameState({
                        status: 'PREPARING',
                        sessionId: null,
                        joinCode: 'ZZZZ9999',
                        versions: versions(null, 1),
                    }),
                );
            },
        });
        renderApp(api, '/new');
        await user.click(screen.getByRole('button', { name: 'ゲームを作成' }));
        expect(await screen.findByText('ZZZZ9999')).toBeInTheDocument();
        expect(order).toEqual(['create', 'state']);
    });

    it('入力を変えて送ると、その値で作成する（最終週と需要系列）', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            createGame: () => Promise.resolve(created),
            getGameState: () =>
                Promise.resolve(
                    gameState({
                        status: 'PREPARING',
                        sessionId: null,
                        joinCode: 'AAAA',
                        versions: versions(null, 1),
                    }),
                ),
        });
        renderApp(api, '/new');
        const finalWeek = screen.getByLabelText('最終週');
        await user.clear(finalWeek);
        await user.type(finalWeek, '3');
        const demand = screen.getByLabelText('需要系列');
        await user.clear(demand);
        await user.type(demand, '4, 8, 12');
        await user.click(screen.getByRole('button', { name: 'ゲームを作成' }));
        await screen.findByText('AAAA');
        expect(api.createGame).toHaveBeenCalledWith({
            kind: 'KIT',
            finalWeek: 3,
            demand: [4, 8, 12],
            retentionDays: 90,
        });
    });

    it('検証の誤りは、すべて要約に示し、入力を保持して、要約へフォーカスを移す', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            createGame: () =>
                Promise.reject(
                    new ApiError(422, {
                        type: '/problems/validation.invalid_input',
                        code: 'validation.invalid_input',
                        correlationId: 'c-1',
                        errors: [
                            {
                                field: 'demand',
                                week: 5,
                                message: '需要は 0 以上 1000 以下の整数にしてください。',
                            },
                            {
                                field: 'finalWeek',
                                message: '最終週は 1〜50 の整数にしてください。',
                            },
                        ],
                    }),
                ),
        });
        renderApp(api, '/new');
        const demand = screen.getByLabelText('需要系列');
        await user.clear(demand);
        await user.type(demand, '4, 4, 4, 4, 1001');
        await user.click(screen.getByRole('button', { name: 'ゲームを作成' }));

        const summary = await screen.findByRole('heading', { name: '入力に誤りがあります' });
        const region = summary.closest('section');
        expect(region).not.toBeNull();
        expect(region).toHaveTextContent('第 5 週: 需要は 0 以上 1000 以下の整数にしてください。');
        expect(region).toHaveTextContent('最終週は 1〜50 の整数にしてください。');
        expect(region).not.toHaveAttribute('role', 'alert');
        await waitFor(() => expect(region).toHaveFocus());

        expect(screen.getByLabelText('需要系列')).toHaveValue('4, 4, 4, 4, 1001');
        expect(screen.getByLabelText('需要系列')).toHaveAttribute('aria-invalid', 'true');
        expect(screen.getByLabelText('最終週')).toHaveAttribute('aria-invalid', 'true');
        expect(screen.queryByText('A1B2C3D4')).not.toBeInTheDocument();
    });

    it('サーバーの失敗は、区分の文言と相関 ID を role="alert" で示し、入力を保持する', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            createGame: () =>
                Promise.reject(
                    new ApiError(500, {
                        type: '/problems/app.internal',
                        code: 'app.internal',
                        correlationId: 'corr-77',
                    }),
                ),
        });
        renderApp(api, '/new');
        await user.click(screen.getByRole('button', { name: 'ゲームを作成' }));
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(
            '問題が発生しました。時間をおいて、もう一度お試しください。',
        );
        expect(alert).toHaveTextContent('corr-77');
        expect(screen.getByLabelText('最終週')).toHaveValue('12');
    });
});
