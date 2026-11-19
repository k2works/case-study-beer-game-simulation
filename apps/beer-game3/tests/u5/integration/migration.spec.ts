import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../../src/server/migrate.js';
import { newPgStore, databaseUrl, rawPool, resetDatabase } from '../../u1/support/pg.js';

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

const GAME_OLD = '11111111-1111-4111-8111-111111111111';
const GAME_FRESH = '12121212-1212-4212-8212-121212121212';
const GAME_ENDED = '13131313-1313-4313-8313-131313131313';
const PARTICIPANT = '22222222-2222-4222-8222-222222222222';

describe('C3 移行: games.last_operation_at と 2 つの部分索引', () => {
  it('列は not null で default now()、部分索引は未終了と終了済みに分かれる', async () => {
    const column = await pool.query(
      `select is_nullable, column_default from information_schema.columns
        where table_name = 'games' and column_name = 'last_operation_at'`,
    );
    expect(column.rows[0].is_nullable).toBe('NO');
    expect(String(column.rows[0].column_default)).toContain('now()');

    const indexes = await pool.query(
      "select indexname, indexdef from pg_indexes where tablename = 'games' order by indexname",
    );
    const byName = new Map(indexes.rows.map((r) => [r.indexname as string, r.indexdef as string]));
    expect(byName.get('games_stale_idx')).toMatch(/last_operation_at.*WHERE.*status.*ended/is);
    expect(byName.get('games_expired_idx')).toMatch(/ended_at.*WHERE.*status.*ended/is);
  });

  it('既存の行は、作成・参加・履歴・入力・終了のうち最も遅い時刻で埋める（移行の直後に早すぎる自動終了が起きない）', async () => {
    await runMigrations(databaseUrl(), 'down', 1);
    const columns = await pool.query(
      "select 1 from information_schema.columns where table_name = 'games' and column_name = 'last_operation_at'",
    );
    expect(columns.rowCount).toBe(0);

    // 古い作成日のあと、参加 → 履歴 → 入力と、操作が続いたゲーム
    await pool.query(
      "insert into games (game_id, name, week_count, status, created_at) values ($1, '古い', 3, 'running', '2026-01-01T00:00:00Z')",
      [GAME_OLD],
    );
    await pool.query(
      "insert into participants (participant_id, game_id, display_name, join_order, joined_at) values ($1, $2, '旧', 1, '2026-02-01T00:00:00Z')",
      [PARTICIPANT, GAME_OLD],
    );
    await pool.query(
      `insert into operation_log_entries (entry_id, game_id, sequence, kind, actor_kind, occurred_at, detail)
       values ('33333333-3333-4333-8333-333333333333', $1, 1, 'pause', 'facilitator', '2026-02-15T00:00:00Z', '{}')`,
      [GAME_OLD],
    );
    await pool.query(
      `insert into week_records (week_record_id, game_id, week, role, decision, decided_by_kind, decided_at, decision_revision)
       values ('44444444-4444-4444-8444-444444444444', $1, 1, 'factory', 3, 'facilitator', '2026-03-01T00:00:00Z', 1)`,
      [GAME_OLD],
    );
    // 作成のあと何も起きていないゲーム
    await pool.query(
      "insert into games (game_id, name, week_count, created_at) values ($1, '新しい', 3, '2026-05-01T00:00:00Z')",
      [GAME_FRESH],
    );
    // 終了したゲーム
    await pool.query(
      `insert into games (game_id, name, week_count, status, end_reason, created_at, ended_at)
       values ($1, '終了', 3, 'ended', 'facilitator', '2026-01-02T00:00:00Z', '2026-04-01T00:00:00Z')`,
      [GAME_ENDED],
    );

    await runMigrations(databaseUrl(), 'up');

    const rows = await pool.query('select game_id, last_operation_at from games order by game_id');
    const at = new Map(
      rows.rows.map((r) => [r.game_id as string, (r.last_operation_at as Date).toISOString()]),
    );
    expect(at.get(GAME_OLD)).toBe('2026-03-01T00:00:00.000Z');
    expect(at.get(GAME_FRESH)).toBe('2026-05-01T00:00:00.000Z');
    expect(at.get(GAME_ENDED)).toBe('2026-04-01T00:00:00.000Z');

    // 履歴だけを見るよりも新しいので、参加と入力のあとの時刻より前の期限では対象にならない
    const store = newPgStore();
    try {
      const stale = await store.findStaleGames(new Date('2026-02-20T00:00:00Z'), 10, []);
      expect(stale).toEqual([]);
      const later = await store.findStaleGames(new Date('2026-03-02T00:00:00Z'), 10, []);
      expect(later).toEqual([GAME_OLD]);
    } finally {
      await store.close();
    }
  });

  it('逆の移行で列と索引を落とし、再び適用できる（既存の列は残る）', async () => {
    await runMigrations(databaseUrl(), 'down', 1);
    const indexes = await pool.query(
      "select indexname from pg_indexes where indexname in ('games_stale_idx', 'games_expired_idx')",
    );
    expect(indexes.rowCount).toBe(0);
    const remaining = await pool.query(
      "select column_name from information_schema.columns where table_name = 'games'",
    );
    expect(remaining.rows.map((r) => r.column_name)).toEqual(
      expect.arrayContaining(['game_id', 'status', 'ended_at', 'end_reason', 'next_log_sequence']),
    );
    await runMigrations(databaseUrl(), 'up');
    const again = await pool.query(
      "select 1 from information_schema.columns where table_name = 'games' and column_name = 'last_operation_at'",
    );
    expect(again.rowCount).toBe(1);
  });
});
