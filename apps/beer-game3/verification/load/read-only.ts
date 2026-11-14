import pg from 'pg';

/**
 * 読み取り専用のセッション（reliability-design.md）。接続のオプションで `default_transaction_read_only=on` にし、
 * 検査は `BEGIN READ ONLY` の中で行う。書き込みを試みると PostgreSQL のエラー 25006 で失敗する。
 */
export interface ReadOnlySession {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<T>>;
  /** 一貫した見え方（REPEATABLE READ）の読み取り専用のトランザクションの中で実行する。 */
  readTransaction<T>(fn: (session: ReadOnlySession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openReadOnlySession(connectionString: string): Promise<ReadOnlySession> {
  const client = new pg.Client({
    connectionString,
    options: '-c default_transaction_read_only=on',
  });
  await client.connect();
  const session: ReadOnlySession = {
    query: (text, values) => client.query(text, values),
    async readTransaction(fn) {
      await client.query('begin read only isolation level repeatable read');
      try {
        return await fn(session);
      } finally {
        await client.query('rollback');
      }
    },
    close: () => client.end(),
  };
  return session;
}
