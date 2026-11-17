import { act, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import type { Observation } from '../../api/types';
import { expectNoStructuralA11yViolations } from '../../testing/a11y';
import { GAME_ID, fakeApi, versions } from '../../testing/fakeApi';
import { renderApp } from '../../testing/render';
import { OBSERVATION_POLL_MS } from './ObservationPage';

const PATH = `/games/${GAME_ID}/observation`;

function observation(overrides: Partial<Observation> = {}): Observation {
    return {
        gameId: GAME_ID,
        status: 'STARTED',
        finalWeek: 5,
        sessionStatus: 'ACTIVE',
        week: 3,
        submittedRoleCount: 2,
        totals: {
            policy: 'TEAM_TOTAL',
            weeks: [
                { week: 1, order: 16, inventory: 48, backlog: 0 },
                { week: 2, order: 20, inventory: 44, backlog: 4 },
            ],
        },
        versions: versions(5, 5),
        ...overrides,
    };
}

describe('S07 観察', () => {
    it('現在週・完了状況・チーム合計の表を示す。役割別の値や操作の部品は無い', async () => {
        const api = fakeApi({ getObservation: () => Promise.resolve(observation()) });
        renderApp(api, PATH);

        expect(await screen.findByRole('heading', { name: '観察' })).toBeInTheDocument();
        expect(screen.getByText(/第 3 週（全 5 週）/)).toBeInTheDocument();
        expect(screen.getByText(/入力済み 2 \/ 4 役割/)).toBeInTheDocument();
        const table = screen.getByRole('table', { name: 'チーム合計の表' });
        const rows = within(table).getAllByRole('row');
        expect(
            within(rows[1] as HTMLElement)
                .getAllByRole('cell')
                .map((c) => c.textContent),
        ).toEqual(['1', '16', '48', '0']);
        expect(
            within(rows[2] as HTMLElement)
                .getAllByRole('cell')
                .map((c) => c.textContent),
        ).toEqual(['2', '20', '44', '4']);
        // 役割別の語も、入力・確定・進行の操作もない（読み取り専用）
        expect(screen.queryByText(/小売店|二次卸|一次卸|工場/)).not.toBeInTheDocument();
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        expect(screen.getByText(/読み取り専用です/)).toBeInTheDocument();
        expectNoStructuralA11yViolations();
    });

    it('公開範囲が「なし」なら、合計の表を出さず、理由を示す（現在週と完了状況は示す）', async () => {
        const api = fakeApi({
            getObservation: () =>
                Promise.resolve(
                    observation({
                        totals: { policy: 'NONE', hiddenReason: 'DISCLOSURE_NONE', weeks: [] },
                    }),
                ),
        });
        renderApp(api, PATH);

        expect(
            await screen.findByText(
                '進行役の設定により、プレイ中のチーム合計は公開されていません。',
            ),
        ).toBeInTheDocument();
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
        expect(screen.getByText(/第 3 週/)).toBeInTheDocument();
    });

    it('寄与者が足りない週は、値の代わりに「非表示」と理由の注記を示す', async () => {
        const api = fakeApi({
            getObservation: () =>
                Promise.resolve(
                    observation({
                        totals: {
                            policy: 'TEAM_TOTAL',
                            weeks: [
                                { week: 1, hidden: true, reason: 'CONTRIBUTORS_BELOW_MINIMUM' },
                                { week: 2, order: 20, inventory: 44, backlog: 4 },
                            ],
                        },
                    }),
                ),
        });
        renderApp(api, PATH);

        const table = await screen.findByRole('table', { name: 'チーム合計の表' });
        expect(within(table).getByText('非表示（※）')).toBeInTheDocument();
        expect(screen.getByText(/1 役割だけの週は、個別の値が分かってしまう/)).toBeInTheDocument();
    });

    it('確定した週がなければ、その旨を示す。終了後は振り返りへの導線を出し、取り直しをやめる', async () => {
        vi.useFakeTimers();
        try {
            const getObservation = vi.fn(() =>
                Promise.resolve(
                    observation({
                        status: 'ENDED',
                        sessionStatus: 'ENDED',
                        totals: { policy: 'TEAM_TOTAL', weeks: [] },
                    }),
                ),
            );
            renderApp(fakeApi({ getObservation }), PATH);
            await act(() => vi.advanceTimersByTimeAsync(0));

            expect(screen.getByText('まだ確定した週はありません。')).toBeInTheDocument();
            expect(screen.getByRole('link', { name: '振り返りを見る' })).toHaveAttribute(
                'href',
                `/games/${GAME_ID}/review`,
            );
            await act(() => vi.advanceTimersByTimeAsync(OBSERVATION_POLL_MS * 3));
            expect(getObservation).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('プレイ中は、一定の間隔で取り直して、新しい週の合計を反映する。取り直しの失敗は、表示中の内容を消さない', async () => {
        vi.useFakeTimers();
        try {
            const getObservation = vi
                .fn<() => Promise<Observation>>()
                .mockResolvedValueOnce(
                    observation({ week: 2, totals: { policy: 'TEAM_TOTAL', weeks: [] } }),
                )
                .mockRejectedValueOnce(new Error('一時的な失敗'))
                .mockResolvedValue(observation());
            renderApp(fakeApi({ getObservation }), PATH);
            await act(() => vi.advanceTimersByTimeAsync(0));
            expect(screen.getByText(/第 2 週/)).toBeInTheDocument();

            await act(() => vi.advanceTimersByTimeAsync(OBSERVATION_POLL_MS));
            expect(screen.getByText(/第 2 週/)).toBeInTheDocument();

            await act(() => vi.advanceTimersByTimeAsync(OBSERVATION_POLL_MS));
            expect(screen.getByText(/第 3 週/)).toBeInTheDocument();
            expect(screen.getByRole('table', { name: 'チーム合計の表' })).toBeInTheDocument();
        } finally {
            vi.useRealTimers();
        }
    });

    it('権限が無い（観察者でない）人には、権限の失敗を示し、観察者として参加する導線を出す', async () => {
        const api = fakeApi({
            getObservation: () => Promise.reject(new ApiError(403, { code: 'app.unauthorized' })),
        });
        renderApp(api, PATH);

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'この画面を開く権限がありません。',
        );
        expect(screen.getByRole('link', { name: '観察者として参加する' })).toHaveAttribute(
            'href',
            '/observe',
        );
    });
});
