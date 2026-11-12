import { vi } from 'vitest';
import {
  ApiError,
  type ApiClient,
  type Credential,
  type GameStateView,
} from '../../../src/web/api.js';
import type { CredentialStorage } from '../../../src/web/storage.js';
import type { Problem } from '../../../src/server/errors.js';

export function problem(p: Problem): ApiError {
  return new ApiError(p.kind, p, p.reason);
}

/** すべて vi.fn の API。必要なものだけ上書きする。 */
export function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient & {
  [K in keyof ApiClient]: ReturnType<typeof vi.fn>;
} {
  const api = {
    createGame: vi.fn(async () => {
      throw new Error('createGame は未設定です');
    }),
    join: vi.fn(async () => {
      throw new Error('join は未設定です');
    }),
    me: vi.fn(async () => {
      throw new Error('me は未設定です');
    }),
    getState: vi.fn(async () => {
      throw new Error('getState は未設定です');
    }),
    getCodes: vi.fn(async () => ({ joinCode: 'JOINCODE23', observerCode: 'obs_x' })),
    assign: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    submitDecision: vi.fn(async () => {
      throw new Error('submitDecision は未設定です');
    }),
    confirmWeek: vi.fn(async () => {
      throw new Error('confirmWeek は未設定です');
    }),
    pause: vi.fn(async () => {
      throw new Error('pause は未設定です');
    }),
    resume: vi.fn(async () => {
      throw new Error('resume は未設定です');
    }),
    end: vi.fn(async () => {
      throw new Error('end は未設定です');
    }),
    replaceAssignee: vi.fn(async () => {
      throw new Error('replaceAssignee は未設定です');
    }),
    getHistory: vi.fn(async () => ({ entries: [] })),
  };
  // 上書きした関数も spy にして、呼び出しを検査できるようにする
  for (const [name, fn] of Object.entries(overrides)) {
    (api as Record<string, unknown>)[name] = vi.fn(fn as never);
  }
  return api as never;
}

export function memoryStorage(initial: Credential | null = null): CredentialStorage & {
  saved: Credential | null;
  cleared: boolean;
} {
  const state = { saved: initial, cleared: false };
  return {
    load: () => state.saved,
    save: (credential) => {
      state.saved = credential;
    },
    clear: () => {
      state.saved = null;
      state.cleared = true;
    },
    get saved() {
      return state.saved;
    },
    get cleared() {
      return state.cleared;
    },
  };
}

const emptyMine = {
  role: 'retailer' as const,
  week: 1,
  receipt: 4,
  ordersReceived: 4,
  inventory: 12,
  backlog: 0,
  cumulativeCost: 0,
  decision: null,
  decisionRevision: 0,
  decidedBy: null,
  history: [],
};

export function participantState(overrides: Partial<GameStateView> = {}): GameStateView {
  return {
    gameId: 'g1',
    name: '授業',
    status: 'running',
    currentWeek: 1,
    weekCount: 6,
    setupKind: 'custom',
    version: 1,
    viewerKind: 'participant',
    participants: [
      { displayName: '太郎', joinOrder: 1, label: '太郎 #1', replaced: false },
      { displayName: '花子', joinOrder: 2, label: '花子 #2', replaced: false },
    ],
    inputsDone: 0,
    role: 'retailer',
    self: { participantId: 'p1', displayName: '太郎', joinOrder: 1 },
    mine: emptyMine,
    ...overrides,
  };
}

export function facilitatorState(overrides: Partial<GameStateView> = {}): GameStateView {
  const overview = (decided: boolean, _decision: number | null) => ({
    decided,
    receipt: 4,
    ordersReceived: 4,
    inventory: 12,
    backlog: 0,
    cumulativeCost: 0,
  });
  return {
    gameId: 'g1',
    name: '授業',
    status: 'running',
    currentWeek: 1,
    weekCount: 6,
    setupKind: 'custom',
    version: 1,
    viewerKind: 'facilitator',
    participants: [
      { participantId: 'p1', displayName: '太郎', joinOrder: 1, label: '太郎 #1', replaced: false },
      { participantId: 'p2', displayName: '花子', joinOrder: 2, label: '花子 #2', replaced: false },
    ],
    inputsDone: 2,
    assignments: [],
    unassignedRoles: [],
    roles: {
      factory: overview(true, 4),
      wholesaler1: overview(true, 4),
      wholesaler2: overview(false, null),
      retailer: overview(false, null),
    },
    missingInputRoles: ['wholesaler2', 'retailer'],
    ...overrides,
  };
}

export const participantCredential: Credential = {
  kind: 'participant',
  secret: 'tok_abc',
  gameId: 'g1',
};
export const facilitatorCredential: Credential = {
  kind: 'facilitator',
  secret: 'fac_abc',
  gameId: 'g1',
};
