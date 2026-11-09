// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateGameForm, JoinAndRecovery, Lobby } from '../../src/ui/CreateJoinLobby.js';
import { App } from '../../src/ui/App.js';
import type { BrowserApi, LobbyState } from '../../src/ui/browser-api.js';

const api = (methods: Record<string, unknown>) => methods as unknown as BrowserApi;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Given a facilitator creating a game', () => {
  it('keeps invalid custom demand and focuses the error summary', async () => {
    const createGame = vi.fn();
    render(<CreateGameForm api={api({ createGame })} onLobby={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('カスタム条件'));
    fireEvent.change(screen.getByLabelText('最終週'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('需要系列（カンマ区切り）'), {
      target: { value: '2, 4' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ゲームを作成' }));
    expect(createGame).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('需要系列');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')));
    expect((screen.getByLabelText('需要系列（カンマ区切り）') as HTMLTextAreaElement).value).toBe(
      '2, 4',
    );
  });

  it('shows the join code and moves focus after successful creation', async () => {
    const createGame = vi
      .fn()
      .mockResolvedValue({ gameId: 'g', sessionId: 's', joinCode: 'ABCD1234', version: 1 });
    render(<CreateGameForm api={api({ createGame })} onLobby={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'ゲームを作成' }));
    const code = await screen.findByText('ABCD1234');
    await waitFor(() => expect(document.activeElement).toBe(code));
    expect(createGame).toHaveBeenCalledWith(
      expect.objectContaining({ finalWeek: 12, retentionDays: 90 }),
      expect.any(String),
    );
    expect(screen.getByRole('button', { name: 'ロビーへ' })).toBeTruthy();
  });

  it('opens the created lobby only when requested', async () => {
    const onLobby = vi.fn();
    render(
      <CreateGameForm
        api={api({
          createGame: vi
            .fn()
            .mockResolvedValue({ gameId: 'g', sessionId: 's', joinCode: 'ABCD1234', version: 1 }),
        })}
        onLobby={onLobby}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'ゲームを作成' }));
    fireEvent.click(await screen.findByRole('button', { name: 'ロビーへ' }));
    expect(onLobby).toHaveBeenCalledWith('g');
  });
});

describe('Given a participant joining or recovering', () => {
  it('keeps the entered code and name when a code is invalid', async () => {
    const join = vi.fn().mockRejectedValue(new Error('JOIN_CODE_NOT_FOUND'));
    render(<JoinAndRecovery api={api({ join })} onJoined={vi.fn()} onRecovered={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('参加コード'), { target: { value: 'BADCODE' } });
    fireEvent.change(screen.getByLabelText('表示名'), { target: { value: 'Aki' } });
    fireEvent.click(screen.getByRole('button', { name: '参加する' }));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('参加コード') as HTMLInputElement).value).toBe('BADCODE');
    expect((screen.getByLabelText('表示名') as HTMLInputElement).value).toBe('Aki');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')));
  });

  it('joins by code without putting a credential in the page', async () => {
    const join = vi.fn().mockResolvedValue({ gameId: 'g', sessionId: 's', participantId: 'p' });
    const onJoined = vi.fn();
    render(<JoinAndRecovery api={api({ join })} onJoined={onJoined} onRecovered={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('参加コード'), { target: { value: 'ABCD1234' } });
    fireEvent.change(screen.getByLabelText('表示名'), { target: { value: 'Aki' } });
    fireEvent.click(screen.getByRole('button', { name: '参加する' }));
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith('g'));
    expect(document.body.textContent).not.toContain('recoveryToken');
  });

  it('recovers from an HttpOnly cookie and opens the same session', async () => {
    const recover = vi
      .fn()
      .mockResolvedValue({ gameId: 'g', state: { sessionId: 's', own: { role: 'RETAILER' } } });
    const onRecovered = vi.fn();
    render(<JoinAndRecovery api={api({ recover })} onJoined={vi.fn()} onRecovered={onRecovered} />);
    fireEvent.click(screen.getByRole('button', { name: '復帰する' }));
    await waitFor(() => expect(onRecovered).toHaveBeenCalledWith('g', 's'));
    expect(recover).toHaveBeenCalledWith();
  });
});

const lobby: LobbyState = {
  gameId: 'g',
  sessionId: 's',
  week: 1,
  status: 'LOBBY',
  version: 1,
  joinCode: 'ABCD1234',
  participants: [{ participantId: 'p', displayName: 'Aki' }],
};

describe('Given a lobby', () => {
  it('blocks start until four roles are assigned', async () => {
    render(
      <Lobby
        api={api({ lobby: vi.fn().mockResolvedValue(lobby) })}
        gameId="g"
        facilitator
        onStarted={vi.fn()}
      />,
    );
    expect(await screen.findByText('ABCD1234')).toBeTruthy();
    expect((screen.getByRole('button', { name: '開始する' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/役割が 4 つ揃うと開始できます/)).toBeTruthy();
  });

  it('hides invitation code and role assignment from participants', async () => {
    render(
      <Lobby
        api={api({ lobby: vi.fn().mockResolvedValue({ ...lobby, joinCode: undefined }) })}
        gameId="g"
        facilitator={false}
        onStarted={vi.fn()}
      />,
    );
    await screen.findByText('Aki');
    expect(screen.queryByText('ABCD1234')).toBeNull();
    expect(screen.queryByRole('button', { name: '開始する' })).toBeNull();
    expect(screen.queryByLabelText('Aki の役割')).toBeNull();
  });

  it('moves a participant to play after the facilitator starts', async () => {
    const onStarted = vi.fn();
    render(
      <Lobby
        api={api({
          lobby: vi.fn().mockResolvedValue({ ...lobby, status: 'ACTIVE', joinCode: undefined }),
        })}
        gameId="g"
        facilitator={false}
        onStarted={onStarted}
      />,
    );
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith('s'));
  });

  it('assigns a selected role with the displayed lobby version', async () => {
    const assignRole = vi
      .fn()
      .mockResolvedValue({ participantId: 'p', role: 'RETAILER', version: 1 });
    const load = vi
      .fn()
      .mockResolvedValueOnce(lobby)
      .mockResolvedValue({
        ...lobby,
        participants: [{ participantId: 'p', displayName: 'Aki', role: 'RETAILER' }],
      });
    render(
      <Lobby api={api({ lobby: load, assignRole })} gameId="g" facilitator onStarted={vi.fn()} />,
    );
    fireEvent.change(await screen.findByLabelText('Aki の役割'), { target: { value: 'RETAILER' } });
    fireEvent.click(screen.getByRole('button', { name: '割り当てる' }));
    await waitFor(() =>
      expect(assignRole).toHaveBeenCalledWith('g', 'p', 'RETAILER', 1, expect.any(String)),
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText('RETAILER').length).toBeGreaterThan(1);
  });
});

describe('Given the browser entry', () => {
  it('opens the create form and then the facilitator lobby', async () => {
    const browser = api({
      createGame: vi
        .fn()
        .mockResolvedValue({ gameId: 'g', sessionId: 's', joinCode: 'ABCD1234', version: 1 }),
      lobby: vi.fn().mockResolvedValue(lobby),
    });
    render(<App api={browser} />);
    fireEvent.click(screen.getByRole('button', { name: 'ゲームを作る' }));
    fireEvent.click(screen.getByRole('button', { name: 'ゲームを作成' }));
    fireEvent.click(await screen.findByRole('button', { name: 'ロビーへ' }));
    expect(await screen.findByRole('heading', { name: 'ロビー' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '開始する' })).toBeTruthy();
  });

  it('opens the facilitator console after all roles start', async () => {
    const ready = {
      ...lobby,
      participants: [
        { participantId: 'r', displayName: 'R', role: 'RETAILER' },
        { participantId: 'w', displayName: 'W', role: 'WHOLESALER' },
        { participantId: 'd', displayName: 'D', role: 'DISTRIBUTOR' },
        { participantId: 'f', displayName: 'F', role: 'FACTORY' },
      ],
    };
    const browser = api({
      createGame: vi
        .fn()
        .mockResolvedValue({ gameId: 'g', sessionId: 's', joinCode: 'ABCD1234', version: 1 }),
      lobby: vi.fn().mockResolvedValue(ready),
      lifecycle: vi.fn().mockResolvedValue({ status: 'ACTIVE', version: 2 }),
    });
    render(<App api={browser} />);
    fireEvent.click(screen.getByRole('button', { name: 'ゲームを作る' }));
    fireEvent.click(screen.getByRole('button', { name: 'ゲームを作成' }));
    fireEvent.click(await screen.findByRole('button', { name: 'ロビーへ' }));
    fireEvent.click(await screen.findByRole('button', { name: '開始する' }));
    expect(await screen.findByRole('heading', { name: '進行役' })).toBeTruthy();
  });
});
