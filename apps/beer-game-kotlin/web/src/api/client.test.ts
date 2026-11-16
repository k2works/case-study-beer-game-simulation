import { describe, expect, it, vi } from 'vitest';
import { createHttpApiClient, tabCredentialId } from './client';
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

    it('createGame は、応答の復帰コード（recoveryCode）を、結果に含める', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(
                json(
                    201,
                    { versions: { game: 1, session: null }, recoveryCode: 'RC-FACILITATOR-1' },
                    { location: '/api/v1/games/g-1/state' },
                ),
            );
        const result = await clientWith(fetchMock).createGame({
            kind: 'KIT',
            finalWeek: 12,
            demand: [4],
        });
        expect(result.recoveryCode).toBe('RC-FACILITATOR-1');
    });

    it('joinGame は、応答のゲームの ID（gameId）を、結果に含める', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(json(200, { versions: { game: 2, session: null }, gameId: 'g-7' }));
        const result = await clientWith(fetchMock).joinGame({
            joinCode: 'ABCDEFGH2345',
            displayName: '田中',
        });
        expect(result.gameId).toBe('g-7');
    });

    it('joinWithoutSession は、参加の応答の Cookie を受け取らない（credentials: omit）ので、進行役の資格を上書きしない', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(json(200, { versions: { game: 2, session: null }, gameId: 'g-7' }));
        const result = await clientWith(fetchMock).joinWithoutSession({
            joinCode: 'ABCDEFGH2345',
            displayName: 'ダミー小売店',
        });
        expect(result.gameId).toBe('g-7');
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/v1/participations/join');
        expect(init.credentials).toBe('omit');
        expect(headerOf(fetchMock.mock.calls[0] as unknown[], 'Idempotency-Key')).toBe('key-1');
    });

    it('submitProxyDecision は、役割の URL へ PUT し、冪等キーを付け、If-Match は付けない', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(json(200, { versions: { game: null, session: 6 } }));
        const result = await clientWith(fetchMock).submitProxyDecision('s-1', 'FACTORY', {
            requestedWeek: 2,
            quantity: 4,
        });
        expect(result.versions.session).toBe(6);
        const call = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(call[0]).toBe('/api/v1/sessions/s-1/proxy-decisions/FACTORY');
        expect(call[1].method).toBe('PUT');
        expect(JSON.parse(call[1].body as string)).toEqual({ requestedWeek: 2, quantity: 4 });
        expect(headerOf(call, 'Idempotency-Key')).toBe('key-1');
        expect(headerOf(call, 'If-Match')).toBeNull();
    });

    it('すべての要求に、タブの識別子（X-Tab-Id）を付ける（読み取りにも、変更にも）', async () => {
        const fetchMock = vi
            .fn()
            .mockImplementation(() => Promise.resolve(json(200, { versions: { game: 1 } })));
        const client = createHttpApiClient({
            fetch: fetchMock,
            newKey: () => 'k',
            tabId: 'tabid0123456789ab',
        });
        await client.getLobby('g-1');
        await client.startGame('g-1');
        for (const call of fetchMock.mock.calls as unknown[][]) {
            expect(headerOf(call, 'X-Tab-Id')).toBe('tabid0123456789ab');
        }
    });

    it('tabCredentialId は、タブ（sessionStorage）ごとに一度作り、以後は同じ値を返す。形は英数字 32 文字', () => {
        sessionStorage.clear();
        const first = tabCredentialId();
        expect(first).toMatch(/^[A-Za-z0-9]{32}$/);
        expect(tabCredentialId()).toBe(first);
        sessionStorage.clear();
        expect(tabCredentialId()).not.toBe(first);
    });

    it('pauseSession・resumeSession は、本文なしで POST し、冪等キーを付ける', async () => {
        const fetchMock = vi
            .fn()
            .mockImplementation(() =>
                Promise.resolve(json(200, { versions: { game: null, session: 4 } })),
            );
        const client = clientWith(fetchMock);
        await client.pauseSession('s-1');
        await client.resumeSession('s-1');
        const pause = fetchMock.mock.calls[0]!;
        const resume = fetchMock.mock.calls[1]!;
        expect(pause[0]).toBe('/api/v1/sessions/s-1/pause');
        expect(resume[0]).toBe('/api/v1/sessions/s-1/resume');
        expect((pause[1] as RequestInit).method).toBe('POST');
        expect((pause[1] as RequestInit).body).toBeUndefined();
        expect(headerOf(pause, 'Idempotency-Key')).toBe('key-1');
        expect(headerOf(resume, 'Idempotency-Key')).toBe('key-2');
    });

    it('recoverParticipation は、ゲームの ID と復帰コードを POST し、復帰先（gameId・kind・role）を返す', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            json(200, {
                versions: { game: 3, session: 2 },
                gameId: 'g-1',
                kind: 'PARTICIPANT',
                role: 'FACTORY',
            }),
        );
        const result = await clientWith(fetchMock).recoverParticipation({
            gameId: 'g-1',
            recoveryCode: 'RC-1',
        });
        const call = fetchMock.mock.calls[0]!;
        expect(call[0]).toBe('/api/v1/participations/recover');
        expect((call[1] as RequestInit).method).toBe('POST');
        expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
            gameId: 'g-1',
            recoveryCode: 'RC-1',
        });
        expect(result).toMatchObject({ gameId: 'g-1', kind: 'PARTICIPANT', role: 'FACTORY' });
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
