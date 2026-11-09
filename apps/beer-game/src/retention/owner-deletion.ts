import { randomUUID } from 'node:crypto';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { OWNER_UNITS, type OwnerUnit } from './retention-service.js';

const requestSchema = z.object({
  eventId: z.string().uuid(),
  deletionId: z.string().uuid(),
  gameId: z.string().uuid(),
  requestedAt: z.iso.datetime(),
  attempt: z.number().int().positive(),
  schemaVersion: z.literal(1),
  ownerUnit: z.enum(OWNER_UNITS),
});

export class PgOwnerDeletionConsumer {
  constructor(
    private readonly ownerUnit: OwnerUnit,
    private readonly pool: Pool,
    private readonly sqs: SQSClient,
    private readonly completionQueueUrl: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async consume(raw: unknown): Promise<'completed' | 'retryable-failure' | 'permanent-failure'> {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success || parsed.data.ownerUnit !== this.ownerUnit)
      throw new Error('INVALID_DELETION_REQUEST');
    const request = parsed.data;
    let status: 'completed' | 'retryable-failure' = 'completed';
    try {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await this.deleteOwnedData(client, request.gameId);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch {
      status = 'retryable-failure';
    }
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.completionQueueUrl,
        MessageBody: JSON.stringify({
          eventId: randomUUID(),
          deletionId: request.deletionId,
          ownerUnit: this.ownerUnit,
          status,
          completedAt: this.now().toISOString(),
          attempt: request.attempt,
          schemaVersion: 2,
          ...(status === 'retryable-failure' ? { failureCode: 'OWNER_STORAGE_UNAVAILABLE' } : {}),
        }),
      }),
    );
    return status;
  }

  private async deleteOwnedData(client: PoolClient, gameId: string): Promise<void> {
    switch (this.ownerUnit) {
      case 'u1-walking-skeleton':
        await client.query(
          'DELETE FROM decisions WHERE session_id IN (SELECT session_id FROM sessions WHERE game_id=$1)',
          [gameId],
        );
        await client.query(
          'DELETE FROM week_results WHERE session_id IN (SELECT session_id FROM sessions WHERE game_id=$1)',
          [gameId],
        );
        await client.query('DELETE FROM sessions WHERE game_id=$1', [gameId]);
        await client.query('DELETE FROM participants WHERE game_id=$1', [gameId]);
        await client.query('DELETE FROM games WHERE game_id=$1', [gameId]);
        return;
      case 'u2-session-continuity':
        await client.query(
          'DELETE FROM recovery_credentials WHERE participant_id IN (SELECT participant_id FROM participants WHERE game_id=$1)',
          [gameId],
        );
        await client.query(
          'DELETE FROM operation_audit WHERE session_id IN (SELECT session_id FROM sessions WHERE game_id=$1)',
          [gameId],
        );
        return;
      case 'u3-learning-view':
        await client.query('DELETE FROM export_packages WHERE game_id=$1', [gameId]);
        await client.query('DELETE FROM review_projections WHERE game_id=$1', [gameId]);
        await client.query('DELETE FROM observation_projections WHERE game_id=$1', [gameId]);
        await client.query('DELETE FROM learning_processed_events WHERE game_id=$1', [gameId]);
        await client.query('DELETE FROM learning_consumer_cursors WHERE game_id=$1', [gameId]);
        return;
    }
  }
}

export class SqsOwnerDeletionWorker {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
    private readonly consumer: PgOwnerDeletionConsumer,
  ) {}

  async runOnce(): Promise<number> {
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );
    let completed = 0;
    for (const message of response.Messages ?? []) {
      if (!message.Body || !message.ReceiptHandle) continue;
      const payload: unknown = JSON.parse(message.Body);
      await this.consumer.consume(payload);
      await this.sqs.send(
        new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }),
      );
      completed += 1;
    }
    return completed;
  }
}
