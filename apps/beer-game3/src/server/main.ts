import { startJoinAttemptSweeper } from './access/join-sweeper.js';
import { createServices } from './access/session-gateway.js';
import { cryptoRandom, systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { ConfigError } from './errors.js';
import { createApp } from './http/app.js';
import { runMigrations } from './migrate.js';
import { FailureMemory } from './retention/failure-memory.js';
import { RetentionJob } from './retention/job.js';
import { describeRetentionPolicy } from './retention/policy.js';
import { startRetentionScheduler, type RetentionScheduler } from './retention/scheduler.js';
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
    ...(config.trustedProxyHops !== null ? { trustedProxyHops: config.trustedProxyHops } : {}),
    policy: config.policy,
  });
  // 参加の窓の古い行を、起動時と一定の周期で削除する（失敗しても参加の要求には影響しない）
  const sweeper = startJoinAttemptSweeper({
    store,
    clock: systemClock,
    policy: config.policy,
    intervalMs: config.sweepIntervalMs,
    log: writeLine,
  });

  // 定期処理（自動終了と削除）は、入口を持たず、GameSession を内部から呼ぶ（NFR6.5）。
  // 入口のモジュールは Retention を import せず、起動を組み立てるここだけが組み合わせる
  const { session } = createServices({
    store,
    keyRing: config.keyRing,
    clock: systemClock,
    random: cryptoRandom,
    policy: config.policy,
  });
  const intervalMs = config.retention.jobIntervalMinutes * 60_000;
  const job = new RetentionJob({
    store,
    session,
    clock: systemClock,
    policy: config.retention,
    log: writeLine,
    failures: new FailureMemory({ cooldownMs: intervalMs }),
  });
  let retention: RetentionScheduler | null = null;

  // 停止の手順: タイマー（実行中の処理の終わりを最大 10 秒待つ）、HTTP、接続プールの順（NFR5.2）
  const shutdown = async (): Promise<void> => {
    sweeper.stop();
    await retention?.stop();
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
  // 起動の完了後に、有効な設定値を出し、定期処理を待たずに始める（BR26.5）
  for (const line of describeRetentionPolicy(config.retention)) {
    writeLine(line);
  }
  retention = startRetentionScheduler({ job, intervalMs, log: writeLine });
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
