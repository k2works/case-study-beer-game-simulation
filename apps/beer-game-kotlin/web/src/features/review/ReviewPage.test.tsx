import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import type { Review, Role, RoleWeekResult } from '../../api/types';
import { expectNoStructuralA11yViolations } from '../../testing/a11y';
import { GAME_ID, fakeApi, versions } from '../../testing/fakeApi';
import { renderApp } from '../../testing/render';

const PATH = `/games/${GAME_ID}/review`;
const ROLES: Role[] = ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'];

/** 週 w、役割 r の値が、他と紛れない形（注文: 役割の添字 × 10 + 週）になる結果。 */
function resultOf(role: Role, week: number): RoleWeekResult {
    const base = (ROLES.indexOf(role) + 1) * 10 + week;
    return {
        role,
        week,
        orders: role === 'RETAILER' ? 4 : base,
        order: base,
        inventory: 100 + base,
        backlog: 200 + base,
        shipment: 300 + base,
        cost: 400 + base,
        cumulativeCost: 500 + base,
    };
}

function review(overrides: Partial<Review> = {}): Review {
    return {
        gameId: GAME_ID,
        finalWeek: 3,
        settingsKind: 'KIT',
        changedSettings: [],
        commitMode: 'MANUAL',
        results: [1, 2, 3].flatMap((week) => ROLES.map((role) => resultOf(role, week))),
        versions: versions(5, 30),
        ...overrides,
    };
}

/** 表の最初のデータ行（週 1）のセルの文字列。 */
function firstRowCells(table: HTMLElement): (string | null)[] {
    const row = within(table).getAllByRole('row')[1];
    if (row === undefined) throw new Error('データ行がない');
    return within(row)
        .getAllByRole('cell')
        .map((c) => c.textContent);
}

describe('S08 振り返り（役割別）', () => {
    it('既定は「注文」の役割別の推移。グラフと同じ値の表を併記し、需要と 4 役割の列を週の軸で並べる', async () => {
        const api = fakeApi({ getReview: () => Promise.resolve(review()) });
        renderApp(api, PATH);

        const table = await screen.findByRole('table', { name: '週次推移の表' });
        expect(screen.getByRole('radio', { name: '注文' })).toBeChecked();
        const headers = within(table)
            .getAllByRole('columnheader')
            .map((h) => h.textContent);
        expect(headers).toEqual(['週', '需要', '小売店', '二次卸', '一次卸', '工場']);
        expect(firstRowCells(table)).toEqual(['1', '4', '11', '21', '31', '41']);
        expect(screen.getByRole('img', { name: /注文の週次推移/ })).toBeVisible();
        expect(api.getReview).toHaveBeenCalledWith(GAME_ID);
    });

    it('指標を切り替えると、表の値が、その指標の値になる（グラフと同じ値）', async () => {
        const user = userEvent.setup();
        renderApp(fakeApi({ getReview: () => Promise.resolve(review()) }), PATH);

        await user.click(await screen.findByRole('radio', { name: '在庫' }));

        const table = screen.getByRole('table', { name: '週次推移の表' });
        expect(firstRowCells(table)).toEqual(['1', '4', '111', '121', '131', '141']);
        expect(screen.getByRole('img', { name: /在庫の週次推移/ })).toBeVisible();
    });

    it('役割のチェックを外すと、その役割の列が表から消える。需要の列も外せる', async () => {
        const user = userEvent.setup();
        renderApp(fakeApi({ getReview: () => Promise.resolve(review()) }), PATH);

        await user.click(await screen.findByRole('checkbox', { name: '二次卸' }));
        await user.click(screen.getByRole('checkbox', { name: '需要' }));

        const table = screen.getByRole('table', { name: '週次推移の表' });
        expect(
            within(table)
                .getAllByRole('columnheader')
                .map((h) => h.textContent),
        ).toEqual(['週', '小売店', '一次卸', '工場']);
    });

    it('全指標の結果を、週の昇順・小売店から工場の順の表でも示す（指標や役割の切り替えに左右されない）', async () => {
        const user = userEvent.setup();
        renderApp(fakeApi({ getReview: () => Promise.resolve(review()) }), PATH);

        await user.click(await screen.findByRole('radio', { name: '費用' }));
        await user.click(screen.getByRole('checkbox', { name: '二次卸' }));

        const table = screen.getByRole('table', { name: '全週の結果の表' });
        expect(
            within(table)
                .getAllByRole('columnheader')
                .map((h) => h.textContent),
        ).toEqual(['週', '役割', '受注', '発注', '在庫', '受注残', '出荷', '費用', '累計費用']);
        const rows = within(table).getAllByRole('row').slice(1);
        expect(rows).toHaveLength(12);
        const keys = rows.map(
            (row) =>
                `${within(row).getAllByRole('cell')[0]?.textContent}:${within(row).getByRole('rowheader').textContent}`,
        );
        expect(keys.slice(0, 5)).toEqual([
            '1:小売店',
            '1:二次卸',
            '1:一次卸',
            '1:工場',
            '2:小売店',
        ]);
        expect(keys.at(-1)).toBe('3:工場');
        const first = rows[0];
        if (first === undefined) throw new Error('行がない');
        expect(
            within(first)
                .getAllByRole('cell')
                .map((c) => c.textContent),
        ).toEqual(['1', '4', '11', '111', '211', '311', '411', '511']);
    });

    it('ゲームが終了していない（game.not_ended）ときは、失敗でなく、終了後に開く旨を示す', async () => {
        renderApp(
            fakeApi({
                getReview: () => Promise.reject(new ApiError(409, { code: 'game.not_ended' })),
            }),
            PATH,
        );

        expect(
            await screen.findByText('ゲームが終了するまで、振り返りは開けません。'),
        ).toBeVisible();
    });

    it('結果が 0 件のときは「データなし」を示し、読み込みの失敗とは区別する（AC4.2.3）', async () => {
        renderApp(fakeApi({ getReview: () => Promise.resolve(review({ results: [] })) }), PATH);

        expect(await screen.findByText('データなし')).toBeVisible();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('読み込みの失敗は、原因の区分と相関 ID を role="alert" で示す（「データなし」とは別）', async () => {
        renderApp(
            fakeApi({
                getReview: () => Promise.reject(new ApiError(503, { correlationId: 'abc-123' })),
            }),
            PATH,
        );

        expect(await screen.findByRole('alert')).toHaveTextContent('abc-123');
        expect(screen.queryByText('データなし')).not.toBeInTheDocument();
    });

    it('構造のアクセシビリティの検査に通る', async () => {
        renderApp(fakeApi({ getReview: () => Promise.resolve(review()) }), PATH);
        await screen.findByRole('table', { name: '週次推移の表' });
        expectNoStructuralA11yViolations();
    });
});
