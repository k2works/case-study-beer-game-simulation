/**
 * 試験専用の小さな CSV の読み取り（RFC 4180）。本番の依存には足さない。
 * 先頭の BOM を取り除き、二重引用符の中のカンマと改行を値として保つ。
 */
export function parseCsv(text: string): string[][] {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === '') {
      quoted = true;
      index += 1;
    } else if (char === ',') {
      row.push(field);
      field = '';
      index += 1;
    } else if (char === '\r' && source[index + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 2;
    } else {
      field += char;
      index += 1;
    }
  }
  if (quoted) {
    throw new Error('CSV の引用が閉じていません');
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const NUMERIC = new Set([
  'week',
  'customerDemand',
  'receipt',
  'ordersReceived',
  'shipped',
  'inventory',
  'backlog',
  'decision',
  'weeklyCostCents',
  'cumulativeCostCents',
]);

/** 1 行目を列名として、各行をオブジェクトに戻す。数値の列は数に、空のセルは null にする（JSON の records と比べるため）。 */
export function readRecords(text: string): Array<Record<string, string | number | null>> {
  const [header, ...rows] = parseCsv(text);
  if (!header) {
    return [];
  }
  return rows.map((cells) => {
    if (cells.length !== header.length) {
      throw new Error(`列の数が合いません: ${cells.length} / ${header.length}`);
    }
    return Object.fromEntries(
      header.map((name, i) => {
        const cell = cells[i]!;
        if (cell === '') {
          return [name, null];
        }
        return [name, NUMERIC.has(name) ? Number(cell) : cell];
      }),
    );
  });
}
