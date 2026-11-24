import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import {
  createApplication,
  type Application,
} from '../../src/application/index.js';
import { buildServer } from '../../src/adapters/http/server.js';
import type { IdGenerator } from '../../src/ports/index.js';
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

export interface Booted {
  server: FastifyInstance;
  /** 前提のゲームを、HTTP を通さずに用意するための、アプリケーション */
  app: Application;
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
  } = {},
): Promise<Booted> {
  const mem = memoryUnitOfWork();
  const app = createApplication({
    uow: mem.uow,
    clock: { now: () => new Date() },
    ids: uuidIds(),
    credentials: fakeCredentials(),
    reviews: memoryReviewReader(mem),
    exports: memoryExportReader(mem),
  });
  const server = buildServer({
    app,
    ready: options.ready ?? (async () => true),
    ...(options.notifierReady ? { notifierReady: options.notifierReady } : {}),
    notifier: { subscribe: () => () => {} },
    rateLimiter: memoryRateLimiter(options.rateLimit ?? 1000, 60_000),
    config: {
      allowedOrigins: options.allowedOrigins ?? [ORIGIN],
      logLevel: 'silent',
      secureCookies: options.secureCookies ?? false,
    },
    logStream: new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    }),
  });
  await server.ready();
  return { server, app };
}

export async function bootServer(
  options: Parameters<typeof bootApp>[0] = {},
): Promise<FastifyInstance> {
  return (await bootApp(options)).server;
}
