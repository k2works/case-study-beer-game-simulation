import type pg from 'pg';
import type { Role } from '../../domain/role.js';
import type { ReviewReader, ReviewSource } from '../../ports/index.js';

/** 振り返りの読み取り専用の経路。ロックを取らず、役割別の週結果の表から SQL で直接読む */
export class PgReviewReader implements ReviewReader {
  constructor(private readonly pool: pg.Pool) {}

  async read(gameId: string): Promise<ReviewSource> {
    const session = await this.pool.query(
      'SELECT session_id, status FROM sessions WHERE game_id = $1',
      [gameId],
    );
    const row = session.rows[0];
    if (!row) return { sessionStatus: null, rows: [] };
    const { rows } = await this.pool.query(
      `SELECT week, role, demand, received, shipped, ordered, ending_inventory,
              ending_backlog, weekly_cost_minor, cumulative_cost_minor
         FROM week_role_results
        WHERE session_id = $1
        ORDER BY week, role`,
      [row.session_id],
    );
    return {
      sessionStatus: row.status,
      rows: rows.map((r) => ({
        week: r.week,
        role: r.role as Role,
        demand: r.demand,
        received: r.received,
        shipped: r.shipped,
        order: r.ordered,
        endingInventory: r.ending_inventory,
        endingBacklog: r.ending_backlog,
        weeklyCostMinor: r.weekly_cost_minor,
        cumulativeCostMinor: r.cumulative_cost_minor,
      })),
    };
  }
}
