import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PgNotifier } from '../../src/adapters/persistence/pg-notifier.js';
import { PgUnitOfWork } from '../../src/adapters/persistence/pg-unit-of-work.js';
import { buildServer } from '../../src/adapters/http/server.js';
import { createApplication } from '../../src/application/index.js';
import { ROLES } from '../../src/domain/role.js';
import { fakeCredentials, sequentialIds } from '../support/memory.js';
import { prepareTestDatabase, resetData, TEST_URL } from '../support/db.js';

let pool: pg.Pool;
beforeAll(async () => {
  pool = await prepareTestDatabase();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetData(pool);
});

describe('PgNotifier（LISTEN / NOTIFY）', () => {
  it('[US2.1] セッションが更新されると、そのゲームの購読者だけに、内容なしで通知される', async () => {
    const notifier = new PgNotifier(TEST_URL);
    await notifier.start();
    const app = createApplication({
      uow: new PgUnitOfWork(pool, { idempotencyKey: Buffer.alloc(32, 1) }),
      clock: { now: () => new Date() },
      ids: { uuid: () => randomUUID(), joinCode: sequentialIds().joinCode },
      credentials: fakeCredentials(),
    });
    const c = await app.createGame({ weeks: 2 });
    const mine = vi.fn();
    const other = vi.fn();
    const off = notifier.subscribe(c.gameId, mine);
    notifier.subscribe('someone-else', other);
    for (const role of ROLES) {
      const j = await app.joinGame({ joinCode: c.joinCode, displayName: role });
      await app.assignRole({
        token: c.facilitatorToken,
        gameId: c.gameId,
        participantId: j.participantId,
        role,
      });
    }
    await app.startGame({ token: c.facilitatorToken, gameId: c.gameId });
    await vi.waitFor(() => expect(mine).toHaveBeenCalled());
    expect(mine.mock.calls[0]).toEqual([]);
    expect(other).not.toHaveBeenCalled();
    off();
    mine.mockClear();
    await pool.query("SELECT pg_notify('session_changed', $1)", [c.gameId]);
    await new Promise((r) => setTimeout(r, 100));
    expect(mine).not.toHaveBeenCalled();
    await notifier.stop();
  });
});

describe('PgNotifier の再接続', () => {
  it('[US6.1] 接続が切れても、プロセスは落ちず、再接続して通知を受け取れる', async () => {
    const notifier = new PgNotifier(TEST_URL, { retryMs: 50 });
    await notifier.start();
    const listener = vi.fn();
    notifier.subscribe('g-reconnect', listener);
    await pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = current_database() AND query LIKE 'LISTEN%'`,
    );
    await vi.waitFor(
      async () => {
        await pool.query("SELECT pg_notify('session_changed', 'g-reconnect')");
        expect(listener).toHaveBeenCalled();
      },
      { timeout: 3000, interval: 100 },
    );
    await notifier.stop();
  });
});

describe('SSE', () => {
  it('[US2.1] 通知は「変化があった」ことだけを伝え、状態の内容を含まない。認証が要る', async () => {
    let fire: () => void = () => {};
    const app = createApplication({
      uow: new PgUnitOfWork(pool, { idempotencyKey: Buffer.alloc(32, 1) }),
      clock: { now: () => new Date() },
      ids: { uuid: () => randomUUID(), joinCode: sequentialIds().joinCode },
      credentials: fakeCredentials(),
    });
    const server = buildServer({
      app,
      ready: async () => true,
      notifier: {
        subscribe: (_id, l) => {
          fire = l;
          return () => {};
        },
      },
      config: { allowedOrigin: 'https://x.test', logLevel: 'silent' },
    });
    await server.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
    try {
      const c = await app.createGame({ weeks: 2 });
      expect((await fetch(`${base}/api/games/${c.gameId}/stream`)).status).toBe(
        401,
      );

      const ctrl = new AbortController();
      const res = await fetch(`${base}/api/games/${c.gameId}/stream`, {
        headers: { cookie: `bg_facilitator=${c.facilitatorToken}` },
        signal: ctrl.signal,
      });
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = decoder.decode((await reader.read()).value);
      expect(text).toContain(': connected');
      fire();
      text += decoder.decode((await reader.read()).value);
      expect(text).toContain('event: changed\ndata: {}');
      ctrl.abort();
    } finally {
      await server.close();
    }
  });
});
