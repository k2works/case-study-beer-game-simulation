import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDisposableDatabase,
  newRunId,
  startApp,
  sweepStaleDatabases,
  withLifecycle,
} from '../../../verification/load/lifecycle.js';
import { adminUrl, databaseExists, isAlive, listVerifyDatabases } from '../support/pg.js';

// 機能: 試験が環境を汚さない（NFR2.2）。使い捨てのデータベースとアプリケーションの起動と破棄

describe('シナリオ: 使い捨てのデータベース', () => {
  it('Given 管理用の接続 When 作って破棄する Then bg3_verify_ の名前で作られ、破棄後は存在しない', async () => {
    const db = await createDisposableDatabase(adminUrl(), newRunId());
    expect(db.name).toMatch(/^bg3_verify_\d+_[0-9a-f]+$/);
    expect(await databaseExists(db.name)).toBe(true);
    await db.drop();
    expect(await databaseExists(db.name)).toBe(false);
  });

  it('Given 1 時間より古い bg3_verify_ と新しいもの When 掃除する Then 古いものだけを消し、ほかのデータベースに触れない', async () => {
    const now = Date.now();
    const oldName = `bg3_verify_${Math.floor((now - 2 * 3600_000) / 1000)}_aaaa0001`;
    const freshName = `bg3_verify_${Math.floor((now - 60_000) / 1000)}_bbbb0002`;
    const other = `bg3_keep_${Math.floor((now - 5 * 3600_000) / 1000)}_cccc0003`;
    const admin = new pg.Client({ connectionString: adminUrl() });
    await admin.connect();
    try {
      for (const name of [oldName, freshName, other]) {
        await admin.query(`create database ${name}`);
      }
      const removed = await sweepStaleDatabases(adminUrl(), now);
      expect(removed).toContain(oldName);
      expect(removed).not.toContain(freshName);
      expect(await databaseExists(oldName)).toBe(false);
      expect(await databaseExists(freshName)).toBe(true);
      expect(await databaseExists(other)).toBe(true);
    } finally {
      await admin.query(`drop database if exists ${freshName} with (force)`);
      await admin.query(`drop database if exists ${other} with (force)`);
      await admin.query(`drop database if exists ${oldName} with (force)`);
      await admin.end();
    }
  });
});

describe('シナリオ: アプリケーションの起動と停止', () => {
  let before: string[] = [];
  beforeAll(async () => {
    before = await listVerifyDatabases();
  });
  afterAll(async () => {
    expect(await listVerifyDatabases()).toEqual(before);
  });

  it('Given 使い捨てのデータベース When アプリケーションを起動する Then 空きポートで /health が通り、停止後はプロセスがない', async () => {
    let pid = 0;
    await withLifecycle(adminUrl(), async (env) => {
      const app = await startApp({ databaseUrl: env.databaseUrl });
      pid = app.pid;
      expect(app.port).not.toBe(3000);
      expect(app.port).not.toBe(5173);
      const response = await fetch(`${app.baseUrl}/health`);
      expect(response.status).toBe(200);
      await app.stop();
      expect(isAlive(pid)).toBe(false);
    });
  }, 60_000);

  it('Given 試験の途中の例外 When 破棄する Then プロセスもデータベースも残らない', async () => {
    let pid = 0;
    let name = '';
    await expect(
      withLifecycle(adminUrl(), async (env) => {
        name = env.databaseName;
        const app = await startApp({ databaseUrl: env.databaseUrl });
        pid = app.pid;
        env.registerCleanup(() => app.stop());
        throw new Error('失敗の注入');
      }),
    ).rejects.toThrow('失敗の注入');
    expect(isAlive(pid)).toBe(false);
    expect(await databaseExists(name)).toBe(false);
  }, 60_000);

  it('Given アプリケーションの起動の失敗 When 起動する Then 上限つきの待ちで失敗し、データベースが残らない', async () => {
    let name = '';
    await expect(
      withLifecycle(adminUrl(), async (env) => {
        name = env.databaseName;
        await startApp({
          databaseUrl: env.databaseUrl,
          envOverrides: { PORT: 'not-a-number' },
          startTimeoutMs: 20_000,
        });
      }),
    ).rejects.toThrow(/起動/);
    expect(await databaseExists(name)).toBe(false);
  }, 60_000);

  it('Given 子プロセスの環境 When 起動する Then 親の PG* と DATABASE_URL を継承しない（実行時の確認）', async () => {
    process.env.PGHOST = 'db.prod.example.com';
    try {
      await withLifecycle(adminUrl(), async (env) => {
        const app = await startApp({ databaseUrl: env.databaseUrl });
        try {
          expect((await fetch(`${app.baseUrl}/health`)).status).toBe(200);
        } finally {
          await app.stop();
        }
      });
    } finally {
      delete process.env.PGHOST;
    }
  }, 60_000);
});
