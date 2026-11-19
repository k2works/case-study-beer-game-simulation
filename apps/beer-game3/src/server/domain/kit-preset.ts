import { FIXED_DELAY_WEEKS, type SetupKind } from './types.js';

/**
 * キット準拠のプリセット（値の集まり）。保存せず、コードの中の定義として持つ（entities.md の KitPreset）。
 * 判定の基準になる（BR6.3）。
 */
export interface KitPreset {
  weekCount: number;
  initialInventory: number;
  initialPipelineQuantity: number;
  inventoryUnitCost: number;
  backlogUnitCost: number;
  delayWeeks: number;
  /**
   * JSD の既定の需要系列。確定するまで「未提供」（null）。
   * 未提供の間は、どのゲームも「キット準拠」と判定されない（BR6.2）。
   */
  demandSeries: readonly number[] | null;
}

/** 判定する設定（作成のときの確定した値）。 */
export interface SetupCandidate {
  weekCount: number;
  initialInventory: number;
  initialPipelineQuantity: number;
  inventoryUnitCost: number;
  backlogUnitCost: number;
  delayWeeks: number;
  demandSeries: readonly number[];
}

/**
 * 実際のキットの値。需要系列は JSD の資料の確認待ち（外部依存 E1、E2）のため、未提供のまま。
 * 確定したら demandSeries に 50 週分の値を入れる。
 */
export const KIT_PRESET: KitPreset = {
  weekCount: 50,
  initialInventory: 12,
  initialPipelineQuantity: 4,
  inventoryUnitCost: 50,
  backlogUnitCost: 100,
  delayWeeks: FIXED_DELAY_WEEKS,
  demandSeries: null,
};

/**
 * 設定が KitPreset の全項目と一致し、かつ KitPreset の需要系列が提供されているときだけ kit（BR6.3）。
 * どれか 1 つでも違う、または需要系列が未提供なら custom（BR6.2）。
 */
export function judgeSetupKind(
  candidate: SetupCandidate,
  preset: KitPreset = KIT_PRESET,
): SetupKind {
  if (preset.demandSeries === null) {
    return 'custom';
  }
  const sameSeries =
    candidate.demandSeries.length === preset.demandSeries.length &&
    candidate.demandSeries.every((value, index) => value === preset.demandSeries?.[index]);
  const matches =
    candidate.weekCount === preset.weekCount &&
    candidate.initialInventory === preset.initialInventory &&
    candidate.initialPipelineQuantity === preset.initialPipelineQuantity &&
    candidate.inventoryUnitCost === preset.inventoryUnitCost &&
    candidate.backlogUnitCost === preset.backlogUnitCost &&
    candidate.delayWeeks === preset.delayWeeks &&
    sameSeries;
  return matches ? 'kit' : 'custom';
}
