import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { HmacCredentialPolicy } from './adapters/http/credentials.js';
import { buildServer } from './adapters/http/server.js';
import { PgRateLimiter } from './adapters/persistence/pg-rate-limiter.js';
import { PgReviewReader } from './adapters/persistence/pg-review-reader.js';
import { PgNotifier } from './adapters/persistence/pg-notifier.js';
import { PgUnitOfWork } from './adapters/persistence/pg-unit-of-work.js';
import { createApplication } from './application/index.js';
import { loadConfig } from './config/index.js';

// 紛らわしい文字（0/O、1/I/L）を除いた英数字から、8 桁の参加コードを作る
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function joinCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

const config = loadConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl });
// アイドル中の接続の切断でプロセスが落ちないようにする（/ready が失敗として現れる）
pool.on('error', (e) =>
  console.error(
    JSON.stringify({ level: 'error', msg: 'pool error', error: e.message }),
  ),
);
const notifier = new PgNotifier(config.databaseUrl);
await notifier.start();

const app = createApplication({
  uow: new PgUnitOfWork(pool, { idempotencyKey: config.idempotencyKey }),
  clock: { now: () => new Date() },
  ids: { uuid: randomUUID, joinCode },
  reviews: new PgReviewReader(pool),
  credentials: new HmacCredentialPolicy(config.credentialKeys),
});

const server = buildServer({
  app,
  ready: async () => {
    await pool.query('SELECT 1');
    return true;
  },
  notifier,
  rateLimiter: new PgRateLimiter(pool, {
    limit: config.authRateLimitPerMinute,
    windowMs: 60_000,
  }),
  config: { allowedOrigin: config.allowedOrigin, logLevel: config.logLevel },
});

async function shutdown() {
  await server.close();
  await notifier.stop();
  await pool.end();
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

await server.listen({ port: config.port, host: '0.0.0.0' });
