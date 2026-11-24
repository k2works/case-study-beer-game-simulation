import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import {
  createApplication,
  type Application,
} from '../../src/application/index.js';
import { buildServer } from '../../src/adapters/http/server.js';
import type { IdGenerator, Metric } from '../../src/ports/index.js';
import {
  fakeCredentials,
  memoryExportReader,
  memoryRateLimiter,
  memoryReviewReader,
  memoryUnitOfWork,
} from '../support/memory.js';

/** 契約テストで使う、許可する送信元 */
export const ORIGIN = 'https://beer.example.test';

/** 契約の ID は UUID（`format: uuid`）。参加コードは連番 */
function uuidIds(): IdGenerator {
  let n = 0;
  return {
    uuid: () => randomUUID(),
    joinCode: () => `JOIN-${String(++n).padStart(4, '0')}`,
  };
}

/** 出したメトリクス（値と次元） */
export interface EmittedMetric {
  metrics: readonly Metric[];
  dimensions: Record<string, string>;
}

export interface Booted {
  server: FastifyInstance;
  /** 前提のゲームを、HTTP を通さずに用意するための、アプリケーション */
  app: Application;
  /** メモリ上の永続化（失敗の注入に使う） */
  mem: ReturnType<typeof memoryUnitOfWork>;
  /** サーバーが出したログ（1 行 1 件の JSON）。`logLevel` を 'silent' 以外にしたときだけ入る */
  logs: string[];
  /** 出したメトリクス（アプリケーションとサーバーの両方） */
  emitted: EmittedMetric[];
}

/** メモリ上の永続化で、実際の HTTP アダプターを組み立てる（DB は要らない。既存の統合テストと同じ組み立て） */
export async function bootApp(
  options: {
    ready?: () => Promise<boolean>;
    notifierReady?: () => boolean;
    allowedOrigins?: readonly string[];
    secureCookies?: boolean;
    /** 参加・復帰の専用のレート制限（窓あたりの上限）。既定は、超えない値 */
    rateLimit?: number;
    /** ログの水準。既定は 'silent'（ログを集めない） */
    logLevel?: string;
  } = {},
): Promise<Booted> {
  const mem = memoryUnitOfWork();
  const logs: string[] = [];
  const emitted: EmittedMetric[] = [];
  const metrics = {
    emit: (
      ms: readonly Metric[],
      dimensions: Record<string, string> = {},
    ): void => {
      emitted.push({ metrics: ms, dimensions });
    },
  };
  const app = createApplication({
    uow: mem.uow,
    clock: { now: () => new Date() },
    ids: uuidIds(),
    credentials: fakeCredentials(),
    reviews: memoryReviewReader(mem),
    exports: memoryExportReader(mem),
    metrics,
  });
  const server = buildServer({
    app,
    ready: options.ready ?? (async () => true),
    ...(options.notifierReady ? { notifierReady: options.notifierReady } : {}),
    rateLimiter: memoryRateLimiter(options.rateLimit ?? 1000, 60_000),
    metrics,
    config: {
      allowedOrigins: options.allowedOrigins ?? [ORIGIN],
      logLevel: options.logLevel ?? 'silent',
      secureCookies: options.secureCookies ?? false,
    },
    logStream: new Writable({
      write(chunk, _enc, cb) {
        logs.push(String(chunk));
        cb();
      },
    }),
  });
  await server.ready();
  return { server, app, mem, logs, emitted };
}

export async function bootServer(
  options: Parameters<typeof bootApp>[0] = {},
): Promise<FastifyInstance> {
  return (await bootApp(options)).server;
}
