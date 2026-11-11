import type { ConditionItem, Conditions } from './conditions.js';
import type { CommitMode } from './game.js';
import type { ReviewRow } from './review.js';
import { ROLES, type Role } from './role.js';

/** 出力の形式の版。形を変えたら上げる */
export const EXPORT_SCHEMA_VERSION = 'beer-game2.export.v1';

/** 履歴に載せる出来事（ゲームの進行）。資格・参加・観察に関わる出来事は載せない */
export const EXPORT_HISTORY_TYPES: readonly string[] = [
  'GameCreated',
  'GameStarted',
  'SessionStarted',
  'WeekCommitted',
  'SessionPaused',
  'SessionResumed',
  'AutoCommitChanged',
  'SessionEnded',
];

/** 入力の記録に載せる出来事と、入力した人の種類 */
export const EXPORT_INPUT_TYPES = {
  DecisionSaved: 'PARTICIPANT',
  ProxyDecisionSubmitted: 'PROXY',
} as const;

/** 出力を完全に組み立てられない（記録の欠け）。部分的な結果を、完全な出力として返さない */
export class ExportIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportIncompleteError';
  }
}

/** 出力の元データ（読み取り専用の経路で集める） */
export interface ExportSource {
  gameId: string;
  finalWeek: number;
  commitMode: CommitMode;
  settings: Conditions & {
    kind: 'KIT' | 'CUSTOM';
    changes: readonly ConditionItem[];
  };
  /** 顧客需要の系列 */
  demand: readonly number[];
  /** 確定した週と、確定の種別 */
  weeks: readonly { week: number; commitKind: 'MANUAL' | 'AUTO' }[];
  /** 役割別の週結果の行 */
  rows: readonly ReviewRow[];
  /** 入力の記録（参加者の保存か、進行役の代理入力か）。表示名は含めない。週の無い古い記録は null */
  inputs: readonly {
    week: number | null;
    role: Role;
    quantity: number;
    by: 'PARTICIPANT' | 'PROXY';
    at: string;
  }[];
  /** ゲームの出来事の種類と時刻（資格に関わる出来事は含めない） */
  history: readonly { type: string; at: string }[];
}

type RoleValues = Omit<ReviewRow, 'week' | 'role' | 'demand'>;

export interface ExportDocument {
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  game: {
    gameId: string;
    finalWeek: number;
    commitMode: CommitMode;
    settings: ExportSource['settings'];
    demand: readonly number[];
  };
  weeks: {
    week: number;
    commitKind: 'MANUAL' | 'AUTO';
    /** 顧客需要 */
    demand: number;
    roles: Record<Role, RoleValues>;
  }[];
  inputs: ExportSource['inputs'];
  history: ExportSource['history'];
}

const CSV_COLUMNS = [
  'schema_version',
  'game_id',
  'settings_kind',
  'settings_changes',
  'week',
  'commit_kind',
  'role',
  'demand',
  'order',
  'received',
  'shipped',
  'ending_inventory',
  'ending_backlog',
  'weekly_cost_minor',
  'cumulative_cost_minor',
] as const;

/** RFC 4180: カンマ・引用符・改行を含む値は、引用符で囲み、引用符は二重にする */
const cell = (v: string | number) => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * 出力（CSV と JSON）を、同じ元データから組み立てる（純粋関数）。両形式の値は、同じ行から作るので必ず一致する。
 * 週が 1 から最終週まで続かない、または役割の行が欠けていれば、組み立てずに失敗する。
 */
export function buildExport(src: ExportSource): {
  json: ExportDocument;
  csv: string;
} {
  if (src.weeks.length !== src.finalWeek)
    throw new ExportIncompleteError(
      `確定した週が ${src.weeks.length} 週で、最終週（${src.finalWeek} 週）までそろっていません`,
    );
  const byKey = new Map(src.rows.map((r) => [`${r.week}:${r.role}`, r]));
  const weeks = src.weeks.map(({ week, commitKind }, i) => {
    if (week !== i + 1)
      throw new ExportIncompleteError(`${i + 1} 週目の記録がありません`);
    const roles = {} as Record<Role, RoleValues>;
    for (const role of ROLES) {
      const r = byKey.get(`${week}:${role}`);
      if (!r)
        throw new ExportIncompleteError(
          `${week} 週目の ${role} の記録がありません`,
        );
      roles[role] = {
        order: r.order,
        received: r.received,
        shipped: r.shipped,
        endingInventory: r.endingInventory,
        endingBacklog: r.endingBacklog,
        weeklyCostMinor: r.weeklyCostMinor,
        cumulativeCostMinor: r.cumulativeCostMinor,
      };
    }
    return { week, commitKind, demand: src.demand[week - 1] ?? 0, roles };
  });

  const json: ExportDocument = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    game: {
      gameId: src.gameId,
      finalWeek: src.finalWeek,
      commitMode: src.commitMode,
      settings: src.settings,
      demand: src.demand,
    },
    weeks,
    inputs: src.inputs,
    history: src.history,
  };

  const lines = [CSV_COLUMNS.join(',')];
  for (const w of weeks) {
    for (const role of ROLES) {
      const row = byKey.get(`${w.week}:${role}`)!;
      lines.push(
        [
          EXPORT_SCHEMA_VERSION,
          src.gameId,
          src.settings.kind,
          src.settings.changes.join(';'),
          w.week,
          w.commitKind,
          role,
          row.demand,
          row.order,
          row.received,
          row.shipped,
          row.endingInventory,
          row.endingBacklog,
          row.weeklyCostMinor,
          row.cumulativeCostMinor,
        ]
          .map(cell)
          .join(','),
      );
    }
  }
  return { json, csv: `${lines.join('\r\n')}\r\n` };
}
