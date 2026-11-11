import type pg from 'pg';
import {
  EXPORT_HISTORY_TYPES,
  EXPORT_INPUT_TYPES,
} from '../../domain/export.js';
import type { GameSettings } from '../../domain/game.js';
import type { Role } from '../../domain/role.js';
import type { ExportReader, ReviewReader } from '../../ports/index.js';

/**
 * 出力の元データの読み取り専用の経路。ロックを取らず、セッションの設定の写し・週結果・イベントを SQL で読む。
 * 役割別の週結果は、振り返りの読み取り（`ReviewReader`）と同じ問い合わせを使う。
 */
export class PgExportReader implements ExportReader {
  constructor(
    private readonly pool: pg.Pool,
    private readonly reviews: ReviewReader,
  ) {}

  async read(gameId: string) {
    const session = (
      await this.pool.query(
        'SELECT session_id, status, settings FROM sessions WHERE game_id = $1',
        [gameId],
      )
    ).rows[0];
    if (!session) return { sessionStatus: null, source: null };
    const s = session.settings as GameSettings;
    const weeks = (
      await this.pool.query(
        'SELECT week, commit_kind FROM week_results WHERE session_id = $1 ORDER BY week',
        [session.session_id],
      )
    ).rows.map((r) => ({
      week: r.week as number,
      commitKind: r.commit_kind as 'MANUAL' | 'AUTO',
    }));
    const { rows } = await this.reviews.read(gameId);
    const events = (
      await this.pool.query(
        `SELECT event_type, payload, occurred_at FROM events
          WHERE game_id = $1 AND event_type = ANY($2) ORDER BY seq`,
        [gameId, [...EXPORT_HISTORY_TYPES, ...Object.keys(EXPORT_INPUT_TYPES)]],
      )
    ).rows;
    return {
      sessionStatus: session.status,
      source: {
        gameId,
        finalWeek: s.finalWeek,
        commitMode: s.commitMode,
        settings: {
          kind: s.kind,
          changes: s.changes,
          initialInventory: s.initialInventory,
          orderDelayWeeks: s.orderDelayWeeks,
          shipmentDelayWeeks: s.shipmentDelayWeeks,
          productionDelayWeeks: s.productionDelayWeeks,
          holdingCostMinor: s.holdingCostMinor,
          backlogCostMinor: s.backlogCostMinor,
          disclosure: s.disclosure,
        },
        demand: s.demand,
        weeks,
        rows,
        inputs: events.flatMap((e) =>
          e.event_type in EXPORT_INPUT_TYPES
            ? [
                {
                  week: (e.payload.week as number | undefined) ?? null,
                  role: e.payload.role as Role,
                  quantity: e.payload.quantity as number,
                  by: EXPORT_INPUT_TYPES[
                    e.event_type as keyof typeof EXPORT_INPUT_TYPES
                  ],
                  at: (e.occurred_at as Date).toISOString(),
                },
              ]
            : [],
        ),
        history: events
          .filter((e) => EXPORT_HISTORY_TYPES.includes(e.event_type))
          .map((e) => ({
            type: e.event_type as string,
            at: (e.occurred_at as Date).toISOString(),
          })),
      },
    };
  }
}
