import { SQSClient } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import { PgOwnerDeletionConsumer, SqsOwnerDeletionWorker } from './owner-deletion.js';
import { PostgresRetentionService } from './postgres-retention.js';
import { OWNER_UNITS, type OwnerUnit } from './retention-service.js';
import { SqsRetentionWorker } from './sqs-worker.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const role = process.argv[2];
const pool = new Pool({ connectionString: required('DATABASE_URL') });
const sqs = new SQSClient({});
try {
  if (role === 'coordinator') {
    const queues = Object.fromEntries(
      OWNER_UNITS.map((owner) => [
        owner,
        required(`DELETION_QUEUE_${owner.toUpperCase().replaceAll('-', '_')}`),
      ]),
    ) as Record<OwnerUnit, string>;
    const service = new PostgresRetentionService(pool, required('RETENTION_HMAC_KEY'));
    const worker = new SqsRetentionWorker(pool, service, sqs, {
      ownerQueueUrls: queues,
      completionQueueUrl: required('DELETION_COMPLETION_QUEUE_URL'),
      quarantineQueueUrl: required('DELETION_QUARANTINE_QUEUE_URL'),
    });
    await worker.runOnce();
  } else if (role === 'owner') {
    const owner = required('DELETION_OWNER_UNIT');
    if (!OWNER_UNITS.includes(owner as OwnerUnit))
      throw new Error('DELETION_OWNER_UNIT is invalid');
    const consumer = new PgOwnerDeletionConsumer(
      owner as OwnerUnit,
      pool,
      sqs,
      required('DELETION_COMPLETION_QUEUE_URL'),
    );
    const worker = new SqsOwnerDeletionWorker(sqs, required('DELETION_OWNER_QUEUE_URL'), consumer);
    await worker.runOnce();
  } else {
    throw new Error('Worker role must be coordinator or owner');
  }
} finally {
  await Promise.all([pool.end(), sqs.destroy()]);
}
