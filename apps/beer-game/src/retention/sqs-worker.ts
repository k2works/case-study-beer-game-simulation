import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { Pool } from 'pg';
import { PostgresRetentionService } from './postgres-retention.js';
import type { OwnerUnit } from './retention-service.js';

export interface DeletionQueueConfig {
  ownerQueueUrls: Record<OwnerUnit, string>;
  completionQueueUrl: string;
  quarantineQueueUrl: string;
}

export class SqsRetentionWorker {
  constructor(
    private readonly pool: Pool,
    private readonly service: PostgresRetentionService,
    private readonly sqs: SQSClient,
    private readonly queues: DeletionQueueConfig,
  ) {}

  async runOnce(): Promise<{
    started: number;
    retried: number;
    published: number;
    consumed: number;
  }> {
    const started = await this.service.startDueDeletions();
    const retried = await this.service.runScheduledRetries();
    const published = await this.publishPending();
    const consumed = await this.consumeCompletions();
    return { started: started.length, retried: retried.length, published, consumed };
  }

  async publishPending(limit = 100): Promise<number> {
    const client = await this.pool.connect();
    let count = 0;
    try {
      await client.query('BEGIN');
      const rows = await client.query(
        `SELECT o.event_id,o.owner_unit,o.payload FROM deletion_outbox o
         WHERE o.published_at IS NULL AND
         (o.owner_unit <> 'u1-walking-skeleton' OR NOT EXISTS (
           SELECT 1 FROM owner_deletion_progress p
           WHERE p.deletion_id=o.deletion_id AND p.owner_unit='u2-session-continuity' AND p.status <> 'COMPLETED'
         )) ORDER BY o.created_at LIMIT $1 FOR UPDATE OF o SKIP LOCKED`,
        [limit],
      );
      for (const row of rows.rows) {
        const queueUrl = this.queues.ownerQueueUrls[row.owner_unit as OwnerUnit];
        if (!queueUrl) throw new Error(`No owner queue configured for ${row.owner_unit}`);
        await this.sqs.send(
          new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(row.payload) }),
        );
        await client.query('UPDATE deletion_outbox SET published_at=now() WHERE event_id=$1', [
          row.event_id,
        ]);
        count += 1;
      }
      await client.query('COMMIT');
      return count;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async consumeCompletions(): Promise<number> {
    const response = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queues.completionQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );
    let consumed = 0;
    for (const message of response.Messages ?? []) {
      if (!message.Body || !message.ReceiptHandle) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(message.Body);
      } catch {
        payload = { malformed: true };
      }
      const outcome = await this.service.consumeCompletion(payload);
      if (outcome === 'quarantined')
        await this.sqs.send(
          new SendMessageCommand({
            QueueUrl: this.queues.quarantineQueueUrl,
            MessageBody: message.Body,
          }),
        );
      await this.sqs.send(
        new DeleteMessageCommand({
          QueueUrl: this.queues.completionQueueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
      consumed += 1;
    }
    return consumed;
  }
}
