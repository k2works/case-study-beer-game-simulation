import { ApiError, NetworkError } from './errors';
import type {
    CommandResponse,
    CommitWeekRequest,
    CreateGameRequest,
    CreateGameResult,
    GameState,
    CreateGameResponse,
    JoinGameRequest,
    JoinResponse,
    Lobby,
    ProblemBody,
    RecoverRequest,
    RecoverResponse,
    Role,
    SaveDecisionRequest,
    SessionState,
} from './types';

/** 画面から見た API の窓口。コンポーネントのテストでは、これを差し替える（ApiContext）。 */
export interface ApiClient {
    createGame(request: CreateGameRequest): Promise<CreateGameResult>;
    getGameState(gameId: string): Promise<GameState>;
    getLobby(gameId: string): Promise<Lobby>;
    assignRole(gameId: string, participantId: string, role: Role): Promise<CommandResponse>;
    joinGame(request: JoinGameRequest): Promise<JoinResponse>;
    /** 復帰。復帰コードを省くと、Cookie の復帰資格で復帰する。新しいブラウザセッションは Set-Cookie で発行される。 */
    recoverParticipation(request: RecoverRequest): Promise<RecoverResponse>;
    startGame(gameId: string): Promise<CommandResponse>;
    /** 進行役だけ。停止中は、参加者の保存と週の確定を受け付けない。 */
    pauseSession(sessionId: string): Promise<CommandResponse>;
    resumeSession(sessionId: string): Promise<CommandResponse>;
    getSessionState(sessionId: string): Promise<SessionState>;
    /** expectedVersion は、画面が見ている意思決定の版（If-Match）。 */
    saveDecision(
        sessionId: string,
        request: SaveDecisionRequest,
        expectedVersion: number,
    ): Promise<CommandResponse>;
    commitWeek(sessionId: string, request: CommitWeekRequest): Promise<CommandResponse>;
}

export interface HttpApiClientOptions {
    fetch?: typeof fetch;
    /** 冪等キーの作り方。操作（呼び出し）ごとに 1 つ作り、自動の再送でも同じキーを使う。 */
    newKey?: () => string;
    /** 結果が不明なときの再送の間隔（ミリ秒）と、再送の回数の上限。 */
    resendDelayMs?: number;
    maxResends?: number;
}

const BASE = '/api/v1';

function parseBody(text: string): ProblemBody {
    if (text === '') return {};
    try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === 'object' && parsed !== null ? (parsed as ProblemBody) : {};
    } catch {
        // HTML など、problem+json でない本文（LB の応答など）。本文なしの失敗として扱う（状態コードは残す）
        return {};
    }
}

export function createHttpApiClient(options: HttpApiClientOptions = {}): ApiClient {
    const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
    const newKey = options.newKey ?? (() => crypto.randomUUID());
    const resendDelayMs = options.resendDelayMs ?? 500;
    const maxResends = options.maxResends ?? 2;

    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    /** 1 回の送信。通信の失敗は NetworkError、HTTP の失敗は ApiError にする。 */
    async function send(path: string, init: RequestInit): Promise<Response> {
        let response: Response;
        try {
            response = await doFetch(`${BASE}${path}`, { credentials: 'same-origin', ...init });
        } catch (cause) {
            throw new NetworkError('通信に失敗しました', { cause });
        }
        if (!response.ok) {
            throw new ApiError(response.status, parseBody(await response.text()));
        }
        return response;
    }

    async function query<T>(path: string): Promise<T> {
        const response = await send(path, { method: 'GET' });
        return (await response.json()) as T;
    }

    /**
     * 状態を変える操作。冪等キーを 1 つ作り、結果が不明なとき（通信の失敗、type の無い 5xx）は、同じキーで自動で再送する。
     * type を持つ失敗（バックエンド自身が返した失敗。app.retry_exhausted を含む）は、実行されていないので再送しない。
     */
    async function command(
        method: 'POST' | 'PUT',
        path: string,
        body: unknown,
        extraHeaders: Record<string, string> = {},
    ): Promise<Response> {
        const headers = {
            'Content-Type': 'application/json',
            'Idempotency-Key': newKey(),
            ...extraHeaders,
        };
        const init: RequestInit = {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        };
        for (let resends = 0; ; resends++) {
            try {
                return await send(path, init);
            } catch (error) {
                const unknownOutcome =
                    error instanceof NetworkError ||
                    (error instanceof ApiError && error.status >= 500 && error.type === undefined);
                if (!unknownOutcome || resends >= maxResends) throw error;
                await sleep(resendDelayMs);
            }
        }
    }

    async function commandResponse<T extends CommandResponse = CommandResponse>(
        response: Response,
    ): Promise<T> {
        return (await response.json()) as T;
    }

    return {
        async createGame(request) {
            const response = await command('POST', '/games', request);
            const location = response.headers.get('Location') ?? '';
            const gameId = /\/games\/([^/]+)\/state$/.exec(location)?.[1];
            if (gameId === undefined) {
                throw new ApiError(response.status, {
                    detail: '応答の Location からゲームの ID を得られません',
                });
            }
            return { ...(await commandResponse<CreateGameResponse>(response)), gameId };
        },
        getGameState: (gameId) => query<GameState>(`/games/${gameId}/state`),
        getLobby: (gameId) => query<Lobby>(`/games/${gameId}/lobby`),
        async assignRole(gameId, participantId, role) {
            return commandResponse(
                await command('PUT', `/games/${gameId}/participants/${participantId}/role`, {
                    role,
                }),
            );
        },
        async joinGame(request) {
            return commandResponse<JoinResponse>(
                await command('POST', '/participations/join', request),
            );
        },
        async recoverParticipation(request) {
            return commandResponse<RecoverResponse>(
                await command('POST', '/participations/recover', request),
            );
        },
        async pauseSession(sessionId) {
            return commandResponse(
                await command('POST', `/sessions/${sessionId}/pause`, undefined),
            );
        },
        async resumeSession(sessionId) {
            return commandResponse(
                await command('POST', `/sessions/${sessionId}/resume`, undefined),
            );
        },
        async startGame(gameId) {
            return commandResponse(await command('POST', `/games/${gameId}/start`, undefined));
        },
        getSessionState: (sessionId) => query<SessionState>(`/sessions/${sessionId}/state`),
        async saveDecision(sessionId, request, expectedVersion) {
            return commandResponse(
                await command('PUT', `/sessions/${sessionId}/decisions`, request, {
                    'If-Match': `"${expectedVersion}"`,
                }),
            );
        },
        async commitWeek(sessionId, request) {
            return commandResponse(
                await command(
                    'POST',
                    `/sessions/${sessionId}/weeks/${request.requestedWeek}/commit`,
                    request,
                ),
            );
        },
    };
}
