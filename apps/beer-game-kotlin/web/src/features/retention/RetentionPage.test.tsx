import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import type { Retention, Review } from '../../api/types';
import { expectNoStructuralA11yViolations } from '../../testing/a11y';
import { GAME_ID, fakeApi, gameState, versions } from '../../testing/fakeApi';
import { renderApp } from '../../testing/render';

const PATH = `/games/${GAME_ID}/retention`;

const retention = (overrides: Partial<Retention> = {}): Retention => ({
    retentionDays: 90,
    startsAt: '2026-11-14T09:00:00Z',
    deleteAfter: '2027-02-12T09:00:00Z',
    status: 'SCHEDULED',
    attempt: 0,
    nextAttemptAt: null,
    lastFailureCode: null,
    backupRetentionDays: 7,
    ...overrides,
});

describe('S09 保持状態（US5.1）', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2027-02-09T09:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /** 保持状態の表の「項目 → 内容」。 */
    const rowsOf = (table: HTMLElement) =>
        within(table)
            .getAllByRole('row')
            .map((row) => [
                within(row).getByRole('rowheader').textContent,
                within(row).getByRole('cell').textContent,
            ]);

    it('削除予定日と残り日数、保持期間、保持の起点、削除の進行、バックアップの残存を、表で示す', async () => {
        renderApp(fakeApi({ getRetention: () => Promise.resolve(retention()) }), PATH);

        expect(await screen.findByRole('heading', { name: '保持状態' })).toBeVisible();
        const table = screen.getByRole('table', { name: '保持状態の表' });
        expect(rowsOf(table)).toEqual([
            ['削除予定日', '2027-02-12（あと 3 日）'],
            ['保持期間', '90 日'],
            ['保持の起点', '2026-11-14（ゲームの作成時）'],
            ['削除の進行', '削除の予定です。'],
            ['バックアップ', '削除後も最大 7 日残ります（データベースの自動バックアップ）'],
        ]);
        expect(screen.getByText(/削除予定日までに済ませてください/)).toBeVisible();
        await expectNoStructuralA11yViolations();
    });

    it('バックアップに、削除後も最大 7 日残ることを示す（AC5.1.5）', async () => {
        renderApp(
            fakeApi({
                getRetention: () => Promise.resolve(retention({ backupRetentionDays: 14 })),
            }),
            PATH,
        );

        const table = await screen.findByRole('table', { name: '保持状態の表' });
        expect(
            within(table).getByRole('rowheader', { name: 'バックアップ' }).nextSibling,
        ).toHaveTextContent('削除後も最大 14 日残ります');
    });

    it('状態ごとに、削除の進行を示す', async () => {
        const cases: [Partial<Retention>, string][] = [
            [{ status: 'SCHEDULED' }, '削除の予定です。'],
            [{ status: 'IN_PROGRESS', attempt: 1 }, '削除しています。'],
            [
                {
                    status: 'RETRY_PENDING',
                    attempt: 2,
                    nextAttemptAt: '2027-02-09T10:00:00Z',
                    lastFailureCode: 'persistence.retention.delete',
                },
                '削除に失敗しました（2 回目）。自動で再試行します。次の試行: 2027-02-09T10:00:00Z',
            ],
            [
                {
                    status: 'ABANDONED',
                    attempt: 5,
                    lastFailureCode: 'persistence.retention.delete',
                },
                '再試行の上限に達したため、自動の削除をやめました。運営者へ連絡してください。',
            ],
        ];
        for (const [overrides, text] of cases) {
            const view = renderApp(
                fakeApi({ getRetention: () => Promise.resolve(retention(overrides)) }),
                PATH,
            );
            await screen.findByRole('heading', { name: '保持状態' });
            expect(screen.getByRole('status')).toHaveTextContent(text);
            view.unmount();
        }
    });

    it('削除予定日を過ぎていたら、期限に達していると示す', async () => {
        vi.setSystemTime(new Date('2027-02-13T09:00:00Z'));
        renderApp(fakeApi({ getRetention: () => Promise.resolve(retention()) }), PATH);

        const table = await screen.findByRole('table', { name: '保持状態の表' });
        expect(
            within(table).getByRole('rowheader', { name: '削除予定日' }).nextSibling,
        ).toHaveTextContent('2027-02-12（期限に達しています）');
    });

    it('進行役でなければ（403）、取得に失敗したことを role="alert" で示す', async () => {
        renderApp(
            fakeApi({
                getRetention: () =>
                    Promise.reject(
                        new ApiError(403, { code: 'app.unauthorized', correlationId: 'c-1' }),
                    ),
            }),
            PATH,
        );

        expect(await screen.findByRole('alert')).toHaveTextContent('c-1');
    });

    it('コンソールへ戻るリンクを示す', async () => {
        renderApp(fakeApi({ getRetention: () => Promise.resolve(retention()) }), PATH);

        const back = await screen.findByRole('link', { name: 'コンソールへ戻る' });
        expect(back).toHaveAttribute('href', `/games/${GAME_ID}/console`);
    });
});

const review = (): Review => ({
    gameId: GAME_ID,
    finalWeek: 1,
    settingsKind: 'KIT',
    changedSettings: [],
    commitMode: 'MANUAL',
    results: (['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'] as const).map((role) => ({
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

describe('S08 振り返り: 削除予定日の注記（AC5.1.1）', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2027-02-09T09:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('進行役には、削除予定日を、見出しの近くに示す', async () => {
        renderApp(
            fakeApi({
                getReview: () => Promise.resolve(review()),
                getGameState: () =>
                    Promise.resolve(gameState({ status: 'ENDED', joinCode: 'ABCDEFGH2345' })),
                getRetention: () => Promise.resolve(retention()),
            }),
            `/games/${GAME_ID}/review`,
        );

        expect(await screen.findByText('削除予定日: 2027-02-12（あと 3 日）')).toBeVisible();
    });

    it('参加者には示さず、保持状態も取得しない', async () => {
        const api = fakeApi({
            getReview: () => Promise.resolve(review()),
            getGameState: () => Promise.resolve(gameState({ status: 'ENDED' })),
        });
        renderApp(api, `/games/${GAME_ID}/review`);

        await screen.findByRole('heading', { name: '振り返り' });
        expect(screen.queryByText(/削除予定日/)).not.toBeInTheDocument();
        expect(api.getRetention).not.toHaveBeenCalled();
    });

    it('保持状態を取得できなくても、振り返りは表示する（注記だけを示さない）', async () => {
        renderApp(
            fakeApi({
                getReview: () => Promise.resolve(review()),
                getGameState: () =>
                    Promise.resolve(gameState({ status: 'ENDED', joinCode: 'ABCDEFGH2345' })),
                getRetention: () => Promise.reject(new ApiError(503, { correlationId: 'r-1' })),
            }),
            `/games/${GAME_ID}/review`,
        );

        expect(await screen.findByRole('heading', { name: '振り返り' })).toBeVisible();
        expect(screen.queryByText(/削除予定日/)).not.toBeInTheDocument();
    });
});
