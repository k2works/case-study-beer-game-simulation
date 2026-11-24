import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import type { Review, Role } from '../../api/types';
import { expectNoStructuralA11yViolations } from '../../testing/a11y';
import { GAME_ID, fakeApi, gameState, versions } from '../../testing/fakeApi';
import { renderApp } from '../../testing/render';

const PATH = `/games/${GAME_ID}/review`;
const ROLES: Role[] = ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'];

const review = (): Review => ({
    gameId: GAME_ID,
    finalWeek: 1,
    settingsKind: 'KIT',
    changedSettings: [],
    commitMode: 'MANUAL',
    results: ROLES.map((role) => ({
        role,
        week: 1,
        orders: 4,
        order: 4,
        inventory: 12,
        backlog: 0,
        shipment: 4,
        cost: 600,
        cumulativeCost: 600,
    })),
    versions: versions(5, 30),
});

const facilitatorState = () => gameState({ status: 'ENDED', joinCode: 'ABCDEFGH2345' });
const participantState = () => gameState({ status: 'ENDED' });

const file = (name: string) => ({ filename: name, blob: new Blob(['x']) });

describe('S08 振り返り: 結果の出力（US4.3）', () => {
    const clicked: { download: string; href: string }[] = [];

    beforeEach(() => {
        clicked.length = 0;
        URL.createObjectURL = vi.fn(() => 'blob:export');
        URL.revokeObjectURL = vi.fn();
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
            this: HTMLAnchorElement,
        ) {
            clicked.push({ download: this.download, href: this.href });
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('進行役には「CSV を出力」「JSON を出力」を示し、含まれるものを注記する', async () => {
        renderApp(
            fakeApi({
                getReview: () => Promise.resolve(review()),
                getGameState: () => Promise.resolve(facilitatorState()),
            }),
            PATH,
        );

        expect(await screen.findByRole('button', { name: 'CSV を出力' })).toBeVisible();
        expect(screen.getByRole('button', { name: 'JSON を出力' })).toBeVisible();
        expect(screen.getByText('設定・役割別の値・意思決定を含みます。')).toBeVisible();
    });

    it('「CSV を出力」を押すと、CSV を要求し、サーバーが決めた名前でダウンロードする', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            getReview: () => Promise.resolve(review()),
            getGameState: () => Promise.resolve(facilitatorState()),
            exportResult: () => Promise.resolve(file('beer-game-g-1.csv')),
        });
        renderApp(api, PATH);

        await user.click(await screen.findByRole('button', { name: 'CSV を出力' }));

        await waitFor(() => expect(clicked).toHaveLength(1));
        expect(api.exportResult).toHaveBeenCalledWith(GAME_ID, 'csv');
        expect(clicked[0]).toEqual({ download: 'beer-game-g-1.csv', href: 'blob:export' });
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:export');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('「JSON を出力」は、JSON を要求する', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            getReview: () => Promise.resolve(review()),
            getGameState: () => Promise.resolve(facilitatorState()),
            exportResult: () => Promise.resolve(file('beer-game-g-1.json')),
        });
        renderApp(api, PATH);

        await user.click(await screen.findByRole('button', { name: 'JSON を出力' }));

        await waitFor(() => expect(clicked).toHaveLength(1));
        expect(api.exportResult).toHaveBeenCalledWith(GAME_ID, 'json');
    });

    it('出力に失敗したら、ダウンロードせず、原因の区分と相関 ID を role="alert" で示す（部分的な結果を示さない）', async () => {
        const user = userEvent.setup();
        renderApp(
            fakeApi({
                getReview: () => Promise.resolve(review()),
                getGameState: () => Promise.resolve(facilitatorState()),
                exportResult: () =>
                    Promise.reject(
                        new ApiError(500, {
                            type: '/problems/app.internal',
                            correlationId: 'exp-9',
                        }),
                    ),
            }),
            PATH,
        );

        await user.click(await screen.findByRole('button', { name: 'CSV を出力' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('exp-9');
        expect(clicked).toHaveLength(0);
    });

    it('出力している間は、2 つのボタンを押せない（二重の要求を防ぐ）', async () => {
        const user = userEvent.setup();
        let finish: (f: ReturnType<typeof file>) => void = () => undefined;
        renderApp(
            fakeApi({
                getReview: () => Promise.resolve(review()),
                getGameState: () => Promise.resolve(facilitatorState()),
                exportResult: () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    }),
            }),
            PATH,
        );

        await user.click(await screen.findByRole('button', { name: 'CSV を出力' }));

        expect(screen.getByRole('button', { name: 'CSV を出力' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'JSON を出力' })).toBeDisabled();
        finish(file('beer-game-g-1.csv'));
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'CSV を出力' })).toBeEnabled(),
        );
    });

    it('参加者（進行役でない人）には、出力のボタンを示さない', async () => {
        renderApp(
            fakeApi({
                getReview: () => Promise.resolve(review()),
                getGameState: () => Promise.resolve(participantState()),
            }),
            PATH,
        );

        await screen.findByRole('table', { name: '週次推移の表' });
        expect(screen.queryByRole('button', { name: 'CSV を出力' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'JSON を出力' })).not.toBeInTheDocument();
    });

    it('進行役かどうかを取得できなくても、振り返りは開ける（出力のボタンだけを示さない）', async () => {
        renderApp(fakeApi({ getReview: () => Promise.resolve(review()) }), PATH);

        await screen.findByRole('table', { name: '週次推移の表' });
        expect(screen.queryByRole('button', { name: 'CSV を出力' })).not.toBeInTheDocument();
    });

    it('構造のアクセシビリティの検査に通る', async () => {
        renderApp(
            fakeApi({
                getReview: () => Promise.resolve(review()),
                getGameState: () => Promise.resolve(facilitatorState()),
            }),
            PATH,
        );
        await screen.findByRole('button', { name: 'CSV を出力' });
        expectNoStructuralA11yViolations();
    });
});
