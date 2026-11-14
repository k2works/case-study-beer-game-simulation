import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/server/migrate.js';
import { databaseUrl, rawPool, resetDatabase } from '../../u1/support/pg.js';

let pool: pg.Pool;

beforeAll(async () => {
  await resetDatabase();
  pool = rawPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase();
});

// どの試験が失敗しても、他の試験のために最新の状態に戻す
afterEach(async () => {
  await runMigrations(databaseUrl(), 'up');
});

const columnsOf = async (table: string): Promise<string[]> =>
  (
    await pool.query(
      'select column_name from information_schema.columns where table_name = $1 order by column_name',
      [table],
    )
  ).rows.map((row) => row.column_name as string);

const tableExists = async (table: string): Promise<boolean> =>
  (await pool.query('select to_regclass($1) as name', [table])).rows[0].name !== null;

describe('C3 移行: return_tokens.last_used_at と join_attempts', () => {
  it('最新の移行で、列と表と 2 つの索引がある', async () => {
    expect(await columnsOf('return_tokens')).toContain('last_used_at');
    expect(await columnsOf('join_attempts')).toEqual(['attempted_at', 'id', 'source_key']);
    const indexes = await pool.query(
      "select indexname from pg_indexes where tablename = 'join_attempts' order by indexname",
    );
    expect(indexes.rows.map((r) => r.indexname)).toEqual(
      expect.arrayContaining(['join_attempts_attempted_idx', 'join_attempts_source_idx']),
    );
    const nullable = await pool.query(
      "select is_nullable from information_schema.columns where table_name = 'return_tokens' and column_name = 'last_used_at'",
    );
    expect(nullable.rows[0].is_nullable).toBe('NO');
  });

  it('既存の行は issued_at で埋める（U3 までに発行された token が、移行の直後に期限切れにならない）', async () => {
    // 新しい順に戻す: U5 の移行、続いて U4 の移行
    await runMigrations(databaseUrl(), 'down', 2);
    expect(await columnsOf('return_tokens')).not.toContain('last_used_at');

    const gameId = '11111111-1111-4111-8111-111111111111';
    const participantId = '22222222-2222-4222-8222-222222222222';
    await pool.query(
      "insert into games (game_id, name, week_count, created_at) values ($1, '移行', 3, now())",
      [gameId],
    );
    await pool.query(
      "insert into participants (participant_id, game_id, display_name, join_order, joined_at) values ($1, $2, '旧', 1, now())",
      [participantId, gameId],
    );
    await pool.query(
      "insert into return_tokens (token_id, participant_id, token_hash, issued_at) values ('33333333-3333-4333-8333-333333333333', $1, 'sha256:old', '2026-11-01T00:00:00Z')",
      [participantId],
    );

    await runMigrations(databaseUrl(), 'up');
    const row = await pool.query(
      "select issued_at, last_used_at from return_tokens where token_hash = 'sha256:old'",
    );
    expect(row.rows[0].last_used_at).toEqual(row.rows[0].issued_at);
  });

  it('逆の移行で、追加した列と表を落とし、再び適用できる', async () => {
    // 新しい順に戻す: U5 の移行、続いて U4 の移行
    await runMigrations(databaseUrl(), 'down', 2);
    expect(await columnsOf('return_tokens')).not.toContain('last_used_at');
    expect(await tableExists('join_attempts')).toBe(false);
    // 既存の列と表は残る
    expect(await columnsOf('return_tokens')).toEqual(
      expect.arrayContaining([
        'token_id',
        'participant_id',
        'token_hash',
        'issued_at',
        'revoked_at',
      ]),
    );
    await runMigrations(databaseUrl(), 'up');
    expect(await tableExists('join_attempts')).toBe(true);
  });
});
