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
    try {
      const rows = await client.query(
        'SELECT * FROM outbox_events WHERE published_at IS NULL ORDER BY occurred_at, aggregate_version LIMIT $1 FOR UPDATE SKIP LOCKED',
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
            'UPDATE outbox_events SET attempts = attempts + 1 WHERE event_id = $1',
            [row.event_id],
          );
          throw error;
        }
      }
      return published;
    } finally {
      client.release();
    }
  }
}
