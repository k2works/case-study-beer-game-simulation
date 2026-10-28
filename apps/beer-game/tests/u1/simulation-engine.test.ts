import { describe, expect, it } from 'vitest';
import { initialRoleState, simulateWeek } from '../../src/domain/simulation-engine.js';
import { ROLES, type Role, type SessionSnapshot } from '../../src/domain/types.js';

const settings = { holdingCostMinor: 50, backlogCostMinor: 100, quantityUpperBound: 1000 };
const snapshot = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  sessionId: 'session',
  gameId: 'game',
  week: 1,
  finalWeek: 2,
  status: 'ACTIVE',
  version: 1,
  demand: [4, 8],
  roles: Object.fromEntries(
    ROLES.map((role) => [role, initialRoleState(role)]),
  ) as SessionSnapshot['roles'],
  ...overrides,
});
const decisions = Object.fromEntries(ROLES.map((role) => [role, 4])) as Record<Role, number>;

describe('Given an active custom-series game, when week one is simulated', () => {
  it('advances exactly one week and version', () => {
    const result = simulateWeek(snapshot(), decisions, settings);
    expect(result.snapshot.week).toBe(2);
    expect(result.snapshot.version).toBe(2);
  });
  it('keeps deterministic results', () => {
    expect(simulateWeek(snapshot(), decisions, settings)).toEqual(
      simulateWeek(snapshot(), decisions, settings),
    );
  });
  it.each(ROLES)('keeps %s balances non-negative', (role) => {
    const result = simulateWeek(snapshot(), decisions, settings).result.roles[role];
    expect(result.endingInventory).toBeGreaterThanOrEqual(0);
    expect(result.endingBacklog).toBeGreaterThanOrEqual(0);
  });
  it.each(ROLES)('calculates integer-minor cost for %s', (role) => {
    expect(
      Number.isSafeInteger(
        simulateWeek(snapshot(), decisions, settings).result.roles[role].weeklyCostMinor,
      ),
    ).toBe(true);
  });
  it('ends on the configured final week', () =>
    expect(simulateWeek(snapshot({ finalWeek: 1 }), decisions, settings).snapshot.status).toBe(
      'ENDED',
    ));
  it('rejects inactive sessions', () =>
    expect(() => simulateWeek(snapshot({ status: 'LOBBY' }), decisions, settings)).toThrow(
      'not active',
    ));
  it('rejects missing demand', () =>
    expect(() => simulateWeek(snapshot({ week: 3 }), decisions, settings)).toThrow(
      'demand is missing',
    ));
  it.each([-1, 1.5, 1001])('rejects invalid decision %s', (quantity) =>
    expect(() => simulateWeek(snapshot(), { ...decisions, RETAILER: quantity }, settings)).toThrow(
      RangeError,
    ),
  );
  it('carries backlog when demand exceeds stock', () => {
    const high = snapshot({ demand: [100] });
    expect(simulateWeek(high, decisions, settings).result.roles.RETAILER.endingBacklog).toBe(84);
  });
  it('advances factory production delay', () =>
    expect(
      simulateWeek(snapshot(), { ...decisions, FACTORY: 9 }, settings).snapshot.roles.FACTORY
        .production,
    ).toEqual([4, 9]));
});
