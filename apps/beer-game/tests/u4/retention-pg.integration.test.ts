import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresRetentionService } from '../../src/retention/postgres-retention.js';
import { OWNER_UNITS } from '../../src/retention/retention-service.js';
import { SqsRetentionWorker } from '../../src/retention/sqs-worker.js';
import {
  PgOwnerDeletionConsumer,
  SqsOwnerDeletionWorker,
} from '../../src/retention/owner-deletion.js';

const databaseUrl = process.env.RETENTION_TEST_DATABASE_URL;
const schema = `u4_${randomUUID().replaceAll('-', '')}`;
const migrations = [1, 2, 3, 4].map((number) => {
  const names = [
    '001_u1_walking_skeleton.sql',
    '002_u2_session_continuity.sql',
    '003_u3_learning_view.sql',
    '004_u4_retention.sql',
  ];
  return readFileSync(new URL(`../../migrations/${names[number - 1]}`, import.meta.url), 'utf8');
});

describe.skipIf(!databaseUrl)('Given a real PostgreSQL retention store', () => {
  let admin: Pool;
  let pool: Pool;
  let now = new Date('2026-01-01T00:00:00.000Z');
  let service: PostgresRetentionService;

  beforeAll(async () => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_u4_test'))
      throw new Error('RETENTION_TEST_DATABASE_URL must target a dedicated _u4_test database');
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const migration of migrations) await pool.query(migration);
    service = new PostgresRetentionService(pool, 'test-only-key', () => now);
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('atomically starts one Saga with three outbox rows and survives a new service instance', async () => {
    const gameId = randomUUID();
    await service.configure(gameId, 1, new Date(now.getTime() - 86400_000));
    const [saga] = await service.startDueDeletions();
    expect(saga.gameId).toBe(gameId);
    expect(await service.startDueDeletions()).toEqual([]);
    expect(await service.pendingRequests()).toHaveLength(3);
    const restarted = new PostgresRetentionService(pool, 'test-only-key', () => now);
    expect((await restarted.status(gameId)).deletionId).toBe(saga.deletionId);
  });

  it('deduplicates v2 completion and commits receipt only after every owner completes', async () => {
    const gameId = randomUUID();
    await service.configure(gameId, 1, new Date(now.getTime() - 86400_000));
    const [saga] = await service.startDueDeletions();
    for (const owner of OWNER_UNITS) {
      const completion = {
        eventId: randomUUID(),
        deletionId: saga.deletionId,
        ownerUnit: owner,
        attempt: 1,
        schemaVersion: 2,
        status: 'completed',
        completedAt: now.toISOString(),
      };
      expect(await service.consumeCompletion(completion)).toBe('accepted');
      expect(await service.consumeCompletion(completion)).toBe('duplicate');
    }
    expect((await service.status(gameId)).status).toBe('COMPLETED');
    const receipt = await service.receipt(saga.deletionId);
    expect(receipt?.gameReferenceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain(gameId);
  });

  it('blocks receipt reads across restore until an expiry sweep commits', async () => {
    const gameId = randomUUID();
    await service.configure(gameId, 1, new Date(now.getTime() - 86400_000));
    const [saga] = await service.startDueDeletions();
    for (const owner of OWNER_UNITS)
      await service.consumeCompletion({
        eventId: randomUUID(),
        deletionId: saga.deletionId,
        ownerUnit: owner,
        attempt: 1,
        schemaVersion: 2,
        status: 'completed',
        completedAt: now.toISOString(),
      });
    await service.beginRestore();
    expect(await service.receipt(saga.deletionId)).toBeUndefined();
    now = new Date(now.getTime() + 366 * 86400_000);
    expect(await service.completeRestore()).toBeGreaterThanOrEqual(1);
    expect(await service.receipt(saga.deletionId)).toBeUndefined();
  });

  it('publishes committed outbox rows to owner queues once', async () => {
    const gameId = randomUUID();
    await service.configure(gameId, 1, new Date(now.getTime() - 86400_000));
    await service.startDueDeletions();
    const sent: unknown[] = [];
    const sqs = {
      send: async (command: unknown) => {
        sent.push(command);
        if (command instanceof ReceiveMessageCommand) return { Messages: [] };
        return {};
      },
    } as unknown as SQSClient;
    const worker = new SqsRetentionWorker(pool, service, sqs, {
      ownerQueueUrls: Object.fromEntries(
        OWNER_UNITS.map((owner) => [owner, `https://example.test/${owner}`]),
      ) as Record<(typeof OWNER_UNITS)[number], string>,
      completionQueueUrl: 'https://example.test/completion',
      quarantineQueueUrl: 'https://example.test/quarantine',
    });
    const published = await worker.publishPending();
    expect(published).toBeGreaterThanOrEqual(3);
    expect(await worker.publishPending()).toBe(0);
    expect(sent.filter((command) => command instanceof SendMessageCommand)).toHaveLength(published);
    expect(sent.some((command) => command instanceof DeleteMessageCommand)).toBe(false);
  });

  it('deletes each owner store and echoes C4 attempt in a C5 v2 completion', async () => {
    const gameId = randomUUID();
    const sessionId = randomUUID();
    const participantId = randomUUID();
    await pool.query(
      'INSERT INTO games (game_id,join_code,facilitator_digest,final_week,demand) VALUES ($1,$2,$3,1,$4)',
      [gameId, randomUUID().slice(0, 8), 'digest', JSON.stringify([4])],
    );
    await pool.query(
      "INSERT INTO sessions (session_id,game_id,status,week,version,state) VALUES ($1,$2,'LOBBY',1,1,$3)",
      [sessionId, gameId, JSON.stringify({})],
    );
    await pool.query(
      'INSERT INTO participants (participant_id,game_id,display_name,credential_digest) VALUES ($1,$2,$3,$4)',
      [participantId, gameId, 'private-name', 'private-digest'],
    );
    await pool.query(
      'INSERT INTO recovery_credentials (recovery_credential_id,participant_id,credential_digest,expires_at) VALUES ($1,$2,$3,$4)',
      [randomUUID(), participantId, 'private-recovery-digest', now],
    );
    await pool.query(
      "INSERT INTO operation_audit (audit_id,session_id,actor_id,action_kind,outcome,correlation_id) VALUES ($1,$2,$3,'recover','SUCCESS',$4)",
      [randomUUID(), sessionId, participantId, randomUUID()],
    );
    await pool.query(
      'INSERT INTO observation_projections (game_id,session_id,source_version,projection) VALUES ($1,$2,1,$3)',
      [gameId, sessionId, JSON.stringify({ private: true })],
    );
    await service.configure(gameId, 1, new Date(now.getTime() - 86400_000));
    const [saga] = await service.startDueDeletions();
    const sent: SendMessageCommand[] = [];
    const sqs = {
      send: async (command: SendMessageCommand) => {
        sent.push(command);
        return {};
      },
    } as unknown as SQSClient;
    for (const owner of [OWNER_UNITS[1], OWNER_UNITS[2], OWNER_UNITS[0]]) {
      const request = (await service.pendingRequests()).find(
        (event) => event.deletionId === saga.deletionId && event.ownerUnit === owner,
      )!;
      const consumer = new PgOwnerDeletionConsumer(
        owner,
        pool,
        sqs,
        'https://example.test/completion',
        () => now,
      );
      expect(await consumer.consume(request)).toBe('completed');
    }
    expect(sent).toHaveLength(3);
    for (const command of sent) {
      const completion = JSON.parse(command.input.MessageBody!);
      expect(completion.attempt).toBe(1);
      expect(completion.schemaVersion).toBe(2);
      expect(await service.consumeCompletion(completion)).toBe('accepted');
    }
    expect((await service.status(gameId)).status).toBe('COMPLETED');
    for (const table of [
      'games',
      'sessions',
      'participants',
      'recovery_credentials',
      'operation_audit',
      'observation_projections',
    ]) {
      const count = await pool.query(`SELECT count(*)::int AS count FROM ${table}`);
      expect(count.rows[0].count).toBe(0);
    }
    expect(JSON.stringify(sent)).not.toContain('private-name');
  });

  it('persists retry scheduling and rejects stale completion after restart', async () => {
    const gameId = randomUUID();
    await service.configure(gameId, 1, new Date(now.getTime() - 86400_000));
    const [saga] = await service.startDueDeletions();
    const first = {
      eventId: randomUUID(),
      deletionId: saga.deletionId,
      ownerUnit: OWNER_UNITS[0],
      attempt: 1,
      schemaVersion: 2,
      status: 'retryable-failure',
      completedAt: now.toISOString(),
      failureCode: 'TIMEOUT',
    };
    expect(await service.consumeCompletion(first)).toBe('accepted');
    const restarted = new PostgresRetentionService(pool, 'test-only-key', () => now);
    expect((await restarted.status(gameId)).nextAttemptAt).toBeTruthy();
    now = new Date(now.getTime() + 31 * 60_000);
    expect(await restarted.runScheduledRetries()).toHaveLength(1);
    expect((await restarted.status(gameId)).attempt).toBe(2);
    expect(await restarted.consumeCompletion({ ...first, eventId: randomUUID() })).toBe('stale');
    expect(
      await restarted.consumeCompletion({
        ...first,
        eventId: randomUUID(),
        attempt: 2,
        status: 'permanent-failure',
      }),
    ).toBe('accepted');
    expect((await restarted.status(gameId)).status).toBe('FAILED');
    await expect(restarted.manualRetry(gameId, false)).rejects.toThrow('OPERATOR_REQUIRED');
    expect((await restarted.manualRetry(gameId, true)).attempt).toBe(3);
  });

  it('quarantines v1 completion from SQS and acknowledges only after forwarding it', async () => {
    const commands: unknown[] = [];
    const sqs = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof ReceiveMessageCommand)
          return {
            Messages: [
              {
                Body: JSON.stringify({ schemaVersion: 1, eventId: randomUUID() }),
                ReceiptHandle: 'receipt-handle',
              },
            ],
          };
        return {};
      },
    } as unknown as SQSClient;
    const worker = new SqsRetentionWorker(pool, service, sqs, {
      ownerQueueUrls: Object.fromEntries(
        OWNER_UNITS.map((owner) => [owner, `https://example.test/${owner}`]),
      ) as Record<(typeof OWNER_UNITS)[number], string>,
      completionQueueUrl: 'https://example.test/completion',
      quarantineQueueUrl: 'https://example.test/quarantine',
    });
    expect(await worker.consumeCompletions()).toBe(1);
    expect(commands[1]).toBeInstanceOf(SendMessageCommand);
    expect((commands[1] as SendMessageCommand).input.QueueUrl).toContain('quarantine');
    expect(commands[2]).toBeInstanceOf(DeleteMessageCommand);
  });

  it('acknowledges a C4 owner request after a C5 completion is sent', async () => {
    const gameId = randomUUID();
    await service.configure(gameId, 1, new Date(now.getTime() - 86400_000));
    const [saga] = await service.startDueDeletions();
    const request = (await service.pendingRequests()).find(
      (event) => event.deletionId === saga.deletionId && event.ownerUnit === OWNER_UNITS[2],
    )!;
    const commands: unknown[] = [];
    const sqs = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof ReceiveMessageCommand)
          return { Messages: [{ Body: JSON.stringify(request), ReceiptHandle: 'owner-handle' }] };
        return {};
      },
    } as unknown as SQSClient;
    const consumer = new PgOwnerDeletionConsumer(
      OWNER_UNITS[2],
      pool,
      sqs,
      'https://example.test/completion',
      () => now,
    );
    const worker = new SqsOwnerDeletionWorker(sqs, 'https://example.test/owner', consumer);
    expect(await worker.runOnce()).toBe(1);
    expect(commands[1]).toBeInstanceOf(SendMessageCommand);
    expect(commands[2]).toBeInstanceOf(DeleteMessageCommand);
  });

  it('holds U1 delivery until U2 has deleted its participant-owned records', async () => {
    const gameId = randomUUID();
    await service.configure(gameId, 1, new Date(now.getTime() - 86400_000));
    const [saga] = await service.startDueDeletions();
    const sqs = { send: async () => ({ Messages: [] }) } as unknown as SQSClient;
    const worker = new SqsRetentionWorker(pool, service, sqs, {
      ownerQueueUrls: Object.fromEntries(
        OWNER_UNITS.map((owner) => [owner, `https://example.test/${owner}`]),
      ) as Record<(typeof OWNER_UNITS)[number], string>,
      completionQueueUrl: 'https://example.test/completion',
      quarantineQueueUrl: 'https://example.test/quarantine',
    });
    await worker.publishPending();
    const before = await pool.query(
      'SELECT published_at FROM deletion_outbox WHERE deletion_id=$1 AND owner_unit=$2',
      [saga.deletionId, OWNER_UNITS[0]],
    );
    expect(before.rows[0].published_at).toBeNull();
    await service.consumeCompletion({
      eventId: randomUUID(),
      deletionId: saga.deletionId,
      ownerUnit: OWNER_UNITS[1],
      attempt: 1,
      schemaVersion: 2,
      status: 'completed',
      completedAt: now.toISOString(),
    });
    await worker.publishPending();
    const after = await pool.query(
      'SELECT published_at FROM deletion_outbox WHERE deletion_id=$1 AND owner_unit=$2',
      [saga.deletionId, OWNER_UNITS[0]],
    );
    expect(after.rows[0].published_at).not.toBeNull();
  });
});
