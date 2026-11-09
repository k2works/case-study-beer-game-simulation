import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserApi, BrowserApiError } from '../../src/ui/browser-api.js';

describe('Given the same-origin browser adapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends credentials and idempotency on a create command', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ gameId: 'g', sessionId: 's', joinCode: 'ABCD1234', version: 1 }),
          { status: 201 },
        ),
      );
    const api = new BrowserApi(fetcher);
    await api.createGame({ finalWeek: 1, demand: [4], retentionDays: 90 }, 'create-1');
    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/games',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.objectContaining({ 'Idempotency-Key': 'create-1' }),
      }),
    );
  });

  it('sends If-Match and idempotency for role assignment', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ participantId: 'p', role: 'RETAILER', version: 1 }), {
        status: 200,
      }),
    );
    const api = new BrowserApi(fetcher);
    await api.assignRole('g', 'p', 'RETAILER', 1, 'role-1');
    expect(fetcher).toHaveBeenCalledWith(
      '/api/v1/games/g/participants/p/role',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'include',
        headers: expect.objectContaining({ 'If-Match': '1', 'Idempotency-Key': 'role-1' }),
      }),
    );
  });

  it('maps a problem response to a code without exposing its body in UI messages', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ title: 'VERSION_CONFLICT', detail: 'private data', status: 412 }),
          { status: 412 },
        ),
      );
    const api = new BrowserApi(fetcher);
    await expect(api.assignRole('g', 'p', 'RETAILER', 1, 'role-1')).rejects.toMatchObject({
      status: 412,
      code: 'VERSION_CONFLICT',
    } satisfies Partial<BrowserApiError>);
  });

  it('calls the native browser fetch with its required global receiver', async () => {
    const native = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new Error('Illegal invocation');
      return Promise.resolve(new Response(JSON.stringify({ gameId: 'g' }), { status: 201 }));
    });
    vi.stubGlobal('fetch', native);
    await expect(
      new BrowserApi().createGame({ finalWeek: 1, demand: [4], retentionDays: 90 }, 'key'),
    ).resolves.toMatchObject({ gameId: 'g' });
  });
});
