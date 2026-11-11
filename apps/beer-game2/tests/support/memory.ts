import {
  CredentialValidity,
  type CredentialValidity as Validity,
} from '../../src/domain/credential.js';
import type { Game } from '../../src/domain/game.js';
import {
  EXPORT_HISTORY_TYPES,
  EXPORT_INPUT_TYPES,
} from '../../src/domain/export.js';
import { ROLES, type Role } from '../../src/domain/role.js';
import type { ReviewRow } from '../../src/domain/review.js';
import type { Session } from '../../src/domain/session.js';
import {
  ConflictError,
  type CredentialPolicy,
  type CredentialPurpose,
  type ExportReader,
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
  (a.participantId ?? null) === (b.participantId ?? null) &&
  (a.observerId ?? null) === (b.observerId ?? null);

interface StoredInvitation {
  id: string;
  gameId: string;
  validity: Validity;
}

interface Store {
  games: Map<string, Game>;
  sessions: Map<string, Session>;
  credentials: Map<string, StoredCredential>;
  /** 招待コードのダイジェスト → 招待 */
  invitations: Map<string, StoredInvitation>;
  observers: Map<
    string,
    { gameId: string; invitationId: string; displayName: string }
  >;
  idempotency: Map<string, IdempotencyRecord>;
  events: { gameId: string; event: object }[];
}

const emptyStore = (): Store => ({
  games: new Map(),
  sessions: new Map(),
  credentials: new Map(),
  invitations: new Map(),
  observers: new Map(),
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
    observers: {
      saveInvitation: async (digest, inv) =>
        void store.invitations.set(digest, inv),
      findInvitation: async (digests, at) => {
        for (const d of digests) {
          const inv = store.invitations.get(d);
          if (
            inv &&
            store.games.has(inv.gameId) &&
            CredentialValidity.isValid(inv.validity, at)
          )
            return { id: inv.id, gameId: inv.gameId };
        }
        return null;
      },
      revokeInvitation: async (gameId, id, at) => {
        for (const [d, inv] of store.invitations) {
          if (inv.id !== id || inv.gameId !== gameId) continue;
          store.invitations.set(d, {
            ...inv,
            validity: CredentialValidity.revoke(inv.validity, at),
          });
          return true;
        }
        return false;
      },
      activeInvitations: async (gameId, at) =>
        [...store.invitations.values()]
          .filter(
            (inv) =>
              inv.gameId === gameId &&
              CredentialValidity.isValid(inv.validity, at),
          )
          .map((inv) => ({ id: inv.id, expiresAt: inv.validity.expiresAt })),
      addObserver: async (o) =>
        void store.observers.set(o.id, {
          gameId: o.gameId,
          invitationId: o.invitationId,
          displayName: o.displayName,
        }),
      countObservers: async (gameId) =>
        [...store.observers.values()].filter((o) => o.gameId === gameId).length,
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

/** メモリ上の出力の元データ（UnitOfWork の保存内容とイベントから組み立てる） */
export function memoryExportReader(mem: {
  snapshot: () => Store;
}): ExportReader {
  return {
    read: async (gameId) => {
      const store = mem.snapshot();
      const session = store.sessions.get(gameId);
      if (!session) return { sessionStatus: null, source: null };
      const rows = (await memoryReviewReader(mem).read(gameId)).rows;
      const events = store.events
        .filter((e) => e.gameId === gameId)
        .map((e) => e.event as Record<string, unknown> & { type: string });
      const s = session.settings;
      return {
        sessionStatus: session.status,
        source: {
          gameId,
          finalWeek: s.finalWeek,
          commitMode: s.commitMode,
          settings: {
            kind: s.kind,
            changes: s.changes,
            initialInventory: s.initialInventory,
            orderDelayWeeks: s.orderDelayWeeks,
            shipmentDelayWeeks: s.shipmentDelayWeeks,
            productionDelayWeeks: s.productionDelayWeeks,
            holdingCostMinor: s.holdingCostMinor,
            backlogCostMinor: s.backlogCostMinor,
            disclosure: s.disclosure,
          },
          demand: s.demand,
          weeks: session.history.map((h) => ({
            week: h.week,
            commitKind: h.commitKind,
          })),
          rows,
          inputs: events.flatMap((e) =>
            e.type in EXPORT_INPUT_TYPES
              ? [
                  {
                    week: (e.week as number | undefined) ?? null,
                    role: e.role as Role,
                    quantity: e.quantity as number,
                    by: EXPORT_INPUT_TYPES[
                      e.type as keyof typeof EXPORT_INPUT_TYPES
                    ],
                    at: '',
                  },
                ]
              : [],
          ),
          history: events
            .filter((e) => EXPORT_HISTORY_TYPES.includes(e.type))
            .map((e) => ({ type: e.type, at: '' })),
        },
      };
    },
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
