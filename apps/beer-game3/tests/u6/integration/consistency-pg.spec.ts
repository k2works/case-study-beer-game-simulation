import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/server/migrate.js';
import { checkConsistency, openReadOnlySession } from '../../../verification/load/consistency.js';
import { createDisposableDatabase, newRunId } from '../../../verification/load/lifecycle.js';
import { ROLES } from '../../../verification/shared/roles.js';
import { adminUrl } from '../support/pg.js';

// 機能: 読み取り専用の接続で、全ゲームの整合性を検査する（NFR2.1）。意図的に崩したデータを検知する

let db: Awaited<ReturnType<typeof createDisposableDatabase>>;
let writer: pg.Client;

beforeAll(async () => {
  db = await createDisposableDatabase(adminUrl(), newRunId());
  await runMigrations(db.url, 'up');
  writer = new pg.Client({ connectionString: db.url });
  await writer.connect();
}, 60_000);

afterAll(async () => {
  await writer?.end();
  await db?.drop();
});

async function insertGame(currentWeek: number, status = 'running'): Promise<string> {
  const gameId = randomUUID();
  await writer.query(
    `insert into games (game_id, name, status, week_count, current_week, created_at, ended_at)
     values ($1, '整合性の試験', $2, 10, $3, now(), case when $2 = 'ended' then now() else null end)`,
    [gameId, status, currentWeek],
  );
  return gameId;
}

async function insertConfirmed(
  gameId: string,
  week: number,
  quantity = 4,
  roles: readonly string[] = ROLES,
) {
  for (const role of roles) {
    await writer.query(
      `insert into week_records (week_record_id, game_id, week, role, decision, receipt, orders_received,
         shipped, inventory, backlog, weekly_cost, cumulative_cost, is_confirmed)
       values ($1, $2, $3, $4, $5, 4, 4, 4, 12, 0, 600, 600, true)`,
      [randomUUID(), gameId, week, role, quantity],
    );
  }
}

describe('シナリオ: 読み取り専用の接続', () => {
  it('Given 読み取り専用の接続 When 書き込む Then PostgreSQL のエラー 25006 で失敗する', async () => {
    const session = await openReadOnlySession(db.url);
    try {
      await expect(
        session.query("delete from games where name = '存在しない'"),
      ).rejects.toMatchObject({
        code: '25006',
      });
      await expect(
        session.query(
          `insert into games (game_id, name, status, week_count, current_week, created_at)
           values (gen_random_uuid(), 'x', 'preparing', 1, 1, now())`,
        ),
      ).rejects.toMatchObject({ code: '25006' });
    } finally {
      await session.close();
    }
  });
});

describe('シナリオ: 意図的に崩したデータの検知', () => {
  it('Given 週 1〜2 が各 4 役割で確定した正常なゲーム When 検査する Then 崩れなし、成功応答の値も一致する', async () => {
    const gameId = await insertGame(3);
    await insertConfirmed(gameId, 1, 6);
    await insertConfirmed(gameId, 2, 7);
    const result = await checkConsistency(db.url, [
      { gameId, week: 1, role: 'factory', quantity: 6 },
      { gameId, week: 2, role: 'retailer', quantity: 7 },
    ]);
    expect(result.broken.filter((b) => b.gameId === gameId)).toEqual([]);
    expect(result.checkedGames).toBeGreaterThanOrEqual(1);
  });

  it('Given 週の欠け When 検査する Then missing_week を検知する', async () => {
    const gameId = await insertGame(4);
    await insertConfirmed(gameId, 1);
    await insertConfirmed(gameId, 3);
    const result = await checkConsistency(db.url, []);
    expect(result.broken).toContainEqual({ gameId, week: 2, kind: 'missing_week' });
  });

  it('Given 役割の欠けた確定 When 検査する Then incomplete_week を検知する', async () => {
    const gameId = await insertGame(2);
    await insertConfirmed(gameId, 1, 4, ROLES.slice(0, 3));
    const result = await checkConsistency(db.url, []);
    expect(result.broken).toContainEqual({ gameId, week: 1, kind: 'incomplete_week' });
  });

  it('Given 成功応答の値が保存されていない When 検査する Then missing_value と value_mismatch を検知する', async () => {
    const gameId = await insertGame(2);
    await insertConfirmed(gameId, 1, 4);
    const result = await checkConsistency(db.url, [
      { gameId, week: 1, role: 'factory', quantity: 99 },
      { gameId, week: 2, role: 'factory', quantity: 5 },
    ]);
    expect(result.broken).toContainEqual({ gameId, week: 1, kind: 'value_mismatch' });
    expect(result.broken).toContainEqual({ gameId, week: 2, kind: 'missing_value' });
  });

  it('Given 検査の後 When ゲームの行を調べる Then 検査は何も書き込んでいない', async () => {
    const before = await writer.query('select count(*)::int as n from games');
    await checkConsistency(db.url, []);
    const after = await writer.query('select count(*)::int as n from games');
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
