import { z } from 'zod';
import { ROLES, type Role } from '../domain/types.js';

/**
 * 操作の履歴（OperationLogEntry、US5.6）。追記だけで、変更も削除もしない（BR13.2）。
 * detail は kind ごとの厳密な型で検証してから保存する。自由な文章の項目と資格情報は持てない（BR13.6、NFR7.1）。
 */

export const LOG_KINDS = [
  'setting',
  'roleChange',
  'proxyInput',
  'weekConfirm',
  'pause',
  'resume',
  'end',
] as const;
export type LogKind = (typeof LOG_KINDS)[number];

export type ActorKind = 'facilitator' | 'system';

const role = z.enum(ROLES);
const count = z.int().min(0);
const week = z.int().min(1).max(50);
const id = z.string().min(1);

const detailSchemas = {
  setting: z.strictObject({
    weekCount: count,
    initialInventory: count,
    initialPipelineQuantity: count,
    inventoryUnitCost: count,
    backlogUnitCost: count,
    setupKind: z.enum(['kit', 'custom']),
    demandSeriesLength: count,
    demandSeriesIsProvisional: z.boolean(),
  }),
  roleChange: z.strictObject({
    change: z.enum(['assign', 'reassign', 'unassign', 'replace']),
    participantId: id,
    participantLabel: z.string().min(1),
    fromRole: role.optional(),
    toRole: role.nullable(),
    replacedParticipantId: id.optional(),
    replacedParticipantLabel: z.string().min(1).optional(),
    gameStatus: z.enum(['preparing', 'running', 'paused', 'ended']),
  }),
  proxyInput: z.strictObject({ value: count }),
  weekConfirm: z.strictObject({ week }),
  pause: z.strictObject({ week }),
  resume: z.strictObject({ week }),
  end: z.strictObject({ reason: z.enum(['facilitator', 'finalWeek', 'autoEnd']), week }),
} as const satisfies Record<LogKind, z.ZodType>;

export type LogDetail<K extends LogKind = LogKind> = {
  [P in LogKind]: z.infer<(typeof detailSchemas)[P]>;
}[K];

/** 追記する 1 件。sequence と gameId は、保存がゲームの行を占有した中で決める。 */
export interface NewLogEntry {
  entryId: string;
  kind: LogKind;
  actorKind: ActorKind;
  occurredAt: Date;
  week: number | null;
  role: Role | null;
  detail: LogDetail;
}

export interface LogEntryRow extends NewLogEntry {
  gameId: string;
  sequence: number;
}

/** 画面と API が返す 1 件。kind ごとに detail の型が決まる。 */
export type HistoryEntryView = {
  [K in LogKind]: {
    sequence: number;
    kind: K;
    actorKind: ActorKind;
    /** ISO 8601（UTC） */
    occurredAt: string;
    week: number | null;
    role: Role | null;
    detail: LogDetail<K>;
  };
}[LogKind];

export interface HistoryView {
  entries: HistoryEntryView[];
}

/** 履歴の 1 件を作る。detail が型に合わない（未知の項目を含む）ときは例外にして、保存しない。 */
export function buildLogEntry<K extends LogKind>(input: {
  entryId: string;
  kind: K;
  actorKind: ActorKind;
  occurredAt: Date;
  week?: number | null;
  role?: Role | null;
  detail: LogDetail<K>;
}): NewLogEntry {
  const detail = detailSchemas[input.kind].parse(input.detail) as LogDetail;
  return {
    entryId: input.entryId,
    kind: input.kind,
    actorKind: input.actorKind,
    occurredAt: input.occurredAt,
    week: input.week ?? null,
    role: input.role ?? null,
    detail,
  };
}

export function toHistoryView(rows: LogEntryRow[]): HistoryView {
  return {
    entries: [...rows]
      .sort((a, b) => a.sequence - b.sequence)
      .map(
        (row) =>
          ({
            sequence: row.sequence,
            kind: row.kind,
            actorKind: row.actorKind,
            occurredAt: row.occurredAt.toISOString(),
            week: row.week,
            role: row.role,
            detail: row.detail,
          }) as HistoryEntryView,
      ),
  };
}

/** 参加者のラベル「表示名 #参加順」（BR12.4）。保存せず、表示名と参加順から作る。 */
export function participantLabel(p: { displayName: string; joinOrder: number }): string {
  return `${p.displayName} #${p.joinOrder}`;
}
