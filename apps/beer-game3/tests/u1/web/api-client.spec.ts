import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, newIdempotencyKey } from '../../../src/web/api.js';
import { createBrowserStorage } from '../../../src/web/storage.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const credential = { kind: 'participant', secret: 'tok_abc', gameId: 'g 1' } as const;

describe('API クライアント', () => {
  it('資格情報は Authorization ヘッダで送り、URL には載せない。識別子は Idempotency-Key で送る', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { week: 1, role: 'retailer', quantity: 3, version: 2 }),
    );
    const api = createApi(fetchMock);
    await api.submitDecision(credential, 2, 'retailer', 3, 'key-0123456789abcdef');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/games/g%201/weeks/2/decisions/retailer');
    expect(url).not.toContain('tok_abc');
    expect(init.method).toBe('PUT');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer tok_abc',
      'idempotency-key': 'key-0123456789abcdef',
      'content-type': 'application/json',
    });
    expect(init.body).toBe('{"quantity":3}');
  });

  it('各入口の URL と方法', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    const api = createApi(fetchMock);
    await api.createGame({ name: 'x' });
    await api.join({ joinCode: 'A', displayName: 'B' });
    await api.me('fac_x');
    await api.getState(credential);
    await api.getCodes(credential);
    await api.assign(credential, 'p1', 'factory');
    await api.start(credential);
    await api.confirmWeek(credential, 3, 'key-0123456789abcdef');
    const calls = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>).map(
      ([url, init]) => `${init.method} ${url}`,
    );
    expect(calls).toEqual([
      'POST /api/games',
      'POST /api/games/join',
      'GET /api/me',
      'GET /api/games/g%201/state',
      'GET /api/games/g%201/codes',
      'PUT /api/games/g%201/assignments/p1',
      'POST /api/games/g%201/start',
      'POST /api/games/g%201/weeks/3/confirm',
    ]);
  });

  it('Problem の応答は ApiError にして、種類・理由・項目ごとの理由を取り出せる', async () => {
    const api = createApi(async () =>
      jsonResponse(422, {
        kind: 'validation',
        reason: '誤り',
        hint: '直し方',
        fields: [{ path: 'weekCount', message: '1〜50' }],
      }),
    );
    const error = (await api.createGame({}).catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe('validation');
    expect(error.fieldMessage('weekCount')).toBe('1〜50');
    expect(error.fieldMessage('name')).toBeUndefined();
  });

  it('通信の断と、Problem でない応答は区別して扱う', async () => {
    const offline = createApi(async () => {
      throw new TypeError('failed to fetch');
    });
    await expect(offline.me('x')).rejects.toMatchObject({ kind: 'network' });
    const odd = createApi(async () => new Response('<html>', { status: 502 }));
    await expect(odd.me('x')).rejects.toMatchObject({ kind: 'internal', problem: null });
  });

  it('識別子は 16 文字以上', () => {
    expect(newIdempotencyKey().length).toBeGreaterThanOrEqual(16);
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
  });
});

describe('資格情報の保存', () => {
  function stubStorage() {
    const make = () => {
      const data = new Map<string, string>();
      return {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => void data.set(key, value),
        removeItem: (key: string) => void data.delete(key),
      };
    };
    vi.stubGlobal('localStorage', make());
    vi.stubGlobal('sessionStorage', make());
  }

  it('参加者の token は localStorage、進行役用コードは sessionStorage に保存し、消せる', () => {
    stubStorage();
    const storage = createBrowserStorage();
    expect(storage.load()).toBeNull();
    storage.save({ kind: 'participant', secret: 'tok_a', gameId: 'g1' });
    expect(localStorage.getItem('beerGame3.participant')).toContain('tok_a');
    expect(sessionStorage.getItem('beerGame3.participant')).toBeNull();
    expect(storage.load()).toEqual({ kind: 'participant', secret: 'tok_a', gameId: 'g1' });
    storage.save({ kind: 'facilitator', secret: 'fac_a', gameId: 'g1' });
    expect(sessionStorage.getItem('beerGame3.facilitator')).toContain('fac_a');
    expect(localStorage.getItem('beerGame3.facilitator')).toBeNull();
    expect(storage.load()?.kind).toBe('facilitator');
    storage.clear();
    expect(storage.load()).toBeNull();
    vi.unstubAllGlobals();
  });

  it('保存先が使えない・壊れているときは、例外にせず、保存なしとして動く', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    vi.stubGlobal('localStorage', broken);
    vi.stubGlobal('sessionStorage', broken);
    const storage = createBrowserStorage();
    expect(storage.load()).toBeNull();
    expect(() => storage.save({ kind: 'participant', secret: 's', gameId: 'g' })).not.toThrow();
    expect(() => storage.clear()).not.toThrow();
    vi.unstubAllGlobals();
    stubStorage();
    localStorage.setItem('beerGame3.participant', '{not json');
    expect(createBrowserStorage().load()).toBeNull();
    localStorage.setItem('beerGame3.participant', JSON.stringify({ secret: 1 }));
    expect(createBrowserStorage().load()).toBeNull();
    vi.unstubAllGlobals();
  });
});
