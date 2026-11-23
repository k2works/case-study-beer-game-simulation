import type { ConditionItem, DisclosurePolicy } from './conditions.js';

/**
 * 共有の API の契約（apps/beer-game-contracts/openapi.yaml）が使う、設定の呼び名への写像。
 * 契約の `SettingsField`（キットの値から変えた項目）と、公開範囲の呼び名（`TEAM_TOTAL`・`NONE`）。
 */
export const SETTINGS_FIELDS = [
  'INITIAL_INVENTORY',
  'INITIAL_FLOW',
  'ORDER_DELAY',
  'SHIPMENT_DELAY',
  'PRODUCTION_DELAY',
  'HOLDING_COST',
  'BACKLOG_COST',
  'DISCLOSURE',
] as const;
export type SettingsField = (typeof SETTINGS_FIELDS)[number];

/** 条件の項目 → 契約の項目。需要系列（`demand`）は、契約では設定の変更に含めない */
const FIELD_OF: Record<Exclude<ConditionItem, 'demand'>, SettingsField> = {
  initialInventory: 'INITIAL_INVENTORY',
  orderDelayWeeks: 'ORDER_DELAY',
  shipmentDelayWeeks: 'SHIPMENT_DELAY',
  productionDelayWeeks: 'PRODUCTION_DELAY',
  holdingCostMinor: 'HOLDING_COST',
  backlogCostMinor: 'BACKLOG_COST',
  disclosure: 'DISCLOSURE',
};

/** キットの値から変えた項目（契約の呼び名）。最終週と需要系列は含めない */
export function changedSettingsOf(
  changes: readonly ConditionItem[],
): SettingsField[] {
  return changes.flatMap((c) => (c === 'demand' ? [] : [FIELD_OF[c]]));
}

/** 設定の種別。キットの値と同じなら `KIT`（最終週と需要系列は判定に含めない） */
export function settingsKindOf(
  changes: readonly ConditionItem[],
): 'KIT' | 'CUSTOM' {
  return changedSettingsOf(changes).length > 0 ? 'CUSTOM' : 'KIT';
}

/** 公開範囲の呼び名。契約は、合計を出さない範囲を `NONE` と呼ぶ（このアプリの内部では `PROGRESS_ONLY`） */
export function disclosureNameOf(
  policy: DisclosurePolicy,
): 'TEAM_TOTAL' | 'NONE' {
  return policy === 'TEAM_TOTAL' ? 'TEAM_TOTAL' : 'NONE';
}
