import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootServer } from './boot.js';
import { PENDING_OPERATIONS } from './pending.js';
import { operations } from './spec.js';

// 契約の全操作を、TS 版が `/api/v1` に実装しているか。未実装の一覧（pending.ts）が、進捗の正本。
describe('契約の操作の実装状況', () => {
  let server: FastifyInstance;
  beforeAll(async () => {
    server = await bootServer();
  });
  afterAll(async () => {
    await server.close();
  });

  const all = operations();

  it('未実装の一覧は、契約に存在する操作だけを挙げる（綴りの誤りを防ぐ）', () => {
    const ids = new Set(all.map((o) => o.operationId));
    for (const pending of PENDING_OPERATIONS) {
      expect(ids.has(pending), `${pending} は契約に無い`).toBe(true);
    }
  });

  for (const op of all) {
    it(`${op.operationId}（${op.method} ${op.routeUrl}）: 実装済みか、未実装の一覧にある`, () => {
      const implemented = server.hasRoute({
        method: op.method,
        url: op.routeUrl,
      });
      const pending = PENDING_OPERATIONS.has(op.operationId);
      // 実装したのに一覧に残っている／実装していないのに一覧に無い、のどちらも失敗にする
      expect(
        implemented,
        pending
          ? `${op.operationId} は実装済み。pending.ts の一覧から消してください`
          : `${op.operationId} が未実装。実装するか、pending.ts の一覧に挙げてください`,
      ).toBe(!pending);
    });
  }
});
