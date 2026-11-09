import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const OWNER_UNITS = [
  'u1-walking-skeleton',
  'u2-session-continuity',
  'u3-learning-view',
] as const;
export type OwnerUnit = (typeof OWNER_UNITS)[number];
export type DeletionStatus = 'PENDING' | 'IN_PROGRESS' | 'FAILED' | 'COMPLETED';
export type OwnerStatus = 'PENDING' | 'COMPLETED' | 'RETRYABLE_FAILURE' | 'PERMANENT_FAILURE';

export interface RetentionPolicy {
  gameId: string;
  retentionDays: number;
  retentionStartsAt: string;
  deleteAfter: string;
  policyVersion: number;
}
export interface DeletionRequest {
  eventId: string;
  deletionId: string;
  gameId: string;
  requestedAt: string;
  attempt: number;
  schemaVersion: 1;
  ownerUnit: OwnerUnit;
}
export interface DeletionReceipt {
  deletionId: string;
  gameReferenceDigest: string;
  outcome: 'COMPLETED' | 'FAILED';
  recordedAt: string;
  expiresAt: string;
  correlationId: string;
}
export interface SagaSnapshot {
  deletionId: string;
  gameId: string;
  status: DeletionStatus;
  attempt: number;
  owners: Record<OwnerUnit, OwnerStatus>;
  failureCode?: string;
  nextAttemptAt?: string;
}
interface Saga extends SagaSnapshot {
  automaticRetries: number;
  seenEvents: Map<string, string>;
}

const completionSchema = z.object({
  eventId: z.string().min(1),
  deletionId: z.string().min(1),
  ownerUnit: z.enum(OWNER_UNITS),
  status: z.enum(['completed', 'retryable-failure', 'permanent-failure']),
  completedAt: z.iso.datetime(),
  attempt: z.number().int().min(1),
  schemaVersion: z.literal(2),
  failureCode: z.string().max(80).optional(),
});

export class RetentionError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export class RetentionService {
  private readonly policies = new Map<string, RetentionPolicy>();
  private readonly sagas = new Map<string, Saga>();
  private readonly sagaByGame = new Map<string, string>();
  private readonly requests: DeletionRequest[] = [];
  private readonly receipts = new Map<string, DeletionReceipt>();
  private readonly quarantine: unknown[] = [];
  private restoreGateClosed = false;
  private readonly now: () => Date;
  private readonly jitter: () => number;
  private readonly hmacKey: string;

  constructor(options: { now?: () => Date; jitter?: () => number; hmacKey: string }) {
    if (!options.hmacKey) throw new RetentionError('HMAC_KEY_REQUIRED');
    this.now = options.now ?? (() => new Date());
    this.jitter = options.jitter ?? Math.random;
    this.hmacKey = options.hmacKey;
  }

  configure(gameId: string, retentionDays = 90, startsAt = this.now()): RetentionPolicy {
    if (
      !gameId ||
      !Number.isSafeInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > 3650
    )
      throw new RetentionError('INVALID_RETENTION_POLICY');
    const existing = this.policies.get(gameId);
    if (existing) {
      if (existing.retentionDays !== retentionDays) throw new RetentionError('POLICY_CONFLICT');
      return { ...existing };
    }
    const policy: RetentionPolicy = {
      gameId,
      retentionDays,
      retentionStartsAt: startsAt.toISOString(),
      deleteAfter: new Date(startsAt.getTime() + retentionDays * 86400_000).toISOString(),
      policyVersion: 1,
    };
    this.policies.set(gameId, policy);
    return { ...policy };
  }

  startDueDeletions(): SagaSnapshot[] {
    const started: SagaSnapshot[] = [];
    for (const policy of this.policies.values()) {
      if (new Date(policy.deleteAfter).getTime() > this.now().getTime()) continue;
      if (this.sagaByGame.has(policy.gameId)) continue;
      const saga: Saga = {
        deletionId: randomUUID(),
        gameId: policy.gameId,
        status: 'IN_PROGRESS',
        attempt: 1,
        owners: Object.fromEntries(
          OWNER_UNITS.map((owner) => [owner, 'PENDING']),
        ) as Saga['owners'],
        automaticRetries: 0,
        seenEvents: new Map(),
      };
      this.sagas.set(saga.deletionId, saga);
      this.sagaByGame.set(policy.gameId, saga.deletionId);
      this.enqueueIncompleteOwners(saga);
      started.push(this.snapshot(saga));
    }
    return started;
  }

  consumeCompletion(raw: unknown): 'accepted' | 'duplicate' | 'stale' | 'quarantined' {
    const parsed = completionSchema.safeParse(raw);
    if (!parsed.success) {
      this.quarantine.push(raw);
      return 'quarantined';
    }
    const completion = parsed.data;
    const saga = this.sagas.get(completion.deletionId);
    if (!saga) {
      this.quarantine.push(raw);
      return 'quarantined';
    }
    const fingerprint = JSON.stringify(completion);
    const previous = saga.seenEvents.get(completion.eventId);
    if (previous) {
      if (previous !== fingerprint) {
        this.quarantine.push(raw);
        return 'quarantined';
      }
      return 'duplicate';
    }
    if (completion.attempt !== saga.attempt || saga.status !== 'IN_PROGRESS') return 'stale';
    saga.seenEvents.set(completion.eventId, fingerprint);
    const current = saga.owners[completion.ownerUnit];
    if (current === 'COMPLETED') return 'duplicate';
    if (completion.status === 'completed') {
      saga.owners[completion.ownerUnit] = 'COMPLETED';
      if (OWNER_UNITS.every((owner) => saga.owners[owner] === 'COMPLETED')) {
        this.storeReceipt(saga, 'COMPLETED');
        saga.status = 'COMPLETED';
        saga.nextAttemptAt = undefined;
      }
      return 'accepted';
    }
    saga.failureCode = completion.failureCode ?? 'OWNER_FAILURE';
    if (completion.status === 'permanent-failure') {
      saga.owners[completion.ownerUnit] = 'PERMANENT_FAILURE';
      saga.status = 'FAILED';
      this.storeReceipt(saga, 'FAILED');
      return 'accepted';
    }
    saga.owners[completion.ownerUnit] = 'RETRYABLE_FAILURE';
    if (saga.automaticRetries >= 5) {
      saga.status = 'FAILED';
      this.storeReceipt(saga, 'FAILED');
      return 'accepted';
    }
    const base = Math.min(15 * 60_000, 30_000 * 2 ** saga.automaticRetries);
    const jitter = Math.max(0, Math.min(1, this.jitter())) * base;
    saga.nextAttemptAt = new Date(this.now().getTime() + base + jitter).toISOString();
    return 'accepted';
  }

  runScheduledRetries(): SagaSnapshot[] {
    const retried: SagaSnapshot[] = [];
    for (const saga of this.sagas.values()) {
      if (saga.status !== 'IN_PROGRESS' || !saga.nextAttemptAt) continue;
      if (new Date(saga.nextAttemptAt).getTime() > this.now().getTime()) continue;
      saga.automaticRetries += 1;
      saga.attempt += 1;
      saga.nextAttemptAt = undefined;
      for (const owner of OWNER_UNITS)
        if (saga.owners[owner] !== 'COMPLETED') saga.owners[owner] = 'PENDING';
      this.enqueueIncompleteOwners(saga);
      retried.push(this.snapshot(saga));
    }
    return retried;
  }

  manualRetry(gameId: string, operatorAuthorized: boolean): SagaSnapshot {
    if (!operatorAuthorized) throw new RetentionError('OPERATOR_REQUIRED');
    const saga = this.sagaForGame(gameId);
    if (saga.status !== 'FAILED') throw new RetentionError('RETRY_NOT_ALLOWED');
    saga.status = 'IN_PROGRESS';
    saga.attempt += 1;
    saga.automaticRetries = 0;
    saga.failureCode = undefined;
    saga.nextAttemptAt = undefined;
    for (const owner of OWNER_UNITS)
      if (saga.owners[owner] !== 'COMPLETED') saga.owners[owner] = 'PENDING';
    this.enqueueIncompleteOwners(saga);
    return this.snapshot(saga);
  }

  status(gameId: string): SagaSnapshot {
    return this.snapshot(this.sagaForGame(gameId));
  }

  policy(gameId: string): RetentionPolicy | undefined {
    const policy = this.policies.get(gameId);
    return policy ? { ...policy } : undefined;
  }

  pendingRequests(): DeletionRequest[] {
    return this.requests.map((request) => ({ ...request }));
  }

  quarantinedCount(): number {
    return this.quarantine.length;
  }

  receipt(deletionId: string): DeletionReceipt | undefined {
    if (this.restoreGateClosed) throw new RetentionError('RESTORE_GATE_CLOSED');
    const receipt = this.receipts.get(deletionId);
    if (!receipt || new Date(receipt.expiresAt).getTime() <= this.now().getTime()) return undefined;
    return { ...receipt };
  }

  cleanupExpiredReceipts(): number {
    let removed = 0;
    for (const [id, receipt] of this.receipts)
      if (new Date(receipt.expiresAt).getTime() <= this.now().getTime()) {
        this.receipts.delete(id);
        removed += 1;
      }
    return removed;
  }

  beginRestore(): void {
    this.restoreGateClosed = true;
  }

  completeRestore(): number {
    const removed = this.cleanupExpiredReceipts();
    this.restoreGateClosed = false;
    return removed;
  }

  private sagaForGame(gameId: string): Saga {
    const id = this.sagaByGame.get(gameId);
    const saga = id ? this.sagas.get(id) : undefined;
    if (!saga) throw new RetentionError('DELETION_NOT_FOUND');
    return saga;
  }

  private snapshot(saga: Saga): SagaSnapshot {
    return {
      deletionId: saga.deletionId,
      gameId: saga.gameId,
      status: saga.status,
      attempt: saga.attempt,
      owners: { ...saga.owners },
      failureCode: saga.failureCode,
      nextAttemptAt: saga.nextAttemptAt,
    };
  }

  private enqueueIncompleteOwners(saga: Saga): void {
    for (const ownerUnit of OWNER_UNITS) {
      if (saga.owners[ownerUnit] === 'COMPLETED') continue;
      this.requests.push({
        eventId: randomUUID(),
        deletionId: saga.deletionId,
        gameId: saga.gameId,
        requestedAt: this.now().toISOString(),
        attempt: saga.attempt,
        schemaVersion: 1,
        ownerUnit,
      });
    }
  }

  private storeReceipt(saga: Saga, outcome: DeletionReceipt['outcome']): void {
    const recordedAt = this.now();
    const previous = this.receipts.get(saga.deletionId);
    this.receipts.set(saga.deletionId, {
      deletionId: saga.deletionId,
      gameReferenceDigest: createHmac('sha256', this.hmacKey).update(saga.gameId).digest('hex'),
      outcome,
      recordedAt: recordedAt.toISOString(),
      expiresAt: new Date(recordedAt.getTime() + 365 * 86400_000).toISOString(),
      correlationId: previous?.correlationId ?? randomUUID(),
    });
  }
}
