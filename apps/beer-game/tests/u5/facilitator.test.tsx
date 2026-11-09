// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FacilitatorConsole } from '../../src/ui/FacilitatorConsole.js';
import type { BrowserApi, LobbyState } from '../../src/ui/browser-api.js';

const api = (methods: Record<string, unknown>) => methods as unknown as BrowserApi;
const lobby: LobbyState = {
  gameId: 'g',
  sessionId: 's',
  week: 2,
  status: 'ACTIVE',
  version: 4,
  participants: [
    { participantId: 'r', displayName: 'R', role: 'RETAILER' },
    { participantId: 'w', displayName: 'W', role: 'WHOLESALER' },
    { participantId: 'd', displayName: 'D', role: 'DISTRIBUTOR' },
    { participantId: 'f', displayName: 'F', role: 'FACTORY' },
  ],
  decisions: {
    RETAILER: { complete: true, version: 1 },
    WHOLESALER: { complete: true, version: 1 },
    DISTRIBUTOR: { complete: true, version: 1 },
    FACTORY: { complete: false, version: 0 },
  },
};
afterEach(() => {
  document.body.innerHTML = '';
});

describe('Given the facilitator console', () => {
  it('shows four completion states and blocks commit until all decisions exist', async () => {
    render(
      <FacilitatorConsole
        api={api({ lobby: vi.fn().mockResolvedValue(lobby) })}
        gameId="g"
        sessionId="s"
        onEnded={vi.fn()}
      />,
    );
    expect(await screen.findByText('FACTORY: 未入力')).toBeTruthy();
    expect(screen.getByText('RETAILER: 入力済み')).toBeTruthy();
    expect((screen.getByRole('button', { name: '週を確定' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('focuses a confirmation dialog and commits the displayed week and version', async () => {
    const all = {
      ...lobby,
      decisions: { ...lobby.decisions!, FACTORY: { complete: true, version: 1 } },
    };
    const commit = vi.fn().mockResolvedValue({ version: 5 });
    render(
      <FacilitatorConsole
        api={api({ lobby: vi.fn().mockResolvedValue(all), commit })}
        gameId="g"
        sessionId="s"
        onEnded={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '週を確定' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('第 2 週');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: '週確定の確認' })),
    );
    fireEvent.click(screen.getByRole('button', { name: '確定する' }));
    await waitFor(() => expect(commit).toHaveBeenCalledWith('s', 2, 4, expect.any(String)));
  });

  it('offers the review when the game has ended on its own after the final week', async () => {
    const onEnded = vi.fn();
    render(
      <FacilitatorConsole
        api={api({ lobby: vi.fn().mockResolvedValue({ ...lobby, status: 'ENDED' }) })}
        gameId="g"
        sessionId="s"
        onEnded={onEnded}
      />,
    );
    expect((await screen.findByRole('button', { name: '終了する' })).hasAttribute('disabled')).toBe(
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: '振り返りを見る' }));
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('cancels an irreversible end action without sending a command', async () => {
    const lifecycle = vi.fn();
    render(
      <FacilitatorConsole
        api={api({ lobby: vi.fn().mockResolvedValue(lobby), lifecycle })}
        gameId="g"
        sessionId="s"
        onEnded={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '終了する' }));
    expect(screen.getByRole('dialog').textContent).toContain('終了');
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(lifecycle).not.toHaveBeenCalled();
  });

  it('confirms a proxy decision with role and quantity', async () => {
    const proxyDecision = vi.fn().mockResolvedValue({ version: 1 });
    render(
      <FacilitatorConsole
        api={api({ lobby: vi.fn().mockResolvedValue(lobby), proxyDecision })}
        gameId="g"
        sessionId="s"
        onEnded={vi.fn()}
      />,
    );
    fireEvent.change(await screen.findByLabelText('代理入力の役割'), {
      target: { value: 'FACTORY' },
    });
    fireEvent.change(screen.getByLabelText('代理入力の数量'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: '代理入力を確認' }));
    expect(screen.getByRole('dialog').textContent).toContain('FACTORY');
    expect(screen.getByRole('dialog').textContent).toContain('7');
    fireEvent.click(screen.getByRole('button', { name: '確定する' }));
    await waitFor(() =>
      expect(proxyDecision).toHaveBeenCalledWith('s', 'FACTORY', 7, 0, expect.any(String)),
    );
  });

  it('reports a stale commit and retains the current view for refresh', async () => {
    const all = {
      ...lobby,
      decisions: { ...lobby.decisions!, FACTORY: { complete: true, version: 1 } },
    };
    render(
      <FacilitatorConsole
        api={api({
          lobby: vi.fn().mockResolvedValue(all),
          commit: vi.fn().mockRejectedValue({ status: 412 }),
        })}
        gameId="g"
        sessionId="s"
        onEnded={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '週を確定' }));
    fireEvent.click(screen.getByRole('button', { name: '確定する' }));
    expect((await screen.findByRole('alert')).textContent).toContain('最新状態');
    expect(screen.getByRole('button', { name: '手動更新' })).toBeTruthy();
  });

  it('offers automatic update pause and a manual refresh', async () => {
    const load = vi.fn().mockResolvedValue(lobby);
    render(
      <FacilitatorConsole api={api({ lobby: load })} gameId="g" sessionId="s" onEnded={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '自動更新を停止' }));
    fireEvent.click(screen.getByRole('button', { name: '手動更新' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: '自動更新を再開' })).toBeTruthy();
  });
});
