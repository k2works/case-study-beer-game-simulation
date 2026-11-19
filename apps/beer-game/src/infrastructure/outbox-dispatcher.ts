import type { Pool } from 'pg';

export interface EventTransport {
  publish(event: unknown): Promise<void>;
}
export class OutboxDispatcher {
  constructor(
    private readonly pool: Pool,
    private readonly transport: EventTransport,
  ) {}
  async dispatchBatch(limit = 100): Promise<number> {
    const client = await this.pool.connect();
    let published = 0;
    let committed = false;
    try {
      await client.query('BEGIN');
      const rows = await client.query(
        'SELECT * FROM outbox_events WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now()) ORDER BY occurred_at, aggregate_version LIMIT $1 FOR UPDATE SKIP LOCKED',
        [limit],
      );
      for (const row of rows.rows) {
        try {
          await this.transport.publish(row);
          await client.query(
            'UPDATE outbox_events SET published_at = now(), attempts = attempts + 1 WHERE event_id = $1',
            [row.event_id],
          );
          await client.query("SELECT pg_notify('beer_game_events', $1)", [
            JSON.stringify({ aggregateId: row.aggregate_id, version: row.aggregate_version }),
          ]);
          published += 1;
        } catch (error) {
          await client.query(
            "UPDATE outbox_events SET attempts = attempts + 1, next_attempt_at = now() + ($2::integer * interval '1 second') WHERE event_id = $1",
            [row.event_id, Math.min(60, 2 ** Math.min(6, Number(row.attempts) + 1))],
          );
          await client.query('COMMIT');
          committed = true;
          throw error;
        }
      }
      await client.query('COMMIT');
      committed = true;
      return published;
    } catch (error) {
      if (!committed) await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
