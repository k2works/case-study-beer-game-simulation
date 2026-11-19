// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetentionPage } from '../../src/ui/RetentionPage.js';
import { App } from '../../src/ui/App.js';
import type { BrowserApi } from '../../src/ui/browser-api.js';

const api = (methods: Record<string, unknown>) => methods as unknown as BrowserApi;
const policy = {
  gameId: 'g',
  retentionDays: 90,
  retentionStartsAt: '2026-01-01T00:00:00Z',
  deleteAfter: '2026-04-01T00:00:00Z',
  policyVersion: 1,
};
const owners = {
  'u1-walking-skeleton': 'COMPLETED',
  'u2-session-continuity': 'PENDING',
  'u3-learning-view': 'PENDING',
};
afterEach(() => {
  document.body.innerHTML = '';
});

describe('Given an operator retention view', () => {
  it('shows the retention period and deletion date', async () => {
    render(
      <RetentionPage
        api={api({ retention: vi.fn().mockResolvedValue({ policy, deletion: null }) })}
        gameId="g"
      />,
    );
    expect(await screen.findByText('90 日')).toBeTruthy();
    expect(screen.getByText(/2026-04-01/)).toBeTruthy();
    expect(screen.queryByText('削除完了')).toBeNull();
  });

  it('shows no protected data when authorization fails', async () => {
    render(
      <RetentionPage
        api={api({ retention: vi.fn().mockRejectedValue({ status: 403 }) })}
        gameId="g"
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toContain('権限');
    expect(document.body.textContent).not.toContain('90 日');
  });

  it('shows every owner in progress without claiming completion', async () => {
    render(
      <RetentionPage
        api={api({
          retention: vi.fn().mockResolvedValue({
            policy,
            deletion: { deletionId: 'd', status: 'IN_PROGRESS', attempt: 1, owners },
          }),
        })}
        gameId="g"
      />,
    );
    expect(await screen.findByText('u2-session-continuity: PENDING')).toBeTruthy();
    expect(screen.queryByText('削除完了')).toBeNull();
    expect(screen.queryByRole('button', { name: '手動再試行' })).toBeNull();
  });

  it('shows failure code and unfinished owner before retry', async () => {
    render(
      <RetentionPage
        api={api({
          retention: vi.fn().mockResolvedValue({
            policy,
            deletion: {
              deletionId: 'd',
              status: 'FAILED',
              attempt: 1,
              owners,
              failureCode: 'OWNER_ERROR',
            },
          }),
        })}
        gameId="g"
      />,
    );
    expect(await screen.findByText('OWNER_ERROR')).toBeTruthy();
    expect(screen.getByText('u2-session-continuity: PENDING')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '手動再試行' }));
    expect(screen.getByRole('dialog').textContent).toContain('未完了の owner');
  });

  it('sends attempt as If-Match only after explicit confirmation', async () => {
    const retryRetention = vi
      .fn()
      .mockResolvedValue({ deletionId: 'd', status: 'IN_PROGRESS', attempt: 2, owners });
    const retention = vi.fn().mockResolvedValue({
      policy,
      deletion: {
        deletionId: 'd',
        status: 'FAILED',
        attempt: 1,
        owners,
        failureCode: 'OWNER_ERROR',
      },
    });
    render(<RetentionPage api={api({ retention, retryRetention })} gameId="g" />);
    fireEvent.click(await screen.findByRole('button', { name: '手動再試行' }));
    expect(retryRetention).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '再試行を確定' }));
    await waitFor(() => expect(retryRetention).toHaveBeenCalledWith('g', 1, expect.any(String)));
  });

  it('calls deletion complete only when all owners are complete', async () => {
    const completed = {
      'u1-walking-skeleton': 'COMPLETED',
      'u2-session-continuity': 'COMPLETED',
      'u3-learning-view': 'COMPLETED',
    };
    render(
      <RetentionPage
        api={api({
          retention: vi.fn().mockResolvedValue({
            policy,
            deletion: { deletionId: 'd', status: 'COMPLETED', attempt: 1, owners: completed },
          }),
        })}
        gameId="g"
      />,
    );
    expect(await screen.findByText('削除完了')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '手動再試行' })).toBeNull();
  });
});

describe('Given a facilitator in the browser', () => {
  it('opens protected retention status from the game navigation', async () => {
    const browser = api({
      createGame: vi
        .fn()
        .mockResolvedValue({ gameId: 'g', sessionId: 's', joinCode: 'ABCD1234', version: 1 }),
      lobby: vi.fn().mockResolvedValue({
        gameId: 'g',
        sessionId: 's',
        week: 1,
        version: 1,
        status: 'LOBBY',
        participants: [],
      }),
      retention: vi.fn().mockResolvedValue({ policy, deletion: null }),
    });
    render(<App api={browser} />);
    fireEvent.click(screen.getByRole('button', { name: 'ゲームを作る' }));
    fireEvent.click(screen.getByRole('button', { name: 'ゲームを作成' }));
    fireEvent.click(await screen.findByRole('button', { name: 'ロビーへ' }));
    fireEvent.click(screen.getByRole('button', { name: '保持状態を見る' }));
    expect(await screen.findByRole('heading', { name: '保持と削除' })).toBeTruthy();
  });
});
