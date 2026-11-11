import { FACILITATOR, participant, type Actor } from '../domain/actor.js';
import type { Conditions } from '../domain/conditions.js';
import { CREDENTIAL_TTL, CredentialValidity } from '../domain/credential.js';
import { OBSERVER_LIMIT, observe } from '../domain/observation.js';
import { buildExport } from '../domain/export.js';
import {
  assignRole as assignRoleRule,
  unassignRole as unassignRoleRule,
  createGame as createGameRule,
  joinGame as joinGameRule,
  missingRoles,
  type CommitMode,
  type GameSettings,
  startGame as startGameRule,
} from '../domain/game.js';
import { ROLES, type Role } from '../domain/role.js';
import { buildReview, canDisclose } from '../domain/review.js';
import {
  DecisionConflictError,
  DisplayName,
  DomainError,
  PermissionError,
} from '../domain/values.js';
import {
  PROXY_OPERATOR,
  changeCommitMode as changeCommitModeRule,
  commitWeek as commitWeekRule,
  pauseSession as pauseSessionRule,
  proxyDecision as proxyDecisionRule,
  resumeSession as resumeSessionRule,
  saveDecision as saveDecisionRule,
  startSession,
  type Session,
  type SessionOutcome,
} from '../domain/session.js';
import {
  ConflictError,
  type Clock,
  type ReviewReader,
  type CredentialPolicy,
  type CredentialPurpose,
  type ExportReader,
  type IdGenerator,
  type Principal,
  type Repositories,
  type UnitOfWork,
} from '../ports/index.js';
import {
  DecisionConflict,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from './errors.js';

export interface Dependencies {
  uow: UnitOfWork;
  clock: Clock;
  ids: IdGenerator;
  credentials: CredentialPolicy;
  /** 読み取り専用の経路（振り返り） */
  reviews: ReviewReader;
  /** 読み取り専用の経路（出力） */
  exports: ExportReader;
  /** 資格の有効期間（省略時は仮の既定値） */
  ttl?: { sessionMs: number; recoveryMs: number; observerInvitationMs: number };
}

/** 再発行の対象。進行役自身か、このゲームの参加者 1 人 */
export type CredentialTarget =
  { kind: 'FACILITATOR' } | { kind: 'PARTICIPANT'; participantId: string };

/** 無効な復帰コード。復帰せず、進行役への確認方法を示す */
const INVALID_RECOVERY =
  '復帰コードが無効です（失効・期限切れ、またはゲームが削除済み）。進行役に、新しい復帰コードの発行を依頼してください';

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
 *
 * @landmark ユースケース層の入口。1 回の操作は 1 つのトランザクション。ルールを持たず、認証 → 集約の呼び出し → 保存の順に進めるだけ。
 */
export function createApplication(deps: Dependencies) {
  const { uow, ids, credentials, reviews, exports, clock } = deps;
  const ttl = deps.ttl ?? CREDENTIAL_TTL;

  /** 資格を発行して保存し、生の値を返す（生の値は保存しない） */
  async function issue(
    repos: Repositories,
    principal: Principal,
    purpose: CredentialPurpose,
  ): Promise<string> {
    const cred = credentials.issue();
    await repos.credentials.save(
      cred.digest,
      principal,
      purpose,
      CredentialValidity.issue(
        clock.now(),
        purpose === 'SESSION' ? ttl.sessionMs : ttl.recoveryMs,
      ),
    );
    return cred.token;
  }

  const findPrincipal = (
    repos: Repositories,
    token: string,
    purpose: CredentialPurpose,
  ) =>
    token
      ? repos.credentials.find(
          credentials.digestsOf(token),
          purpose,
          clock.now(),
        )
      : Promise.resolve(null);

  async function authenticate(
    repos: Repositories,
    token: string,
    gameId: string,
  ): Promise<Principal> {
    const principal = await findPrincipal(repos, token, 'SESSION');
    if (!principal) throw new UnauthorizedError();
    if (principal.gameId !== gameId) throw new ForbiddenError();
    return principal;
  }

  const actorOf = (p: Principal): Actor =>
    p.kind === 'FACILITATOR'
      ? FACILITATOR
      : p.kind === 'OBSERVER'
        ? { kind: 'OBSERVER', observerId: p.observerId ?? '' }
        : participant(p.participantId ?? '');

  const requireFacilitatorPrincipal = (p: Principal, operation: string) => {
    if (p.kind !== 'FACILITATOR')
      throw new PermissionError(`${operation}は進行役だけができます`);
  };

  async function loadGame(repos: Repositories, gameId: string) {
    const game = await repos.games.find(gameId);
    if (!game) throw new NotFoundError('ゲームが見つかりません');
    return game;
  }

  /** 画面に出す設定（準拠かカスタムか、変更項目、条件の値） */
  const settingsView = (s: GameSettings) => ({
    kind: s.kind,
    changes: s.changes,
    initialInventory: s.initialInventory,
    orderDelayWeeks: s.orderDelayWeeks,
    shipmentDelayWeeks: s.shipmentDelayWeeks,
    productionDelayWeeks: s.productionDelayWeeks,
    holdingCostMinor: s.holdingCostMinor,
    backlogCostMinor: s.backlogCostMinor,
    disclosure: s.disclosure,
  });

  /** 保存者の表示名。代理入力は「進行役」 */
  const nameOf = (names: Record<string, string>, savedBy: string) =>
    savedBy === PROXY_OPERATOR ? '進行役' : (names[savedBy] ?? '');

  async function loadSession(repos: Repositories, gameId: string) {
    const session = await repos.sessions.findByGame(gameId);
    if (!session) throw new NotFoundError('ゲームはまだ開始されていません');
    return session;
  }

  /** 認証 → セッションの読み込み → 集約の操作 → 保存（停止・再開・代理入力で共通） */
  function changeSession(
    input: { token: string; gameId: string },
    operate: (session: Session, actor: Actor) => SessionOutcome,
  ): Promise<Session> {
    return uow.run(async (repos) => {
      const principal = await authenticate(repos, input.token, input.gameId);
      const session = await loadSession(repos, input.gameId);
      const { session: next, events } = operate(session, actorOf(principal));
      await repos.sessions.save(next, session.version);
      await repos.events.append(input.gameId, events);
      return next;
    });
  }

  return {
    /** 候補の資格のうち、このゲームのものを返す。無ければ先頭（認可の失敗として扱われる） */
    identify(input: { tokens: string[]; gameId: string }): Promise<string> {
      return uow.run(async (repos) => {
        for (const token of input.tokens) {
          const principal = await findPrincipal(repos, token, 'SESSION');
          if (principal?.gameId === input.gameId) return token;
        }
        return input.tokens[0] ?? '';
      });
    },

    createGame(input: {
      weeks: number;
      demand?: readonly number[];
      commitMode?: CommitMode;
      conditions?: Partial<Conditions>;
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
        const principal: Principal = { gameId, kind: 'FACILITATOR' };
        const facilitatorToken = await issue(repos, principal, 'SESSION');
        const recoveryCode = await issue(repos, principal, 'RECOVERY');
        await repos.events.append(gameId, events);
        return { gameId, joinCode, facilitatorToken, recoveryCode };
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
        const principal: Principal = {
          gameId: game.id,
          kind: 'PARTICIPANT',
          participantId,
        };
        const token = await issue(repos, principal, 'SESSION');
        const recoveryCode = await issue(repos, principal, 'RECOVERY');
        await repos.events.append(game.id, events);
        return { gameId: game.id, participantId, token, recoveryCode };
      });
    },

    /**
     * 復帰コードで戻る。新しいブラウザセッションを発行する（復帰コード自体は、期限まで再利用できる）。
     * 無効なら、復帰せず、進行役への確認方法を示す。
     */
    recover(input: { code: string }) {
      return uow.run(async (repos) => {
        const principal = await findPrincipal(repos, input.code, 'RECOVERY');
        const game = principal
          ? await repos.games.find(principal.gameId)
          : null;
        if (!principal || !game) throw new UnauthorizedError(INVALID_RECOVERY);
        const token = await issue(repos, principal, 'SESSION');
        await repos.events.append(game.id, [
          { type: 'ParticipationRecovered', ...principal },
        ]);
        return { ...principal, token, gameStatus: game.status };
      });
    },

    /**
     * 進行役が、漏れた資格を失効させて再発行する。対象のブラウザセッションと復帰コードをすべて失効させ、
     * 新しい復帰コードを返す。進行役自身が対象なら、新しいブラウザセッションも返す。
     */
    reissueCredential(input: {
      token: string;
      gameId: string;
      target: CredentialTarget;
    }) {
      return uow.run(async (repos) => {
        const principal = await authenticate(repos, input.token, input.gameId);
        requireFacilitatorPrincipal(principal, '資格の再発行');
        const game = await loadGame(repos, input.gameId);
        const target: Principal =
          input.target.kind === 'FACILITATOR'
            ? { gameId: game.id, kind: 'FACILITATOR' }
            : {
                gameId: game.id,
                kind: 'PARTICIPANT',
                participantId: input.target.participantId,
              };
        if (
          target.kind === 'PARTICIPANT' &&
          !game.participants.some((p) => p.id === target.participantId)
        )
          throw new NotFoundError('このゲームの参加者ではありません');
        await repos.credentials.revokeAll(target, clock.now());
        const recoveryCode = await issue(repos, target, 'RECOVERY');
        const facilitatorToken =
          target.kind === 'FACILITATOR'
            ? await issue(repos, target, 'SESSION')
            : undefined;
        await repos.events.append(game.id, [
          { type: 'CredentialRevoked', ...target },
          { type: 'CredentialReissued', ...target },
        ]);
        return {
          recoveryCode,
          ...(facilitatorToken ? { facilitatorToken } : {}),
        };
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
        let outcome;
        try {
          outcome = saveDecisionRule(
            session,
            actorOf(principal),
            input.role,
            input.quantity,
            input.expectedVersion,
          );
        } catch (e) {
          // 共同入力の競合: 最新の値と保存者の表示名を、同じ応答で返す
          if (!(e instanceof DecisionConflictError)) throw e;
          const names = await repos.games.participantNames(input.gameId);
          throw new DecisionConflict(
            e.message,
            e.latest && {
              quantity: e.latest.quantity,
              version: e.latest.version,
              savedBy: nameOf(names, e.latest.savedBy),
            },
          );
        }
        const { session: next, events } = outcome;
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

    pauseSession(input: { token: string; gameId: string }) {
      return changeSession(input, (session, actor) =>
        pauseSessionRule(session, actor),
      );
    },

    resumeSession(input: { token: string; gameId: string }) {
      return changeSession(input, (session, actor) =>
        resumeSessionRule(session, actor),
      );
    },

    /** 進行役が確定方式を変える（いつでも）。自動へ切り替えて、そろっていれば確定する */
    changeCommitMode(input: {
      token: string;
      gameId: string;
      commitMode: CommitMode;
    }) {
      return changeSession(input, (session, actor) =>
        changeCommitModeRule(session, actor, input.commitMode),
      );
    },

    /** 進行役の代理入力。時刻は注入された時計から取り、イベントに残す */
    async proxyDecision(input: {
      token: string;
      gameId: string;
      role: Role;
      quantity: number;
      expectedVersion: number;
    }) {
      const next = await changeSession(input, (session, actor) =>
        proxyDecisionRule(
          session,
          actor,
          input.role,
          input.quantity,
          input.expectedVersion,
          clock.now(),
        ),
      );
      return {
        version: next.decisions[input.role]?.version ?? 0,
        sessionVersion: next.version,
      };
    },

    /** 観察用の招待の発行（進行役）。招待コードは、この応答で一度だけ返す */
    issueObserverInvitation(input: { token: string; gameId: string }) {
      return uow.run(async (repos) => {
        const principal = await authenticate(repos, input.token, input.gameId);
        requireFacilitatorPrincipal(principal, '観察用の招待の発行');
        const game = await loadGame(repos, input.gameId);
        const invitationId = ids.uuid();
        const cred = credentials.issue();
        const validity = CredentialValidity.issue(
          clock.now(),
          ttl.observerInvitationMs,
        );
        await repos.observers.saveInvitation(cred.digest, {
          id: invitationId,
          gameId: game.id,
          validity,
        });
        await repos.events.append(game.id, [
          { type: 'ObserverInvited', gameId: game.id, invitationId },
        ]);
        return {
          invitationId,
          code: cred.token,
          expiresAt: validity.expiresAt.toISOString(),
        };
      });
    },

    /** 観察用の招待の失効（進行役）。新しい参加だけを止め、参加済みの観察者は観察を続けられる */
    revokeObserverInvitation(input: {
      token: string;
      gameId: string;
      invitationId: string;
    }) {
      return uow.run(async (repos) => {
        const principal = await authenticate(repos, input.token, input.gameId);
        requireFacilitatorPrincipal(principal, '観察用の招待の失効');
        const revoked = await repos.observers.revokeInvitation(
          input.gameId,
          input.invitationId,
          clock.now(),
        );
        if (!revoked) throw new NotFoundError('招待が見つかりません');
        await repos.events.append(input.gameId, [
          {
            type: 'ObserverInvitationRevoked',
            gameId: input.gameId,
            invitationId: input.invitationId,
          },
        ]);
      });
    },

    /** 観察用の招待で、観察者として参加する。役割を持たず、読み取りだけ */
    joinAsObserver(input: { code: string; displayName?: string }) {
      return uow.run(async (repos) => {
        const invitation = input.code
          ? await repos.observers.findInvitation(
              credentials.digestsOf(input.code),
              clock.now(),
            )
          : null;
        if (!invitation)
          throw new UnauthorizedError(
            '招待が無効です（失効または期限切れ）。進行役に確認してください',
          );
        if (
          (await repos.observers.countObservers(invitation.gameId)) >=
          OBSERVER_LIMIT
        )
          throw new DomainError(
            `観察者は 1 ゲーム ${OBSERVER_LIMIT} 人までです`,
          );
        const name = input.displayName?.trim();
        const observerId = ids.uuid();
        await repos.observers.addObserver({
          id: observerId,
          gameId: invitation.gameId,
          invitationId: invitation.id,
          displayName: name ? DisplayName.of(name) : '観察者',
        });
        const token = await issue(
          repos,
          { gameId: invitation.gameId, kind: 'OBSERVER', observerId },
          'SESSION',
        );
        await repos.events.append(invitation.gameId, [
          { type: 'ObserverJoined', gameId: invitation.gameId, observerId },
        ]);
        return { gameId: invitation.gameId, observerId, token };
      });
    },

    /**
     * 観察（観察者と進行役だけ）。参加者には開かせない（自分の値から、合計を使って相手の値を逆算できるため）。
     */
    observation(input: { token: string; gameId: string }) {
      return uow.run(async (repos) => {
        const principal = await authenticate(repos, input.token, input.gameId);
        if (principal.kind === 'PARTICIPANT')
          throw new ForbiddenError(
            '観察の画面は、観察者と進行役だけが開けます',
          );
        return observe(await loadSession(repos, input.gameId));
      });
    },

    /** 変化の通知（SSE）の購読の認可。このゲームの進行役・参加者・観察者に通す */
    async authorizeStream(input: { token: string; gameId: string }) {
      await uow.run((repos) => authenticate(repos, input.token, input.gameId));
    },

    lobby(input: { token: string; gameId: string }) {
      return uow.run(async (repos) => {
        const principal = await authenticate(repos, input.token, input.gameId);
        if (principal.kind === 'OBSERVER')
          throw new ForbiddenError('観察者は、ロビーを開けません');
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
          settings: settingsView(game.settings),
          ...(principal.kind === 'FACILITATOR'
            ? {
                joinCode: game.joinCode,
                observerInvitations: (
                  await repos.observers.activeInvitations(game.id, clock.now())
                ).map((i) => ({
                  id: i.id,
                  expiresAt: i.expiresAt.toISOString(),
                })),
              }
            : {}),
          observerCount: await repos.observers.countObservers(game.id),
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
        const role = ROLES.find((r) =>
          session.holders[r].includes(principal.participantId ?? ''),
        );
        if (!role) throw new ForbiddenError('役割が割り当てられていません');
        const names = await repos.games.participantNames(input.gameId);
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
          /** 同じ役割の担当（共同担当を含む）の表示名 */
          coHolders: session.holders[role].map((id) => names[id] ?? ''),
          decision: decision
            ? {
                quantity: decision.quantity,
                version: decision.version,
                savedBy: nameOf(names, decision.savedBy),
              }
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
      const principal = await uow.run((repos) =>
        authenticate(repos, input.token, input.gameId),
      );
      const source = await reviews.read(input.gameId);
      if (!canDisclose(source.sessionStatus)) {
        throw new PermissionError('振り返りは、ゲームが終了してから見られます');
      }
      return {
        ...buildReview(source.rows),
        /** 出力（CSV・JSON）は進行役だけ */
        canExport: principal.kind === 'FACILITATOR',
      };
    },

    /**
     * 出力（CSV・JSON）。進行役だけが、終了後だけ。全体を組み立ててから返し、欠けがあれば失敗する（部分的な結果を返さない）。
     */
    async exportGame(input: {
      token: string;
      gameId: string;
      format: 'csv' | 'json';
    }) {
      const principal = await uow.run((repos) =>
        authenticate(repos, input.token, input.gameId),
      );
      requireFacilitatorPrincipal(principal, '出力');
      const { sessionStatus, source } = await exports.read(input.gameId);
      if (!canDisclose(sessionStatus) || !source)
        throw new PermissionError('出力は、ゲームが終了してからできます');
      const built = buildExport(source);
      return input.format === 'csv'
        ? {
            contentType: 'text/csv; charset=utf-8',
            filename: `beer-game-${input.gameId}.csv`,
            body: built.csv,
          }
        : {
            contentType: 'application/json; charset=utf-8',
            filename: `beer-game-${input.gameId}.json`,
            body: JSON.stringify(built.json, null, 2),
          };
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
          commitMode: session.settings.commitMode,
          settings: settingsView(session.settings),
          submitted: Object.fromEntries(
            ROLES.map((r) => [r, session.decisions[r] !== undefined]),
          ) as Record<Role, boolean>,
          /** 役割ごとの入力の版（代理入力の楽観的排他に使う。値は含めない） */
          versions: Object.fromEntries(
            ROLES.map((r) => [r, session.decisions[r]?.version ?? 0]),
          ) as Record<Role, number>,
        };
      });
    },
  };
}

export type Application = ReturnType<typeof createApplication>;
