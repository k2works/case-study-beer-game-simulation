import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../src/server/errors.js';
import { ROLES } from '../../../src/server/domain/types.js';
import { CodeCollisionError, VersionConflictError } from '../../../src/server/errors.js';
import type { PgStore } from '../../../src/server/session/pg-store.js';
import { createWorld, newKey, type World } from '../support/world.js';
import { newPgStore, rawPool, resetDatabase } from '../support/pg.js';

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
  store = newPgStore(400);
  world = createWorld({ store });
});

async function kind(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof AppError ? error.problem.kind : String(error)),
  );
}

describe('PostgreSQL への保存（C3）— 主要な境界の結合', () => {
  it('作成 → 参加 → 割当て → 開始 → 入力 → 確定が実際の PostgreSQL で通り、既知の数値になる', async () => {
    const game = await world.startedGame({ weekCount: 6, demandSeries: [4, 4, 4, 4, 8, 8] });
    const costs: number[] = [];
    for (let week = 1; week <= 6; week += 1) {
      costs.push((await world.playWeek(game, week)).teamCost);
    }
    expect(costs).toEqual([2400, 2400, 2400, 2400, 2200, 2000]);
    const view = await world.session.getState(game.players.retailer.principal, game.gameId);
    expect(view.status).toBe('ended');
    expect(view.mine?.history).toHaveLength(6);
    expect(view.mine?.cumulativeCost).toBe(600 * 4 + 400 + 200);
  });

  it('NFR5.1 / 復元: 別のストア（再起動の代わり）から同じ状態を読め、確定前の入力も残っている', async () => {
    const game = await world.startedGame();
    await world.session.submitDecision(
      game.players.retailer.principal,
      game.gameId,
      1,
      'retailer',
      { quantity: 9 },
      newKey(),
    );
    const restarted = createWorld({ store: newPgStore() });
    // 再起動後も、保存済みの token と進行役用コードで入り直せる
    const retailer = await restarted.as(game.players.retailer.token);
    const view = await restarted.session.getState(retailer, game.gameId);
    expect(view.mine?.decision).toBe(9);
    expect(view.status).toBe('running');
    await restarted.store.close();
  });

  it('NFR6.3 保存された値から平文のコードと token を復元できない', async () => {
    const game = await world.startedGame();
    const codes = await pool.query(
      'select kind, code_hash, code_sealed from access_codes where game_id = $1',
      [game.gameId],
    );
    const text = JSON.stringify(codes.rows);
    for (const secret of [game.joinCode, game.facilitatorCode, game.observerCode]) {
      expect(text).not.toContain(secret);
    }
    const facilitatorRow = codes.rows.find((r) => r.kind === 'facilitator');
    expect(facilitatorRow.code_sealed).toBeNull();
    const tokens = await pool.query('select token_hash from return_tokens');
    expect(JSON.stringify(tokens.rows)).not.toContain(game.players.retailer.token);
    // 参加コードと観察者用コードは進行役が何度でも見られる
    await expect(world.session.getCodes(game.facilitator, game.gameId)).resolves.toEqual({
      joinCode: game.joinCode,
      observerCode: game.observerCode,
    });
  });

  it('コード（照合用の値）が重なると CodeCollisionError で、ゲームは作られない', async () => {
    const first = await world.createGame();
    const row = await store.getAccessCode(first.gameId, 'join');
    const snapshot = await store.readSnapshot(first.gameId);
    const duplicate = {
      game: { ...snapshot!.game, gameId: '00000000-0000-4000-8000-0000000000aa' },
      settings: {
        ...snapshot!.settings,
        gameId: '00000000-0000-4000-8000-0000000000aa',
        settingsId: '00000000-0000-4000-8000-0000000000ab',
      },
      codes: [
        {
          ...row!,
          codeId: '00000000-0000-4000-8000-0000000000ac',
          gameId: '00000000-0000-4000-8000-0000000000aa',
        },
      ],
      logs: [],
    };
    await expect(store.createGame(duplicate)).rejects.toBeInstanceOf(CodeCollisionError);
    await expect(store.readSnapshot('00000000-0000-4000-8000-0000000000aa')).resolves.toBeNull();
  });
});

describe('NFR2.1 / BR5.9 原子的な確定（DB のトランザクション）', () => {
  it('保存の途中で失敗したら、記録・枠・週の進行のどれも残らず、やり直せる', async () => {
    const game = await world.startedGame();
    for (const role of ROLES) {
      await world.session.submitDecision(
        game.players[role].principal,
        game.gameId,
        1,
        role,
        { quantity: 4 },
        newKey(),
      );
    }
    const before = await store.readSnapshot(game.gameId);
    // 枠の書き込みで失敗する仕掛けを DB に入れる（確定の途中で失敗する状況を作る）
    await pool.query(`
      create or replace function fail_slots() returns trigger as $$
      begin raise exception 'injected failure'; end $$ language plpgsql`);
    await pool.query(
      'create trigger fail_slots_trigger before insert on pipeline_slots for each statement execute function fail_slots()',
    );
    try {
      await expect(
        kind(world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey())),
      ).resolves.toBe('internal');
      expect(await store.readSnapshot(game.gameId)).toEqual(before);
    } finally {
      await pool.query('drop trigger if exists fail_slots_trigger on pipeline_slots');
      await pool.query('drop function if exists fail_slots');
    }
    await expect(
      world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey()),
    ).resolves.toMatchObject({
      week: 1,
      currentWeek: 2,
    });
  });

  it('NFR2.2 版が食い違う保存は拒否し、何も書かない', async () => {
    const game = await world.createGame();
    await expect(
      store.transact(game.gameId, async (tx) =>
        tx.updateGame({ status: 'ended', endedAt: new Date() }, 999, []),
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect((await store.readSnapshot(game.gameId))?.game.status).toBe('preparing');
  });
});

describe('NFR2.3 / NFR3.7 / NFR4.2 / NFR4.4 ゲーム単位の直列処理（行の占有）', () => {
  it('同じ週の確定を同時に要求しても、確定は 1 回だけ', async () => {
    const game = await world.startedGame();
    for (const role of ROLES) {
      await world.session.submitDecision(
        game.players[role].principal,
        game.gameId,
        1,
        role,
        { quantity: 4 },
        newKey(),
      );
    }
    const outcomes = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        kind(world.session.confirmWeek(game.facilitator, game.gameId, 1, newKey(`race${i}`))),
      ),
    );
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'state')).toHaveLength(3);
    expect((await store.readSnapshot(game.gameId))?.game.currentWeek).toBe(2);
  });

  it('同じ識別子の同時の確定は、同じ結果を返し、一度だけ確定する', async () => {
    const game = await world.startedGame();
    for (const role of ROLES) {
      await world.session.submitDecision(
        game.players[role].principal,
        game.gameId,
        1,
        role,
        { quantity: 4 },
        newKey(),
      );
    }
    const key = newKey('same');
    const [a, b, c] = await Promise.all([
      world.session.confirmWeek(game.facilitator, game.gameId, 1, key),
      world.session.confirmWeek(game.facilitator, game.gameId, 1, key),
      world.session.confirmWeek(game.facilitator, game.gameId, 1, key),
    ]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect((await store.readSnapshot(game.gameId))?.game.version).toBeGreaterThan(0);
  });

  it('参加が同時に重なっても、参加順の番号が重ならない', async () => {
    const game = await world.createGame();
    const joined = await Promise.all(
      Array.from({ length: 8 }, (_, i) => world.joinOne(game.joinCode, `参加者${i}`)),
    );
    expect(joined.map((j) => j.joinOrder).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('順番待ちが上限を超えたら unavailable。別のゲームの書き込みと、読み取りは待たされない', async () => {
    const a = await world.startedGame();
    const b = await world.startedGame();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = store.transact(a.gameId, async () => {
      await hold;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = performance.now();
    await expect(
      kind(
        world.session.submitDecision(
          a.players.retailer.principal,
          a.gameId,
          1,
          'retailer',
          { quantity: 4 },
          newKey(),
        ),
      ),
    ).resolves.toBe('unavailable');
    expect(performance.now() - started).toBeLessThan(2000);
    // 別のゲームは待たされない
    await expect(
      world.session.submitDecision(
        b.players.retailer.principal,
        b.gameId,
        1,
        'retailer',
        { quantity: 4 },
        newKey(),
      ),
    ).resolves.toBeDefined();
    // 占有中でも、状態の取得（読み取り）は応答する
    await expect(
      world.session.getState(a.players.retailer.principal, a.gameId),
    ).resolves.toBeDefined();
    release();
    await holder;
    await expect(
      world.session.submitDecision(
        a.players.retailer.principal,
        a.gameId,
        1,
        'retailer',
        { quantity: 4 },
        newKey(),
      ),
    ).resolves.toBeDefined();
  });

  it('NFR3.3 / NFR4.3 50 週のゲームの最後の週の確定が 500 ミリ秒以内で、保存の大きさに上限がある', async () => {
    const game = await world.startedGame({ weekCount: 50 });
    for (let week = 1; week <= 49; week += 1) {
      await world.playWeek(game, week);
    }
    for (const role of ROLES) {
      await world.session.submitDecision(
        game.players[role].principal,
        game.gameId,
        50,
        role,
        { quantity: 4 },
        newKey(),
      );
    }
    const started = performance.now();
    const result = await world.session.confirmWeek(game.facilitator, game.gameId, 50, newKey());
    const elapsed = performance.now() - started;
    expect(result.status).toBe('ended');
    expect(elapsed).toBeLessThan(500);
    const counts = await pool.query(
      `select (select count(*) from week_records where game_id = $1)::int as records,
              (select count(*) from pipeline_slots where game_id = $1)::int as slots,
              (select count(*) from idempotency_records where game_id = $1)::int as idem`,
      [game.gameId],
    );
    expect(counts.rows[0]).toEqual({ records: 200, slots: 14, idem: 50 * 5 });
  }, 60_000);
});

describe('スキーマの制約（entities.md）', () => {
  it('(game, week, role) は一意。確定済みの記録は結果を欠けさせられない。範囲外の値は入らない', async () => {
    const game = await world.startedGame();
    await expect(
      pool.query(
        `insert into week_records (week_record_id, game_id, week, role) values (gen_random_uuid(), $1, 1, 'retailer')`,
        [game.gameId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      pool.query(
        `update week_records set is_confirmed = true where game_id = $1 and week = 1 and role = 'retailer'`,
        [game.gameId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query(
        `update week_records set decision = 10000 where game_id = $1 and role = 'retailer'`,
        [game.gameId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('1 人の参加者が持てる役割は 1 つ。週数・版・状態に範囲外の値は入らない', async () => {
    const game = await world.startedGame();
    await expect(
      pool.query(
        `insert into role_assignments (assignment_id, game_id, participant_id, role)
         select gen_random_uuid(), game_id, participant_id, 'factory' from role_assignments where game_id = $1 limit 1`,
        [game.gameId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      pool.query(`update games set week_count = 51 where game_id = $1`, [game.gameId]),
    ).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      pool.query(`update games set status = 'cancelled' where game_id = $1`, [game.gameId]),
    ).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('ゲームを削除すると、参加者・コード・token・冪等性の記録も同時に消える（U5 の削除の土台）', async () => {
    const game = await world.startedGame();
    await world.playWeek(game, 1);
    await pool.query('delete from games where game_id = $1', [game.gameId]);
    const counts = await pool.query(`
      select (select count(*) from participants)::int as participants,
             (select count(*) from access_codes)::int as codes,
             (select count(*) from return_tokens)::int as tokens,
             (select count(*) from idempotency_records)::int as idem,
             (select count(*) from week_records)::int as records,
             (select count(*) from pipeline_slots)::int as slots`);
    expect(counts.rows[0]).toEqual({
      participants: 0,
      codes: 0,
      tokens: 0,
      idem: 0,
      records: 0,
      slots: 0,
    });
  });

  it('冪等性の記録は (ゲーム, 操作, 呼び出した人, 識別子) で一意', async () => {
    const game = await world.startedGame();
    await world.session.submitDecision(
      game.players.retailer.principal,
      game.gameId,
      1,
      'retailer',
      { quantity: 5 },
      'dup-key-0000000001',
    );
    await expect(
      pool.query(
        `insert into idempotency_records (record_id, game_id, key, operation, requester_id, request_digest, response_body, created_at)
         select gen_random_uuid(), game_id, key, operation, requester_id, 'x', '{}'::jsonb, now() from idempotency_records limit 1`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
