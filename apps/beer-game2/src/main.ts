import { buildServer } from './adapters/http/server.js';
import { PgNotifier } from './adapters/persistence/pg-notifier.js';
import { PgRateLimiter } from './adapters/persistence/pg-rate-limiter.js';
import { composeApplication, createPool } from './compose.js';
import { loadConfig } from './config/index.js';

const config = loadConfig(process.env);
const pool = createPool(config);
const notifier = new PgNotifier(config.databaseUrl);
await notifier.start();

const app = composeApplication(config, pool);

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
