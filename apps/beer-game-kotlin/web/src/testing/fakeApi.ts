import { vi } from 'vitest';
import type { ApiClient } from '../api/client';
import type { GameState, Lobby, SessionState, StreamVersions } from '../api/types';

type Spied = { [K in keyof ApiClient]: ReturnType<typeof vi.fn> & ApiClient[K] };

/**
 * ApiClient の代わり。呼ばれると想定していないメソッドは、呼ばれたら失敗する（常に通るテストにしない）。
 */
export function fakeApi(overrides: Partial<ApiClient> = {}): Spied {
    const unexpected = (name: string) =>
        vi.fn(() => Promise.reject(new Error(`想定外の呼び出し: ${name}`)));
    const base = {
        createGame: unexpected('createGame'),
        getGameState: unexpected('getGameState'),
        getLobby: unexpected('getLobby'),
        getReview: unexpected('getReview'),
        getObservation: unexpected('getObservation'),
        inviteObserver: unexpected('inviteObserver'),
        revokeObserverInvitation: unexpected('revokeObserverInvitation'),
        joinAsObserver: unexpected('joinAsObserver'),
        assignRole: unexpected('assignRole'),
        joinGame: unexpected('joinGame'),
        joinWithoutSession: unexpected('joinWithoutSession'),
        startGame: unexpected('startGame'),
        getSessionState: unexpected('getSessionState'),
        saveDecision: unexpected('saveDecision'),
        commitWeek: unexpected('commitWeek'),
        submitProxyDecision: unexpected('submitProxyDecision'),
        pauseSession: unexpected('pauseSession'),
        resumeSession: unexpected('resumeSession'),
        setCommitMode: unexpected('setCommitMode'),
        recoverParticipation: unexpected('recoverParticipation'),
    };
    const merged: Record<string, unknown> = { ...base };
    for (const [name, impl] of Object.entries(overrides)) {
        merged[name] = vi.fn(impl as (...args: unknown[]) => unknown);
    }
    return merged as unknown as Spied;
}

export const versions = (session: number | null, game: number | null = null): StreamVersions => ({
    game,
    session,
});

export const GAME_ID = '11111111-1111-4111-8111-111111111111';

export function gameState(overrides: Partial<GameState> = {}): GameState {
    return {
        gameId: GAME_ID,
        sessionId: GAME_ID,
        status: 'STARTED',
        settingsKind: 'KIT',
        changedSettings: [],
        commitMode: 'MANUAL',
        versions: versions(1, 10),
        ...overrides,
    };
}

export function lobby(overrides: Partial<Lobby> = {}): Lobby {
    return {
        gameId: GAME_ID,
        status: 'PREPARING',
        joinCode: 'ABCDEFGH2345',
        settingsKind: 'KIT',
        changedSettings: [],
        commitMode: 'MANUAL',
        participants: [],
        invitations: [],
        observers: [],
        versions: versions(null, 3),
        ...overrides,
    };
}

export function roleStatus(overrides: Partial<NonNullable<SessionState['roleStatus']>> = {}) {
    return {
        inventory: 12,
        backlog: 0,
        arrivals: 4,
        orders: 4,
        decision: null,
        decisionVersion: 0,
        decisionEditor: null,
        decisionSavedAt: null,
        ...overrides,
    };
}
