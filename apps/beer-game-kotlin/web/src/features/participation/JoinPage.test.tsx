import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import { fakeApi, versions } from '../../testing/fakeApi';
import { renderApp } from '../../testing/render';

async function fill(user: ReturnType<typeof userEvent.setup>, code: string, name: string) {
    await user.type(screen.getByLabelText('参加コード'), code);
    await user.type(screen.getByLabelText('表示名'), name);
    await user.click(screen.getByRole('button', { name: '参加する' }));
}

describe('S03 参加', () => {
    it('参加コードと表示名で参加し、参加できたことと開始を待つ旨を示す', async () => {
        const user = userEvent.setup();
        const api = fakeApi({ joinGame: () => Promise.resolve({ versions: versions(null, 2) }) });
        renderApp(api, '/join');
        await fill(user, 'ABCDEFGH2345', '田中');
        expect(api.joinGame).toHaveBeenCalledWith({
            joinCode: 'ABCDEFGH2345',
            displayName: '田中',
        });
        expect(await screen.findByRole('status')).toHaveTextContent(
            '参加しました。進行役が開始するまでお待ちください。',
        );
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
