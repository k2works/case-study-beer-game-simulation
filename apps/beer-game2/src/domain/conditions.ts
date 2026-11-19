import { DomainError, type Issue } from './values.js';

/** 公開範囲（観察者にプレイ中に見せる範囲。観察は Bolt 8） */
export const DISCLOSURE_POLICIES = ['TEAM_TOTAL', 'PROGRESS_ONLY'] as const;
export type DisclosurePolicy = (typeof DISCLOSURE_POLICIES)[number];

/** ゲームの条件（キット準拠値から変えられる項目） */
export interface Conditions {
  initialInventory: number;
  /** 注文が上流へ届くまでの週数 */
  orderDelayWeeks: number;
  /** 出荷が下流へ届くまでの週数 */
  shipmentDelayWeeks: number;
  /** 工場の生産要請が在庫になるまでの週数 */
  productionDelayWeeks: number;
  holdingCostMinor: number;
  backlogCostMinor: number;
  disclosure: DisclosurePolicy;
}

/** 条件の項目に、需要系列を加えたもの（準拠か、カスタムかの判定の対象） */
export type ConditionItem = keyof Conditions | 'demand';

/** 改訂版キットの準拠値 */
export const KIT_CONDITIONS: Conditions = {
  initialInventory: 12,
  orderDelayWeeks: 2,
  shipmentDelayWeeks: 2,
  productionDelayWeeks: 2,
  holdingCostMinor: 50,
  backlogCostMinor: 100,
  disclosure: 'TEAM_TOTAL',
};

/**
 * 条件の範囲の**仮の値**（運営者と未合意。Unit 定義の未決事項 2）。合意したら、ここだけを変える。
 * 遅延は 1 週以上（0 だと同じ週に届き、週の中の処理の順序が変わるため、採らない）。
 */
export const CONDITION_LIMITS = {
  initialInventory: { min: 0, max: 100 },
  delayWeeks: { min: 1, max: 4 },
  costMinor: { min: 0, max: 1000 },
} as const;

const RANGES: Record<
  Exclude<keyof Conditions, 'disclosure'>,
  { label: string; range: { min: number; max: number }; unit: string }
> = {
  initialInventory: {
    label: '初期在庫',
    range: CONDITION_LIMITS.initialInventory,
    unit: ' の整数',
  },
  orderDelayWeeks: {
    label: '注文の遅延',
    range: CONDITION_LIMITS.delayWeeks,
    unit: ' 週の整数',
  },
  shipmentDelayWeeks: {
    label: '配送の遅延',
    range: CONDITION_LIMITS.delayWeeks,
    unit: ' 週の整数',
  },
  productionDelayWeeks: {
    label: '生産の遅延',
    range: CONDITION_LIMITS.delayWeeks,
    unit: ' 週の整数',
  },
  holdingCostMinor: {
    label: '在庫の費用単価',
    range: CONDITION_LIMITS.costMinor,
    unit: ' の整数（最小単位）',
  },
  backlogCostMinor: {
    label: '受注残の費用単価',
    range: CONDITION_LIMITS.costMinor,
    unit: ' の整数（最小単位）',
  },
};

/** 判定と表示の順序 */
const ORDER: readonly (keyof Conditions)[] = [
  'initialInventory',
  'orderDelayWeeks',
  'shipmentDelayWeeks',
  'productionDelayWeeks',
  'holdingCostMinor',
  'backlogCostMinor',
  'disclosure',
];

/**
 * 指定された条件を検査し、指定の無い項目はキットの値で埋める。範囲外は、項目ごとの修正内容つきで拒否する。
 */
export function conditionsOf(input: Partial<Conditions>): Conditions {
  const conditions: Conditions = { ...KIT_CONDITIONS, ...input };
  const issues: Issue[] = [];
  for (const key of ORDER) {
    if (key === 'disclosure') {
      if (!DISCLOSURE_POLICIES.includes(conditions.disclosure))
        issues.push({
          problem: '公開範囲が選択肢にありません',
          fix: `公開範囲を ${DISCLOSURE_POLICIES.join('、')} のどれかにしてください`,
        });
      continue;
    }
    const { label, range, unit } = RANGES[key];
    const v = conditions[key];
    if (!Number.isInteger(v) || v < range.min || v > range.max)
      issues.push({
        problem: `${label}は ${range.min}〜${range.max}${unit}です`,
        fix: `${label}を ${range.min}〜${range.max} にしてください`,
      });
  }
  if (issues.length > 0) throw new DomainError('条件が無効です', issues);
  return conditions;
}

/**
 * キット準拠か、カスタムかを判定し、変更した項目を列挙する（純粋関数）。
 * 需要系列がキットの既定と違えば、`demand` も変更項目に含める。
 */
export function kitPreset(
  conditions: Conditions,
  demandChanged: boolean,
): { kind: 'KIT' | 'CUSTOM'; changes: ConditionItem[] } {
  const changes: ConditionItem[] = ORDER.filter(
    (k) => conditions[k] !== KIT_CONDITIONS[k],
  );
  if (demandChanged) changes.push('demand');
  return { kind: changes.length > 0 ? 'CUSTOM' : 'KIT', changes };
}
