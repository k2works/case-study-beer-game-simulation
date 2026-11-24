import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import { expectNoStructuralA11yViolations } from '../../testing/a11y';
import { GAME_ID, fakeApi, versions } from '../../testing/fakeApi';
import { renderApp } from '../../testing/render';
import { DEFAULT_OBSERVER_NAME } from './ObserverJoinPage';

const joined = { versions: versions(null, 5), gameId: GAME_ID, kind: 'OBSERVER' } as const;

describe('S10 観察者の参加', () => {
    it('招待コードと表示名で参加し、観察の画面へ進む（読み取り専用であることを示す）', async () => {
        const api = fakeApi({
            joinAsObserver: () => Promise.resolve(joined),
            getObservation: () =>
                Promise.resolve({
                    gameId: GAME_ID,
                    status: 'STARTED',
                    finalWeek: 3,
                    totals: { policy: 'TEAM_TOTAL', weeks: [] },
                    versions: versions(2, 5),
                }),
        });
        renderApp(api, '/observe');
        await screen.findByRole('heading', { name: '観察者として参加' });
        expect(screen.getByText(/読み取り専用です/)).toBeInTheDocument();
        expectNoStructuralA11yViolations();

        await userEvent.type(screen.getByLabelText('観察用の招待コード'), '  v1.ABCDEFGH2345 ');
        await userEvent.type(screen.getByLabelText('表示名（任意）'), '見学者');
        await userEvent.click(screen.getByRole('button', { name: '参加する' }));

        expect(await screen.findByRole('heading', { name: '観察' })).toBeInTheDocument();
        expect(api.joinAsObserver).toHaveBeenCalledWith({
            invitationCode: 'v1.ABCDEFGH2345',
            displayName: '見学者',
        });
    });

    it('表示名を省くと、既定の名前で参加する', async () => {
        const api = fakeApi({ joinAsObserver: () => Promise.resolve(joined) });
        api.getObservation.mockRejectedValue(new Error('観察は、このテストの対象外'));
        renderApp(api, '/observe');

        await userEvent.type(await screen.findByLabelText('観察用の招待コード'), 'v1.CODE');
        await userEvent.click(screen.getByRole('button', { name: '参加する' }));

        await screen.findByRole('heading', { name: '観察' });
        expect(api.joinAsObserver).toHaveBeenCalledWith({
            invitationCode: 'v1.CODE',
            displayName: DEFAULT_OBSERVER_NAME,
        });
    });

    it('無効な招待は、失効・期限切れ・不明を区別せず、招待が無効という文言で示す', async () => {
        const api = fakeApi({
            joinAsObserver: () =>
                Promise.reject(new ApiError(403, { code: 'game.invitation_invalid' })),
        });
        renderApp(api, '/observe');

        await userEvent.type(await screen.findByLabelText('観察用の招待コード'), 'v1.WRONG');
        await userEvent.click(screen.getByRole('button', { name: '参加する' }));

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent(
            '招待が無効です（失効または期限切れ）。進行役に確認してください。',
        );
        expect(alert).not.toHaveTextContent('参加コードが無効です');
        expect(screen.getByRole('button', { name: '参加する' })).toBeEnabled();
    });

    it('入力の誤り（422）は、項目の近くに示し、入力を保持する', async () => {
        const api = fakeApi({
            joinAsObserver: () =>
                Promise.reject(
                    new ApiError(422, {
                        code: 'validation.invalid_input',
                        errors: [
                            {
                                field: 'displayName',
                                message: '表示名は 80 文字以下にしてください。',
                            },
                        ],
                    }),
                ),
        });
        renderApp(api, '/observe');

        await userEvent.type(await screen.findByLabelText('観察用の招待コード'), 'v1.CODE');
        await userEvent.click(screen.getByRole('button', { name: '参加する' }));

        expect(await screen.findByText('表示名は 80 文字以下にしてください。')).toBeInTheDocument();
        expect(screen.getByLabelText('観察用の招待コード')).toHaveValue('v1.CODE');
    });
});
