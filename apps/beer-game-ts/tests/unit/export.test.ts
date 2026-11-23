import { describe, expect, it } from 'vitest';
import { KIT_CONDITIONS } from '../../src/domain/conditions.js';
import {
  EXPORT_SCHEMA_VERSION,
  ExportIncompleteError,
  buildExport,
  type ExportSource,
} from '../../src/domain/export.js';
import { ROLES } from '../../src/domain/role.js';

function source(weeks = 2, extra: Partial<ExportSource> = {}): ExportSource {
  return {
    gameId: 'g1',
    finalWeek: weeks,
    commitMode: 'MANUAL',
    settings: {
      ...KIT_CONDITIONS,
      kind: 'CUSTOM',
      changes: ['initialInventory'],
      initialInventory: 20,
    },
    demand: Array.from({ length: weeks }, () => 4),
    weeks: Array.from({ length: weeks }, (_, i) => ({
      week: i + 1,
      commitKind: i === 0 ? 'MANUAL' : 'AUTO',
    })),
    rows: Array.from({ length: weeks }, (_, i) =>
      ROLES.map((role, r) => ({
        week: i + 1,
        role,
        demand: 4,
        received: 4,
        shipped: 4,
        order: 10 * (i + 1) + r,
        endingInventory: 20,
        endingBacklog: 0,
        weeklyCostMinor: 1000 + r,
        cumulativeCostMinor: (1000 + r) * (i + 1),
      })),
    ).flat(),
    inputs: [
      {
        week: 1,
        role: 'RETAILER',
        quantity: 13,
        by: 'PARTICIPANT',
        at: '2026-11-11T00:00:01.000Z',
      },
      {
        week: 2,
        role: 'FACTORY',
        quantity: 20,
        by: 'PROXY',
        at: '2026-11-11T00:00:02.000Z',
      },
    ],
    history: [
      { type: 'GameCreated', at: '2026-11-11T00:00:00.000Z' },
      { type: 'WeekCommitted', at: '2026-11-11T00:00:03.000Z' },
    ],
    ...extra,
  };
}

/** CSV を、見出しの名前つきの行に読み戻す（値に引用符・カンマを含まない前提） */
function parseCsv(csv: string) {
  const [head, ...lines] = csv.trimEnd().split('\r\n');
  const keys = head!.split(',');
  return lines.map((l) =>
    Object.fromEntries(l.split(',').map((v, i) => [keys[i]!, v])),
  );
}

describe('buildExport', () => {
  it('[US4.3/AC4.3.1] JSON は、設定（カスタムの別）・全週・全役割・意思決定・費用・入力の記録・履歴を持つ', () => {
    const { json } = buildExport(source());
    expect(json.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(json.game).toMatchObject({
      gameId: 'g1',
      finalWeek: 2,
      commitMode: 'MANUAL',
      settings: {
        kind: 'CUSTOM',
        changes: ['initialInventory'],
        initialInventory: 20,
      },
      demand: [4, 4],
    });
    expect(json.weeks).toHaveLength(2);
    expect(json.weeks[1]).toMatchObject({
      week: 2,
      commitKind: 'AUTO',
      demand: 4,
    });
    expect(Object.keys(json.weeks[0]!.roles)).toEqual(ROLES);
    expect(json.weeks[0]!.roles.RETAILER).toEqual({
      order: 13,
      received: 4,
      shipped: 4,
      endingInventory: 20,
      endingBacklog: 0,
      weeklyCostMinor: 1003,
      cumulativeCostMinor: 1003,
    });
    expect(json.inputs).toHaveLength(2);
    expect(json.inputs[1]).toMatchObject({ by: 'PROXY', role: 'FACTORY' });
    expect(json.history.map((h) => h.type)).toEqual([
      'GameCreated',
      'WeekCommitted',
    ]);
  });

  it('[US4.3/AC4.3.1] CSV は、週 × 役割の行で、設定の種別・変更項目・確定の種別・意思決定・費用を列に持つ', () => {
    const rows = parseCsv(buildExport(source()).csv);
    expect(rows).toHaveLength(8);
    expect(rows[3]).toEqual({
      schema_version: EXPORT_SCHEMA_VERSION,
      game_id: 'g1',
      settings_kind: 'CUSTOM',
      settings_changes: 'initialInventory',
      week: '1',
      commit_kind: 'MANUAL',
      role: 'RETAILER',
      demand: '4',
      order: '13',
      received: '4',
      shipped: '4',
      ending_inventory: '20',
      ending_backlog: '0',
      weekly_cost_minor: '1003',
      cumulative_cost_minor: '1003',
    });
  });

  it('[US4.3/AC4.3.2] 両形式の数量と費用が一致し、両方にスキーマ版が記録される', () => {
    const { json, csv } = buildExport(source(3));
    const rows = parseCsv(csv);
    for (const row of rows) {
      expect(row.schema_version).toBe(json.schemaVersion);
      const v =
        json.weeks[Number(row.week) - 1]!.roles[
          row.role as (typeof ROLES)[number]
        ];
      expect(Number(row.order)).toBe(v.order);
      expect(Number(row.shipped)).toBe(v.shipped);
      expect(Number(row.ending_inventory)).toBe(v.endingInventory);
      expect(Number(row.weekly_cost_minor)).toBe(v.weeklyCostMinor);
      expect(Number(row.cumulative_cost_minor)).toBe(v.cumulativeCostMinor);
    }
    expect(rows).toHaveLength(json.weeks.length * ROLES.length);
  });

  it('[US4.3/AC4.3.3] 役割の行が欠けていれば、出力を組み立てず、失敗として扱う', () => {
    const src = source();
    expect(() => buildExport({ ...src, rows: src.rows.slice(0, -1) })).toThrow(
      ExportIncompleteError,
    );
  });

  it('[US4.3/AC4.3.3] 確定した週が最終週まで続かなければ（欠けた週）、出力を組み立てない', () => {
    const src = source(3);
    expect(() =>
      buildExport({
        ...src,
        weeks: src.weeks.filter((w) => w.week !== 2),
        rows: src.rows.filter((r) => r.week !== 2),
      }),
    ).toThrow(ExportIncompleteError);
  });

  it('CSV の値にカンマ・引用符・改行があれば、引用符で囲む', () => {
    const { csv } = buildExport(source(1, { gameId: 'a,"b"' }));
    expect(csv.split('\r\n')[1]).toContain('"a,""b"""');
  });
});
