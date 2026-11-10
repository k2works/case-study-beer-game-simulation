import type { Game } from '../../src/domain/game.js';
import { ROLES } from '../../src/domain/role.js';
import type { ReviewRow } from '../../src/domain/review.js';
import type { Session } from '../../src/domain/session.js';
import {
  ConflictError,
  type CredentialPolicy,
  type IdGenerator,
  type IdempotencyRecord,
  type Principal,
  type Repositories,
  type ReviewReader,
  type UnitOfWork,
} from '../../src/ports/index.js';

interface Store {
  games: Map<string, Game>;
  sessions: Map<string, Session>;
  credentials: Map<string, Principal>;
  idempotency: Map<string, IdempotencyRecord>;
  events: { gameId: string; event: object }[];
}

const emptyStore = (): Store => ({
  games: new Map(),
  sessions: new Map(),
  credentials: new Map(),
  idempotency: new Map(),
  events: [],
});

function reposOver(store: Store, failOnAppend: () => boolean): Repositories {
  const checkVersion = (
    current: { version: number } | undefined,
    expected: number | null,
  ) => {
    if (
      expected === null ? current !== undefined : current?.version !== expected
    ) {
      throw new ConflictError();
    }
  };
  return {
    games: {
      find: async (id) => store.games.get(id) ?? null,
      findByJoinCode: async (code) =>
        [...store.games.values()].find((g) => g.joinCode === code) ?? null,
      save: async (game, expected) => {
        checkVersion(store.games.get(game.id), expected);
        store.games.set(game.id, game);
      },
    },
    sessions: {
      findByGame: async (gameId) => store.sessions.get(gameId) ?? null,
      save: async (session, expected) => {
        checkVersion(store.sessions.get(session.gameId), expected);
        store.sessions.set(session.gameId, session);
      },
    },
    credentials: {
      save: async (digest, principal) =>
        void store.credentials.set(digest, principal),
      find: async (digest) => store.credentials.get(digest) ?? null,
    },
    idempotency: {
      find: async (gameId, key) =>
        store.idempotency.get(`${gameId}:${key}`) ?? null,
      save: async (r) => void store.idempotency.set(`${r.gameId}:${r.key}`, r),
    },
    events: {
      append: async (gameId, events) => {
        if (failOnAppend()) throw new Error('injected failure');
        for (const event of events) store.events.push({ gameId, event });
      },
    },
  };
}

/** 失敗したら元に戻る、メモリ上の UnitOfWork（本物のトランザクションの代役） */
export function memoryUnitOfWork() {
  let store = emptyStore();
  let failOnAppend = false;
  const uow: UnitOfWork = {
    async run(work) {
      const working = structuredClone(store);
      const result = await work(reposOver(working, () => failOnAppend));
      store = working;
      return result;
    },
  };
  return {
    uow,
    snapshot: () => store,
    failEventAppend: (on: boolean) => {
      failOnAppend = on;
    },
  };
}

export function sequentialIds(): IdGenerator {
  let n = 0;
  return {
    uuid: () => `id-${++n}`,
    joinCode: () => `JOIN-${String(++n).padStart(4, '0')}`,
  };
}

export function fakeCredentials(): CredentialPolicy {
  let n = 0;
  return {
    issue: () => {
      const token = `token-${++n}`;
      return { token, digest: `digest(${token})` };
    },
    digestOf: (token) => `digest(${token})`,
  };
}

/** メモリ上の読み取り専用の経路（振り返り）。UnitOfWork の保存内容をそのまま読む */
export function memoryReviewReader(mem: {
  snapshot: () => Store;
}): ReviewReader {
  return {
    read: async (gameId) => {
      const session = mem.snapshot().sessions.get(gameId);
      if (!session) return { sessionStatus: null, rows: [] };
      const rows: ReviewRow[] = session.history.flatMap((record) =>
        ROLES.map((role) => {
          const r = record.roles[role];
          return {
            week: record.week,
            role,
            demand: r.demand,
            received: r.received,
            shipped: r.shipped,
            order: r.order,
            endingInventory: r.endingInventory,
            endingBacklog: r.endingBacklog,
            weeklyCostMinor: r.weeklyCostMinor,
            cumulativeCostMinor: r.cumulativeCostMinor,
          };
        }),
      );
      return { sessionStatus: session.status, rows };
    },
  };
}
