import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import type { Role, RoleStatus, RoleWeekResult, SessionState } from '../../api/types';
import { expectNoStructuralA11yViolations } from '../../testing/a11y';
import { GAME_ID, fakeApi, gameState, roleStatus, versions } from '../../testing/fakeApi';
import { renderApp } from '../../testing/render';

const PATH = `/games/${GAME_ID}/console`;

function decisions(values: Partial<Record<Role, number | null>>, version = 1) {
    const roles: Partial<Record<Role, RoleStatus>> = {};
    for (const role of ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'] as const) {
        const decision = values[role] ?? null;
        roles[role] = roleStatus({ decision, decisionVersion: decision === null ? 0 : version });
    }
    return roles;
}

function consoleState(overrides: Partial<SessionState> = {}): SessionState {
    return {
        sessionId: GAME_ID,
        status: 'ACTIVE',
        week: 1,
        submittedRoleCount: 4,
        finalWeek: 12,
        roles: decisions({ RETAILER: 4, WHOLESALER: 5, DISTRIBUTOR: 6, FACTORY: 7 }),
        results: [],
        versions: versions(5, 10),
        ...overrides,
    };
}

function resultOf(role: Role, week: number, extra: Partial<RoleWeekResult> = {}): RoleWeekResult {
    return {
        role,
        week,
        orders: 4,
        order: 4,
        inventory: 12,
        backlog: 0,
        shipment: 4,
        cost: 600,
        cumulativeCost: 600,
        ...extra,
    };
}

const ROLE_LABELS: Array<[Role, string]> = [
    ['RETAILER', '小売店'],
    ['WHOLESALER', '二次卸'],
    ['DISTRIBUTOR', '一次卸'],
    ['FACTORY', '工場'],
];

describe('S06 進行役のコンソール（開発用: 代理入力）', () => {
    it('未入力の役割だけを、現在の週で代理入力し、状態を取り直して週を確定できるようにする', async () => {
        const user = userEvent.setup();
        let roles = decisions({ RETAILER: 4 });
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ finalWeek: 12 })),
            getSessionState: () =>
                Promise.resolve(consoleState({ week: 3, roles, versions: versions(6, 10) })),
            submitProxyDecision: (_sessionId, role, request) => {
                roles = { ...roles, [role]: roleStatus({ decision: request.quantity }) };
                return Promise.resolve({ versions: versions(6, 10) });
            },
        });
        renderApp(api, PATH);

        await user.click(
            await screen.findByRole('button', { name: /ダミーの役割を代理入力で埋める/ }),
        );

        await waitFor(() => expect(api.submitProxyDecision).toHaveBeenCalledTimes(3));
        expect(api.submitProxyDecision).toHaveBeenCalledWith(GAME_ID, 'WHOLESALER', {
            requestedWeek: 3,
            quantity: 4,
        });
        expect(api.submitProxyDecision).not.toHaveBeenCalledWith(
            GAME_ID,
            'RETAILER',
            expect.anything(),
        );
        expect(await screen.findByRole('button', { name: '週を確定' })).toBeEnabled();
    });

    it('全役割が入力済みなら、代理入力のボタンを出さない', async () => {
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ finalWeek: 12 })),
            getSessionState: () => Promise.resolve(consoleState()),
        });
        renderApp(api, PATH);
        await screen.findByRole('button', { name: '週を確定' });
        expect(screen.queryByRole('button', { name: /代理入力/ })).not.toBeInTheDocument();
    });
});

describe('S06 進行役のコンソール: 保持状態への導線（B11）', () => {
    it('「保持状態を見る」から、保持状態（S09）へ進める', async () => {
        renderApp(
            fakeApi({
                getGameState: () => Promise.resolve(gameState({ finalWeek: 12 })),
                getSessionState: () => Promise.resolve(consoleState()),
            }),
            PATH,
        );

        const link = await screen.findByRole('link', { name: '保持状態を見る' });
        expect(link).toHaveAttribute('href', `/games/${GAME_ID}/retention`);
    });
});

describe('S06 進行役のコンソール', () => {
    it('第 N 週・状態・各役割の入力状況（入力値つき）を示す', async () => {
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ finalWeek: 12 })),
            getSessionState: () =>
                Promise.resolve(
                    consoleState({
                        submittedRoleCount: 3,
                        roles: decisions({ RETAILER: 4, WHOLESALER: 5, FACTORY: 7 }),
                    }),
                ),
        });
        renderApp(api, PATH);

        expect(
            await screen.findByRole('heading', { name: '進行役のコンソール' }),
        ).toBeInTheDocument();
        expect(screen.getByText(/^第 1 週\s+進行中$/)).toBeInTheDocument();
        expect(
            within(screen.getByRole('listitem', { name: '小売店' })).getByText('入力済み: 4'),
        ).toBeInTheDocument();
        expect(
            within(screen.getByRole('listitem', { name: '一次卸' })).getByText('未入力'),
        ).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '週を確定' })).toBeDisabled();
        expect(screen.getByText('4 役割の入力が揃うと、週を確定できます。')).toBeInTheDocument();
    });

    it('4 役割がそろっていれば「週を確定」を押せ、確認ダイアログに各役割の値と影響を示す', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState()),
            getSessionState: () => Promise.resolve(consoleState()),
        });
        renderApp(api, PATH);
        await user.click(await screen.findByRole('button', { name: '週を確定' }));

        const dialog = await screen.findByRole('dialog', { name: '第 1 週を確定' });
        expect(dialog).toHaveTextContent('4 役割の入力が揃いました。確定後は編集できません。');
        for (const [label, value] of [
            ['小売店', '4'],
            ['二次卸', '5'],
            ['一次卸', '6'],
            ['工場', '7'],
        ] as const) {
            expect(within(dialog).getByText(`${label}: ${value}`)).toBeInTheDocument();
        }
        expect(dialog).toHaveTextContent(
            '次に起きること: 遅延を進め、出荷・在庫・受注残・費用を計算して保存します。',
        );
        await user.click(within(dialog).getByRole('button', { name: '戻って確認' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(api.commitWeek).not.toHaveBeenCalled();
    });

    it('確定すると、確認時の週と入力の版（basis）を送り、取得し直した状態の第 2 週と各役割の第 1 週の結果を示す', async () => {
        const user = userEvent.setup();
        let committed = false;
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState()),
            getSessionState: () =>
                Promise.resolve(
                    committed
                        ? consoleState({
                              week: 2,
                              submittedRoleCount: 0,
                              roles: decisions({}),
                              results: ROLE_LABELS.map(([role]) => resultOf(role, 1)),
                              versions: versions(6, 10),
                          })
                        : consoleState({
                              roles: decisions(
                                  { RETAILER: 4, WHOLESALER: 5, DISTRIBUTOR: 6, FACTORY: 7 },
                                  3,
                              ),
                          }),
                ),
            commitWeek: () => {
                committed = true;
                return Promise.resolve({ versions: versions(6) });
            },
        });
        renderApp(api, PATH);
        await user.click(await screen.findByRole('button', { name: '週を確定' }));
        await user.click(
            within(await screen.findByRole('dialog')).getByRole('button', {
                name: '第 1 週を確定',
            }),
        );

        expect(await screen.findByText(/^第 2 週\s+進行中$/)).toBeInTheDocument();
        expect(api.commitWeek).toHaveBeenCalledWith(GAME_ID, {
            requestedWeek: 1,
            basis: { RETAILER: 3, WHOLESALER: 3, DISTRIBUTOR: 3, FACTORY: 3 },
        });
        const results = screen.getByRole('region', { name: '確定した週の結果' });
        for (const [, label] of ROLE_LABELS) {
            expect(
                within(results).getByText(new RegExp(`^${label} 第 1 週の結果:`)),
            ).toBeInTheDocument();
        }
        expect(
            within(results).getByText(
                /^小売店 第 1 週の結果: 受注 4、発注 4、在庫 12、受注残 0、出荷 4、費用 600（累計 600）$/,
            ),
        ).toBeInTheDocument();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('確定の前に入力が変わったときは、更新した値で確認ダイアログを開き直し、通知の見出しへフォーカスを移して、もう一度確定できる', async () => {
        const user = userEvent.setup();
        let changed = false;
        let committed = false;
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState()),
            getSessionState: () =>
                Promise.resolve(
                    committed
                        ? consoleState({ week: 2, roles: decisions({}), versions: versions(8, 10) })
                        : consoleState({
                              roles: changed
                                  ? decisions(
                                        { RETAILER: 10, WHOLESALER: 5, DISTRIBUTOR: 6, FACTORY: 7 },
                                        2,
                                    )
                                  : decisions(
                                        { RETAILER: 4, WHOLESALER: 5, DISTRIBUTOR: 6, FACTORY: 7 },
                                        1,
                                    ),
                              versions: versions(changed ? 7 : 5, 10),
                          }),
                ),
            commitWeek: () => {
                if (!changed) {
                    changed = true;
                    return Promise.reject(
                        new ApiError(409, {
                            type: '/problems/session.decisions_changed',
                            code: 'session.decisions_changed',
                            correlationId: 'c-3',
                        }),
                    );
                }
                committed = true;
                return Promise.resolve({ versions: versions(8) });
            },
        });
        renderApp(api, PATH);
        await user.click(await screen.findByRole('button', { name: '週を確定' }));
        await user.click(
            within(await screen.findByRole('dialog')).getByRole('button', {
                name: '第 1 週を確定',
            }),
        );

        const heading = await screen.findByRole('heading', {
            name: '確定の前に入力が変わりました。最新の値を確認してください。',
        });
        const dialog = screen.getByRole('dialog');
        expect(dialog).toContainElement(heading);
        await waitFor(() => expect(heading).toHaveFocus());
        expect(within(dialog).getByText('小売店: 10')).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();

        await user.click(within(dialog).getByRole('button', { name: '第 1 週を確定' }));
        expect(await screen.findByText(/^第 2 週\s+進行中$/)).toBeInTheDocument();
        expect(api.commitWeek).toHaveBeenCalledTimes(2);
        // 開き直したダイアログは、更新した値の basis を覚えて、改めて確定を送る
        expect(api.commitWeek).toHaveBeenLastCalledWith(GAME_ID, {
            requestedWeek: 1,
            basis: { RETAILER: 2, WHOLESALER: 2, DISTRIBUTOR: 2, FACTORY: 2 },
        });
    });

    it('確定の前に週が進んでいたときは、ダイアログを閉じ、週が進んだ旨と最新の状況を示す（入力が変わった旨とは混ぜない）', async () => {
        const user = userEvent.setup();
        let advanced = false;
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState()),
            getSessionState: () =>
                Promise.resolve(
                    advanced
                        ? consoleState({ week: 2, roles: decisions({}), versions: versions(7, 10) })
                        : consoleState(),
                ),
            commitWeek: () => {
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
        await user.click(await screen.findByRole('button', { name: '週を確定' }));
        await user.click(
            within(await screen.findByRole('dialog')).getByRole('button', {
                name: '第 1 週を確定',
            }),
        );

        expect(await screen.findByText('第 1 週はすでに確定されています。')).toBeInTheDocument();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.queryByText(/確定の前に入力が変わりました/)).not.toBeInTheDocument();
        expect(await screen.findByText(/^第 2 週\s+進行中$/)).toBeInTheDocument();
    });

    it('それ以外の失敗は、区分と相関 ID と再操作の案内を role="alert" で示し、ダイアログを閉じる', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState()),
            getSessionState: () => Promise.resolve(consoleState()),
            commitWeek: () =>
                Promise.reject(
                    new ApiError(500, {
                        type: '/problems/app.internal',
                        code: 'app.internal',
                        correlationId: 'corr-42',
                    }),
                ),
        });
        renderApp(api, PATH);
        await user.click(await screen.findByRole('button', { name: '週を確定' }));
        await user.click(
            within(await screen.findByRole('dialog')).getByRole('button', {
                name: '第 1 週を確定',
            }),
        );

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('corr-42');
        expect(alert).toHaveTextContent('最新状態を確認して、再度操作してください。');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('確定中は、確定のボタンを無効にして「確定中」と示す（二重の操作を防ぐ）', async () => {
        const user = userEvent.setup();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState()),
            getSessionState: () => Promise.resolve(consoleState()),
            commitWeek: async () => {
                await gate;
                return { versions: versions(5) };
            },
        });
        renderApp(api, PATH);
        await user.click(await screen.findByRole('button', { name: '週を確定' }));
        await user.click(
            within(await screen.findByRole('dialog')).getByRole('button', {
                name: '第 1 週を確定',
            }),
        );
        expect(await screen.findByRole('button', { name: '確定中' })).toBeDisabled();
        release();
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('終了したゲームは、終了を示し、「週を確定」を出さない', async () => {
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ status: 'ENDED' })),
            getSessionState: () => Promise.resolve(consoleState({ status: 'ENDED', week: 12 })),
        });
        renderApp(api, PATH);
        expect(await screen.findByText(/^第 12 週\s+終了$/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: '週を確定' })).not.toBeInTheDocument();
    });

    it('権限が無ければ、権限の文言と参加の画面への導線を示す', async () => {
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
        // 復帰できるように、いまのゲームの ID を導線に持たせる
        expect(screen.getByRole('link', { name: '参加・復帰の画面へ' })).toHaveAttribute(
            'href',
            `/join?gameId=${GAME_ID}`,
        );
    });

    describe('停止・再開', () => {
        it('進行中は「停止する」を示し、押すと、対象と影響を示す確認ダイアログを開く（送らない）', async () => {
            const user = userEvent.setup();
            const api = fakeApi({
                getGameState: () => Promise.resolve(gameState()),
                getSessionState: () => Promise.resolve(consoleState()),
            });
            renderApp(api, PATH);
            await user.click(await screen.findByRole('button', { name: '停止する' }));

            const dialog = await screen.findByRole('dialog', { name: '第 1 週を一時停止' });
            expect(dialog).toHaveTextContent(
                '停止すると、参加者は入力できなくなり、週を確定できなくなります。再開するまで、第 1 週のままです。',
            );
            expect(dialog).toHaveTextContent('入力済みの値は、失われません。');
            expect(api.pauseSession).not.toHaveBeenCalled();
            expect(screen.queryByRole('button', { name: '再開する' })).not.toBeInTheDocument();
            await user.click(within(dialog).getByRole('button', { name: '戻る' }));
            expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
            expect(api.pauseSession).not.toHaveBeenCalled();
        });

        it('停止を確定すると、取得し直した状態から「停止中」を示し、「再開する」に切り替わり、週の確定を出さない', async () => {
            const user = userEvent.setup();
            let paused = false;
            const api = fakeApi({
                getGameState: () => Promise.resolve(gameState()),
                getSessionState: () =>
                    Promise.resolve(
                        paused
                            ? consoleState({ status: 'PAUSED', versions: versions(6, 10) })
                            : consoleState(),
                    ),
                pauseSession: () => {
                    paused = true;
                    return Promise.resolve({ versions: versions(6) });
                },
            });
            renderApp(api, PATH);
            await user.click(await screen.findByRole('button', { name: '停止する' }));
            await user.click(
                within(await screen.findByRole('dialog')).getByRole('button', {
                    name: '一時停止する',
                }),
            );

            expect(await screen.findByText(/^第 1 週\s+停止中$/)).toBeInTheDocument();
            expect(api.pauseSession).toHaveBeenCalledWith(GAME_ID);
            expect(screen.getByRole('button', { name: '再開する' })).toBeInTheDocument();
            expect(screen.queryByRole('button', { name: '停止する' })).not.toBeInTheDocument();
            expect(screen.queryByRole('button', { name: '週を確定' })).not.toBeInTheDocument();
            expect(
                screen.getByText('停止中です。再開するまで、週を確定できません。'),
            ).toBeVisible();
            // 停止中でも、各役割の入力状況（進行役だけが見られる値）は見える
            expect(
                within(screen.getByRole('listitem', { name: '小売店' })).getByText('入力済み: 4'),
            ).toBeInTheDocument();
            expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        });

        it('停止中は「再開する」を示し、確認ダイアログを経て再開すると、「進行中」に戻り、「週を確定」が戻る', async () => {
            const user = userEvent.setup();
            let paused = true;
            const api = fakeApi({
                getGameState: () => Promise.resolve(gameState()),
                getSessionState: () =>
                    Promise.resolve(
                        paused
                            ? consoleState({ status: 'PAUSED', versions: versions(6, 10) })
                            : consoleState({ versions: versions(7, 10) }),
                    ),
                resumeSession: () => {
                    paused = false;
                    return Promise.resolve({ versions: versions(7) });
                },
            });
            renderApp(api, PATH);
            await user.click(await screen.findByRole('button', { name: '再開する' }));
            const dialog = await screen.findByRole('dialog', { name: '第 1 週を再開' });
            expect(dialog).toHaveTextContent('再開すると、参加者は第 1 週の入力を再開できます。');
            await user.click(within(dialog).getByRole('button', { name: '再開する' }));

            expect(await screen.findByText(/^第 1 週\s+進行中$/)).toBeInTheDocument();
            expect(api.resumeSession).toHaveBeenCalledWith(GAME_ID);
            expect(screen.getByRole('button', { name: '週を確定' })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: '停止する' })).toBeInTheDocument();
        });

        it('停止の操作の確定中は、ボタンを無効にし「停止中」でなく「確定中」と示す（二重の送信をしない）', async () => {
            const user = userEvent.setup();
            let release: () => void = () => undefined;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const api = fakeApi({
                getGameState: () => Promise.resolve(gameState()),
                getSessionState: () => Promise.resolve(consoleState()),
                pauseSession: async () => {
                    await gate;
                    return { versions: versions(5) };
                },
            });
            renderApp(api, PATH);
            await user.click(await screen.findByRole('button', { name: '停止する' }));
            await user.click(
                within(await screen.findByRole('dialog')).getByRole('button', {
                    name: '一時停止する',
                }),
            );
            expect(await screen.findByRole('button', { name: '確定中' })).toBeDisabled();
            release();
            await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        });

        it('すでに停止されていた（session.paused）ときは、その文言を示し、最新の状態（停止中）に切り替える', async () => {
            const user = userEvent.setup();
            let paused = false;
            const api = fakeApi({
                getGameState: () => Promise.resolve(gameState()),
                getSessionState: () =>
                    Promise.resolve(
                        paused
                            ? consoleState({ status: 'PAUSED', versions: versions(6, 10) })
                            : consoleState(),
                    ),
                pauseSession: () => {
                    paused = true;
                    return Promise.reject(
                        new ApiError(409, {
                            type: '/problems/session.paused',
                            code: 'session.paused',
                            correlationId: 'c-pp',
                        }),
                    );
                },
            });
            renderApp(api, PATH);
            await user.click(await screen.findByRole('button', { name: '停止する' }));
            await user.click(
                within(await screen.findByRole('dialog')).getByRole('button', {
                    name: '一時停止する',
                }),
            );
            expect(await screen.findByRole('alert')).toHaveTextContent(
                '停止中です。進行役の再開を待ってください。',
            );
            expect(await screen.findByText(/^第 1 週\s+停止中$/)).toBeInTheDocument();
            expect(screen.getByRole('button', { name: '再開する' })).toBeInTheDocument();
        });

        it('停止中でなかった（session.not_paused）ときは、その文言を示し、最新の状態（進行中）に切り替える', async () => {
            const user = userEvent.setup();
            let paused = true;
            const api = fakeApi({
                getGameState: () => Promise.resolve(gameState()),
                getSessionState: () =>
                    Promise.resolve(
                        paused
                            ? consoleState({ status: 'PAUSED' })
                            : consoleState({ versions: versions(7, 10) }),
                    ),
                resumeSession: () => {
                    paused = false;
                    return Promise.reject(
                        new ApiError(409, {
                            type: '/problems/session.not_paused',
                            code: 'session.not_paused',
                        }),
                    );
                },
            });
            renderApp(api, PATH);
            await user.click(await screen.findByRole('button', { name: '再開する' }));
            await user.click(
                within(await screen.findByRole('dialog')).getByRole('button', {
                    name: '再開する',
                }),
            );
            expect(await screen.findByRole('alert')).toHaveTextContent('停止中ではありません。');
            expect(await screen.findByText(/^第 1 週\s+進行中$/)).toBeInTheDocument();
        });

        it('権限の失敗（403）は、権限の文言と導線を示す', async () => {
            const user = userEvent.setup();
            const api = fakeApi({
                getGameState: () => Promise.resolve(gameState()),
                getSessionState: () => Promise.resolve(consoleState()),
                pauseSession: () =>
                    Promise.reject(
                        new ApiError(403, {
                            type: '/problems/app.unauthorized',
                            code: 'app.unauthorized',
                        }),
                    ),
            });
            renderApp(api, PATH);
            await user.click(await screen.findByRole('button', { name: '停止する' }));
            await user.click(
                within(await screen.findByRole('dialog')).getByRole('button', {
                    name: '一時停止する',
                }),
            );
            expect(await screen.findByRole('alert')).toHaveTextContent(
                'この画面を開く権限がありません。',
            );
        });

        it('開始前（セッションなし）と終了後は、停止・再開の操作を出さない', async () => {
            const api = fakeApi({
                getGameState: () => Promise.resolve(gameState({ status: 'ENDED' })),
                getSessionState: () => Promise.resolve(consoleState({ status: 'ENDED', week: 12 })),
            });
            renderApp(api, PATH);
            await screen.findByText(/^第 12 週\s+終了$/);
            expect(screen.queryByRole('button', { name: '停止する' })).not.toBeInTheDocument();
            expect(screen.queryByRole('button', { name: '再開する' })).not.toBeInTheDocument();
        });

        it('構造のアクセシビリティ（名前・参照先・見出し・題名・ダイアログ）に違反が無い（進行中・停止中・ダイアログ）', async () => {
            const user = userEvent.setup();
            const api = fakeApi({
                getGameState: () => Promise.resolve(gameState()),
                getSessionState: () => Promise.resolve(consoleState({ status: 'PAUSED' })),
            });
            renderApp(api, PATH);
            await user.click(await screen.findByRole('button', { name: '再開する' }));
            await screen.findByRole('dialog');
            expectNoStructuralA11yViolations();
        });
    });
});

describe('S06 進行役のコンソール（確定方式）', () => {
    it('確定方式を示し、切り替えると setCommitMode を呼んで、状態を取り直す', async () => {
        const user = userEvent.setup();
        let mode: 'MANUAL' | 'AUTO' = 'MANUAL';
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ commitMode: mode })),
            getSessionState: () => Promise.resolve(consoleState({ versions: versions(6, 10) })),
            setCommitMode: (_sessionId, next) => {
                mode = next;
                return Promise.resolve({ versions: versions(6, 10) });
            },
        });
        renderApp(api, PATH);

        expect(await screen.findByText('自動確定: 無効')).toBeVisible();
        await user.click(screen.getByRole('button', { name: '自動確定を有効にする' }));

        expect(await screen.findByText('自動確定: 有効')).toBeVisible();
        expect(api.setCommitMode).toHaveBeenCalledWith(GAME_ID, 'AUTO');
        expect(screen.getByRole('button', { name: '自動確定を無効にする' })).toBeVisible();
    });

    it('停止中でも、確定方式を変えられる（無効にする。AC2.4.5）', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ commitMode: 'AUTO' })),
            getSessionState: () => Promise.resolve(consoleState({ status: 'PAUSED' })),
            setCommitMode: () => Promise.resolve({ versions: versions(6, 10) }),
        });
        renderApp(api, PATH);

        await user.click(await screen.findByRole('button', { name: '自動確定を無効にする' }));

        await waitFor(() => expect(api.setCommitMode).toHaveBeenCalledWith(GAME_ID, 'MANUAL'));
    });
});

describe('S06 進行役のコンソール（終了後）', () => {
    it('終了後は、振り返りへの導線を示す', async () => {
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState()),
            getSessionState: () => Promise.resolve(consoleState({ status: 'ENDED' })),
        });
        renderApp(api, PATH);

        expect(await screen.findByRole('link', { name: '振り返りを見る' })).toHaveAttribute(
            'href',
            `/games/${GAME_ID}/review`,
        );
    });
});
