import { createHash, randomUUID } from 'node:crypto';
import {
  initialRoleState,
  simulateWeek,
  type SimulationSettings,
} from '../domain/simulation-engine.js';
import { ROLES, type Role, type SessionSnapshot, type WeekResult } from '../domain/types.js';
import { issueCredential } from '../security/credentials.js';
import { credentialMatches } from '../security/credentials.js';

export interface Actor {
  id: string;
  kind: 'FACILITATOR' | 'PARTICIPANT';
  gameId: string;
  role?: Role;
}
export interface SafeState {
  sessionId: string;
  week: number;
  status: string;
  version: number;
  decisionComplete: boolean;
  own: { role: Role; inventory: number; backlog: number; arrivals: number; order: number };
}
interface Participant {
  id: string;
  name: string;
  role?: Role;
  credentialDigest: string;
  credentialExpiresAt: number;
  credentialRevoked: boolean;
}
interface Game {
  id: string;
  joinCode: string;
  facilitatorDigest: string;
  session: SessionSnapshot;
  participants: Map<string, Participant>;
  decisions: Map<Role, { quantity: number; version: number }>;
  idempotency: Map<string, { requestDigest: string; value: unknown }>;
  results: WeekResult[];
  events: DomainEvent[];
}
export interface DomainEvent {
  eventId: string;
  eventType: string;
  gameId: string;
  sessionId: string;
  aggregateVersion: number;
  schemaVersion: 1;
  correlationId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}
export interface CreateGameResult {
  gameId: string;
  sessionId: string;
  joinCode: string;
  facilitatorCredential: string;
  version: number;
}

export class Problem extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public latest?: unknown,
  ) {
    super(message);
  }
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const DEFAULT_SETTINGS: SimulationSettings = {
  holdingCostMinor: 50,
  backlogCostMinor: 100,
  quantityUpperBound: 1000,
};

export class GameService {
  private readonly games = new Map<string, Game>();
  private readonly creationKeys = new Map<
    string,
    { requestDigest: string; value: CreateGameResult }
  >();

  createGame(input: { finalWeek: number; demand: number[] }, key: string): CreateGameResult {
    if (!key) throw new Problem(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required');
    if (
      !Number.isInteger(input.finalWeek) ||
      input.finalWeek < 1 ||
      input.demand.length < input.finalWeek ||
      input.demand.some((v) => !Number.isSafeInteger(v) || v < 0 || v > 1000)
    )
      throw new Problem(400, 'INVALID_GAME', 'finalWeek and demand must be bounded integers');
    const requestDigest = digest(input);
    const existing = this.creationKeys.get(key);
    if (existing) {
      if (existing.requestDigest !== requestDigest)
        throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'Key was used with a different request');
      return existing.value;
    }
    const id = randomUUID();
    const sessionId = randomUUID();
    const credential = issueCredential();
    const roles = Object.fromEntries(
      ROLES.map((role) => [role, initialRoleState(role)]),
    ) as SessionSnapshot['roles'];
    const game: Game = {
      id,
      joinCode: randomBytesCode(),
      facilitatorDigest: credential.digest,
      participants: new Map(),
      decisions: new Map(),
      idempotency: new Map(),
      results: [],
      events: [],
      session: {
        sessionId,
        gameId: id,
        week: 1,
        finalWeek: input.finalWeek,
        status: 'LOBBY',
        version: 1,
        demand: input.demand,
        roles,
      },
    };
    this.emit(game, 'GameCreated', {});
    this.games.set(id, game);
    const value = {
      gameId: id,
      sessionId,
      joinCode: game.joinCode,
      facilitatorCredential: credential.raw,
      version: 1,
    };
    this.creationKeys.set(key, { requestDigest, value });
    return value;
  }

  joinGame(gameId: string, displayName: string, key: string) {
    const game = this.game(gameId);
    if (game.session.status !== 'LOBBY')
      throw new Problem(409, 'JOIN_CLOSED', 'Game is not accepting participants');
    const name = displayName.trim();
    if (name.length < 1 || name.length > 80)
      throw new Problem(400, 'INVALID_NAME', 'Display name must be 1..80 characters');
    return this.idempotent(game, `join:${key}`, { name }, () => {
      const credential = issueCredential();
      const participant: Participant = {
        id: randomUUID(),
        name,
        credentialDigest: credential.digest,
        credentialExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
        credentialRevoked: false,
      };
      game.participants.set(participant.id, participant);
      this.emit(game, 'ParticipantJoined', { participantId: participant.id });
      return { participantId: participant.id, recoveryToken: credential.raw };
    });
  }

  assignRole(actor: Actor, participantId: string, role: Role) {
    const game = this.authorizeFacilitator(actor);
    const participant = game.participants.get(participantId);
    if (!participant) throw new Problem(404, 'PARTICIPANT_NOT_FOUND', 'Participant was not found');
    if (participant.role && participant.role !== role)
      throw new Problem(409, 'ROLE_ALREADY_ASSIGNED', 'Participant already has a role');
    if ([...game.participants.values()].some((p) => p.id !== participantId && p.role === role))
      throw new Problem(409, 'ROLE_OCCUPIED', 'Role is occupied');
    participant.role = role;
    this.emit(game, 'RoleAssigned', { participantId, role });
    return { participantId, role };
  }

  startSession(actor: Actor) {
    const game = this.authorizeFacilitator(actor);
    const assigned = new Set([...game.participants.values()].map((p) => p.role));
    const missing = ROLES.filter((role) => !assigned.has(role));
    if (missing.length)
      throw new Problem(409, 'ROLES_MISSING', `Missing roles: ${missing.join(', ')}`);
    game.session = { ...game.session, status: 'ACTIVE', version: game.session.version + 1 };
    return { version: game.session.version };
  }

  pauseSession(actor: Actor, expectedVersion: number, key: string) {
    return this.transitionSession(
      actor,
      expectedVersion,
      key,
      'PAUSED',
      ['ACTIVE'],
      'SessionPaused',
    );
  }

  resumeSession(actor: Actor, expectedVersion: number, key: string) {
    return this.transitionSession(
      actor,
      expectedVersion,
      key,
      'ACTIVE',
      ['PAUSED'],
      'SessionResumed',
    );
  }

  endSession(actor: Actor, expectedVersion: number, key: string) {
    return this.transitionSession(
      actor,
      expectedVersion,
      key,
      'ENDED',
      ['ACTIVE', 'PAUSED'],
      'SessionEnded',
    );
  }

  submitProxyDecision(
    actor: Actor,
    role: Role,
    quantity: number,
    expectedVersion: number,
    key: string,
  ) {
    const game = this.authorizeFacilitator(actor);
    if (game.session.status !== 'ACTIVE')
      throw new Problem(409, 'SESSION_NOT_ACTIVE', 'Session is not active');
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000)
      throw new Problem(400, 'INVALID_QUANTITY', 'Quantity must be a bounded integer');
    return this.idempotent(
      game,
      `proxy:${role}:${key}`,
      { role, quantity, expectedVersion },
      () => {
        const current = game.decisions.get(role);
        const version = current?.version ?? 0;
        if (version !== expectedVersion)
          throw new Problem(409, 'STALE_STATE', 'Decision version is stale', { version });
        game.decisions.set(role, { quantity, version: version + 1 });
        this.emit(game, 'ProxyDecisionSubmitted', { role, actorId: actor.id });
        return { role, quantity, version: version + 1, proxied: true as const };
      },
    );
  }

  recoverParticipation(rawToken: string) {
    for (const game of this.games.values()) {
      for (const participant of game.participants.values()) {
        if (
          !participant.credentialRevoked &&
          participant.credentialExpiresAt > Date.now() &&
          credentialMatches(rawToken, participant.credentialDigest)
        ) {
          if (!participant.role)
            throw new Problem(401, 'RECOVERY_NOT_AVAILABLE', 'Recovery is not available');
          const rotated = issueCredential();
          participant.credentialDigest = rotated.digest;
          participant.credentialExpiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
          const actor: Actor = {
            id: participant.id,
            kind: 'PARTICIPANT',
            gameId: game.id,
            role: participant.role,
          };
          this.emit(game, 'ParticipationRecovered', { participantId: participant.id });
          return { actor, recoveryToken: rotated.raw, state: this.roleSafeState(actor) };
        }
      }
    }
    throw new Problem(401, 'RECOVERY_NOT_AVAILABLE', 'Recovery is not available');
  }

  submitDecision(actor: Actor, quantity: number, expectedVersion: number, key: string) {
    const game = this.authorizeParticipant(actor);
    if (!actor.role) throw new Problem(403, 'ROLE_REQUIRED', 'A role is required');
    if (game.session.status !== 'ACTIVE')
      throw new Problem(409, 'SESSION_NOT_ACTIVE', 'Session is not active');
    if (
      !Number.isSafeInteger(quantity) ||
      quantity < 0 ||
      quantity > DEFAULT_SETTINGS.quantityUpperBound
    )
      throw new Problem(400, 'INVALID_QUANTITY', 'Quantity must be a bounded integer');
    return this.idempotent(
      game,
      `decision:${actor.id}:${key}`,
      { quantity, expectedVersion },
      () => {
        const current = game.decisions.get(actor.role!);
        const version = current?.version ?? 0;
        if (expectedVersion !== version)
          throw new Problem(412, 'VERSION_CONFLICT', 'Decision version is stale', { version });
        game.decisions.set(actor.role!, { quantity, version: version + 1 });
        this.emit(game, 'DecisionSubmitted', { role: actor.role });
        return { role: actor.role, quantity, version: version + 1 };
      },
    );
  }

  commitWeek(actor: Actor, expectedVersion: number, key: string) {
    const game = this.authorizeFacilitator(actor);
    return this.idempotent(game, `commit:${key}`, { expectedVersion }, () => {
      if (game.session.version !== expectedVersion)
        throw new Problem(412, 'VERSION_CONFLICT', 'Session version is stale');
      const missing = ROLES.filter((role) => !game.decisions.has(role));
      if (missing.length)
        throw new Problem(409, 'DECISIONS_MISSING', `Missing decisions: ${missing.join(', ')}`);
      const decisions = Object.fromEntries(
        ROLES.map((r) => [r, game.decisions.get(r)!.quantity]),
      ) as Record<Role, number>;
      const transition = simulateWeek(game.session, decisions, DEFAULT_SETTINGS);
      game.session = transition.snapshot;
      game.results.push(transition.result);
      game.decisions.clear();
      this.emit(game, 'WeekCommitted', { week: transition.result.week });
      return { result: transition.result, version: game.session.version };
    });
  }

  roleSafeState(actor: Actor): SafeState {
    const game = this.authorizeParticipant(actor);
    const role = actor.role!;
    const state = game.session.roles[role];
    return {
      sessionId: game.session.sessionId,
      week: game.session.week,
      status: game.session.status,
      version: game.session.version,
      decisionComplete: game.decisions.has(role),
      own: {
        role,
        inventory: state.inventory,
        backlog: state.backlog,
        arrivals: state.incomingShipments[0] ?? 0,
        order: state.incomingOrders[0] ?? 0,
      },
    };
  }

  actorForParticipant(gameId: string, participantId: string): Actor {
    const participant = this.game(gameId).participants.get(participantId);
    if (!participant?.role) throw new Problem(403, 'ROLE_REQUIRED', 'Participant has no role');
    return { id: participant.id, kind: 'PARTICIPANT', gameId, role: participant.role };
  }
  events(gameId: string) {
    return this.game(gameId).events.map((event) => ({ ...event }));
  }
  private game(id: string) {
    const game = this.games.get(id);
    if (!game) throw new Problem(404, 'GAME_NOT_FOUND', 'Game was not found');
    return game;
  }
  private authorizeFacilitator(actor: Actor) {
    const game = this.game(actor.gameId);
    if (actor.kind !== 'FACILITATOR')
      throw new Problem(403, 'FORBIDDEN', 'Facilitator access required');
    return game;
  }
  private authorizeParticipant(actor: Actor) {
    const game = this.game(actor.gameId);
    if (actor.kind !== 'PARTICIPANT' || !actor.role)
      throw new Problem(403, 'FORBIDDEN', 'Participant access required');
    return game;
  }
  private idempotent<T>(game: Game, key: string, request: unknown, action: () => T): T {
    if (!key) throw new Problem(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required');
    const requestDigest = digest(request);
    const existing = game.idempotency.get(key);
    if (existing) {
      if (existing.requestDigest !== requestDigest)
        throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'Key was used with a different request');
      return existing.value as T;
    }
    const value = action();
    game.idempotency.set(key, { requestDigest, value });
    return value;
  }
  private transitionSession(
    actor: Actor,
    expectedVersion: number,
    key: string,
    nextStatus: SessionSnapshot['status'],
    allowed: SessionSnapshot['status'][],
    eventType: string,
  ) {
    const game = this.authorizeFacilitator(actor);
    return this.idempotent(game, `lifecycle:${key}`, { expectedVersion, nextStatus }, () => {
      if (game.session.version !== expectedVersion)
        throw new Problem(409, 'STALE_STATE', 'Session version is stale', {
          version: game.session.version,
        });
      if (!allowed.includes(game.session.status))
        throw new Problem(409, 'INVALID_TRANSITION', 'Session transition is not allowed');
      game.session = {
        ...game.session,
        status: nextStatus,
        version: game.session.version + 1,
      };
      this.emit(game, eventType, {});
      return { status: game.session.status, version: game.session.version };
    });
  }
  private emit(game: Game, eventType: string, data: Record<string, unknown>) {
    game.events.push({
      eventId: randomUUID(),
      eventType,
      gameId: game.id,
      sessionId: game.session.sessionId,
      aggregateVersion: game.session.version,
      schemaVersion: 1,
      correlationId: randomUUID(),
      occurredAt: new Date().toISOString(),
      data,
    });
  }
}

function randomBytesCode(): string {
  return randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
}
