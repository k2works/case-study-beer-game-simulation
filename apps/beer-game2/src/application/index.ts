import { FACILITATOR, participant, type Actor } from '../domain/actor.js';
import {
  assignRole as assignRoleRule,
  unassignRole as unassignRoleRule,
  createGame as createGameRule,
  joinGame as joinGameRule,
  missingRoles,
  type CommitMode,
  startGame as startGameRule,
} from '../domain/game.js';
import { ROLES, type Role } from '../domain/role.js';
import { buildReview, canDisclose } from '../domain/review.js';
import { PermissionError } from '../domain/values.js';
import {
  commitWeek as commitWeekRule,
  saveDecision as saveDecisionRule,
  startSession,
  type Session,
} from '../domain/session.js';
import {
  ConflictError,
  type Clock,
  type ReviewReader,
  type CredentialPolicy,
  type IdGenerator,
  type Principal,
  type Repositories,
  type UnitOfWork,
} from '../ports/index.js';
import { ForbiddenError, NotFoundError, UnauthorizedError } from './errors.js';

export interface Dependencies {
  uow: UnitOfWork;
  clock: Clock;
  ids: IdGenerator;
  credentials: CredentialPolicy;
  /** 読み取り専用の経路（振り返り） */
  reviews: ReviewReader;
}

export interface CommitResult {
  committedWeek: number;
  nextWeek: number;
  status: Session['status'];
}

/**
 * ユースケース。読み込み → 集約の呼び出し → 保存だけを行い、ルールは持たない。
 * 1 回の操作は 1 つのトランザクション（UnitOfWork）で行う。
 *
 * @guidedTour walking-skeleton 40 ユースケース。1 回の操作を `UnitOfWork`（1 つのトランザクション）の中で行い、資格を確認し、集約を呼び、保存する。**ルールはここに書かない**（層の依存は lint で守られる）。次は、集約のルール。
 */
export function createApplication(deps: Dependencies) {
  const { uow, ids, credentials, reviews } = deps;

  async function authenticate(
    repos: Repositories,
    token: string,
    gameId: string,
  ): Promise<Principal> {
    const principal = token
      ? await repos.credentials.find(credentials.digestOf(token))
      : null;
    if (!principal) throw new UnauthorizedError();
    if (principal.gameId !== gameId) throw new ForbiddenError();
    return principal;
  }

  const actorOf = (p: Principal): Actor =>
    p.kind === 'FACILITATOR' ? FACILITATOR : participant(p.participantId ?? '');

  async function loadGame(repos: Repositories, gameId: string) {
    const game = await repos.games.find(gameId);
    if (!game) throw new NotFoundError('ゲームが見つかりません');
    return game;
  }

  async function loadSession(repos: Repositories, gameId: string) {
    const session = await repos.sessions.findByGame(gameId);
    if (!session) throw new NotFoundError('ゲームはまだ開始されていません');
    return session;
  }

  return {
    /** 候補の資格のうち、このゲームのものを返す。無ければ先頭（認可の失敗として扱われる） */
    identify(input: { tokens: string[]; gameId: string }): Promise<string> {
      return uow.run(async (repos) => {
        for (const token of input.tokens) {
          const principal = await repos.credentials.find(
            credentials.digestOf(token),
          );
          if (principal?.gameId === input.gameId) return token;
        }
        return input.tokens[0] ?? '';
      });
    },

    createGame(input: {
      weeks: number;
      demand?: readonly number[];
      commitMode?: CommitMode;
    }) {
      return uow.run(async (repos) => {
        const gameId = ids.uuid();
        const joinCode = ids.joinCode();
        const { game, events } = createGameRule({
          id: gameId,
          joinCode,
          ...input,
        });
        await repos.games.save(game, null);
        const cred = credentials.issue();
        await repos.credentials.save(cred.digest, {
          gameId,
          kind: 'FACILITATOR',
        });
        await repos.events.append(gameId, events);
        return { gameId, joinCode, facilitatorToken: cred.token };
      });
    },

    joinGame(input: { joinCode: string; displayName: string }) {
      return uow.run(async (repos) => {
        const game = await repos.games.findByJoinCode(input.joinCode);
        if (!game) throw new NotFoundError('参加コードが見つかりません');
        const participantId = ids.uuid();
        const { game: next, events } = joinGameRule(game, {
          participantId,
          displayName: input.displayName,
        });
        await repos.games.save(next, game.version);
        const cred = credentials.issue();
        await repos.credentials.save(cred.digest, {
          gameId: game.id,
          kind: 'PARTICIPANT',
          participantId,
        });
        await repos.events.append(game.id, events);
        return { gameId: game.id, participantId, token: cred.token };
      });
    },

    assignRole(input: {
      token: string;
      gameId: string;
      participantId: string;
      role: Role;
    }) {
      return uow.run(async (repos) => {
        const principal = await authenticate(repos, input.token, input.gameId);
        const game = await loadGame(repos, input.gameId);
        const { game: next, events } = assignRoleRule(
          game,
          actorOf(principal),
          input.participantId,
          input.role,
        );
        await repos.games.save(next, game.version);
        await repos.events.append(game.id, events);
      });
    },

    unassignRole(input: {
      token: string;
      gameId: string;
      participantId: string;
    }) {
      return uow.run(async (repos) => {
        const principal = await authenticate(repos, input.token, input.gameId);
        const game = await loadGame(repos, input.gameId);
        const { game: next, events } = unassignRoleRule(
          game,
          actorOf(principal),
          input.participantId,
        );
        await repos.games.save(next, game.version);
        await repos.events.append(game.id, events);
      });
    },

    startGame(input: { token: string; gameId: string }) {
      return uow.run(async (repos) => {
        const principal = await authenticate(repos, input.token, input.gameId);
        const game = await loadGame(repos, input.gameId);
        const { game: started, events } = startGameRule(
          game,
          actorOf(principal),
        );
        const { session, events: sessionEvents } = startSession(
          started,
          ids.uuid(),
        );
        await repos.games.save(started, game.version);
        await repos.sessions.save(session, null);
        await repos.events.append(game.id, [...events, ...sessionEvents]);
      });
    },

    saveDecision(input: {
      token: string;
      gameId: string;
      role: Role;
      quantity: number;
      expectedVersion: number;
    }) {
      return uow.run(async (repos) => {
        const principal = await authenticate(repos, input.token, input.gameId);
        const session = await loadSession(repos, input.gameId);
        const { session: next, events } = saveDecisionRule(
          session,
          actorOf(principal),
          input.role,
          input.quantity,
          input.expectedVersion,
        );
        await repos.sessions.save(next, session.version);
        await repos.events.append(input.gameId, events);
        // 自動確定された場合は、その結果も返す
        const committedEvent = events.find((e) => e.type === 'WeekCommitted');
        const committed: CommitResult | undefined = committedEvent
          ? {
              committedWeek: session.week,
              nextWeek: next.week,
              status: next.status,
            }
          : undefined;
        return {
          version: next.decisions[input.role]?.version ?? 0,
          sessionVersion: next.version,
          ...(committed ? { committed } : {}),
        };
      });
    },

    commitWeek(input: {
      token: string;
      gameId: string;
      week: number;
      version: number;
      idempotencyKey: string;
    }): Promise<CommitResult> {
      return uow.run(async (repos) => {
        const principal = await authenticate(repos, input.token, input.gameId);
        const fingerprint = `${input.week}:${input.version}`;
        const prior = await repos.idempotency.find(
          input.gameId,
          input.idempotencyKey,
        );
        if (prior) {
          if (prior.fingerprint !== fingerprint) {
            throw new ConflictError('同じ冪等キーで、内容の違う要求です');
          }
          return prior.response as CommitResult;
        }
        const session = await loadSession(repos, input.gameId);
        const { session: next, events } = commitWeekRule(
          session,
          actorOf(principal),
          {
            week: input.week,
            version: input.version,
          },
        );
        const result: CommitResult = {
          committedWeek: input.week,
          nextWeek: next.week,
          status: next.status,
        };
        await repos.sessions.save(next, session.version);
        await repos.events.append(input.gameId, events);
        await repos.idempotency.save({
          gameId: input.gameId,
          key: input.idempotencyKey,
          fingerprint,
          response: result,
        });
        return result;
      });
    },

    lobby(input: { token: string; gameId: string }) {
      return uow.run(async (repos) => {
        const principal = await authenticate(repos, input.token, input.gameId);
        const game = await loadGame(repos, input.gameId);
        return {
          gameId: game.id,
          viewer:
            principal.kind === 'FACILITATOR'
              ? { kind: 'FACILITATOR' as const }
              : {
                  kind: 'PARTICIPANT' as const,
                  participantId: principal.participantId ?? '',
                },
          status: game.status,
          finalWeek: game.settings.finalWeek,
          commitMode: game.settings.commitMode,
          ...(principal.kind === 'FACILITATOR'
            ? { joinCode: game.joinCode }
            : {}),
          participants: game.participants.map((p) => ({
            id: p.id,
            displayName: p.displayName,
          })),
          assignments: game.assignments,
          missingRoles: missingRoles(game),
        };
      });
    },

    /** 参加者の役割別の状況。自分の役割の情報だけで、他の役割と将来の需要は含まない */
    roleState(input: { token: string; gameId: string }) {
      return uow.run(async (repos) => {
        const principal = await authenticate(repos, input.token, input.gameId);
        if (principal.kind !== 'PARTICIPANT')
          throw new ForbiddenError('参加者の画面です');
        const session = await loadSession(repos, input.gameId);
        const role = ROLES.find(
          (r) => session.holders[r] === principal.participantId,
        );
        if (!role) throw new ForbiddenError('役割が割り当てられていません');
        const state = session.states[role];
        const decision = session.decisions[role];
        return {
          role,
          status: session.status,
          week: session.week,
          sessionVersion: session.version,
          commitMode: session.settings.commitMode,
          inventory: state.inventory,
          backlog: state.backlog,
          incomingGoods: [...state.incomingGoods],
          ...(role === 'RETAILER' && session.status === 'ACTIVE'
            ? { customerDemand: session.settings.demand[session.week - 1] }
            : {}),
          decision: decision
            ? { quantity: decision.quantity, version: decision.version }
            : null,
          history: session.history.map((h) => {
            const r = h.roles[role];
            return {
              week: h.week,
              order: r.order,
              demand: r.demand,
              received: r.received,
              shipped: r.shipped,
              endingInventory: r.endingInventory,
              endingBacklog: r.endingBacklog,
              weeklyCostMinor: r.weeklyCostMinor,
              cumulativeCostMinor: r.cumulativeCostMinor,
            };
          }),
        };
      });
    },

    /**
     * 振り返り（役割別の時系列）。ゲームが終了してから、そのゲームの進行役・参加者に開示する。
     * 開示の判定はドメインの `canDisclose` に集め、終了前は値を一切返さない。
     */
    async review(input: { token: string; gameId: string }) {
      await uow.run((repos) => authenticate(repos, input.token, input.gameId));
      const source = await reviews.read(input.gameId);
      if (!canDisclose(source.sessionStatus)) {
        throw new PermissionError('振り返りは、ゲームが終了してから見られます');
      }
      return buildReview(source.rows);
    },

    /** 進行役のコンソール。入力の有無だけを見せる */
    console(input: { token: string; gameId: string }) {
      return uow.run(async (repos) => {
        const principal = await authenticate(repos, input.token, input.gameId);
        if (principal.kind !== 'FACILITATOR')
          throw new ForbiddenError('進行役の画面です');
        const session = await loadSession(repos, input.gameId);
        return {
          status: session.status,
          week: session.week,
          sessionVersion: session.version,
          submitted: Object.fromEntries(
            ROLES.map((r) => [r, session.decisions[r] !== undefined]),
          ) as Record<Role, boolean>,
        };
      });
    },
  };
}

export type Application = ReturnType<typeof createApplication>;
