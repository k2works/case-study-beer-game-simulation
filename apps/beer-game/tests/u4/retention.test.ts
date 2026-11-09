import { describe, expect, it } from 'vitest';
import { RetentionService, OWNER_UNITS } from '../../src/retention/retention-service.js';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const makeService = () => {
  let now = NOW.getTime();
  const service = new RetentionService({
    now: () => new Date(now),
    jitter: () => 0,
    hmacKey: 'test-only-key',
  });
  return { service, advance: (ms: number) => (now += ms) };
};

const completed = (deletionId: string, ownerUnit: (typeof OWNER_UNITS)[number], attempt = 1) => ({
  eventId: `${ownerUnit}-${attempt}`,
  deletionId,
  ownerUnit,
  status: 'completed' as const,
  completedAt: NOW.toISOString(),
  attempt,
  schemaVersion: 2 as const,
});

describe('U4 retention behavior', () => {
  it('Given no retention period, When a game is configured, Then deletion is due after 90 days', () => {
    const { service, advance } = makeService();
    const policy = service.configure('game-1');
    expect(policy.retentionDays).toBe(90);
    expect(service.startDueDeletions()).toEqual([]);
    advance(90 * 86400_000);
    expect(service.startDueDeletions()).toHaveLength(1);
  });

  it('rejects invalid periods and a conflicting policy change', () => {
    const { service } = makeService();
    expect(() => service.configure('game-1', 0)).toThrow('INVALID_RETENTION_POLICY');
    expect(() => service.configure('game-1', 3651)).toThrow('INVALID_RETENTION_POLICY');
    service.configure('game-1', 45);
    expect(() => service.configure('game-1', 46)).toThrow('POLICY_CONFLICT');
  });

  it('Given a due game, When the scheduler repeats, Then one saga and three owner requests exist', () => {
    const { service } = makeService();
    service.configure('game-1', 1, new Date(NOW.getTime() - 86400_000));
    const [saga] = service.startDueDeletions();
    expect(service.startDueDeletions()).toEqual([]);
    expect(service.pendingRequests()).toHaveLength(3);
    expect(service.status('game-1').deletionId).toBe(saga.deletionId);
  });

  it('Given duplicate and old completion, When consumed, Then progress does not regress', () => {
    const { service } = makeService();
    service.configure('game-1', 1, new Date(NOW.getTime() - 86400_000));
    const [saga] = service.startDueDeletions();
    const event = completed(saga.deletionId, OWNER_UNITS[0]);
    expect(service.consumeCompletion(event)).toBe('accepted');
    expect(service.consumeCompletion(event)).toBe('duplicate');
    expect(service.consumeCompletion({ ...event, eventId: 'late', attempt: 2 })).toBe('stale');
    expect(service.status('game-1').owners[OWNER_UNITS[0]]).toBe('COMPLETED');
  });

  it('quarantines a duplicate event ID with a different payload', () => {
    const { service } = makeService();
    service.configure('game-1', 1, new Date(NOW.getTime() - 86400_000));
    const [saga] = service.startDueDeletions();
    const event = completed(saga.deletionId, OWNER_UNITS[0]);
    service.consumeCompletion(event);
    expect(service.consumeCompletion({ ...event, status: 'permanent-failure' })).toBe(
      'quarantined',
    );
    expect(service.quarantinedCount()).toBe(1);
  });

  it('Given one owner unfinished, When two complete, Then no completed receipt exists', () => {
    const { service } = makeService();
    service.configure('game-1', 1, new Date(NOW.getTime() - 86400_000));
    const [saga] = service.startDueDeletions();
    service.consumeCompletion(completed(saga.deletionId, OWNER_UNITS[0]));
    service.consumeCompletion(completed(saga.deletionId, OWNER_UNITS[1]));
    expect(service.status('game-1').status).toBe('IN_PROGRESS');
    expect(service.receipt(saga.deletionId)).toBeUndefined();
  });

  it('Given all owners complete, When the final completion arrives, Then one privacy-safe receipt exists', () => {
    const { service } = makeService();
    service.configure('game-1', 1, new Date(NOW.getTime() - 86400_000));
    const [saga] = service.startDueDeletions();
    for (const owner of OWNER_UNITS) service.consumeCompletion(completed(saga.deletionId, owner));
    expect(service.status('game-1').status).toBe('COMPLETED');
    const receipt = service.receipt(saga.deletionId)!;
    expect(receipt.outcome).toBe('COMPLETED');
    expect(JSON.stringify(receipt)).not.toContain('game-1');
    expect(receipt.gameReferenceDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not accept a completion for an unknown deletion ID', () => {
    const { service } = makeService();
    expect(service.consumeCompletion(completed('unknown', OWNER_UNITS[0]))).toBe('quarantined');
  });

  it('Given retryable failures, When the schedule runs, Then it retries five times and fails after attempt six', () => {
    const { service, advance } = makeService();
    service.configure('game-1', 1, new Date(NOW.getTime() - 86400_000));
    const [saga] = service.startDueDeletions();
    for (let attempt = 1; attempt <= 6; attempt++) {
      service.consumeCompletion({
        ...completed(saga.deletionId, OWNER_UNITS[0], attempt),
        status: 'retryable-failure',
        failureCode: 'TIMEOUT',
      });
      if (attempt < 6) {
        advance(31 * 60_000);
        expect(service.runScheduledRetries()).toHaveLength(1);
        expect(service.status('game-1').attempt).toBe(attempt + 1);
      }
    }
    expect(service.status('game-1').status).toBe('FAILED');
  });

  it('Given a permanent failure, When an operator retries, Then only unfinished owners receive new requests', () => {
    const { service } = makeService();
    service.configure('game-1', 1, new Date(NOW.getTime() - 86400_000));
    const [saga] = service.startDueDeletions();
    service.consumeCompletion(completed(saga.deletionId, OWNER_UNITS[0]));
    service.consumeCompletion({
      ...completed(saga.deletionId, OWNER_UNITS[1]),
      status: 'permanent-failure',
      failureCode: 'OWNER_ERROR',
    });
    expect(service.status('game-1').status).toBe('FAILED');
    expect(() => service.manualRetry('game-1', false)).toThrow('OPERATOR_REQUIRED');
    expect(service.manualRetry('game-1', true).attempt).toBe(2);
    expect(service.pendingRequests().filter((event) => event.attempt === 2)).toHaveLength(2);
  });

  it('rejects a manual retry unless the saga is FAILED', () => {
    const { service } = makeService();
    service.configure('game-1', 1, new Date(NOW.getTime() - 86400_000));
    service.startDueDeletions();
    expect(() => service.manualRetry('game-1', true)).toThrow('RETRY_NOT_ALLOWED');
  });

  it('Given a v1 event or unknown major, When consumed, Then it is quarantined', () => {
    const { service } = makeService();
    service.configure('game-1', 1, new Date(NOW.getTime() - 86400_000));
    const [saga] = service.startDueDeletions();
    expect(
      service.consumeCompletion({
        ...completed(saga.deletionId, OWNER_UNITS[0]),
        schemaVersion: 1,
      }),
    ).toBe('quarantined');
    expect(
      service.consumeCompletion({
        ...completed(saga.deletionId, OWNER_UNITS[0]),
        schemaVersion: 3,
      }),
    ).toBe('quarantined');
    expect(service.status('game-1').owners[OWNER_UNITS[0]]).toBe('PENDING');
  });

  it('Given a restored database, When expiry sweep has not run, Then receipt reads stay closed', () => {
    const { service, advance } = makeService();
    service.configure('game-1', 1, new Date(NOW.getTime() - 86400_000));
    const [saga] = service.startDueDeletions();
    for (const owner of OWNER_UNITS) service.consumeCompletion(completed(saga.deletionId, owner));
    service.beginRestore();
    expect(() => service.receipt(saga.deletionId)).toThrow('RESTORE_GATE_CLOSED');
    advance(366 * 86400_000);
    expect(service.completeRestore()).toBe(1);
    expect(service.receipt(saga.deletionId)).toBeUndefined();
  });

  it('hides expired receipts before the cleanup worker removes them', () => {
    const { service, advance } = makeService();
    service.configure('game-1', 1, new Date(NOW.getTime() - 86400_000));
    const [saga] = service.startDueDeletions();
    for (const owner of OWNER_UNITS) service.consumeCompletion(completed(saga.deletionId, owner));
    advance(366 * 86400_000);
    expect(service.receipt(saga.deletionId)).toBeUndefined();
    expect(service.cleanupExpiredReceipts()).toBe(1);
  });
});
