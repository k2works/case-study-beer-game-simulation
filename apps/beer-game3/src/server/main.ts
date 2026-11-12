import { cryptoRandom, systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { ConfigError } from './errors.js';
import { createApp } from './http/app.js';
import { runMigrations } from './migrate.js';
import { PgStore } from './session/pg-store.js';

const writeLine = (line: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    // 鍵や接続先が無いときは、起動しない（NFR6.11）。値は出さず、理由だけを出す
    writeLine({
      time: new Date().toISOString(),
      level: 'error',
      event: 'startup_refused',
      reason: error instanceof ConfigError ? error.message : 'unknown',
    });
    process.exit(1);
  }

  if (config.runMigrations) {
    await runMigrations(config.databaseUrl, 'up');
  }
  const store = new PgStore({
    connectionString: config.databaseUrl,
    lockTimeoutMs: config.lockTimeoutMs,
  });
  const app = await createApp({
    store,
    keyRing: config.keyRing,
    clock: systemClock,
    random: cryptoRandom,
    log: writeLine,
    hsts: config.hsts,
    enforceHttps: config.hsts,
    webDist: config.webDist,
  });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  await app.listen({ host: config.host, port: config.port });
  writeLine({
    time: new Date().toISOString(),
    level: 'info',
    event: 'listening',
    port: config.port,
  });
}

main().catch((error: unknown) => {
  writeLine({
    time: new Date().toISOString(),
    level: 'error',
    event: 'startup_failed',
    errorName: error instanceof Error ? error.name : 'unknown',
  });
  process.exit(1);
});
