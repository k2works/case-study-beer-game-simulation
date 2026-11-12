import pg from 'pg';
import { runMigrations } from '../../../src/server/migrate.js';
import { PgStore } from '../../../src/server/session/pg-store.js';

/**
 * 結合の試験用の PostgreSQL。接続先は環境変数 DATABASE_URL。
 * 無いときは、飛ばさずに失敗させる（unit-test-instructions.md）。
 */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL が設定されていません。結合の試験には PostgreSQL 18 の空のデータベースが必要です（tests/u1 の unit-test-instructions.md を参照）',
    );
  }
  return url;
}

let migrated = false;

/** 移行を適用し、全部の表を空にする。 */
export async function resetDatabase(): Promise<void> {
  const url = databaseUrl();
  if (!migrated) {
    await runMigrations(url, 'up');
    migrated = true;
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await pool.query('truncate games cascade');
  } finally {
    await pool.end();
  }
}

export function newPgStore(lockTimeoutMs = 3000): PgStore {
  return new PgStore({ connectionString: databaseUrl(), lockTimeoutMs });
}

export function rawPool(): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl(), max: 2 });
}
