import type pg from 'pg';
import type { RateLimiter } from '../../ports/index.js';

/**
 * 固定窓のレート制限。状態を DB の行に持ち、タスクの間で共有する（実効の上限がタスク数で増えない）。
 * 回数の加算は 1 文の UPSERT で、並行する要求でも数え漏れない。
 */
export class PgRateLimiter implements RateLimiter {
  constructor(
    private readonly pool: Pick<pg.Pool, 'query'>,
    private readonly options: { limit: number; windowMs: number },
  ) {}

  async hit(bucket: string, at: Date): Promise<boolean> {
    const { windowMs, limit } = this.options;
    const windowStart = new Date(
      Math.floor(at.getTime() / windowMs) * windowMs,
    );
    // 古い窓の行を消す（表の肥大を防ぐ）
    await this.pool.query('DELETE FROM rate_limits WHERE window_start < $1', [
      windowStart,
    ]);
    const { rows } = await this.pool.query(
      `INSERT INTO rate_limits (bucket, window_start, hits) VALUES ($1, $2, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET hits = rate_limits.hits + 1
       RETURNING hits`,
      [bucket, windowStart],
    );
    return (rows[0].hits as number) <= limit;
  }
}
