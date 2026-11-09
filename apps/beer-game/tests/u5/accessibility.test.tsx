// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App.js';
import { CreateGameForm } from '../../src/ui/CreateJoinLobby.js';
import { FacilitatorConsole } from '../../src/ui/FacilitatorConsole.js';
import { LiveStateAdapter } from '../../src/ui/LiveStateAdapter.js';
import type { BrowserApi } from '../../src/ui/browser-api.js';

const api = (methods: Record<string, unknown>) => methods as unknown as BrowserApi;
afterEach(() => {
  document.body.innerHTML = '';
});

describe('Given keyboard and screen reader use', () => {
  it('offers a skip link to the main landmark and one page title', () => {
    render(<App api={api({})} />);
    expect(screen.getByRole('link', { name: '本文へスキップ' }).getAttribute('href')).toBe('#main');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('main').id).toBe('main');
  });

  it('describes a custom demand error on the field as well as in the summary', async () => {
    render(<CreateGameForm api={api({ createGame: vi.fn() })} onLobby={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('カスタム条件'));
    fireEvent.change(screen.getByLabelText('最終週'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('需要系列（カンマ区切り）'), {
      target: { value: '1, 2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ゲームを作成' }));
    const field = screen.getByLabelText('需要系列（カンマ区切り）');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    const describedBy = field.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain('需要系列');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')));
  });

  it('keeps focus inside a confirmation dialog and restores its trigger on Escape', async () => {
    const lobby = {
      gameId: 'g',
      sessionId: 's',
      week: 1,
      version: 2,
      status: 'ACTIVE',
      participants: [],
      decisions: {},
    };
    render(
      <FacilitatorConsole
        api={api({ lobby: vi.fn().mockResolvedValue(lobby) })}
        gameId="g"
        sessionId="s"
        onEnded={vi.fn()}
      />,
    );
    const trigger = await screen.findByRole('button', { name: '終了する' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('heading', { name: '操作の確認' })),
    );
    const confirm = screen.getByRole('button', { name: '確定する' });
    confirm.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'キャンセル' }));
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('announces only one update for duplicate equal snapshots', async () => {
    const source = { addEventListener: vi.fn(), onerror: null, onopen: null, close: vi.fn() };
    const updated = vi.fn();
    const adapter = new LiveStateAdapter(
      '/events',
      vi.fn().mockResolvedValue({ version: 3, value: 'same' }),
      updated,
      () => source,
    );
    await adapter.start();
    await adapter.refresh();
    expect(updated).toHaveBeenCalledTimes(1);
    adapter.stop();
  });
});
