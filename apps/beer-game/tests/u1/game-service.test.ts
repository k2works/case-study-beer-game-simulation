import { beforeEach, describe, expect, it } from 'vitest';
import { GameService, Problem, type Actor } from '../../src/application/game-service.js';
import { ROLES, type Role } from '../../src/domain/types.js';

let service: GameService;
let game: ReturnType<GameService['createGame']>;
let facilitator: Actor;
let actors: Record<Role, Actor>;
function readyGame() {
  game = service.createGame({ finalWeek: 2, demand: [4, 4] }, 'create');
  facilitator = { id: game.gameId, kind: 'FACILITATOR', gameId: game.gameId };
  actors = {} as Record<Role, Actor>;
  ROLES.forEach((role, index) => {
    const joined = service.joinGame(game.gameId, role, `join-${index}`);
    service.assignRole(facilitator, joined.participantId, role);
    actors[role] = service.actorForParticipant(game.gameId, joined.participantId);
  });
  service.startSession(facilitator);
}
beforeEach(() => {
  service = new GameService();
});

describe('Given a facilitator, when creating a game', () => {
  it('returns the same result for an identical retry', () => {
    const first = service.createGame({ finalWeek: 1, demand: [4] }, 'k');
    expect(service.createGame({ finalWeek: 1, demand: [4] }, 'k')).toEqual(first);
  });
  it('rejects idempotency payload mismatch', () => {
    service.createGame({ finalWeek: 1, demand: [4] }, 'k');
    expect(() => service.createGame({ finalWeek: 1, demand: [5] }, 'k')).toThrow(Problem);
  });
  it.each([
    { finalWeek: 0, demand: [4] },
    { finalWeek: 2, demand: [4] },
    { finalWeek: 1, demand: [-1] },
  ])('rejects invalid game input %#', (input) =>
    expect(() => service.createGame(input, 'k')).toThrow(Problem),
  );
});

describe('Given a lobby, when participants join and roles are assigned', () => {
  it('starts only after all roles are assigned', () => {
    readyGame();
    expect(service.roleSafeState(actors.RETAILER).status).toBe('ACTIVE');
  });
  it('rejects start with missing roles', () => {
    game = service.createGame({ finalWeek: 1, demand: [4] }, 'c');
    facilitator = { id: game.gameId, kind: 'FACILITATOR', gameId: game.gameId };
    expect(() => service.startSession(facilitator)).toThrow('Missing roles');
  });
  it('rejects duplicate role ownership', () => {
    game = service.createGame({ finalWeek: 1, demand: [4] }, 'c');
    facilitator = { id: game.gameId, kind: 'FACILITATOR', gameId: game.gameId };
    const p1 = service.joinGame(game.gameId, 'A', 'a');
    const p2 = service.joinGame(game.gameId, 'B', 'b');
    service.assignRole(facilitator, p1.participantId, 'RETAILER');
    expect(() => service.assignRole(facilitator, p2.participantId, 'RETAILER')).toThrow('occupied');
  });
  it('returns an idempotent join response', () => {
    game = service.createGame({ finalWeek: 1, demand: [4] }, 'c');
    const first = service.joinGame(game.gameId, 'A', 'j');
    expect(service.joinGame(game.gameId, 'A', 'j')).toEqual(first);
  });
  it.each(['', 'x'.repeat(81)])('rejects invalid display name', (name) => {
    game = service.createGame({ finalWeek: 1, demand: [4] }, 'c');
    expect(() => service.joinGame(game.gameId, name, 'j')).toThrow(Problem);
  });
});

describe('Given an active session, when decisions and week commit occur', () => {
  beforeEach(readyGame);
  it.each(ROLES)('accepts and exposes completion only for own %s decision', (role) => {
    service.submitDecision(actors[role], 4, 0, `d-${role}`);
    expect(service.roleSafeState(actors[role]).decisionComplete).toBe(true);
  });
  it('supports optimistic revision', () => {
    service.submitDecision(actors.RETAILER, 4, 0, 'one');
    expect(service.submitDecision(actors.RETAILER, 5, 1, 'two').version).toBe(2);
  });
  it('rejects stale decision versions with latest version', () => {
    service.submitDecision(actors.RETAILER, 4, 0, 'one');
    try {
      service.submitDecision(actors.RETAILER, 5, 0, 'two');
    } catch (error) {
      expect((error as Problem).status).toBe(412);
      expect((error as Problem).latest).toEqual({ version: 1 });
    }
  });
  it.each([-1, 1.2, 1001])('rejects invalid quantity %s', (quantity) =>
    expect(() => service.submitDecision(actors.RETAILER, quantity, 0, `bad-${quantity}`)).toThrow(
      Problem,
    ),
  );
  it('requires all four decisions before commit', () =>
    expect(() => service.commitWeek(facilitator, 2, 'commit')).toThrow('Missing decisions'));
  it('commits once and replays an identical retry', () => {
    ROLES.forEach((role) => service.submitDecision(actors[role], 4, 0, `d-${role}`));
    const first = service.commitWeek(facilitator, 2, 'commit');
    expect(service.commitWeek(facilitator, 2, 'commit')).toEqual(first);
    expect(first.result.week).toBe(1);
  });
  it('rejects commit payload mismatch', () => {
    ROLES.forEach((role) => service.submitDecision(actors[role], 4, 0, `d-${role}`));
    service.commitWeek(facilitator, 2, 'commit');
    expect(() => service.commitWeek(facilitator, 3, 'commit')).toThrow('different request');
  });
  it('emits ordered, credential-free events', () => {
    const events = service.events(game.gameId);
    expect(events.length).toBeGreaterThan(5);
    expect(JSON.stringify(events)).not.toContain('recoveryToken');
    expect(events.every((e) => e.schemaVersion === 1)).toBe(true);
  });
  it('keeps other role state structurally absent', () => {
    const state = service.roleSafeState(actors.RETAILER);
    expect(state).not.toHaveProperty('roles');
    expect(state.own.role).toBe('RETAILER');
  });
  it('rejects participant use of facilitator commands', () =>
    expect(() => service.startSession(actors.RETAILER)).toThrow('Facilitator'));
});
