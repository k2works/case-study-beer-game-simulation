import { describe, expect, it } from 'vitest';
import {
  KIT_PRESET,
  judgeSetupKind,
  type KitPreset,
  type SetupCandidate,
} from '../../../src/server/domain/kit-preset.js';
import { FIXED_DELAY_WEEKS } from '../../../src/server/domain/types.js';
import { TEST_PRESET } from '../support/test-preset.js';

function candidateOf(preset: KitPreset): SetupCandidate {
  return {
    weekCount: preset.weekCount,
    initialInventory: preset.initialInventory,
    initialPipelineQuantity: preset.initialPipelineQuantity,
    inventoryUnitCost: preset.inventoryUnitCost,
    backlogUnitCost: preset.backlogUnitCost,
    delayWeeks: preset.delayWeeks,
    demandSeries: [...(preset.demandSeries ?? [])],
  };
}

describe('KitPreset の定義（BR6.2）', () => {
  it('実際の KIT_PRESET は、キットの値を持ち、需要系列は未提供（null）', () => {
    expect(KIT_PRESET).toMatchObject({
      weekCount: 50,
      initialInventory: 12,
      initialPipelineQuantity: 4,
      inventoryUnitCost: 50,
      backlogUnitCost: 100,
      delayWeeks: FIXED_DELAY_WEEKS,
      demandSeries: null,
    });
  });
});

describe('AC1.6.3 / BR6.3 キット準拠の判定', () => {
  it('Given プリセットの全項目と一致する設定 / When 判定する / Then kit', () => {
    expect(judgeSetupKind(candidateOf(TEST_PRESET), TEST_PRESET)).toBe('kit');
  });

  const variations: Array<[string, Partial<SetupCandidate>]> = [
    ['週数', { weekCount: 30 }],
    ['初期在庫', { initialInventory: 13 }],
    ['初期パイプライン数量', { initialPipelineQuantity: 5 }],
    ['在庫単価', { inventoryUnitCost: 51 }],
    ['受注残単価', { backlogUnitCost: 101 }],
    ['遅延の週数', { delayWeeks: 3 }],
  ];
  for (const [label, change] of variations) {
    it(`Given ${label} だけが違う / When 判定する / Then custom`, () => {
      expect(judgeSetupKind({ ...candidateOf(TEST_PRESET), ...change }, TEST_PRESET)).toBe(
        'custom',
      );
    });
  }

  it('Given 需要系列の 1 つの値だけが違う / When 判定する / Then custom', () => {
    const series = [...(TEST_PRESET.demandSeries ?? [])];
    series[49] = 9;
    expect(judgeSetupKind({ ...candidateOf(TEST_PRESET), demandSeries: series }, TEST_PRESET)).toBe(
      'custom',
    );
  });

  it('Given 需要系列の長さが違う / When 判定する / Then custom', () => {
    expect(
      judgeSetupKind({ ...candidateOf(TEST_PRESET), demandSeries: [4, 4, 4] }, TEST_PRESET),
    ).toBe('custom');
  });
});

describe('AC1.6.2 / BR6.2 需要系列が未提供の間は、必ず custom', () => {
  it('Given 実際の KIT_PRESET の全項目と一致する設定 / When 判定する / Then custom（需要系列が未提供のため）', () => {
    const candidate: SetupCandidate = {
      weekCount: 50,
      initialInventory: 12,
      initialPipelineQuantity: 4,
      inventoryUnitCost: 50,
      backlogUnitCost: 100,
      delayWeeks: FIXED_DELAY_WEEKS,
      demandSeries: Array.from({ length: 50 }, (_, i) => (i < 4 ? 4 : 8)),
    };
    expect(judgeSetupKind(candidate, KIT_PRESET)).toBe('custom');
    expect(judgeSetupKind(candidate)).toBe('custom');
  });
});
