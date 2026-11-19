import pg from 'pg';

/** 結合の試験の管理用の接続（検証コマンドと同じ DATABASE_URL）。無いときは、飛ばさずに失敗させる。 */
export function adminUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL が設定されていません。結合の試験には PostgreSQL 18 の管理用の接続が必要です（unit-test-instructions.md を参照）',
    );
  }
  return url;
}

export async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function databaseExists(name: string): Promise<boolean> {
  return withAdmin(async (client) => {
    const result = await client.query('select 1 from pg_database where datname = $1', [name]);
    return result.rowCount === 1;
  });
}

export async function listVerifyDatabases(): Promise<string[]> {
  return withAdmin(async (client) => {
    const result = await client.query<{ datname: string }>(
      "select datname from pg_database where datname like 'bg3\\_verify\\_%' order by datname",
    );
    return result.rows.map((row) => row.datname);
  });
}

/** 指定のプロセスが生きているか。 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
