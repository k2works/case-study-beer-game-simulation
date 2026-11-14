import { describe, expect, it } from 'vitest';
import { EXPORT_COLUMNS, renderCsv, renderJson } from '../../../src/server/reporting/csv.js';
import type { ExportDocument, ExportRecord } from '../../../src/server/reporting/export.js';
import { parseCsv, readRecords } from '../support/csv-reader.js';

const record = (overrides: Partial<ExportRecord> = {}): ExportRecord => ({
  gameId: '11111111-1111-4111-8111-111111111111',
  setupKind: 'custom',
  week: 1,
  role: 'factory',
  customerDemand: 8,
  receipt: 4,
  ordersReceived: 8,
  shipped: 8,
  inventory: 8,
  backlog: 0,
  decision: 6,
  weeklyCostCents: 400,
  cumulativeCostCents: 400,
  decidedByKind: 'participant',
  decidedByDisplayName: '太郎',
  ...overrides,
});

describe('BR23.3 CSV は RFC 4180、UTF-8 の BOM つき、値は変えない', () => {
  it('先頭に BOM、1 行目が列名、行の終わりは CRLF', () => {
    const text = renderCsv([record(), record({ week: 2 })]);
    expect(text.startsWith('﻿')).toBe(true);
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe(EXPORT_COLUMNS.join(','));
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('');
    expect(text.includes('\n') && !/[^\r]\n/.test(text)).toBe(true);
  });

  it('列の定義は 1 つで、列名は仕様の並び', () => {
    expect([...EXPORT_COLUMNS]).toEqual([
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
    ]);
  });

  it.each([
    ['カンマ', 'a,b', '"a,b"'],
    ['二重引用符', 'say "hi"', '"say ""hi"""'],
    ['LF', 'a\nb', '"a\nb"'],
    ['CR', 'a\rb', '"a\rb"'],
    ['CRLF', 'a\r\nb', '"a\r\nb"'],
    ['引用が要らない値はそのまま', '日本語 😀', '日本語 😀'],
  ])('%s を含む値の引用', (_label, value, expected) => {
    const text = renderCsv([record({ decidedByDisplayName: value })]);
    expect(text).toContain(`,${expected}\r\n`);
  });

  it('値を変えない: 先頭が = + - @ でも、先頭に文字を足さない', () => {
    for (const value of ['=1+1', '+1', '-1', '@A1', '=HYPERLINK("x")']) {
      const text = renderCsv([record({ decidedByDisplayName: value })]);
      expect(readRecords(text)[0]!.decidedByDisplayName).toBe(value);
      expect(text).not.toContain(`'${value}`);
    }
  });

  it('空の値は空のセル、数値は整数のまま', () => {
    const text = renderCsv([
      record({ decidedByKind: null, decidedByDisplayName: null, weeklyCostCents: 1234567 }),
    ]);
    const lines = text.slice(1).split('\r\n');
    expect(lines[1]).toMatch(/,1234567,400,,$/);
    expect(readRecords(text)[0]).toMatchObject({
      decidedByKind: null,
      decidedByDisplayName: null,
      weeklyCostCents: 1234567,
    });
  });

  it('行が 0 件でも、列名の行だけを出す', () => {
    expect(parseCsv(renderCsv([]))).toEqual([[...EXPORT_COLUMNS]]);
  });

  it('性質: ランダムな表示名（記号・改行・引用符・日本語・絵文字）が、往復で一致する', () => {
    const alphabet = [
      'a',
      'Z',
      ',',
      '"',
      '\n',
      '\r',
      '\r\n',
      '=',
      '+',
      '-',
      '@',
      ' ',
      '日本',
      '😀',
      '\t',
    ];
    // 決定論的な擬似乱数（線形合同法）
    let seed = 20261113;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed;
    };
    for (let i = 0; i < 400; i += 1) {
      const length = 1 + (next() % 12);
      let name = '';
      for (let j = 0; j < length; j += 1) {
        name += alphabet[next() % alphabet.length];
      }
      const text = renderCsv([record({ decidedByDisplayName: name }), record({ week: 2 })]);
      const rows = parseCsv(text);
      expect(rows).toHaveLength(3);
      expect(rows[1]!.at(-1)).toBe(name);
      expect(rows[1]).toHaveLength(EXPORT_COLUMNS.length);
    }
  });
});

describe('BR23.4 CSV と JSON は同じ中間表現から作り、数値が一致する', () => {
  const document: ExportDocument = {
    game: {
      gameId: '11111111-1111-4111-8111-111111111111',
      name: '授業 "A", 1',
      setupKind: 'custom',
      status: 'ended',
      endReason: 'finalWeek',
      weekCount: 2,
      confirmedWeeks: 2,
      createdAt: '2026-11-13T00:00:00.000Z',
      endedAt: '2026-11-13T01:00:00.000Z',
      initialInventory: 12,
      initialPipelineQuantity: 4,
      inventoryUnitCostCents: 50,
      backlogUnitCostCents: 100,
      demandSeries: [8, 4],
    },
    records: [
      record(),
      record({ role: 'wholesaler1', decidedByKind: null, decidedByDisplayName: null }),
    ],
  };

  it('JSON は game と records を持ち、数値は JSON の数、日時は ISO 8601', () => {
    const parsed = JSON.parse(renderJson(document)) as ExportDocument;
    expect(Object.keys(parsed)).toEqual(['game', 'records']);
    expect(parsed).toEqual(document);
    expect(typeof parsed.records[0]!.weeklyCostCents).toBe('number');
  });

  it('CSV を読み戻した records は、JSON の records と件数・順序・値が一致する', () => {
    const fromCsv = readRecords(renderCsv(document.records));
    expect(fromCsv).toEqual(JSON.parse(renderJson(document)).records);
  });
});
