import { ROLES, type Role, type SetupKind } from '../domain/types.js';
import type { Snapshot, WeekRecordRow } from '../session/store.js';

/** 1 役割・1 週の確定済みの記録。金額は整数の最小単位（セント）。 */
export interface ResultWeek {
  week: number;
  receipt: number;
  ordersReceived: number;
  shipped: number;
  inventory: number;
  backlog: number;
  /** 発注（工場では生産要請） */
  decision: number;
  weeklyCost: number;
  cumulativeCost: number;
}

export interface ResultRole {
  role: Role;
  weeks: ResultWeek[];
}

/**
 * 終了したゲームの全役割の時系列（ResultsView、entities.md）。保存しない投影で、GET /games/{gameId}/results の応答の形。
 * 許可リスト方式の専用の型で、参加者の表示名、コード、token、ハッシュ、冪等の識別子の項目を持たない（BR21.4、NFR6.2）。
 */
export interface ResultsView {
  gameId: string;
  setupKind: SetupKind;
  weekCount: number;
  confirmedWeeks: number;
  /** 第 1 週から confirmedWeeks までの顧客需要 */
  customerDemand: number[];
  /** 4 役割を factory、wholesaler1、wholesaler2、retailer の順に */
  roles: ResultRole[];
  /** 4 役割の最終の累積費用の合計（セント）。確定済みの週がなければ 0 */
  teamCumulativeCost: number;
}

/** 確定済みの記録だけを、週の昇順で（確定前の入力は含めない、BR21.3）。 */
export function confirmedRecords(snapshot: Snapshot, role: Role): WeekRecordRow[] {
  return snapshot.weekRecords
    .filter((record) => record.role === role && record.isConfirmed)
    .sort((a, b) => a.week - b.week);
}

/** 確定済みの週の数（確定は 4 役割まとめて行うため、最後の確定済みの週と同じ）。 */
export function confirmedWeeksOf(snapshot: Snapshot): number {
  return snapshot.weekRecords.reduce(
    (max, record) => (record.isConfirmed ? Math.max(max, record.week) : max),
    0,
  );
}

/** 項目を 1 つずつ明示して写す（スナップショットの行をそのまま展開しない、NFR6.2）。 */
function toResultWeek(record: WeekRecordRow): ResultWeek {
  return {
    week: record.week,
    receipt: record.receipt ?? 0,
    ordersReceived: record.ordersReceived ?? 0,
    shipped: record.shipped ?? 0,
    inventory: record.inventory ?? 0,
    backlog: record.backlog ?? 0,
    decision: record.decision ?? 0,
    weeklyCost: record.weeklyCost ?? 0,
    cumulativeCost: record.cumulativeCost ?? 0,
  };
}

/** 結果の投影を作る純粋な関数。時計、乱数、プロセスのメモリに依存しない（NFR1.1）。 */
export function buildResultsView(snapshot: Snapshot): ResultsView {
  const confirmedWeeks = confirmedWeeksOf(snapshot);
  const roles: ResultRole[] = ROLES.map((role) => ({
    role,
    weeks: confirmedRecords(snapshot, role).map(toResultWeek),
  }));
  return {
    gameId: snapshot.game.gameId,
    setupKind: snapshot.game.setupKind,
    weekCount: snapshot.game.weekCount,
    confirmedWeeks,
    customerDemand: snapshot.settings.demandSeries.slice(0, confirmedWeeks),
    roles,
    teamCumulativeCost: roles.reduce(
      (sum, role) => sum + (role.weeks.at(-1)?.cumulativeCost ?? 0),
      0,
    ),
  };
}
