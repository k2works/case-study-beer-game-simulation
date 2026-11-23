import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { createApplication } from '../../src/application/index.js';
import { buildServer } from '../../src/adapters/http/server.js';
import {
  fakeCredentials,
  memoryExportReader,
  memoryRateLimiter,
  memoryReviewReader,
  memoryUnitOfWork,
  sequentialIds,
} from '../support/memory.js';

/** 契約テストで使う、許可する送信元 */
export const ORIGIN = 'https://beer.example.test';

/** メモリ上の永続化で、実際の HTTP アダプターを組み立てる（DB は要らない。既存の統合テストと同じ組み立て） */
export async function bootServer(
  options: { ready?: () => Promise<boolean> } = {},
): Promise<FastifyInstance> {
  const mem = memoryUnitOfWork();
  const app = createApplication({
    uow: mem.uow,
    clock: { now: () => new Date() },
    ids: sequentialIds(),
    credentials: fakeCredentials(),
    reviews: memoryReviewReader(mem),
    exports: memoryExportReader(mem),
  });
  const server = buildServer({
    app,
    ready: options.ready ?? (async () => true),
    notifier: { subscribe: () => () => {} },
    rateLimiter: memoryRateLimiter(1000, 60_000),
    config: { allowedOrigin: ORIGIN, logLevel: 'silent' },
    logStream: new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    }),
  });
  await server.ready();
  return server;
}
