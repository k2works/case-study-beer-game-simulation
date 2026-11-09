import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export interface LearningActor {
  id: string;
  gameId: string;
  kind: 'FACILITATOR' | 'OBSERVER' | 'PARTICIPANT';
}

const eventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.string().min(1),
  gameId: z.string().min(1),
  sessionId: z.string().min(1),
  aggregateVersion: z.number().int().positive(),
  schemaVersion: z.number().int(),
  occurredAt: z.string(),
  correlationId: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type GameChanged = z.infer<typeof eventSchema> & { schemaVersion: 1 };

interface WeekRow {
  week: number;
  inventory: number;
  backlog: number;
  orders: number;
  demand: number;
  shipments: number;
  costMinor: number;
}
interface Projection {
  sessionId: string;
  sourceVersion: number;
  status: 'ACTIVE' | 'ENDED';
  stale: boolean;
  currentWeek: number;
  completionStatus: Record<string, boolean>;
  safeTeamTotals?: { inventory: number; backlog: number; orders: number };
  suppressionReasons: string[];
  rows: WeekRow[];
}
export interface ExportPackage {
  exportId: string;
  gameId: string;
  status: 'COMPLETE';
  schemaVersion: '1.0.0';
  sourceVersion: number;
  csv: string;
  json: string;
  checksum: string;
}

const numericTotals = (value: unknown) =>
  z
    .object({
      inventory: z.number(),
      backlog: z.number(),
      orders: z.number(),
      demand: z.number().default(0),
      shipments: z.number().default(0),
      costMinor: z.number().default(0),
    })
    .safeParse(value);

export class LearningViewService {
  private readonly projections = new Map<string, Projection>();
  private readonly processed = new Set<string>();
  private readonly exports = new Map<string, ExportPackage>();

  cursor(gameId: string) {
    return this.projections.get(gameId)?.sourceVersion ?? 0;
  }

  consume(input: GameChanged): { status: 'APPLIED' | 'DUPLICATE' | 'GAP'; sourceVersion: number } {
    const event = eventSchema.parse(input);
    if (event.schemaVersion !== 1) throw new Error('UNSUPPORTED_SCHEMA');
    const current = this.projections.get(event.gameId);
    const sourceVersion = current?.sourceVersion ?? 0;
    if (this.processed.has(event.eventId)) return { status: 'DUPLICATE', sourceVersion };
    if (event.aggregateVersion !== sourceVersion + 1) {
      if (current) current.stale = true;
      return { status: 'GAP', sourceVersion };
    }
    const totals = numericTotals(event.data.teamTotals);
    const contributorCount = Number(event.data.contributorCount ?? 0);
    const mayDisclose = contributorCount >= 2 && totals.success;
    const row = totals.success
      ? { week: Number(event.data.week ?? event.aggregateVersion), ...totals.data }
      : undefined;
    const projection: Projection = {
      sessionId: event.sessionId,
      sourceVersion: event.aggregateVersion,
      status: event.eventType === 'SessionEnded' ? 'ENDED' : (current?.status ?? 'ACTIVE'),
      stale: false,
      currentWeek: Number(event.data.week ?? current?.currentWeek ?? 1),
      completionStatus: z
        .record(z.string(), z.boolean())
        .catch({})
        .parse(event.data.completionStatus),
      safeTeamTotals: mayDisclose ? totals.data : undefined,
      suppressionReasons: mayDisclose ? [] : ['INSUFFICIENT_CONTRIBUTORS'],
      rows: [...(current?.rows ?? []), ...(row ? [row] : [])],
    };
    this.projections.set(event.gameId, projection);
    this.processed.add(event.eventId);
    return { status: 'APPLIED', sourceVersion: projection.sourceVersion };
  }

  getObservation(actor: LearningActor) {
    const projection = this.authorizedProjection(actor);
    return {
      sessionId: projection.sessionId,
      sourceVersion: projection.sourceVersion,
      currentWeek: projection.currentWeek,
      completionStatus: projection.completionStatus,
      safeTeamTotals: projection.safeTeamTotals,
      suppressionReasons: projection.suppressionReasons,
      stale: projection.stale,
    };
  }

  getReview(actor: LearningActor) {
    const projection = this.authorizedProjection(actor);
    if (projection.status !== 'ENDED') throw new Error('GAME_NOT_ENDED');
    if (!projection.rows.length) throw new Error('NO_DATA');
    return {
      status: 'READY' as const,
      sourceVersion: projection.sourceVersion,
      weeklySeries: projection.rows,
    };
  }

  createExport(actor: LearningActor, idempotencyKey: string): ExportPackage {
    if (actor.kind !== 'FACILITATOR') throw new Error('FORBIDDEN');
    if (!idempotencyKey) throw new Error('IDEMPOTENCY_REQUIRED');
    const key = `${actor.gameId}:${idempotencyKey}`;
    const existing = this.exports.get(key);
    if (existing) return existing;
    const review = this.getReview(actor);
    const canonical = {
      schemaVersion: '1.0.0',
      sourceVersion: review.sourceVersion,
      weeklySeries: review.weeklySeries,
    };
    const csv = [
      'week,inventory,backlog,orders,demand,shipments,costMinor',
      ...review.weeklySeries.map(
        (r) =>
          `${r.week},${r.inventory},${r.backlog},${r.orders},${r.demand},${r.shipments},${r.costMinor}`,
      ),
    ].join('\n');
    const value: ExportPackage = {
      exportId: randomUUID(),
      gameId: actor.gameId,
      status: 'COMPLETE',
      schemaVersion: '1.0.0',
      sourceVersion: review.sourceVersion,
      csv,
      json: JSON.stringify(canonical),
      checksum: createHash('sha256')
        .update(`${csv}\n${JSON.stringify(canonical)}`)
        .digest('hex'),
    };
    this.exports.set(key, value);
    return value;
  }

  getExport(actor: LearningActor, exportId: string) {
    if (actor.kind !== 'FACILITATOR') throw new Error('FORBIDDEN');
    const value = [...this.exports.values()].find((item) => item.exportId === exportId);
    if (!value) throw new Error('NOT_FOUND');
    if (value.gameId !== actor.gameId) throw new Error('FORBIDDEN');
    return value;
  }

  private authorizedProjection(actor: LearningActor) {
    const projection = this.projections.get(actor.gameId);
    if (!projection) throw new Error('NOT_FOUND');
    return projection;
  }
}
