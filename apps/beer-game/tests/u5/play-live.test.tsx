// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoleDecisionForm, PlayPage } from '../../src/ui/PlayPage.js';
import type { BrowserApi, RoleState } from '../../src/ui/browser-api.js';

const state: RoleState = {
  sessionId: 's',
  week: 1,
  status: 'ACTIVE',
  version: 2,
  decisionVersion: 0,
  decisionComplete: false,
  own: { role: 'RETAILER', inventory: 12, backlog: 3, arrivals: 4, order: 5 },
};
const api = (methods: Record<string, unknown>) => methods as unknown as BrowserApi;
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('Given a participant’s current week', () => {
  it('shows twelve steps and only the own role values', async () => {
    render(
      <PlayPage
        api={api({ state: vi.fn().mockResolvedValue(state) })}
        gameId="g"
        sessionId="s"
        onReview={vi.fn()}
      />,
    );
    expect(await screen.findByText('RETAILER')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(12);
    expect(screen.getAllByRole('listitem')[7].getAttribute('aria-current')).toBe('step');
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.queryByText('WHOLESALER')).toBeNull();
  });

  it('keeps an invalid decimal draft and focuses its error', async () => {
    const decision = vi.fn();
    render(<RoleDecisionForm state={state} api={api({ decision })} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('発注量'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: '発注を保存' }));
    expect(decision).not.toHaveBeenCalled();
    expect((screen.getByLabelText('発注量') as HTMLInputElement).value).toBe('2.5');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')));
  });

  it('sends the own decision version and announces a successful save', async () => {
    const decision = vi.fn().mockResolvedValue({ version: 1 });
    render(<RoleDecisionForm state={state} api={api({ decision })} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('発注量'), { target: { value: '8' } });
    fireEvent.click(screen.getByRole('button', { name: '発注を保存' }));
    await waitFor(() => expect(decision).toHaveBeenCalledWith('s', 8, 0, expect.any(String)));
    expect((await screen.findByRole('status')).textContent).toContain('保存しました');
  });

  it('keeps a draft and shows the latest version after conflict', async () => {
    const decision = vi.fn().mockRejectedValue({ status: 412, code: 'VERSION_CONFLICT' });
    const current = vi.fn().mockResolvedValue({ ...state, decisionVersion: 1 });
    render(
      <RoleDecisionForm state={state} api={api({ decision, state: current })} onSaved={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('発注量'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: '発注を保存' }));
    expect((await screen.findByRole('alert')).textContent).toContain('最新の入力版 1');
    expect((screen.getByLabelText('発注量') as HTMLInputElement).value).toBe('9');
  });

  it('disables decisions when paused', () => {
    render(
      <RoleDecisionForm state={{ ...state, status: 'PAUSED' }} api={api({})} onSaved={vi.fn()} />,
    );
    expect((screen.getByRole('button', { name: '発注を保存' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/進行役の再開を待ってください/)).toBeTruthy();
  });

  it('stops automatic updates and keeps a manual refresh action', async () => {
    const sources: { listeners: Record<string, () => void>; close: ReturnType<typeof vi.fn> }[] =
      [];
    class Source {
      listeners: Record<string, () => void> = {};
      close = vi.fn();
      onerror = null;
      onopen = null;
      constructor() {
        sources.push(this);
      }
      addEventListener(name: string, listener: () => void) {
        this.listeners[name] = listener;
      }
    }
    vi.stubGlobal('EventSource', Source);
    const load = vi.fn().mockResolvedValue(state);
    render(<PlayPage api={api({ state: load })} gameId="g" sessionId="s" onReview={vi.fn()} />);
    await screen.findByText('RETAILER');
    fireEvent.click(screen.getByRole('button', { name: '自動更新を停止' }));
    sources[0]?.listeners['state-version']?.();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '手動更新' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(sources[0]?.close).toHaveBeenCalled();
  });

  it('announces polling fallback when SSE is unavailable', async () => {
    vi.stubGlobal('EventSource', undefined);
    render(
      <PlayPage
        api={api({ state: vi.fn().mockResolvedValue(state) })}
        gameId="g"
        sessionId="s"
        onReview={vi.fn()}
      />,
    );
    expect((await screen.findByRole('status')).textContent).toContain('再接続中');
  });
});
