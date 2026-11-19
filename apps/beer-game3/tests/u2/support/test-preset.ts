import type { KitPreset } from '../../../src/server/domain/kit-preset.js';

/**
 * 試験の中だけで使う、需要系列を含む仮のプリセット。
 * 実際の KIT_PRESET は需要系列が未提供（JSD の確認待ち）。この値は JSD の系列を意味しない。
 */
export const TEST_PRESET: KitPreset = {
  weekCount: 50,
  initialInventory: 12,
  initialPipelineQuantity: 4,
  inventoryUnitCost: 50,
  backlogUnitCost: 100,
  delayWeeks: 2,
  demandSeries: Array.from({ length: 50 }, (_, i) => (i < 4 ? 4 : 8)),
};
