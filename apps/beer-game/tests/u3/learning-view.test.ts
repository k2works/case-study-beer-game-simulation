import { describe, expect, it } from 'vitest';
import { LearningViewService, type LearningActor } from '../../src/learning/learning-view.js';

const observer: LearningActor = { id: 'observer-1', gameId: 'game-1', kind: 'OBSERVER' };
const facilitator: LearningActor = { id: 'facilitator-1', gameId: 'game-1', kind: 'FACILITATOR' };
const event = (version: number, eventId = `event-${version}`, eventType = 'WeekCommitted') => ({
  eventId,
  eventType,
  gameId: 'game-1',
  sessionId: 'session-1',
  aggregateVersion: version,
  schemaVersion: 1 as const,
  occurredAt: '2026-11-05T00:00:00Z',
  correlationId: 'corr-1',
  data: {
    week: version,
    status: 'ACTIVE',
    completionStatus: { RETAILER: true },
    teamTotals: { inventory: 8, backlog: 3, orders: 4 },
    contributorCount: 4,
  },
});

describe('U3 Learning View behavior', () => {
  it('Given contiguous events When consumed Then observation advances once', () => {
    const service = new LearningViewService();
    expect(service.consume(event(1))).toEqual({ status: 'APPLIED', sourceVersion: 1 });
    expect(service.consume(event(1))).toEqual({ status: 'DUPLICATE', sourceVersion: 1 });
    expect(service.getObservation(observer).sourceVersion).toBe(1);
  });

  it('Given a version gap When consumed Then projection remains stale', () => {
    const service = new LearningViewService();
    service.consume(event(1));
    expect(service.consume(event(3))).toEqual({ status: 'GAP', sourceVersion: 1 });
    expect(service.getObservation(observer).stale).toBe(true);
  });

  it('Given disclosure risk When projected Then unsafe totals are suppressed', () => {
    const service = new LearningViewService();
    const risky = event(1);
    risky.data.contributorCount = 1;
    service.consume(risky);
    expect(service.getObservation(observer)).toMatchObject({
      safeTeamTotals: undefined,
      suppressionReasons: ['INSUFFICIENT_CONTRIBUTORS'],
    });
  });

  it('Given a running game When review requested Then disclosure is denied', () => {
    const service = new LearningViewService();
    service.consume(event(1));
    expect(() => service.getReview(observer)).toThrowError(/GAME_NOT_ENDED/);
  });

  it('Given an ended game When review requested Then aligned series is returned', () => {
    const service = new LearningViewService();
    service.consume(event(1));
    service.consume(event(2, 'ended', 'SessionEnded'));
    expect(service.getReview(observer)).toMatchObject({ status: 'READY', sourceVersion: 2 });
  });

  it('Given a non-facilitator When export requested Then it is forbidden', () => {
    const service = new LearningViewService();
    service.consume(event(1));
    service.consume(event(2, 'ended', 'SessionEnded'));
    expect(() => service.createExport(observer, 'key-1')).toThrowError(/FORBIDDEN/);
  });

  it('Given an ended game When facilitator exports Then CSV and JSON share values', () => {
    const service = new LearningViewService();
    service.consume(event(1));
    service.consume(event(2, 'ended', 'SessionEnded'));
    const result = service.createExport(facilitator, 'key-1');
    expect(result.status).toBe('COMPLETE');
    expect(result.csv).toContain('week,inventory,backlog,orders');
    expect(JSON.parse(result.json).sourceVersion).toBe(2);
  });

  it('Given a reused idempotency key When exporting Then the same package is returned', () => {
    const service = new LearningViewService();
    service.consume(event(1));
    service.consume(event(2, 'ended', 'SessionEnded'));
    expect(service.createExport(facilitator, 'key-1')).toEqual(
      service.createExport(facilitator, 'key-1'),
    );
  });
});
