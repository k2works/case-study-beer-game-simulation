import type { ExportDocument, ExportRecord } from './export.js';

/**
 * 出力の列の定義（1 つの定数）。CSV のヘッダと JSON の項目名の両方がこれを使い、並びは ExportRecord と同じ（NFR1.2）。
 * 列名と役割の値は、読み戻すための識別子として英語のまま出す（NFR11.2）。
 */
export const EXPORT_COLUMNS = [
  'gameId',
  'setupKind',
  'week',
  'role',
  'customerDemand',
  'receipt',
  'ordersReceived',
  'shipped',
  'inventory',
  'backlog',
  'decision',
  'weeklyCostCents',
  'cumulativeCostCents',
  'decidedByKind',
  'decidedByDisplayName',
] as const satisfies ReadonlyArray<keyof ExportRecord>;

const BOM = '﻿';

/** RFC 4180 の引用: カンマ・二重引用符・CR・LF を含む値だけを二重引用符で囲み、内部の二重引用符を 2 つにする。値は変えない。 */
function cell(value: string | number | null): string {
  if (value === null) {
    return '';
  }
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * CSV を作る（BR23.3）。UTF-8 の BOM つき、1 行目が列名、行の終わりは CRLF。
 * 値の先頭が = + - @ でも変えない（先頭に文字を足さない）。式として実行される恐れは、入力の拒否（BR23.10）と
 * 出力ボタンの近くの注意で扱う。
 */
export function renderCsv(records: readonly ExportRecord[]): string {
  const lines = [
    EXPORT_COLUMNS.join(','),
    ...records.map((record) => EXPORT_COLUMNS.map((column) => cell(record[column])).join(',')),
  ];
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** JSON を作る（BR23.4）。CSV と同じ ExportRecord の配列から作るので、同じ名前・同じ値になる。数値は JSON の数。 */
export function renderJson(document: ExportDocument): string {
  return JSON.stringify(document, null, 2);
}
