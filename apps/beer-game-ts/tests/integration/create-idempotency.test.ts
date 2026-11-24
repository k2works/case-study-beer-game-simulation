import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApplication,
  type Application,
} from '../../src/application/index.js';
import { IdempotencyKeyReusedError } from '../../src/application/errors.js';
import { PgExportReader } from '../../src/adapters/persistence/pg-export-reader.js';
import { PgReviewReader } from '../../src/adapters/persistence/pg-review-reader.js';
import { PgUnitOfWork } from '../../src/adapters/persistence/pg-unit-of-work.js';
import { prepareTestDatabase, resetData } from '../support/db.js';
import { randomUUID } from 'node:crypto';

// createGame の冪等を、実 PostgreSQL で確かめる（部分一意索引、同時の重複、期限切れ、暗号化）
const KEY = Buffer.alloc(32, 7);
let pool: pg.Pool;
let app: Application;

beforeAll(async () => {
  pool = await prepareTestDatabase();
  const uow = new PgUnitOfWork(pool, { idempotencyKey: KEY });
  let seq = 0;
  let tokens = 0;
  app = createApplication({
    uow,
    clock: { now: () => new Date() },
    // 並行する要求でも、ID・参加コード・資格が重ならないようにする
    ids: {
      uuid: () => randomUUID(),
      joinCode: () => `J-${++seq}-${randomUUID().slice(0, 6)}`,
    },
    credentials: {
      issue: () => {
        const token = `token-${++tokens}-${randomUUID()}`;
        return { token, digest: `digest(${token})` };
      },
      digestsOf: (token) => [`digest(${token})`],
    },
    reviews: new PgReviewReader(pool),
    exports: new PgExportReader(pool, new PgReviewReader(pool)),
  });
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetData(pool);
});

const count = async (table: string) =>
  Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

describe('createGame の冪等（実 PostgreSQL）', () => {
  it('同じキーの再送は、同じゲーム・同じ資格を返し、ゲームも冪等記録も増やさない', async () => {
    const a = await app.createGame({ weeks: 2, idempotencyKey: 'key-1' });
    const b = await app.createGame({ weeks: 2, idempotencyKey: 'key-1' });
    expect(b).toEqual(a);
    expect(await count('games')).toBe(1);
    expect(await count('idempotency_records')).toBe(1);
  });

  it('保存した応答は暗号化され、キーはダイジェストだけを持つ（復帰コードを平文で残さない）', async () => {
    const a = await app.createGame({ weeks: 2, idempotencyKey: 'key-secret' });
    const { rows } = await pool.query(
      "SELECT key_digest, response FROM idempotency_records WHERE scope = 'create'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].key_digest).not.toContain('key-secret');
    const raw = rows[0].response.toString('utf8');
    expect(raw).not.toContain(a.recoveryCode);
    expect(raw).not.toContain(a.facilitatorToken);
  });

  it('同じキーで内容が違えば、IdempotencyKeyReusedError。ゲームは増えない', async () => {
    await app.createGame({ weeks: 2, idempotencyKey: 'key-1' });
    await expect(
      app.createGame({ weeks: 3, idempotencyKey: 'key-1' }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    expect(await count('games')).toBe(1);
  });

  it('同じキーの同時の要求は、すべて同じゲームを返し、ゲームは 1 つだけ作られる', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.createGame({ weeks: 2, idempotencyKey: 'key-race' }),
      ),
    );
    expect(new Set(results.map((r) => r.gameId)).size).toBe(1);
    expect(new Set(results.map((r) => r.facilitatorToken)).size).toBe(1);
    expect(await count('games')).toBe(1);
    expect(await count('idempotency_records')).toBe(1);
  });

  it('期限切れの記録は、同じキーの新しい作成を妨げない（新しいゲームになる）', async () => {
    const first = await app.createGame({ weeks: 2, idempotencyKey: 'key-old' });
    await pool.query(
      "UPDATE idempotency_records SET expires_at = now() - interval '1 second' WHERE scope = 'create'",
    );
    const second = await app.createGame({
      weeks: 2,
      idempotencyKey: 'key-old',
    });
    expect(second.gameId).not.toBe(first.gameId);
    expect(await count('games')).toBe(2);
    // 期限切れの記録は、新しい作成の記録に置き換わる（記録は、いつも 1 つ）
    const { rows } = await pool.query(
      "SELECT game_id FROM idempotency_records WHERE scope = 'create'",
    );
    expect(rows.map((r) => r.game_id)).toEqual([second.gameId]);
  });

  it('作成した資格は、再送で受け取った値でも使える', async () => {
    await app.createGame({ weeks: 2, idempotencyKey: 'key-1' });
    const again = await app.createGame({ weeks: 2, idempotencyKey: 'key-1' });
    const lobby = await app.getLobby({
      token: again.facilitatorToken,
      gameId: again.gameId,
    });
    expect(lobby.gameId).toBe(again.gameId);
  });

  it('ゲームを削除すると、その作成の冪等記録も連鎖して消える（保持期間の削除に、記録を残さない）', async () => {
    const a = await app.createGame({ weeks: 2, idempotencyKey: 'key-1' });
    await pool.query('DELETE FROM games WHERE game_id = $1', [a.gameId]);
    expect(await count('idempotency_records')).toBe(0);
  });

  it('部分一意索引は、作成の範囲だけにかかる', async () => {
    const { rows } = await pool.query(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_idempotency_create'",
    );
    expect(rows[0].indexdef).toContain("WHERE (scope = 'create'::text)");
  });
});
