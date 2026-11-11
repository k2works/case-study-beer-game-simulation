import {
  CredentialValidity,
  type CredentialValidity as Validity,
} from '../../src/domain/credential.js';
import type { Game } from '../../src/domain/game.js';
import { ROLES } from '../../src/domain/role.js';
import type { ReviewRow } from '../../src/domain/review.js';
import type { Session } from '../../src/domain/session.js';
import {
  ConflictError,
  type CredentialPolicy,
  type CredentialPurpose,
  type IdGenerator,
  type IdempotencyRecord,
  type Principal,
  type RateLimiter,
  type Repositories,
  type ReviewReader,
  type UnitOfWork,
} from '../../src/ports/index.js';

interface StoredCredential {
  principal: Principal;
  purpose: CredentialPurpose;
  validity: Validity;
}

const samePrincipal = (a: Principal, b: Principal) =>
  a.gameId === b.gameId &&
  a.kind === b.kind &&
  (a.participantId ?? null) === (b.participantId ?? null);

interface Store {
  games: Map<string, Game>;
  sessions: Map<string, Session>;
  credentials: Map<string, StoredCredential>;
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
      participantNames: async (gameId) =>
        Object.fromEntries(
          (store.games.get(gameId)?.participants ?? []).map((p) => [
            p.id,
            p.displayName,
          ]),
        ),
    },
    sessions: {
      findByGame: async (gameId) => store.sessions.get(gameId) ?? null,
      save: async (session, expected) => {
        checkVersion(store.sessions.get(session.gameId), expected);
        store.sessions.set(session.gameId, session);
      },
    },
    credentials: {
      save: async (digest, principal, purpose, validity) => {
        if (purpose === 'RECOVERY') {
          for (const [d, c] of store.credentials)
            if (
              c.purpose === 'RECOVERY' &&
              samePrincipal(c.principal, principal)
            )
              store.credentials.delete(d);
        }
        store.credentials.set(digest, { principal, purpose, validity });
      },
      find: async (digests, purpose, at) => {
        for (const d of digests) {
          const c = store.credentials.get(d);
          // 削除済みのゲームの資格は、カスケード削除と同じく使えない
          if (
            c?.purpose === purpose &&
            store.games.has(c.principal.gameId) &&
            CredentialValidity.isValid(c.validity, at)
          )
            return c.principal;
        }
        return null;
      },
      revokeAll: async (principal, at) => {
        for (const [d, c] of store.credentials) {
          if (!samePrincipal(c.principal, principal)) continue;
          store.credentials.set(d, {
            ...c,
            validity: CredentialValidity.revoke(c.validity, at),
          });
        }
      },
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
    digestsOf: (token) => [`digest(${token})`],
  };
}

/** メモリ上の固定窓のレート制限 */
export function memoryRateLimiter(
  limit: number,
  windowMs: number,
): RateLimiter {
  const counts = new Map<string, number>();
  return {
    hit: async (bucket, at) => {
      const key = `${bucket}:${Math.floor(at.getTime() / windowMs)}`;
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n <= limit;
    },
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
