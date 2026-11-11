import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HmacCredentialPolicy } from '../../src/adapters/http/credentials.js';
import { PgExportReader } from '../../src/adapters/persistence/pg-export-reader.js';
import { PgReviewReader } from '../../src/adapters/persistence/pg-review-reader.js';
import { PgUnitOfWork } from '../../src/adapters/persistence/pg-unit-of-work.js';
import {
  createApplication,
  type Application,
} from '../../src/application/index.js';
import { ROLES } from '../../src/domain/role.js';
import { prepareTestDatabase, resetData } from '../support/db.js';
import { sequentialIds } from '../support/memory.js';

let pool: pg.Pool;
let app: Application;
let now: Date;
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  pool = await prepareTestDatabase();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetData(pool);
  await pool.query('TRUNCATE deletion_receipts');
  now = new Date();
  app = createApplication({
    uow: new PgUnitOfWork(pool, { idempotencyKey: Buffer.alloc(32, 7) }),
    clock: { now: () => now },
    ids: { uuid: () => randomUUID(), joinCode: sequentialIds().joinCode },
    // 受領記録の参照は鍵つきのダイジェスト（偽の方式は生の値を含むため、本物を使う）
    credentials: new HmacCredentialPolicy([
      { version: 'v1', key: Buffer.alloc(32, 3) },
    ]),
    reviews: new PgReviewReader(pool),
    exports: new PgExportReader(pool, new PgReviewReader(pool)),
  });
});

/** ゲームを作り、参加・開始・入力・確定・観察者・冪等記録まで、ゲームの ID を持つ行を一通り作る */
async function fullGame(retentionDays: number) {
  const c = await app.createGame({ weeks: 2, retentionDays });
  const tokens: string[] = [];
  for (const role of ROLES) {
    const j = await app.joinGame({ joinCode: c.joinCode, displayName: role });
    await app.assignRole({
      token: c.facilitatorToken,
      gameId: c.gameId,
      participantId: j.participantId,
      role,
    });
    tokens.push(j.token);
  }
  const inv = await app.issueObserverInvitation({
    token: c.facilitatorToken,
    gameId: c.gameId,
  });
  await app.joinAsObserver({ code: inv.code });
  await app.startGame({ token: c.facilitatorToken, gameId: c.gameId });
  for (const [i, role] of ROLES.entries())
    await app.saveDecision({
      token: tokens[i]!,
      gameId: c.gameId,
      role,
      quantity: 4,
      expectedVersion: 0,
    });
  const v = await app.console({ token: c.facilitatorToken, gameId: c.gameId });
  await app.commitWeek({
    token: c.facilitatorToken,
    gameId: c.gameId,
    week: 1,
    version: v.sessionVersion,
    idempotencyKey: 'k1',
  });
  return c.gameId;
}

/** `game_id` 列を持つすべての表と、そのゲームの行数（session_id で結ぶ表も含める） */
async function rowsOf(gameId: string) {
  const { rows: tables } = await pool.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'game_id' ORDER BY table_name`,
  );
  const counts: Record<string, number> = {};
  for (const { table_name: t } of tables) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ${t} WHERE game_id = $1`,
      [gameId],
    );
    counts[t] = rows[0].n;
  }
  const { rows: sessionTables } = await pool.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'session_id' AND table_name <> 'sessions'`,
  );
  for (const { table_name: t } of sessionTables) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ${t} WHERE session_id IN
         (SELECT session_id FROM sessions WHERE game_id = $1)`,
      [gameId],
    );
    counts[t] = rows[0].n;
  }
  return counts;
}

describe('保持と削除（実 PostgreSQL）', () => {
  it('[US5.1/AC5.1.4] 削除の完了後、game_id を持つどの表にも、そのゲームの行が残らない', async () => {
    const gameId = await fullGame(1);
    const before = await rowsOf(gameId);
    // 削除の前は、主な表に行がある（網羅の検査が空振りしていないこと）
    for (const t of [
      'games',
      'participants',
      'sessions',
      'events',
      'browser_sessions',
      'observers',
      'idempotency_records',
    ])
      expect(before[t], t).toBeGreaterThan(0);
    now = new Date(now.getTime() + DAY);
    expect(await app.runRetention()).toMatchObject({ deleted: 1 });
    const after = await rowsOf(gameId);
    expect(
      Object.values(after).every((n) => n === 0),
      JSON.stringify(after),
    ).toBe(true);
    const { rows } = await pool.query('SELECT outcome FROM deletion_receipts');
    expect(rows).toEqual([{ outcome: 'DELETED' }]);
  });

  it('[US5.1/AC5.1.2] 期限前のゲームは削除しない', async () => {
    const gameId = await fullGame(2);
    now = new Date(now.getTime() + DAY);
    expect(await app.runRetention()).toMatchObject({ deleted: 0 });
    expect((await rowsOf(gameId)).games).toBe(1);
  });

  it('[US5.1/AC5.1.3] 受領記録の書き込みで失敗すると、何も消えず、試行回数が増え、再試行で一度だけ削除される', async () => {
    const gameId = await fullGame(1);
    now = new Date(now.getTime() + DAY);
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_receipt() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_receipt BEFORE INSERT ON deletion_receipts
        FOR EACH ROW EXECUTE FUNCTION fail_receipt();`);
    try {
      expect(await app.runRetention()).toMatchObject({ deleted: 0, failed: 1 });
      const kept = await rowsOf(gameId);
      expect(kept.games).toBe(1);
      expect(kept.events).toBeGreaterThan(0);
      const { rows } = await pool.query(
        'SELECT deletion_attempts FROM games WHERE game_id = $1',
        [gameId],
      );
      expect(rows[0].deletion_attempts).toBe(1);
    } finally {
      await pool.query(
        'DROP TRIGGER fail_receipt ON deletion_receipts; DROP FUNCTION fail_receipt();',
      );
    }
    expect(await app.runRetention()).toMatchObject({ deleted: 1 });
    expect(await app.runRetention()).toMatchObject({ deleted: 0 });
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM deletion_receipts',
    );
    expect(rows[0].n).toBe(1);
  });

  it('[US5.1/AC5.1.3] 2 つのタスクが同時に削除しても、受領記録は一度だけ', async () => {
    await fullGame(1);
    now = new Date(now.getTime() + DAY);
    const results = await Promise.all([app.runRetention(), app.runRetention()]);
    expect(results.reduce((a, r) => a + r.deleted, 0)).toBe(1);
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM deletion_receipts',
    );
    expect(rows[0].n).toBe(1);
  });

  it('[US5.1/AC5.1.2] 受領記録は、ゲームの ID を含まない', async () => {
    const gameId = await fullGame(1);
    now = new Date(now.getTime() + DAY);
    await app.runRetention();
    const { rows } = await pool.query('SELECT * FROM deletion_receipts');
    expect(JSON.stringify(rows)).not.toContain(gameId);
  });
});
