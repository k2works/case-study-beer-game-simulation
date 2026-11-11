import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { HmacCredentialPolicy } from './adapters/http/credentials.js';
import { PgExportReader } from './adapters/persistence/pg-export-reader.js';
import { PgReviewReader } from './adapters/persistence/pg-review-reader.js';
import { PgUnitOfWork } from './adapters/persistence/pg-unit-of-work.js';
import { createApplication } from './application/index.js';
import type { Config } from './config/index.js';

// 紛らわしい文字（0/O、1/I/L）を除いた英数字から、8 桁の参加コードを作る
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function joinCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** 接続プール。アイドル中の接続の切断でプロセスが落ちないようにする（/ready が失敗として現れる） */
export function createPool(config: Config): pg.Pool {
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  pool.on('error', (e) =>
    console.error(
      JSON.stringify({ level: 'error', msg: 'pool error', error: e.message }),
    ),
  );
  return pool;
}

/** 本番のアプリケーションの組み立て（API と定期のタスクで共通） */
export function composeApplication(config: Config, pool: pg.Pool) {
  const reviews = new PgReviewReader(pool);
  return createApplication({
    uow: new PgUnitOfWork(pool, { idempotencyKey: config.idempotencyKey }),
    clock: { now: () => new Date() },
    ids: { uuid: randomUUID, joinCode },
    reviews,
    exports: new PgExportReader(pool, reviews),
    credentials: new HmacCredentialPolicy(config.credentialKeys),
  });
}
