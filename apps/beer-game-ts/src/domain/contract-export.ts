import type { CommitMode } from './game.js';
import { changedSettingsOf, settingsKindOf } from './contract-settings.js';
import { ExportIncompleteError, type ExportSource } from './export.js';
import { ROLES, type Role } from './role.js';

/**
 * 結果の出力（CSV・JSON）。共有の API の契約（`getExport`・`ExportDocument`）の形。要求時に、役割別の週結果と設定から作る純粋な関数。
 * CSV は RFC 4180（CRLF）。文字列の列の先頭が `=`・`+`・`-`・`@`・タブ・CR のときは、先頭に `'` を付ける
 * （表計算の数式として解釈させない）。表示名・資格・参加コードは含めない（NF-S14）。数量と費用は、CSV と JSON で同じ値。
 *
 * 出力の形の版は、共有の契約が定める値（Kotlin 版・Rust 版と同じ形式）。形式が同じなので、同じ値にする。
 */
export const CONTRACT_EXPORT_SCHEMA_VERSION = 'beer-game-kotlin.export.v1';

export const CONTRACT_CSV_HEADER =
  'schema_version,game_id,settings_kind,settings_changes,commit_mode,week,role,orders,shipped,ordered,ending_inventory,ending_backlog,weekly_cost_minor,cumulative_cost_minor';

export interface ContractExportRecord {
  week: number;
  role: Role;
  orders: number;
  shipped: number;
  ordered: number;
  endingInventory: number;
  endingBacklog: number;
  weeklyCostMinor: number;
  cumulativeCostMinor: number;
}

export interface ContractExportDocument {
  schemaVersion: typeof CONTRACT_EXPORT_SCHEMA_VERSION;
  gameId: string;
  finalWeek: number;
  settings: {
    kind: 'KIT' | 'CUSTOM';
    changes: string[];
    commitMode: CommitMode;
  };
  records: ContractExportRecord[];
}

/** CSV の 1 つの文字列の列。数式として解釈される先頭の文字に `'` を付け、`,`・`"`・改行を含むなら引用する */
function csvCell(value: string | number): string {
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 出力を、同じ元データから組み立てる。週が 1 から最終週まで続かない、または役割の行が欠けていれば、
 * 組み立てずに失敗する（部分的な結果を、完全な出力として返さない。AC4.3.3）。
 */
export function buildContractExport(src: ExportSource): {
  json: ContractExportDocument;
  csv: string;
} {
  if (src.weeks.length !== src.finalWeek)
    throw new ExportIncompleteError(
      `確定した週が ${src.weeks.length} 週で、最終週（${src.finalWeek} 週）までそろっていません`,
    );
  const byKey = new Map(src.rows.map((r) => [`${r.week}:${r.role}`, r]));
  const records: ContractExportRecord[] = [];
  src.weeks.forEach(({ week }, i) => {
    if (week !== i + 1)
      throw new ExportIncompleteError(`${i + 1} 週目の記録がありません`);
    for (const role of ROLES) {
      const r = byKey.get(`${week}:${role}`);
      if (!r)
        throw new ExportIncompleteError(
          `${week} 週目の ${role} の記録がありません`,
        );
      records.push({
        week,
        role,
        orders: r.demand,
        shipped: r.shipped,
        ordered: r.order,
        endingInventory: r.endingInventory,
        endingBacklog: r.endingBacklog,
        weeklyCostMinor: r.weeklyCostMinor,
        cumulativeCostMinor: r.cumulativeCostMinor,
      });
    }
  });

  const changes = changedSettingsOf(src.settings.changes);
  const kind = settingsKindOf(src.settings.changes);
  const json: ContractExportDocument = {
    schemaVersion: CONTRACT_EXPORT_SCHEMA_VERSION,
    gameId: src.gameId,
    finalWeek: src.finalWeek,
    settings: { kind, changes, commitMode: src.commitMode },
    records,
  };

  const lines = [CONTRACT_CSV_HEADER];
  for (const r of records) {
    lines.push(
      [
        CONTRACT_EXPORT_SCHEMA_VERSION,
        src.gameId,
        kind,
        changes.join(';'),
        src.commitMode,
        r.week,
        r.role,
        r.orders,
        r.shipped,
        r.ordered,
        r.endingInventory,
        r.endingBacklog,
        r.weeklyCostMinor,
        r.cumulativeCostMinor,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return { json, csv: `${lines.join('\r\n')}\r\n` };
}
