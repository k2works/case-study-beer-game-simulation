import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LOBBY_POLL_MS } from './LobbyPage';
import { ApiError } from '../../api/errors';
import type { LobbyParticipant } from '../../api/types';
import { GAME_ID, fakeApi, gameState, lobby, roleStatus, versions } from '../../testing/fakeApi';
import { renderApp } from '../../testing/render';

const yamamoto: LobbyParticipant = { participantId: 'p-1', displayName: '山本', role: 'RETAILER' };
const tanaka: LobbyParticipant = { participantId: 'p-2', displayName: '田中', role: null };

function rowOf(name: string) {
    return screen.getByRole('listitem', { name });
}

describe('S04 ロビー（進行役）', () => {
    it('参加コード・状態・各役割の担当・未割り当ての人を示す', async () => {
        const api = fakeApi({
            getLobby: () => Promise.resolve(lobby({ participants: [yamamoto, tanaka] })),
        });
        renderApp(api, `/games/${GAME_ID}/lobby`);

        expect(await screen.findByText('ABCDEFGH2345')).toBeInTheDocument();
        expect(screen.getByText(/状態: 準備中/)).toBeInTheDocument();
        expect(screen.getByText('小売店: 山本')).toBeInTheDocument();
        expect(screen.getByText('二次卸: （未割り当て）')).toBeInTheDocument();
        expect(within(rowOf('田中')).getByText('未割り当て')).toBeInTheDocument();
    });

    it('B7/S04: 設定の種別を示す。キット準拠はそのまま、カスタムは変更した項目の名前を添える', async () => {
        const api = fakeApi({
            getLobby: () =>
                Promise.resolve(
                    lobby({
                        settingsKind: 'CUSTOM',
                        changedSettings: ['INITIAL_INVENTORY', 'SHIPMENT_DELAY'],
                    }),
                ),
        });
        renderApp(api, `/games/${GAME_ID}/lobby`);

        expect(
            await screen.findByText('条件: カスタム（変更: 初期在庫、配送の遅延）'),
        ).toBeInTheDocument();
    });

    it('B7/S04: キット準拠の設定は、「条件: キット準拠」と示す', async () => {
        const api = fakeApi({ getLobby: () => Promise.resolve(lobby()) });
        renderApp(api, `/games/${GAME_ID}/lobby`);

        expect(await screen.findByText('条件: キット準拠')).toBeInTheDocument();
    });

    it('B6/S04: 同じ役割に共同担当（複数人）がいるときは、その役割の行に全員を並べる', async () => {
        const co: LobbyParticipant = {
            participantId: 'p-3',
            displayName: '鈴木',
            role: 'RETAILER',
        };
        const api = fakeApi({
            getLobby: () => Promise.resolve(lobby({ participants: [yamamoto, co] })),
        });
        renderApp(api, `/games/${GAME_ID}/lobby`);

        expect(await screen.findByText('小売店: 山本、鈴木')).toBeInTheDocument();
        expect(screen.getByText('二次卸: （未割り当て）')).toBeInTheDocument();
    });

    it('各役割に 1 人以上が要ることと、不足している役割を示し、開始を押せなくする', async () => {
        const api = fakeApi({
            getLobby: () => Promise.resolve(lobby({ participants: [yamamoto] })),
        });
        renderApp(api, `/games/${GAME_ID}/lobby`);
        expect(
            await screen.findByText('各役割に 1 人以上が必要です。（不足: 二次卸、一次卸、工場）'),
        ).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '開始する' })).toBeDisabled();
    });

    it('未割り当ての人に役割を割り当て、ロビーを取得し直して表示する（応答から表示を作らない）', async () => {
        const user = userEvent.setup();
        let assigned = false;
        const api = fakeApi({
            getLobby: () =>
                Promise.resolve(
                    lobby({
                        participants: [assigned ? { ...tanaka, role: 'WHOLESALER' } : tanaka],
                        versions: versions(null, assigned ? 4 : 3),
                    }),
                ),
            assignRole: () => {
                assigned = true;
                return Promise.resolve({ versions: versions(null, 4) });
            },
        });
        renderApp(api, `/games/${GAME_ID}/lobby`);
        const row = await screen.findByRole('listitem', { name: '田中' });
        await user.selectOptions(within(row).getByLabelText('役割を選ぶ'), '二次卸');
        await user.click(within(row).getByRole('button', { name: '割り当てる' }));

        expect(api.assignRole).toHaveBeenCalledWith(GAME_ID, 'p-2', 'WHOLESALER');
        expect(await screen.findByText('二次卸: 田中')).toBeInTheDocument();
    });

    it('すでに別の役割にいる人を選ぶと、移動元と移動先を示す確認を挟み、確認してから移す', async () => {
        const user = userEvent.setup();
        let moved = false;
        const api = fakeApi({
            getLobby: () =>
                Promise.resolve(
                    lobby({
                        participants: [moved ? { ...yamamoto, role: 'WHOLESALER' } : yamamoto],
                        versions: versions(null, moved ? 4 : 3),
                    }),
                ),
            assignRole: () => {
                moved = true;
                return Promise.resolve({ versions: versions(null, 4) });
            },
        });
        renderApp(api, `/games/${GAME_ID}/lobby`);
        const row = await screen.findByRole('listitem', { name: '山本' });
        await user.selectOptions(within(row).getByLabelText('役割を選ぶ'), '二次卸');
        await user.click(within(row).getByRole('button', { name: '割り当てる' }));

        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent(
            '山本さんは小売店に割り当て済みです。二次卸へ移しますか。',
        );
        expect(api.assignRole).not.toHaveBeenCalled();

        await user.click(within(dialog).getByRole('button', { name: '移す' }));
        expect(api.assignRole).toHaveBeenCalledWith(GAME_ID, 'p-1', 'WHOLESALER');
        expect(await screen.findByText('二次卸: 山本')).toBeInTheDocument();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('移す確認で「戻って確認」を選ぶと、何も変えない', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            getLobby: () => Promise.resolve(lobby({ participants: [yamamoto] })),
        });
        renderApp(api, `/games/${GAME_ID}/lobby`);
        const row = await screen.findByRole('listitem', { name: '山本' });
        await user.selectOptions(within(row).getByLabelText('役割を選ぶ'), '工場');
        await user.click(within(row).getByRole('button', { name: '割り当てる' }));
        await user.click(await screen.findByRole('button', { name: '戻って確認' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(api.assignRole).not.toHaveBeenCalled();
    });

    it('他の人が参加すると、更新しなくても、一定の間隔でロビーを取り直して参加者を示す', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            let participants: LobbyParticipant[] = [yamamoto];
            const api = fakeApi({
                getLobby: () => Promise.resolve(lobby({ participants })),
            });
            renderApp(api, `/games/${GAME_ID}/lobby`);
            expect(await screen.findByRole('listitem', { name: '山本' })).toBeInTheDocument();
            expect(screen.queryByRole('listitem', { name: '田中' })).not.toBeInTheDocument();

            participants = [yamamoto, tanaka];
            await act(() => vi.advanceTimersByTimeAsync(LOBBY_POLL_MS));

            expect(await screen.findByRole('listitem', { name: '田中' })).toBeInTheDocument();
        } finally {
            vi.useRealTimers();
        }
    });

    it('取り直しの失敗では、表示中のロビーを消さない', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            let calls = 0;
            const api = fakeApi({
                getLobby: () =>
                    ++calls === 1
                        ? Promise.resolve(lobby({ participants: [yamamoto] }))
                        : Promise.reject(new Error('通信の失敗')),
            });
            renderApp(api, `/games/${GAME_ID}/lobby`);
            await screen.findByRole('listitem', { name: '山本' });

            await act(() => vi.advanceTimersByTimeAsync(LOBBY_POLL_MS));

            expect(calls).toBeGreaterThan(1);
            expect(screen.getByRole('listitem', { name: '山本' })).toBeInTheDocument();
            expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        } finally {
            vi.useRealTimers();
        }
    });

    it('取り直しで資格がなくなった（403）ときは、黙らず、失敗を示して取り直しをやめる', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            let calls = 0;
            const api = fakeApi({
                getLobby: () =>
                    ++calls === 1
                        ? Promise.resolve(lobby({ participants: [yamamoto] }))
                        : Promise.reject(
                              new ApiError(403, { code: 'app.unauthorized', correlationId: 'c-9' }),
                          ),
            });
            renderApp(api, `/games/${GAME_ID}/lobby`);
            await screen.findByRole('listitem', { name: '山本' });

            await act(() => vi.advanceTimersByTimeAsync(LOBBY_POLL_MS));
            expect(await screen.findByRole('alert')).toHaveTextContent('c-9');

            const seen = calls;
            await act(() => vi.advanceTimersByTimeAsync(LOBBY_POLL_MS * 3));
            expect(calls).toBe(seen);
        } finally {
            vi.useRealTimers();
        }
    });

    it('開発用: 不足する役割のダミー参加者を、進行役の資格を保ったまま作り、割り当てる', async () => {
        const user = userEvent.setup();
        let participants: LobbyParticipant[] = [yamamoto];
        const api = fakeApi({
            getLobby: () => Promise.resolve(lobby({ participants })),
            joinWithoutSession: (request) => {
                participants = [
                    ...participants,
                    {
                        participantId: `d-${participants.length}`,
                        displayName: request.displayName,
                        role: null,
                    },
                ];
                return Promise.resolve({ gameId: GAME_ID, versions: versions(null, 4) });
            },
            assignRole: (_gameId, participantId, role) => {
                participants = participants.map((p) =>
                    p.participantId === participantId ? { ...p, role } : p,
                );
                return Promise.resolve({ versions: versions(null, 5) });
            },
        });
        renderApp(api, `/games/${GAME_ID}/lobby`);

        await user.click(
            await screen.findByRole('button', { name: /ダミー参加者で不足の役割を埋める/ }),
        );

        expect(await screen.findByText('二次卸: ダミー二次卸')).toBeInTheDocument();
        expect(screen.getByText('一次卸: ダミー一次卸')).toBeInTheDocument();
        expect(screen.getByText('工場: ダミー工場')).toBeInTheDocument();
        expect(screen.getByText('小売店: 山本')).toBeInTheDocument();
        expect(api.joinWithoutSession).toHaveBeenCalledTimes(3);
        expect(api.joinWithoutSession).toHaveBeenCalledWith({
            joinCode: 'ABCDEFGH2345',
            displayName: 'ダミー二次卸',
        });
        expect(api.joinGame).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: '開始する' })).toBeEnabled();
    });

    it('4 役割がそろうと開始でき、開始すると進行役のコンソールへ進む', async () => {
        const user = userEvent.setup();
        const four: LobbyParticipant[] = [
            { participantId: 'p-1', displayName: '山本', role: 'RETAILER' },
            { participantId: 'p-2', displayName: '田中', role: 'WHOLESALER' },
            { participantId: 'p-3', displayName: '鈴木', role: 'DISTRIBUTOR' },
            { participantId: 'p-4', displayName: '佐藤', role: 'FACTORY' },
        ];
        const api = fakeApi({
            getLobby: () => Promise.resolve(lobby({ participants: four })),
            startGame: () => Promise.resolve({ versions: versions(1, 10) }),
            getGameState: () =>
                Promise.resolve(gameState({ finalWeek: 12, joinCode: 'ABCDEFGH2345' })),
            getSessionState: () =>
                Promise.resolve({
                    sessionId: GAME_ID,
                    status: 'ACTIVE',
                    week: 1,
                    submittedRoleCount: 0,
                    finalWeek: 12,
                    roles: {
                        RETAILER: roleStatus(),
                        WHOLESALER: roleStatus(),
                        DISTRIBUTOR: roleStatus(),
                        FACTORY: roleStatus(),
                    },
                    results: [],
                    versions: versions(1, 10),
                }),
        });
        renderApp(api, `/games/${GAME_ID}/lobby`);
        const start = await screen.findByRole('button', { name: '開始する' });
        expect(start).toBeEnabled();
        await user.click(start);
        expect(api.startGame).toHaveBeenCalledWith(GAME_ID);
        expect(
            await screen.findByRole('heading', { name: '進行役のコンソール' }),
        ).toBeInTheDocument();
    });

    it('開始の条件を満たさないと拒否されたら、不足している役割を示す', async () => {
        const user = userEvent.setup();
        const four: LobbyParticipant[] = [
            { participantId: 'p-1', displayName: '山本', role: 'RETAILER' },
            { participantId: 'p-2', displayName: '田中', role: 'WHOLESALER' },
            { participantId: 'p-3', displayName: '鈴木', role: 'DISTRIBUTOR' },
            { participantId: 'p-4', displayName: '佐藤', role: 'FACTORY' },
        ];
        const api = fakeApi({
            getLobby: () => Promise.resolve(lobby({ participants: four })),
            startGame: () =>
                Promise.reject(
                    new ApiError(422, {
                        type: '/problems/game.start_condition_not_met',
                        code: 'game.start_condition_not_met',
                        missingRoles: ['DISTRIBUTOR'],
                    }),
                ),
        });
        renderApp(api, `/games/${GAME_ID}/lobby`);
        await user.click(await screen.findByRole('button', { name: '開始する' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(
            '各役割に 1 人以上が必要です。（不足: 一次卸）',
        );
    });

    it('権限が無ければ、権限の文言と、参加の画面への導線を示す', async () => {
        const api = fakeApi({
            getLobby: () =>
                Promise.reject(
                    new ApiError(403, {
                        type: '/problems/app.unauthorized',
                        code: 'app.unauthorized',
                    }),
                ),
        });
        renderApp(api, `/games/${GAME_ID}/lobby`);
        expect(await screen.findByText('この画面を開く権限がありません。')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: '参加・復帰の画面へ' })).toHaveAttribute(
            'href',
            `/join?gameId=${GAME_ID}`,
        );
    });
});
