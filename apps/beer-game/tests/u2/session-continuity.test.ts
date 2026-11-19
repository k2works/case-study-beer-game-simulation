import { beforeEach, describe, expect, it } from 'vitest';
import { GameService, Problem, type Actor } from '../../src/application/game-service.js';
import { ROLES, type Role } from '../../src/domain/types.js';

let service: GameService;
let facilitator: Actor;
let actors: Record<Role, Actor>;
let recoveryToken: string;

beforeEach(() => {
  service = new GameService();
  const game = service.createGame({ finalWeek: 2, demand: [4, 4] }, 'create');
  facilitator = { id: game.gameId, kind: 'FACILITATOR', gameId: game.gameId };
  actors = {} as Record<Role, Actor>;
  ROLES.forEach((role, index) => {
    const joined = service.joinGame(game.gameId, role, `join-${index}`);
    if (role === 'RETAILER') recoveryToken = joined.recoveryToken;
    service.assignRole(facilitator, joined.participantId, role);
    actors[role] = service.actorForParticipant(game.gameId, joined.participantId);
  });
  service.startSession(facilitator);
});

describe('Given an active session, when the facilitator controls continuity', () => {
  it('pauses and resumes while preserving drafts', () => {
    service.submitDecision(actors.RETAILER, 7, 0, 'draft');
    const paused = service.pauseSession(facilitator, 2, 'pause');
    expect(paused.status).toBe('PAUSED');
    expect(() => service.submitDecision(actors.WHOLESALER, 4, 0, 'blocked')).toThrow('not active');
    expect(service.roleSafeState(actors.RETAILER).decisionComplete).toBe(true);
    expect(service.resumeSession(facilitator, paused.version, 'resume').status).toBe('ACTIVE');
  });

  it('ends irreversibly and rejects resume', () => {
    const ended = service.endSession(facilitator, 2, 'end');
    expect(ended.status).toBe('ENDED');
    expect(() => service.resumeSession(facilitator, ended.version, 'resume')).toThrow(Problem);
  });

  it('rejects stale lifecycle commands with current version', () => {
    expect(() => service.pauseSession(facilitator, 1, 'pause')).toThrow(Problem);
  });

  it('submits a proxy decision and records actor attribution', () => {
    const result = service.submitProxyDecision(facilitator, 'RETAILER', 8, 0, 'proxy');
    expect(result).toMatchObject({ role: 'RETAILER', quantity: 8, proxied: true });
    expect(service.events(facilitator.gameId).at(-1)?.eventType).toBe('ProxyDecisionSubmitted');
  });
});

describe('Given a recovery token, when a participant reconnects', () => {
  it('restores the same role and rotates the token', () => {
    const recovered = service.recoverParticipation(recoveryToken);
    expect(recovered.actor.role).toBe('RETAILER');
    expect(recovered.recoveryToken).not.toBe(recoveryToken);
    expect(() => service.recoverParticipation(recoveryToken)).toThrow('not available');
  });

  it('returns a uniform failure for an invalid token', () => {
    try {
      service.recoverParticipation('invalid');
    } catch (error) {
      expect(error).toMatchObject({ status: 401, code: 'RECOVERY_NOT_AVAILABLE' });
    }
  });

  it('rejects stale decisions from another tab with the latest version', () => {
    service.submitDecision(actors.RETAILER, 4, 0, 'tab-a');
    expect(() => service.submitDecision(actors.RETAILER, 5, 0, 'tab-b')).toThrow(Problem);
  });
});
