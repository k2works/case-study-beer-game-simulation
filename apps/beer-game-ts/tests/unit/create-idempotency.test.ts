import { beforeEach, describe, expect, it } from 'vitest';
import {
  createApplication,
  type Application,
} from '../../src/application/index.js';
import { IdempotencyKeyReusedError } from '../../src/application/errors.js';
import { ConflictError } from '../../src/ports/index.js';
import {
  fakeCredentials,
  memoryExportReader,
  memoryReviewReader,
  memoryUnitOfWork,
  sequentialIds,
} from '../support/memory.js';

// createGame の冪等（共有の契約: 変更系は Idempotency-Key が必須。同じキーの再送は、保存した応答を返す）
let mem: ReturnType<typeof memoryUnitOfWork>;
let app: Application;
beforeEach(() => {
  mem = memoryUnitOfWork();
  app = createApplication({
    uow: mem.uow,
    clock: { now: () => new Date('2026-11-24T00:00:00Z') },
    ids: sequentialIds(),
    credentials: fakeCredentials(),
    reviews: memoryReviewReader(mem),
    exports: memoryExportReader(mem),
  });
});

const request = { weeks: 3, demand: [4, 4, 4] };

describe('createGame の冪等', () => {
  it('同じキー・同じ内容の再送は、同じゲームと同じ資格・復帰コードを返し、ゲームを増やさない', async () => {
    const a = await app.createGame({ ...request, idempotencyKey: 'key-1' });
    const b = await app.createGame({ ...request, idempotencyKey: 'key-1' });
    expect(b).toEqual(a);
    expect(mem.snapshot().games.size).toBe(1);
  });

  it('同じキーで内容が違えば、409 の競合（app.idempotency_key_reused）で、ゲームを増やさない', async () => {
    await app.createGame({ ...request, idempotencyKey: 'key-1' });
    const err = await app
      .createGame({ weeks: 5, idempotencyKey: 'key-1' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdempotencyKeyReusedError);
    // 旧い経路が 409 の競合として扱えるように、競合の一種
    expect(err).toBeInstanceOf(ConflictError);
    expect(mem.snapshot().games.size).toBe(1);
  });

  it('キーが違えば、別のゲーム。キーが無ければ、冪等にしない（旧い経路）', async () => {
    const a = await app.createGame({ ...request, idempotencyKey: 'key-1' });
    const b = await app.createGame({ ...request, idempotencyKey: 'key-2' });
    expect(b.gameId).not.toBe(a.gameId);
    const c = await app.createGame(request);
    const d = await app.createGame(request);
    expect(d.gameId).not.toBe(c.gameId);
    expect(mem.snapshot().games.size).toBe(4);
  });

  it('内容の比較は、項目の順序・省略した既定値の違いに左右されない（同じ要求とみなす）', async () => {
    const a = await app.createGame({
      weeks: 3,
      demand: [4, 4, 4],
      commitMode: 'MANUAL',
      idempotencyKey: 'key-1',
    });
    const b = await app.createGame({
      idempotencyKey: 'key-1',
      commitMode: 'MANUAL',
      demand: [4, 4, 4],
      weeks: 3,
    });
    expect(b.gameId).toBe(a.gameId);
  });

  it('失敗した作成（検証の誤り）は、キーを消費しない。直した内容で、同じキーで作れる', async () => {
    await expect(
      app.createGame({ weeks: 99, idempotencyKey: 'key-1' }),
    ).rejects.toThrow();
    const ok = await app.createGame({ ...request, idempotencyKey: 'key-1' });
    expect(ok.gameId).toBeTruthy();
    expect(mem.snapshot().games.size).toBe(1);
  });

  it('再送で返す資格は、そのまま使える（保存した応答の資格で、ゲームを読める）', async () => {
    const a = await app.createGame({ ...request, idempotencyKey: 'key-1' });
    const b = await app.createGame({ ...request, idempotencyKey: 'key-1' });
    const lobby = await app.getLobby({
      token: b.facilitatorToken,
      gameId: a.gameId,
    });
    expect(lobby.gameId).toBe(a.gameId);
  });
});
