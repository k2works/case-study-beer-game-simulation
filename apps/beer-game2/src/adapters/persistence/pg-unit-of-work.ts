import type pg from 'pg';
import type { Repositories, UnitOfWork } from '../../ports/index.js';
import { repositoriesOver } from './pg-repositories.js';

export interface PgOptions {
  /** 冪等記録の応答を暗号化する鍵（32 バイト） */
  idempotencyKey: Buffer;
}

/** 1 回の操作を 1 つのトランザクションで行う。失敗したら、何も残さない */
export class PgUnitOfWork implements UnitOfWork {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: PgOptions,
  ) {}

  async run<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(
        repositoriesOver(client, this.options.idempotencyKey),
      );
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
