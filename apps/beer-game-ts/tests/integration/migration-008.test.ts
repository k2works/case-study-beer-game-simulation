import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// マイグレーション 008（役割ごとの初期在庫と初期の流れ）が、旧い形の行を変換し、Down で戻せること。
// 共有のテスト DB には触れず、使い捨ての DB で、007 まで適用 → 旧い形の行を入れる → 008 を適用する。
const ADMIN_URL =
  process.env.DATABASE_URL ??
  'postgres://beer_game2:local-only@localhost:5433/beer_game2';
const SCRATCH = 'beer_game2_migration008_test';

const withDatabase = (name: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  return u.toString();
};

const migrate = (direction: 'up' | 'down', count: number) =>
  runner({
    databaseUrl: withDatabase(SCRATCH),
    dir: 'migrations',
    direction,
    migrationsTable: 'pgmigrations',
    count,
    log: () => {},
  });

let admin: pg.Client;
let db: pg.Pool;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
  await admin.query(`CREATE DATABASE ${SCRATCH}`);
  await migrate('up', 7); // 001〜007
  db = new pg.Pool({ connectionString: withDatabase(SCRATCH) });
}, 60_000);

afterAll(async () => {
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
  await admin?.end();
});

describe('マイグレーション 008（役割ごとの初期在庫・初期の流れ）', () => {
  const gameId = '3f9c1b9e-5b0a-4a53-8b52-0c6b8f2d4a11';

  it('旧い形の行（整数の初期在庫）を、役割ごとの列と初期の流れ（4）へ変換する', async () => {
    await db.query(
      `INSERT INTO games (game_id, join_code, status, version, final_week, demand,
         holding_cost_minor, backlog_cost_minor, quantity_max, initial_inventory)
       VALUES ($1,'J-OLD','STARTED',1,3,'[4,4,4]',50,100,1000,17)`,
      [gameId],
    );
    await db.query(
      `INSERT INTO sessions (session_id, game_id, status, week, version, settings, holders, role_states)
       VALUES ($1,$1,'ACTIVE',1,1,'{"initialInventory":17,"orderDelayWeeks":2}','{}','{}')`,
      [gameId],
    );

    await migrate('up', 1); // 008

    const { rows } = await db.query(
      `SELECT initial_inventory_factory f, initial_inventory_distributor d,
              initial_inventory_wholesaler w, initial_inventory_retailer r, initial_flow
         FROM games WHERE game_id = $1`,
      [gameId],
    );
    expect(rows[0]).toEqual({ f: 17, d: 17, w: 17, r: 17, initial_flow: 4 });
    const columns = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'games' AND column_name = 'initial_inventory'`,
    );
    expect(columns.rowCount).toBe(0);

    const session = await db.query(
      'SELECT settings FROM sessions WHERE session_id = $1',
      [gameId],
    );
    expect(session.rows[0].settings).toEqual({
      initialInventory: {
        FACTORY: 17,
        DISTRIBUTOR: 17,
        WHOLESALER: 17,
        RETAILER: 17,
      },
      initialFlow: 4,
      orderDelayWeeks: 2,
    });
  });

  it('範囲外の値は、制約で拒否される（負の初期在庫・範囲外の初期の流れ）', async () => {
    await expect(
      db.query(
        'UPDATE games SET initial_inventory_factory = -1 WHERE game_id = $1',
        [gameId],
      ),
    ).rejects.toThrow();
    await expect(
      db.query('UPDATE games SET initial_flow = 1001 WHERE game_id = $1', [
        gameId,
      ]),
    ).rejects.toThrow();
  });

  it('Down で、整数の列（小売店の値）と数値の設定へ戻る', async () => {
    await db.query(
      'UPDATE games SET initial_inventory_retailer = 99 WHERE game_id = $1',
      [gameId],
    );
    await db.query(
      `UPDATE sessions SET settings = jsonb_set(settings, '{initialInventory,RETAILER}', '99')
        WHERE session_id = $1`,
      [gameId],
    );

    await migrate('down', 1);

    const { rows } = await db.query(
      'SELECT initial_inventory FROM games WHERE game_id = $1',
      [gameId],
    );
    expect(rows[0].initial_inventory).toBe(99);
    const session = await db.query(
      'SELECT settings FROM sessions WHERE session_id = $1',
      [gameId],
    );
    expect(session.rows[0].settings).toEqual({
      initialInventory: 99,
      orderDelayWeeks: 2,
    });
  });
});
