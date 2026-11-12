import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLES } from '../../../src/server/domain/types.js';
import { runMigrations } from '../../../src/server/migrate.js';
import type { PgStore } from '../../../src/server/session/pg-store.js';
import { databaseUrl, newPgStore, rawPool, resetDatabase } from '../../u1/support/pg.js';
import { createWorld, newKey, type StartedGame, type World } from '../../u1/support/world.js';
import { expectProblem, outcome } from '../support/helpers.js';

let store: PgStore;
let pool: pg.Pool;
let world: World;

beforeAll(async () => {
  await resetDatabase();
  pool = rawPool();
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDatabase();
  store = newPgStore(3000);
  world = createWorld({ store });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** ゲームの行を占有したまま待つ。解放するまで、ほかの書き込みは順番を待つ。 */
function holdLock(gameId: string): { release: () => void; done: Promise<unknown> } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = store.transact(gameId, async () => gate);
  return { release, done };
}

async function inputAll(game: StartedGame, week: number) {
  for (const role of ROLES) {
    await world.session.submitDecision(
      game.players[role].principal,
      game.gameId,
      week,
      role,
      { quantity: 4 },
      newKey(),
    );
  }
}

async function installFailure(table: string, event: 'insert' | 'update') {
  await pool.query(`
    create or replace function u3_fail() returns trigger as $$
    begin raise exception 'injected failure'; end $$ language plpgsql`);
  await pool.query(
    `create trigger u3_fail_trigger before ${event} on ${table} for each statement execute function u3_fail()`,
  );
}

async function removeFailure(table: string) {
  await pool.query(`drop trigger if exists u3_fail_trigger on ${table}`);
  await pool.query('drop function if exists u3_fail');
}

describe('操作と履歴の原子性（NFR2.1、BR13.1）— 実際の PostgreSQL', () => {
  it('履歴の保存が失敗したら、一時停止も残らない（状態の更新と履歴は 1 トランザクション）', async () => {
    const game = await world.startedGame();
    await installFailure('operation_log_entries', 'insert');
    try {
      await expectProblem(world.session.pauseGame(game.facilitator, game.gameId), 'internal');
    } finally {
      await removeFailure('operation_log_entries');
    }
    const snapshot = await store.readSnapshot(game.gameId);
    expect(snapshot?.game.status).toBe('running');
    const history = await world.session.getHistory(game.facilitator, game.gameId);
    expect(history.entries.some((e) => e.kind === 'pause')).toBe(false);
    // 失敗のあとで、同じ操作をやり直せる
    await expect(world.session.pauseGame(game.facilitator, game.gameId)).resolves.toMatchObject({
      status: 'paused',
    });
  });

  it('最終週の確定の履歴が失敗したら、確定も終了も残らない（NFR2.2）', async () => {
    const game = await world.startedGame({ weekCount: 1, demandSeries: [4] });
    await inputAll(game, 1);
    const before = await store.readSnapshot(game.gameId);
    await installFailure('operation_log_entries', 'insert');
    try {
      await expectProblem(
        world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey()),
        'internal',
      );
    } finally {
      await removeFailure('operation_log_entries');
    }
    expect(await store.readSnapshot(game.gameId)).toEqual(before);
    const result = await world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey());
    expect(result.status).toBe('ended');
    const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
    expect(entries.slice(-2).map((e) => e.sequence)).toEqual([
      entries.at(-2)!.sequence,
      entries.at(-2)!.sequence + 1,
    ]);
  });

  it('入れ替えの途中（token の失効）で失敗したら、旧担当者の割当てと token は有効なまま、新しい参加者もいない', async () => {
    const game = await world.startedGame();
    await installFailure('return_tokens', 'update');
    try {
      await expectProblem(
        world.session.replaceAssignee(game.facilitator, game.gameId, 'retailer', {
          participantId: game.players.retailer.participantId,
          displayName: '新人',
        }),
        'internal',
      );
    } finally {
      await removeFailure('return_tokens');
    }
    const snapshot = await store.readSnapshot(game.gameId);
    expect(snapshot!.participants).toHaveLength(4);
    expect(snapshot!.assignments).toHaveLength(4);
    await expect(world.access.authenticate(game.players.retailer.token)).resolves.not.toBeNull();
    const rows = await pool.query(
      `select count(*)::int as n from operation_log_entries where game_id = $1 and kind = 'roleChange' and detail->>'change' = 'replace'`,
      [game.gameId],
    );
    expect(rows.rows[0].n).toBe(0);
  });
});

describe('競合（ゲーム単位の直列処理）— 占有の順を両方向で確かめる', () => {
  it('最終週の確定が先: 進行役の終了は冪等で、end の履歴は 1 件（finalWeek）', async () => {
    const game = await world.startedGame({ weekCount: 1, demandSeries: [4] });
    await inputAll(game, 1);
    const lock = holdLock(game.gameId);
    await sleep(50);
    const confirm = world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey());
    await sleep(100);
    const end = world.session.endGame(game.facilitator, game.gameId);
    await sleep(100);
    lock.release();
    await lock.done;
    await expect(confirm).resolves.toMatchObject({ status: 'ended' });
    await expect(end).resolves.toMatchObject({ status: 'ended' });
    const snapshot = await store.readSnapshot(game.gameId);
    expect(snapshot?.game.endReason).toBe('finalWeek');
    const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
    expect(entries.filter((e) => e.kind === 'end')).toHaveLength(1);
  });

  it('進行役の終了が先: 確定は 409 state で拒否され、endReason は facilitator、確定前の入力は確定されない', async () => {
    const game = await world.startedGame({ weekCount: 1, demandSeries: [4] });
    await inputAll(game, 1);
    const lock = holdLock(game.gameId);
    await sleep(50);
    const end = world.session.endGame(game.facilitator, game.gameId);
    await sleep(100);
    const confirm = outcome(world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey()));
    await sleep(100);
    lock.release();
    await lock.done;
    await expect(end).resolves.toMatchObject({ status: 'ended' });
    await expect(confirm).resolves.toBe('state');
    const snapshot = await store.readSnapshot(game.gameId);
    expect(snapshot?.game.endReason).toBe('facilitator');
    expect(snapshot!.weekRecords.every((r) => !r.isConfirmed)).toBe(true);
    const { entries } = await world.session.getHistory(game.facilitator, game.gameId);
    expect(entries.filter((e) => e.kind === 'end')).toHaveLength(1);
    expect(entries.some((e) => e.kind === 'weekConfirm')).toBe(false);
  });

  it('入れ替えが先: 旧担当者の入力（認可は入れ替えの前に通過）は 403 で、decision は書かれない（NFR6.3）', async () => {
    const game = await world.startedGame();
    const stale = await world.access.authenticate(game.players.retailer.token);
    const lock = holdLock(game.gameId);
    await sleep(50);
    const replace = world.session.replaceAssignee(game.facilitator, game.gameId, 'retailer', {
      participantId: game.players.retailer.participantId,
      displayName: '新人',
    });
    await sleep(100);
    const input = outcome(
      world.session.submitDecision(stale, game.gameId, 1, 'retailer', { quantity: 9 }, newKey()),
    );
    await sleep(100);
    lock.release();
    await lock.done;
    await replace;
    await expect(input).resolves.toBe('forbidden');
    const snapshot = await store.readSnapshot(game.gameId);
    const record = snapshot!.weekRecords.find((r) => r.week === 1 && r.role === 'retailer');
    expect(record?.decision).toBeNull();
    expect(record?.decidedByParticipantId).toBeNull();
  });

  it('旧担当者の入力が先: 入力は有効で、そのあとの入れ替えでも decision はそのまま残る（BR10.3）', async () => {
    const game = await world.startedGame();
    const stale = await world.access.authenticate(game.players.retailer.token);
    const lock = holdLock(game.gameId);
    await sleep(50);
    const input = world.session.submitDecision(
      stale,
      game.gameId,
      1,
      'retailer',
      { quantity: 9 },
      newKey(),
    );
    await sleep(100);
    const replace = world.session.replaceAssignee(game.facilitator, game.gameId, 'retailer', {
      participantId: game.players.retailer.participantId,
      displayName: '新人',
    });
    await sleep(100);
    lock.release();
    await lock.done;
    await input;
    const result = await replace;
    const snapshot = await store.readSnapshot(game.gameId);
    const record = snapshot!.weekRecords.find((r) => r.week === 1 && r.role === 'retailer');
    expect(record).toMatchObject({
      decision: 9,
      decidedByParticipantId: game.players.retailer.participantId,
    });
    const view = await world.session.getState(await world.as(result.token), game.gameId);
    expect(view.mine?.decision).toBe(9);
    expect(view.mine?.decidedBy?.label).toBe('小売店 #4');
  });

  it('同時の操作（代理入力と一時停止）でも（一時停止の後の入力は拒否されてよい）、履歴の sequence は 1 から欠けず重複しない（BR13.2）', async () => {
    const game = await world.startedGame();
    const operations: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i += 1) {
      operations.push(
        world.session
          .submitDecision(
            game.facilitator,
            game.gameId,
            1,
            ROLES[i % 4]!,
            { quantity: i },
            newKey(),
          )
          .catch(() => null),
      );
    }
    operations.push(world.session.pauseGame(game.facilitator, game.gameId).catch(() => null));
    await Promise.all(operations);
    const rows = await pool.query(
      'select sequence from operation_log_entries where game_id = $1 order by sequence',
      [game.gameId],
    );
    const sequences = rows.rows.map((r) => r.sequence as number);
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));
    const game1 = await pool.query('select next_log_sequence from games where game_id = $1', [
      game.gameId,
    ]);
    expect(game1.rows[0].next_log_sequence).toBe(sequences.length + 1);
  });
});

describe('投影の一貫性（NFR3.2）', () => {
  it('週の確定と入れ替えを繰り返しながら取得し続けても、どの投影も 1 つの時点の見え方になる', async () => {
    const game = await world.startedGame({ weekCount: 8, demandSeries: Array(8).fill(4) });
    let running = true;
    const problems: string[] = [];
    const poller = (async () => {
      while (running) {
        try {
          const view = await world.session.getState(game.facilitator, game.gameId);
          if (view.assignees && view.assignees.length !== 4) {
            problems.push(`担当者の数が ${view.assignees.length}`);
          }
          if (view.status === 'running') {
            const decided = ROLES.filter((r) => view.roles?.[r]?.decided).length;
            if (decided !== view.inputsDone || 4 - decided !== view.missingInputRoles?.length) {
              problems.push('入力済みの数と不足の役割が食い違う');
            }
          }
        } catch (error) {
          problems.push(`取得に失敗: ${String(error)}`);
        }
      }
    })();
    let retailerId = game.players.retailer.participantId;
    for (let week = 1; week <= 8; week += 1) {
      await inputAll({ ...game, players: game.players }, week).catch(async () => {
        // 入れ替えた担当者の token が変わるため、代理入力で埋める
        for (const role of ROLES) {
          await world.session
            .submitDecision(game.facilitator, game.gameId, week, role, { quantity: 4 }, newKey())
            .catch(() => undefined);
        }
      });
      await world.session.confirmWeek(game.facilitator, game.gameId, week, newKey());
      if (week < 8 && week % 2 === 1) {
        const replaced = await world.session.replaceAssignee(
          game.facilitator,
          game.gameId,
          'retailer',
          { participantId: retailerId, displayName: `代役${week}` },
        );
        retailerId = replaced.participantId;
      }
    }
    running = false;
    await poller;
    expect(problems).toEqual([]);
  });
});

describe('永続化と復元（NFR5.1）', () => {
  it('一時停止・終了の状態と理由は、別のストア（再起動の代わり）から同じに読める', async () => {
    const game = await world.startedGame();
    await world.session.pauseGame(game.facilitator, game.gameId);
    const restarted = createWorld({ store: newPgStore() });
    const paused = await restarted.session.getState(game.facilitator, game.gameId);
    expect(paused.status).toBe('paused');
    await restarted.session.endGame(game.facilitator, game.gameId);
    const snapshot = await newPgStore().readSnapshot(game.gameId);
    expect(snapshot?.game).toMatchObject({
      status: 'ended',
      endReason: 'facilitator',
      currentWeek: 1,
    });
  });

  it('履歴はゲームの削除と同時に消える（外部キーの連鎖）。(game_id, sequence) の重複は拒否される', async () => {
    const game = await world.startedGame();
    const count = await pool.query(
      'select count(*)::int as n from operation_log_entries where game_id = $1',
      [game.gameId],
    );
    expect(count.rows[0].n).toBeGreaterThan(0);
    await expect(
      pool.query(
        `insert into operation_log_entries (entry_id, game_id, sequence, kind, actor_kind, occurred_at, detail)
         values (gen_random_uuid(), $1, 1, 'pause', 'facilitator', now(), '{}')`,
        [game.gameId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await pool.query('delete from games where game_id = $1', [game.gameId]);
    const after = await pool.query(
      'select count(*)::int as n from operation_log_entries where game_id = $1',
      [game.gameId],
    );
    expect(after.rows[0].n).toBe(0);
  });

  it('入力の記録に、入力した主体と版が残る。decision が null のとき主体は持てない（制約）', async () => {
    const game = await world.startedGame();
    await world.session.submitDecision(
      game.players.retailer.principal,
      game.gameId,
      1,
      'retailer',
      { quantity: 5 },
      newKey(),
    );
    await world.session.submitDecision(
      game.facilitator,
      game.gameId,
      1,
      'retailer',
      { quantity: 6 },
      newKey(),
    );
    const row = await pool.query(
      `select decision, decided_by_kind, decided_by_participant_id, decision_revision
         from week_records where game_id = $1 and week = 1 and role = 'retailer'`,
      [game.gameId],
    );
    expect(row.rows[0]).toMatchObject({
      decision: 6,
      decided_by_kind: 'facilitator',
      decided_by_participant_id: null,
      decision_revision: 2,
    });
    await expect(
      pool.query(
        `update week_records set decided_by_kind = 'facilitator'
          where game_id = $1 and week = 1 and role = 'factory'`,
        [game.gameId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('移行（U3）と逆の移行', () => {
  it('逆の移行で履歴の表と追加の列が消え、再び進めると復元できる。一時停止中の行は進行中に戻る', async () => {
    const game = await world.startedGame();
    await world.session.pauseGame(game.facilitator, game.gameId);
    await runMigrations(databaseUrl(), 'down', 1);
    try {
      const table = await pool.query(`select to_regclass('operation_log_entries') as t`);
      expect(table.rows[0].t).toBeNull();
      const columns = await pool.query(
        `select column_name from information_schema.columns
          where table_name in ('games', 'week_records', 'participants')
            and column_name in ('end_reason', 'next_log_sequence', 'decision_revision', 'replaced_at')`,
      );
      expect(columns.rows).toHaveLength(0);
      const status = await pool.query('select status from games where game_id = $1', [game.gameId]);
      expect(status.rows[0].status).toBe('running');
    } finally {
      await runMigrations(databaseUrl(), 'up');
    }
    const table = await pool.query(`select to_regclass('operation_log_entries') as t`);
    expect(table.rows[0].t).toBe('operation_log_entries');
  });

  it('移行の前に ended だった行は finalWeek を補われ、入力済みの値は版 1 になる', async () => {
    await runMigrations(databaseUrl(), 'down', 1);
    const gameId = '00000000-0000-4000-8000-0000000000c1';
    try {
      await pool.query(
        `insert into games (game_id, name, status, week_count, current_week, setup_kind, version, created_at, ended_at)
         values ($1, '旧', 'ended', 2, 2, 'custom', 3, now(), now())`,
        [gameId],
      );
      await pool.query(
        `insert into week_records (week_record_id, game_id, week, role, decision)
         values (gen_random_uuid(), $1, 1, 'factory', 5), (gen_random_uuid(), $1, 1, 'retailer', null)`,
        [gameId],
      );
    } finally {
      await runMigrations(databaseUrl(), 'up');
    }
    const game = await pool.query(
      'select end_reason, next_log_sequence from games where game_id = $1',
      [gameId],
    );
    expect(game.rows[0]).toEqual({ end_reason: 'finalWeek', next_log_sequence: 1 });
    const records = await pool.query(
      'select role, decision_revision from week_records where game_id = $1 order by role',
      [gameId],
    );
    expect(records.rows).toEqual([
      { role: 'factory', decision_revision: 1 },
      { role: 'retailer', decision_revision: 0 },
    ]);
  });
});

describe('履歴の規模（NFR3.2）', () => {
  it('履歴 1,000 件の取得は、昇順で全件を返し、応答は 1 MB 未満', async () => {
    const game = await world.startedGame();
    await pool.query(
      `insert into operation_log_entries (entry_id, game_id, sequence, kind, actor_kind, occurred_at, week, role, detail)
       select gen_random_uuid(), $1, 1000 + g, 'proxyInput', 'facilitator', now(), 1, 'factory', '{"value": 4}'::jsonb
         from generate_series(1, 1000) as g`,
      [game.gameId],
    );
    const startedAt = performance.now();
    const history = await world.session.getHistory(game.facilitator, game.gameId);
    const elapsed = performance.now() - startedAt;
    expect(history.entries.length).toBeGreaterThanOrEqual(1000);
    const sequences = history.entries.map((e) => e.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(JSON.stringify(history).length).toBeLessThan(1024 * 1024);
    // 予算は 300 ミリ秒（サーバー内）。試験の機械の揺れを見込んで、10 倍までを許す
    expect(elapsed).toBeLessThan(3000);
  });
});
