import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveStateAdapter } from '../../src/ui/LiveStateAdapter.js';

type Snapshot = { version: number; value: string };
class FakeSource {
  listeners = new Map<string, () => void>();
  onerror?: () => void;
  onopen?: () => void;
  close = vi.fn();
  addEventListener(name: string, listener: () => void) {
    this.listeners.set(name, listener);
  }
  emit() {
    this.listeners.get('state-version')?.();
  }
}

afterEach(() => vi.useRealTimers());

describe('Given a live state adapter', () => {
  it('refreshes on a version notification and discards an older response', async () => {
    const source = new FakeSource();
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({ version: 2, value: 'current' })
      .mockResolvedValueOnce({ version: 3, value: 'new' })
      .mockResolvedValueOnce({ version: 1, value: 'old' });
    const updated = vi.fn();
    const adapter = new LiveStateAdapter<Snapshot>(
      '/api/v1/games/g/events',
      snapshot,
      updated,
      () => source,
    );
    await adapter.start();
    source.emit();
    await vi.waitFor(() => expect(updated).toHaveBeenCalledTimes(2));
    source.emit();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(3));
    expect(updated.mock.calls.map(([state]) => state.value)).toEqual(['current', 'new']);
    adapter.stop();
  });

  it('polls every second during SSE failure and stops on reconnect', async () => {
    vi.useFakeTimers();
    const source = new FakeSource();
    const snapshot = vi.fn().mockResolvedValue({ version: 1, value: 'current' });
    const adapter = new LiveStateAdapter<Snapshot>(
      '/api/v1/games/g/events',
      snapshot,
      vi.fn(),
      () => source,
    );
    await adapter.start();
    source.onerror?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(snapshot).toHaveBeenCalledTimes(2);
    source.onopen?.();
    await vi.advanceTimersByTimeAsync(2000);
    expect(snapshot).toHaveBeenCalledTimes(3);
    adapter.stop();
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it('stops automatic requests but retains manual refresh', async () => {
    vi.useFakeTimers();
    const source = new FakeSource();
    const snapshot = vi.fn().mockResolvedValue({ version: 1, value: 'current' });
    const adapter = new LiveStateAdapter<Snapshot>(
      '/api/v1/games/g/events',
      snapshot,
      vi.fn(),
      () => source,
    );
    await adapter.start();
    source.onerror?.();
    adapter.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(snapshot).toHaveBeenCalledTimes(1);
    await adapter.refresh();
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it('announces fallback and reconnection without leaking state', async () => {
    const source = new FakeSource();
    const connection = vi.fn();
    const adapter = new LiveStateAdapter<Snapshot>(
      '/api/v1/games/g/events',
      vi.fn().mockResolvedValue({ version: 1, value: 'current' }),
      vi.fn(),
      () => source,
      connection,
    );
    await adapter.start();
    source.onerror?.();
    expect(connection).toHaveBeenCalledWith('polling');
    source.onopen?.();
    expect(connection).toHaveBeenCalledWith('connected');
    adapter.stop();
  });
});
