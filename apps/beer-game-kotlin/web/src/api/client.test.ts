import { describe, expect, it, vi } from 'vitest';
import { createHttpApiClient } from './client';
import { ApiError, NetworkError } from './errors';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });

const problem = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/problem+json' },
    });

function clientWith(fetchImpl: typeof fetch, keys: string[] = ['key-1', 'key-2', 'key-3']) {
    let i = 0;
    return createHttpApiClient({
        fetch: fetchImpl,
        newKey: () => keys[i++] ?? `key-extra-${i}`,
        resendDelayMs: 0,
        maxResends: 2,
    });
}

function headerOf(call: unknown[], name: string): string | null {
    const init = call[1] as RequestInit;
    return new Headers(init.headers).get(name);
}

describe('ApiClient（fetch の薄い包み）', () => {
    it('createGame は、冪等キーつきで POST し、Location からゲームの ID を取り出す', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                json(
                    201,
                    { versions: { game: 1, session: null } },
                    { location: '/api/v1/games/11111111-1111-4111-8111-111111111111/state' },
                ),
            );
        const result = await clientWith(fetchMock).createGame({
            kind: 'KIT',
            finalWeek: 12,
            demand: [4, 4],
        });
        expect(result.gameId).toBe('11111111-1111-4111-8111-111111111111');
        expect(result.versions).toEqual({ game: 1, session: null });
        const call = fetchMock.mock.calls[0]!;
        expect(call[0]).toBe('/api/v1/games');
        expect((call[1] as RequestInit).method).toBe('POST');
        expect(headerOf(call, 'Idempotency-Key')).toBe('key-1');
        expect(headerOf(call, 'Content-Type')).toBe('application/json');
        expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
            kind: 'KIT',
            finalWeek: 12,
            demand: [4, 4],
        });
    });

    it('saveDecision は、意思決定の版を If-Match に付け、PUT する', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(json(200, { versions: { game: null, session: 7 } }));
        await clientWith(fetchMock).saveDecision('s-1', { week: 2, quantity: 9 }, 3);
        const call = fetchMock.mock.calls[0]!;
        expect(call[0]).toBe('/api/v1/sessions/s-1/decisions');
        expect((call[1] as RequestInit).method).toBe('PUT');
        expect(headerOf(call, 'If-Match')).toBe('"3"');
        expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
            week: 2,
            quantity: 9,
        });
    });

    it('commitWeek は、If-Match を付けず、経路に週を含める', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(json(200, { versions: { game: null, session: 9 } }));
        const basis = { FACTORY: 1, DISTRIBUTOR: 1, WHOLESALER: 1, RETAILER: 1 };
        await clientWith(fetchMock).commitWeek('s-1', { requestedWeek: 3, basis });
        const call = fetchMock.mock.calls[0]!;
        expect(call[0]).toBe('/api/v1/sessions/s-1/weeks/3/commit');
        expect(headerOf(call, 'If-Match')).toBeNull();
        expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
            requestedWeek: 3,
            basis,
        });
    });

    it('問い合わせ（GET）には、冪等キーを付けない', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            json(200, {
                gameId: 'g',
                sessionId: null,
                status: 'PREPARING',
                versions: { game: 1, session: null },
            }),
        );
        await clientWith(fetchMock).getGameState('g');
        const call = fetchMock.mock.calls[0]!;
        expect(call[0]).toBe('/api/v1/games/g/state');
        expect(headerOf(call, 'Idempotency-Key')).toBeNull();
    });

    it('失敗は problem+json の code・相関 ID・誤りの配列を持つ ApiError にする', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            problem(422, {
                type: '/problems/validation.invalid_input',
                code: 'validation.invalid_input',
                status: 422,
                correlationId: 'c-9',
                errors: [
                    {
                        field: 'demand',
                        week: 5,
                        message: '需要は 0 以上 1000 以下の整数にしてください',
                    },
                ],
            }),
        );
        const error = await clientWith(fetchMock)
            .createGame({ kind: 'KIT', finalWeek: 12, demand: [] })
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ApiError);
        const apiError = error as ApiError;
        expect(apiError.status).toBe(422);
        expect(apiError.code).toBe('validation.invalid_input');
        expect(apiError.correlationId).toBe('c-9');
        expect(apiError.errors).toEqual([
            { field: 'demand', week: 5, message: '需要は 0 以上 1000 以下の整数にしてください' },
        ]);
    });

    it('type の無い 5xx（LB の 503 など）は、結果が不明として、同じキーで再送する', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 503 }))
            .mockResolvedValueOnce(
                json(
                    201,
                    { versions: { game: 1, session: null } },
                    { location: '/api/v1/games/g-1/state' },
                ),
            );
        const result = await clientWith(fetchMock).createGame({
            kind: 'KIT',
            finalWeek: 12,
            demand: [4],
        });
        expect(result.gameId).toBe('g-1');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(headerOf(fetchMock.mock.calls[0]!, 'Idempotency-Key')).toBe('key-1');
        expect(headerOf(fetchMock.mock.calls[1]!, 'Idempotency-Key')).toBe('key-1');
    });

    it('通信の切断も、同じキーで再送する。上限まで続けば NetworkError を投げる', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
        const error = await clientWith(fetchMock)
            .createGame({ kind: 'KIT', finalWeek: 12, demand: [4] })
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NetworkError);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        const keys = fetchMock.mock.calls.map((c) => headerOf(c, 'Idempotency-Key'));
        expect(keys).toEqual(['key-1', 'key-1', 'key-1']);
    });

    it('type を持つ 503（app.retry_exhausted）は、実行されていないので再送せず、そのまま失敗にする', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            problem(503, {
                type: '/problems/app.retry_exhausted',
                code: 'app.retry_exhausted',
                status: 503,
                correlationId: 'c-1',
            }),
        );
        const error = await clientWith(fetchMock)
            .startGame('g-1')
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe('app.retry_exhausted');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('4xx の業務の失敗は再送しない', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            problem(409, {
                type: '/problems/session.already_started',
                code: 'session.already_started',
                status: 409,
            }),
        );
        await expect(clientWith(fetchMock).startGame('g-1')).rejects.toBeInstanceOf(ApiError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('利用者が操作し直したときは、新しいキーを使う', async () => {
        // Response の本文は一度しか読めないので、呼ばれるたびに新しい応答を返す
        const fetchMock = vi
            .fn()
            .mockImplementation(() =>
                Promise.resolve(json(200, { versions: { game: 2, session: 1 } })),
            );
        const client = clientWith(fetchMock);
        await client.startGame('g-1');
        await client.startGame('g-1');
        expect(headerOf(fetchMock.mock.calls[0]!, 'Idempotency-Key')).toBe('key-1');
        expect(headerOf(fetchMock.mock.calls[1]!, 'Idempotency-Key')).toBe('key-2');
    });
});
