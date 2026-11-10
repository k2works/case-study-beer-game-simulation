import pg from 'pg';
import { runner } from 'node-pg-migrate';

const ADMIN_URL =
  process.env.DATABASE_URL ??
  'postgres://beer_game2:local-only@localhost:5433/beer_game2';
export const TEST_DB = 'beer_game2_test';

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}
export const TEST_URL = withDatabase(ADMIN_URL, TEST_DB);

/** 専用のテスト DB を用意し、マイグレーションを適用する。DB に接続できなければ失敗する（スキップしない） */
export async function prepareTestDatabase(): Promise<pg.Pool> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    const { rowCount } = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [TEST_DB],
    );
    if (!rowCount) await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }
  await runner({
    databaseUrl: TEST_URL,
    dir: 'migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => {},
  });
  const pool = new pg.Pool({ connectionString: TEST_URL });
  await assertTestDatabase(pool);
  return pool;
}

/** 破壊的な操作の前に、接続先が専用のテスト DB であることを確かめる */
export async function assertTestDatabase(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query('SELECT current_database() AS db');
  if (rows[0].db !== TEST_DB)
    throw new Error(`テスト DB ではありません: ${rows[0].db}`);
}

export async function resetData(pool: pg.Pool): Promise<void> {
  await assertTestDatabase(pool);
  await pool.query('TRUNCATE games CASCADE');
}
