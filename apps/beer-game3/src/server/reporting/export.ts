import { ROLES, type EndReason, type Role, type SetupKind } from '../domain/types.js';
import type { Snapshot, WeekRecordRow } from '../session/store.js';
import { confirmedWeeksOf } from './results.js';

/**
 * 出力の 1 行（1 週・1 役割）。CSV の 1 行と、JSON の records の 1 要素に共通の中間表現（ExportRecord）。
 * 項目の並びが CSV の列の順序で、JSON の項目名は CSV の列名と同じ。金額は整数のセント（BR23.5）。
 */
export interface ExportRecord {
  gameId: string;
  setupKind: SetupKind;
  week: number;
  role: Role;
  customerDemand: number;
  receipt: number;
  ordersReceived: number;
  shipped: number;
  inventory: number;
  backlog: number;
  /** 発注（工場では生産要請） */
  decision: number;
  weeklyCostCents: number;
  cumulativeCostCents: number;
  /** その週の decision を最後に保存した主体。移行前の記録は null */
  decidedByKind: 'participant' | 'facilitator' | null;
  /** decidedByKind が participant のときだけ、その参加者の表示名（入れ替え済みの参加者も含む）。値は元のまま */
  decidedByDisplayName: string | null;
}

/** JSON の game。ゲーム設定の写し。日時は ISO 8601 の UTC。 */
export interface ExportGame {
  gameId: string;
  name: string;
  setupKind: SetupKind;
  status: 'ended';
  endReason: EndReason;
  weekCount: number;
  confirmedWeeks: number;
  createdAt: string;
  endedAt: string;
  initialInventory: number;
  initialPipelineQuantity: number;
  inventoryUnitCostCents: number;
  backlogUnitCostCents: number;
  /** weekCount 週分の顧客需要の系列（設定そのもの） */
  demandSeries: number[];
}

export interface ExportDocument {
  game: ExportGame;
  records: ExportRecord[];
}

/** 週の昇順、同じ週では factory、wholesaler1、wholesaler2、retailer の順に 1 週・1 役割を 1 行にする。 */
export function buildExportRecords(snapshot: Snapshot): ExportRecord[] {
  const names = new Map(snapshot.participants.map((p) => [p.participantId, p.displayName]));
  const byKey = new Map<string, WeekRecordRow>(
    snapshot.weekRecords
      .filter((record) => record.isConfirmed)
      .map((record) => [`${record.week}:${record.role}`, record]),
  );
  const records: ExportRecord[] = [];
  const weeks = confirmedWeeksOf(snapshot);
  for (let week = 1; week <= weeks; week += 1) {
    for (const role of ROLES) {
      const record = byKey.get(`${week}:${role}`);
      if (!record) {
        continue;
      }
      const kind = record.decidedByKind;
      records.push({
        gameId: snapshot.game.gameId,
        setupKind: snapshot.game.setupKind,
        week,
        role,
        customerDemand: snapshot.settings.demandSeries[week - 1] ?? 0,
        receipt: record.receipt ?? 0,
        ordersReceived: record.ordersReceived ?? 0,
        shipped: record.shipped ?? 0,
        inventory: record.inventory ?? 0,
        backlog: record.backlog ?? 0,
        decision: record.decision ?? 0,
        weeklyCostCents: record.weeklyCost ?? 0,
        cumulativeCostCents: record.cumulativeCost ?? 0,
        decidedByKind: kind,
        decidedByDisplayName:
          kind === 'participant' && record.decidedByParticipantId !== null
            ? (names.get(record.decidedByParticipantId) ?? null)
            : null,
      });
    }
  }
  return records;
}

/** 終了したゲームの出力全体（ExportDocument）。終了していないゲームには作らない。 */
export function buildExportDocument(snapshot: Snapshot): ExportDocument {
  const { game, settings } = snapshot;
  if (game.status !== 'ended' || game.endedAt === null || game.endReason === null) {
    throw new Error('終了していないゲームは出力できません');
  }
  return {
    game: {
      gameId: game.gameId,
      name: game.name,
      setupKind: game.setupKind,
      status: 'ended',
      endReason: game.endReason,
      weekCount: game.weekCount,
      confirmedWeeks: confirmedWeeksOf(snapshot),
      createdAt: game.createdAt.toISOString(),
      endedAt: game.endedAt.toISOString(),
      initialInventory: settings.initialInventory,
      initialPipelineQuantity: settings.initialPipelineQuantity,
      inventoryUnitCostCents: settings.inventoryUnitCost,
      backlogUnitCostCents: settings.backlogUnitCost,
      demandSeries: [...settings.demandSeries],
    },
    records: buildExportRecords(snapshot),
  };
}
