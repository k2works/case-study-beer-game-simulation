import type pg from 'pg';
import type { Repositories, UnitOfWork } from '../../ports/index.js';
import { repositoriesOver } from './pg-repositories.js';

export interface PgOptions {
  /** 冪等記録の応答を暗号化する鍵（32 バイト） */
  idempotencyKey: Buffer;
}

/** 1 回の操作を 1 つのトランザクションで行う。失敗したら、何も残さない
 *
 * @guidedTour walking-skeleton 80 トランザクションの境界。1 回の操作の保存（集約、役割別の週結果、イベント、冪等記録）は、すべて成功するか、何も残らない。版つきの更新で、同時の更新も検出する。保存のたびに `pg_notify` され（`PgNotifier`。受信が生きているかは `/api/v1/ready` の `notifier` で確かめる）、画面は応答の `versions` に追いつくまで状態を取得し直して更新される。動く様子は、共有の画面の受け入れ（`apps/beer-game-web` の `@ui`。TS 版のバックエンドで CI が実行する）で確認できる。
 */
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
