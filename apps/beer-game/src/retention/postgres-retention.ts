import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  OWNER_UNITS,
  RetentionError,
  type DeletionRequest,
  type DeletionReceipt,
  type RetentionPolicy,
  type SagaSnapshot,
} from './retention-service.js';

const completionSchema = z.object({
  eventId: z.string().uuid(),
  deletionId: z.string().uuid(),
  ownerUnit: z.enum(OWNER_UNITS),
  attempt: z.number().int().min(1),
  schemaVersion: z.literal(2),
  status: z.enum(['completed', 'retryable-failure', 'permanent-failure']),
  completedAt: z.iso.datetime(),
  failureCode: z.string().max(80).optional(),
});
export class PostgresRetentionService {
  constructor(
    private readonly pool: Pool,
    private readonly hmacKey: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!hmacKey) throw new RetentionError('HMAC_KEY_REQUIRED');
  }

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async configure(
    gameId: string,
    retentionDays = 90,
    startsAt = this.now(),
  ): Promise<RetentionPolicy> {
    if (
      !z.string().uuid().safeParse(gameId).success ||
      !Number.isInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > 3650
    )
      throw new RetentionError('INVALID_RETENTION_POLICY');
    const deleteAfter = new Date(startsAt.getTime() + retentionDays * 86400_000);
    await this.pool.query(
      `INSERT INTO retention_policies (game_id, retention_days, retention_starts_at, delete_after, policy_version)
       VALUES ($1,$2,$3,$4,1) ON CONFLICT (game_id) DO NOTHING`,
      [gameId, retentionDays, startsAt, deleteAfter],
    );
    const policy = await this.policy(gameId);
    if (!policy || policy.retentionDays !== retentionDays)
      throw new RetentionError('POLICY_CONFLICT');
    return policy;
  }

  async policy(gameId: string): Promise<RetentionPolicy | undefined> {
    const result = await this.pool.query('SELECT * FROM retention_policies WHERE game_id=$1', [
      gameId,
    ]);
    const row = result.rows[0];
    return row
      ? {
          gameId: row.game_id,
          retentionDays: row.retention_days,
          retentionStartsAt: row.retention_starts_at.toISOString(),
          deleteAfter: row.delete_after.toISOString(),
          policyVersion: row.policy_version,
        }
      : undefined;
  }

  async startDueDeletions(limit = 100): Promise<SagaSnapshot[]> {
    return this.transaction(async (client) => {
      const due = await client.query(
        `SELECT p.game_id FROM retention_policies p LEFT JOIN deletion_sagas s USING (game_id)
         WHERE p.delete_after <= $1 AND s.deletion_id IS NULL ORDER BY p.delete_after, p.game_id
         LIMIT $2 FOR UPDATE OF p SKIP LOCKED`,
        [this.now(), limit],
      );
      const started: SagaSnapshot[] = [];
      for (const row of due.rows) {
        const deletionId = randomUUID();
        const inserted = await client.query(
          `INSERT INTO deletion_sagas (deletion_id, game_id, status, attempt, requested_at)
           VALUES ($1,$2,'IN_PROGRESS',1,$3) ON CONFLICT (game_id) DO NOTHING RETURNING deletion_id`,
          [deletionId, row.game_id, this.now()],
        );
        if (!inserted.rowCount) continue;
        await client.query(
          'INSERT INTO deletion_attempts (deletion_id, attempt, started_at) VALUES ($1,1,$2)',
          [deletionId, this.now()],
        );
        for (const owner of OWNER_UNITS) {
          await client.query(
            "INSERT INTO owner_deletion_progress (deletion_id, owner_unit, status) VALUES ($1,$2,'PENDING')",
            [deletionId, owner],
          );
          await this.enqueue(client, deletionId, row.game_id, owner, 1);
        }
        started.push(await this.statusForClient(client, deletionId));
      }
      return started;
    });
  }

  async consumeCompletion(
    raw: unknown,
  ): Promise<'accepted' | 'duplicate' | 'stale' | 'quarantined'> {
    const parsed = completionSchema.safeParse(raw);
    if (!parsed.success) return 'quarantined';
    const event = parsed.data;
    return this.transaction(async (client) => {
      const rows = await client.query(
        'SELECT * FROM deletion_sagas WHERE deletion_id=$1 FOR UPDATE',
        [event.deletionId],
      );
      const saga = rows.rows[0];
      if (!saga) return 'quarantined';
      const digest = createHash('sha256').update(JSON.stringify(event)).digest('hex');
      const seen = await client.query(
        'SELECT payload_digest FROM deletion_inbox WHERE event_id=$1',
        [event.eventId],
      );
      if (seen.rowCount)
        return seen.rows[0].payload_digest === digest ? 'duplicate' : 'quarantined';
      if (saga.attempt !== event.attempt || saga.status !== 'IN_PROGRESS') return 'stale';
      const ownerRows = await client.query(
        'SELECT status FROM owner_deletion_progress WHERE deletion_id=$1 AND owner_unit=$2 FOR UPDATE',
        [event.deletionId, event.ownerUnit],
      );
      if (!ownerRows.rowCount) return 'quarantined';
      await client.query(
        'INSERT INTO deletion_inbox (event_id,deletion_id,owner_unit,attempt,payload_digest) VALUES ($1,$2,$3,$4,$5)',
        [event.eventId, event.deletionId, event.ownerUnit, event.attempt, digest],
      );
      if (ownerRows.rows[0].status === 'COMPLETED') return 'duplicate';
      if (event.status === 'completed') {
        await client.query(
          "UPDATE owner_deletion_progress SET status='COMPLETED', completed_at=$3, failure_code=NULL WHERE deletion_id=$1 AND owner_unit=$2",
          [event.deletionId, event.ownerUnit, event.completedAt],
        );
        const incomplete = await client.query(
          "SELECT 1 FROM owner_deletion_progress WHERE deletion_id=$1 AND status <> 'COMPLETED' LIMIT 1",
          [event.deletionId],
        );
        if (!incomplete.rowCount) {
          await this.upsertReceipt(client, saga, 'COMPLETED');
          await client.query(
            "UPDATE deletion_sagas SET status='COMPLETED', completed_at=$2, next_attempt_at=NULL WHERE deletion_id=$1",
            [event.deletionId, this.now()],
          );
        }
        return 'accepted';
      }
      const failureCode = event.failureCode ?? 'OWNER_FAILURE';
      if (event.status === 'permanent-failure' || saga.automatic_retries >= 5) {
        await client.query(
          'UPDATE owner_deletion_progress SET status=$3, failure_code=$4 WHERE deletion_id=$1 AND owner_unit=$2',
          [
            event.deletionId,
            event.ownerUnit,
            event.status === 'permanent-failure' ? 'PERMANENT_FAILURE' : 'RETRYABLE_FAILURE',
            failureCode,
          ],
        );
        await this.upsertReceipt(client, saga, 'FAILED');
        await client.query(
          "UPDATE deletion_sagas SET status='FAILED', last_failure_code=$2, next_attempt_at=NULL WHERE deletion_id=$1",
          [event.deletionId, failureCode],
        );
        return 'accepted';
      }
      const base = Math.min(900_000, 30_000 * 2 ** saga.automatic_retries);
      const next = new Date(this.now().getTime() + base + Math.random() * base);
      await client.query(
        "UPDATE owner_deletion_progress SET status='RETRYABLE_FAILURE', failure_code=$3 WHERE deletion_id=$1 AND owner_unit=$2",
        [event.deletionId, event.ownerUnit, failureCode],
      );
      await client.query(
        'UPDATE deletion_sagas SET next_attempt_at=$2,last_failure_code=$3 WHERE deletion_id=$1',
        [event.deletionId, next, failureCode],
      );
      await client.query(
        'UPDATE deletion_attempts SET next_attempt_at=$3,failure_code=$4 WHERE deletion_id=$1 AND attempt=$2',
        [event.deletionId, event.attempt, next, failureCode],
      );
      return 'accepted';
    });
  }

  async runScheduledRetries(limit = 100): Promise<SagaSnapshot[]> {
    return this.transaction(async (client) => {
      const due = await client.query(
        "SELECT * FROM deletion_sagas WHERE status='IN_PROGRESS' AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT $2 FOR UPDATE SKIP LOCKED",
        [this.now(), limit],
      );
      const retried: SagaSnapshot[] = [];
      for (const saga of due.rows) {
        const attempt = saga.attempt + 1;
        await client.query(
          'UPDATE deletion_sagas SET attempt=$2,automatic_retries=automatic_retries+1,next_attempt_at=NULL WHERE deletion_id=$1',
          [saga.deletion_id, attempt],
        );
        await client.query(
          'INSERT INTO deletion_attempts (deletion_id,attempt,started_at) VALUES ($1,$2,$3)',
          [saga.deletion_id, attempt, this.now()],
        );
        const owners = await client.query(
          "UPDATE owner_deletion_progress SET status='PENDING',failure_code=NULL WHERE deletion_id=$1 AND status <> 'COMPLETED' RETURNING owner_unit",
          [saga.deletion_id],
        );
        for (const owner of owners.rows)
          await this.enqueue(client, saga.deletion_id, saga.game_id, owner.owner_unit, attempt);
        retried.push(await this.statusForClient(client, saga.deletion_id));
      }
      return retried;
    });
  }

  async manualRetry(
    gameId: string,
    operatorAuthorized: boolean,
    idempotency?: { key: string; expectedAttempt: number },
  ): Promise<SagaSnapshot> {
    if (!operatorAuthorized) throw new RetentionError('OPERATOR_REQUIRED');
    return this.transaction(async (client) => {
      const result = await client.query(
        'SELECT * FROM deletion_sagas WHERE game_id=$1 FOR UPDATE',
        [gameId],
      );
      const saga = result.rows[0];
      const keyDigest = idempotency
        ? createHash('sha256').update(idempotency.key).digest('hex')
        : undefined;
      if (idempotency && keyDigest) {
        const previous = await client.query(
          'SELECT expected_attempt,response FROM retention_retry_idempotency WHERE game_id=$1 AND key_digest=$2',
          [gameId, keyDigest],
        );
        if (previous.rowCount) {
          if (previous.rows[0].expected_attempt !== idempotency.expectedAttempt)
            throw new RetentionError('IDEMPOTENCY_CONFLICT');
          return previous.rows[0].response as SagaSnapshot;
        }
        if (saga && saga.attempt !== idempotency.expectedAttempt)
          throw new RetentionError('VERSION_CONFLICT');
      }
      if (!saga || saga.status !== 'FAILED') throw new RetentionError('RETRY_NOT_ALLOWED');
      const attempt = saga.attempt + 1;
      await client.query(
        "UPDATE deletion_sagas SET status='IN_PROGRESS',attempt=$2,automatic_retries=0,last_failure_code=NULL,next_attempt_at=NULL WHERE deletion_id=$1",
        [saga.deletion_id, attempt],
      );
      await client.query(
        'INSERT INTO deletion_attempts (deletion_id,attempt,started_at) VALUES ($1,$2,$3)',
        [saga.deletion_id, attempt, this.now()],
      );
      const owners = await client.query(
        "UPDATE owner_deletion_progress SET status='PENDING',failure_code=NULL WHERE deletion_id=$1 AND status <> 'COMPLETED' RETURNING owner_unit",
        [saga.deletion_id],
      );
      for (const owner of owners.rows)
        await this.enqueue(client, saga.deletion_id, gameId, owner.owner_unit, attempt);
      const snapshot = await this.statusForClient(client, saga.deletion_id);
      if (idempotency && keyDigest)
        await client.query(
          'INSERT INTO retention_retry_idempotency(game_id,key_digest,expected_attempt,response) VALUES ($1,$2,$3,$4)',
          [gameId, keyDigest, idempotency.expectedAttempt, snapshot],
        );
      return snapshot;
    });
  }

  async status(gameId: string): Promise<SagaSnapshot> {
    const row = await this.pool.query('SELECT deletion_id FROM deletion_sagas WHERE game_id=$1', [
      gameId,
    ]);
    if (!row.rowCount) throw new RetentionError('DELETION_NOT_FOUND');
    return this.statusForClient(this.pool, row.rows[0].deletion_id);
  }

  async pendingRequests(limit = 100): Promise<DeletionRequest[]> {
    const rows = await this.pool.query(
      'SELECT payload FROM deletion_outbox WHERE published_at IS NULL ORDER BY created_at LIMIT $1',
      [limit],
    );
    return rows.rows.map((row) => row.payload as DeletionRequest);
  }

  async receipt(deletionId: string): Promise<DeletionReceipt | undefined> {
    const result = await this.pool.query(
      `SELECT r.* FROM deletion_receipts r CROSS JOIN retention_restore_gate g
      WHERE r.deletion_id=$1 AND r.expires_at > $2 AND g.gate_id=true AND g.reads_open=true`,
      [deletionId, this.now()],
    );
    const row = result.rows[0];
    return row
      ? {
          deletionId: row.deletion_id,
          gameReferenceDigest: row.game_reference_digest,
          outcome: row.outcome,
          recordedAt: row.recorded_at.toISOString(),
          expiresAt: row.expires_at.toISOString(),
          correlationId: row.correlation_id,
        }
      : undefined;
  }

  async beginRestore(): Promise<void> {
    await this.pool.query(
      'UPDATE retention_restore_gate SET reads_open=false,sweep_completed_at=NULL WHERE gate_id=true',
    );
  }

  async completeRestore(): Promise<number> {
    return this.transaction(async (client) => {
      const removed = await client.query('DELETE FROM deletion_receipts WHERE expires_at <= $1', [
        this.now(),
      ]);
      await client.query(
        'UPDATE retention_restore_gate SET reads_open=true,sweep_completed_at=$1 WHERE gate_id=true',
        [this.now()],
      );
      return removed.rowCount ?? 0;
    });
  }

  private async enqueue(
    client: PoolClient,
    deletionId: string,
    gameId: string,
    ownerUnit: string,
    attempt: number,
  ): Promise<void> {
    const payload = {
      eventId: randomUUID(),
      deletionId,
      gameId,
      ownerUnit,
      attempt,
      requestedAt: this.now().toISOString(),
      schemaVersion: 1,
    };
    await client.query(
      'INSERT INTO deletion_outbox (event_id,deletion_id,owner_unit,attempt,channel,payload) VALUES ($1,$2,$3,$4,$5,$6)',
      [payload.eventId, deletionId, ownerUnit, attempt, 'beer-game.deletion.requested.v1', payload],
    );
  }

  private async upsertReceipt(
    client: PoolClient,
    saga: { deletion_id: string; game_id: string },
    outcome: 'COMPLETED' | 'FAILED',
  ): Promise<void> {
    const now = this.now();
    const digest = createHmac('sha256', this.hmacKey).update(saga.game_id).digest('hex');
    const expires = new Date(now.getTime() + 365 * 86400_000);
    await client.query(
      `INSERT INTO deletion_receipts (deletion_id,game_reference_digest,outcome,recorded_at,expires_at,correlation_id)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (deletion_id) DO UPDATE SET outcome=EXCLUDED.outcome,recorded_at=EXCLUDED.recorded_at,expires_at=EXCLUDED.expires_at`,
      [saga.deletion_id, digest, outcome, now, expires, randomUUID()],
    );
  }

  private async statusForClient(
    client: Pick<Pool, 'query'>,
    deletionId: string,
  ): Promise<SagaSnapshot> {
    const result = await client.query('SELECT * FROM deletion_sagas WHERE deletion_id=$1', [
      deletionId,
    ]);
    const saga = result.rows[0];
    if (!saga) throw new RetentionError('DELETION_NOT_FOUND');
    const progress = await client.query(
      'SELECT owner_unit,status FROM owner_deletion_progress WHERE deletion_id=$1',
      [deletionId],
    );
    const owners = Object.fromEntries(
      progress.rows.map((row) => [row.owner_unit, row.status]),
    ) as SagaSnapshot['owners'];
    return {
      deletionId,
      gameId: saga.game_id,
      status: saga.status,
      attempt: saga.attempt,
      owners,
      failureCode: saga.last_failure_code ?? undefined,
      nextAttemptAt: saga.next_attempt_at?.toISOString(),
    };
  }
}
