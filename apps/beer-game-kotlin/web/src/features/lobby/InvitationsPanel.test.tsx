import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import type { Lobby, LobbyInvitation } from '../../api/types';
import { expectNoStructuralA11yViolations } from '../../testing/a11y';
import { GAME_ID, fakeApi, lobby, versions } from '../../testing/fakeApi';
import { renderApp } from '../../testing/render';
import { invitationStatus } from './InvitationsPanel';

const PATH = `/games/${GAME_ID}/lobby`;
const NOW = new Date('2026-11-17T12:00:00Z');

const valid: LobbyInvitation = {
    invitationId: 'inv-1',
    expiresAt: '2026-11-24T12:00:00Z',
    revoked: false,
    createdAt: '2026-11-17T09:00:00Z',
};

describe('観察用の招待（InvitationsPanel の状態）', () => {
    it('失効が先。失効していなければ、期限（瞬間から）で期限切れになる', () => {
        expect(invitationStatus(valid, NOW)).toBe('VALID');
        expect(invitationStatus({ ...valid, expiresAt: NOW.toISOString() }, NOW)).toBe('EXPIRED');
        expect(invitationStatus({ ...valid, revoked: true }, NOW)).toBe('REVOKED');
        expect(
            invitationStatus({ ...valid, revoked: true, expiresAt: '2020-01-01T00:00:00Z' }, NOW),
        ).toBe('REVOKED');
    });
});

describe('S04 ロビー: 観察用の招待', () => {
    it('招待を発行すると、招待コードを一度だけ示し、一覧に招待が載る', async () => {
        const issuedVersions = versions(null, 4);
        const after: Lobby = lobby({ invitations: [valid], versions: issuedVersions });
        const api = fakeApi({
            getLobby: lobbySequence([lobby(), after]),
            inviteObserver: () =>
                Promise.resolve({
                    versions: issuedVersions,
                    invitationId: 'inv-1',
                    invitationCode: 'v1.CODE12345678',
                    expiresAt: valid.expiresAt,
                }),
        });
        renderApp(api, PATH);
        await screen.findByRole('heading', { name: '観察用の招待' });
        expect(screen.getByText('観察者はまだいません。')).toBeInTheDocument();

        await userEvent.click(screen.getByRole('button', { name: '観察用の招待を発行' }));

        expect(await screen.findByText('v1.CODE12345678')).toBeInTheDocument();
        expect(screen.getByText(/いま一度だけ表示します/)).toBeInTheDocument();
        const list = await screen.findByRole('list', { name: '観察用の招待の一覧' });
        expect(within(list).getByText(/招待 1: 有効/)).toBeInTheDocument();
        expectNoStructuralA11yViolations();
    });

    it('失効は確認を挟み、すでに参加した観察者に影響しないと伝える。失効すると、状態が「失効」になり、ボタンは消える', async () => {
        const revokedVersions = versions(null, 6);
        const after: Lobby = lobby({
            invitations: [{ ...valid, revoked: true }],
            observers: [
                { observerId: 'o-1', displayName: '見学者', joinedAt: '2026-11-17T10:00:00Z' },
            ],
            versions: revokedVersions,
        });
        const api = fakeApi({
            getLobby: lobbySequence([
                lobby({
                    invitations: [valid],
                    observers: [
                        {
                            observerId: 'o-1',
                            displayName: '見学者',
                            joinedAt: '2026-11-17T10:00:00Z',
                        },
                    ],
                }),
                after,
            ]),
            revokeObserverInvitation: () => Promise.resolve({ versions: revokedVersions }),
        });
        renderApp(api, PATH);
        const observers = await screen.findByRole('list', { name: '観察者の一覧' });
        expect(within(observers).getByText('見学者')).toBeInTheDocument();

        await userEvent.click(screen.getByRole('button', { name: '招待 1を失効' }));
        const dialog = await screen.findByRole('dialog');
        expect(
            within(dialog).getByText(/すでに参加した観察者は、観察を続けられます/),
        ).toBeInTheDocument();
        await userEvent.click(within(dialog).getByRole('button', { name: '失効させる' }));

        expect(await screen.findByText(/招待 1: 失効/)).toBeInTheDocument();
        expect(api.revokeObserverInvitation).toHaveBeenCalledWith(GAME_ID, 'inv-1');
        expect(screen.queryByRole('button', { name: '招待 1を失効' })).not.toBeInTheDocument();
    });

    it('確認で「戻る」と、失効しない', async () => {
        const api = fakeApi({ getLobby: lobbySequence([lobby({ invitations: [valid] })]) });
        renderApp(api, PATH);

        await userEvent.click(await screen.findByRole('button', { name: '招待 1を失効' }));
        await userEvent.click(
            within(await screen.findByRole('dialog')).getByRole('button', { name: '戻る' }),
        );

        expect(api.revokeObserverInvitation).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('発行に失敗したら、失敗を示す（招待コードは示さない）', async () => {
        const api = fakeApi({
            getLobby: lobbySequence([lobby()]),
            inviteObserver: () => Promise.reject(new ApiError(403, { code: 'app.unauthorized' })),
        });
        renderApp(api, PATH);

        await userEvent.click(await screen.findByRole('button', { name: '観察用の招待を発行' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'この画面を開く権限がありません。',
        );
        expect(screen.queryByText(/いま一度だけ表示します/)).not.toBeInTheDocument();
    });
});

/** 呼ぶたびに、次の値を返す（最後の値は繰り返す）。 */
function lobbySequence(values: Lobby[]) {
    let index = 0;
    return () => Promise.resolve(values[Math.min(index++, values.length - 1)] as Lobby);
}
