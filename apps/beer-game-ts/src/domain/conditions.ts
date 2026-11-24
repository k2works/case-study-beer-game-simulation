import { ROLES, ROLE_LABELS, type Role } from './role.js';
import { DomainError, type Issue } from './values.js';

/** 公開範囲（観察者にプレイ中に見せる範囲。観察は Bolt 8） */
export const DISCLOSURE_POLICIES = ['TEAM_TOTAL', 'PROGRESS_ONLY'] as const;
export type DisclosurePolicy = (typeof DISCLOSURE_POLICIES)[number];

/** ゲームの条件（キット準拠値から変えられる項目） */
export interface Conditions {
  /** 役割ごとの初期在庫 */
  initialInventory: Readonly<Record<Role, number>>;
  /** 初期の流れ。遅延の各段（入荷・発注の待ち行列）に、最初から入っている数量 */
  initialFlow: number;
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

/** 作成の入力。指定の無い項目はキットの値。初期在庫は、役割ごとに、省略した役割がキットの値になる */
export type ConditionsInput = Partial<Omit<Conditions, 'initialInventory'>> & {
  initialInventory?: Partial<Record<Role, number>>;
};

/** 条件の項目に、需要系列を加えたもの（準拠か、カスタムかの判定の対象） */
export type ConditionItem = keyof Conditions | 'demand';

const uniformInventory = (n: number) =>
  Object.fromEntries(ROLES.map((r) => [r, n])) as Record<Role, number>;

/** 改訂版キットの準拠値 */
export const KIT_CONDITIONS: Conditions = {
  initialInventory: uniformInventory(12),
  initialFlow: 4,
  orderDelayWeeks: 2,
  shipmentDelayWeeks: 2,
  productionDelayWeeks: 2,
  holdingCostMinor: 50,
  backlogCostMinor: 100,
  disclosure: 'TEAM_TOTAL',
};

/**
 * 条件の範囲。共有の API の契約（apps/beer-game-contracts/openapi.yaml の `CustomConditions`）と同じ値
 * （Kotlin 版・Rust 版と共有する。範囲そのものは、運営者と未合意の仮の値。合意したら、ここだけを変える）。
 * 遅延は 1 週以上（0 だと同じ週に届き、週の中の処理の順序が変わるため、採らない）。
 */
export const CONDITION_LIMITS = {
  initialInventory: { min: 0, max: 1000 },
  initialFlow: { min: 0, max: 1000 },
  delayWeeks: { min: 1, max: 8 },
  costMinor: { min: 0, max: 100_000 },
} as const;

type NumericKey = Exclude<keyof Conditions, 'disclosure' | 'initialInventory'>;

const RANGES: Record<
  NumericKey,
  { label: string; range: { min: number; max: number }; unit: string }
> = {
  initialFlow: {
    label: '初期の流れ',
    range: CONDITION_LIMITS.initialFlow,
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

/** 判定と表示の順序（初期在庫は、役割の順に並べて検査する） */
const ORDER: readonly (keyof Conditions)[] = [
  'initialInventory',
  'initialFlow',
  'orderDelayWeeks',
  'shipmentDelayWeeks',
  'productionDelayWeeks',
  'holdingCostMinor',
  'backlogCostMinor',
  'disclosure',
];

const outOfRange = (
  field: string,
  label: string,
  range: { min: number; max: number },
  unit: string,
): Issue => ({
  field,
  problem: `${label}は ${range.min}〜${range.max}${unit}です`,
  fix: `${label}を ${range.min}〜${range.max} にしてください`,
});

const inRange = (v: unknown, range: { min: number; max: number }) =>
  typeof v === 'number' &&
  Number.isInteger(v) &&
  v >= range.min &&
  v <= range.max;

/**
 * 指定された条件を検査し、指定の無い項目（初期在庫は、省略した役割）はキットの値で埋める。
 * 範囲外は、項目ごとの修正内容と対象（`field`。共有の契約の `conditions.<項目>`）つきで、すべて集めて拒否する。
 */
export function conditionsOf(input: ConditionsInput): Conditions {
  const conditions: Conditions = {
    ...KIT_CONDITIONS,
    ...input,
    initialInventory: {
      ...KIT_CONDITIONS.initialInventory,
      ...input.initialInventory,
    },
  };
  const issues: Issue[] = [];
  for (const key of ORDER) {
    if (key === 'disclosure') {
      if (!DISCLOSURE_POLICIES.includes(conditions.disclosure))
        issues.push({
          field: 'conditions.disclosurePolicy',
          problem: '公開範囲が選択肢にありません',
          fix: `公開範囲を ${DISCLOSURE_POLICIES.join('、')} のどれかにしてください`,
        });
      continue;
    }
    if (key === 'initialInventory') {
      for (const role of ROLES) {
        if (
          !inRange(
            conditions.initialInventory[role],
            CONDITION_LIMITS.initialInventory,
          )
        )
          issues.push(
            outOfRange(
              `conditions.initialInventory.${role}`,
              `初期在庫（${ROLE_LABELS[role]}）`,
              CONDITION_LIMITS.initialInventory,
              ' の整数',
            ),
          );
      }
      continue;
    }
    const { label, range, unit } = RANGES[key];
    if (!inRange(conditions[key], range))
      issues.push(outOfRange(`conditions.${key}`, label, range, unit));
  }
  if (issues.length > 0) throw new DomainError('条件が無効です', issues);
  return conditions;
}

/**
 * キット準拠か、カスタムかを判定し、変更した項目を列挙する（純粋関数）。
 * 初期在庫は、どれか 1 つの役割でもキットの値と違えば、変更項目（`initialInventory`）に含める。
 * 需要系列がキットの既定と違えば、`demand` も変更項目に含める。
 */
export function kitPreset(
  conditions: Conditions,
  demandChanged: boolean,
): { kind: 'KIT' | 'CUSTOM'; changes: ConditionItem[] } {
  const changed = (key: keyof Conditions) =>
    key === 'initialInventory'
      ? ROLES.some(
          (r) =>
            conditions.initialInventory[r] !==
            KIT_CONDITIONS.initialInventory[r],
        )
      : conditions[key] !== KIT_CONDITIONS[key];
  const changes: ConditionItem[] = ORDER.filter(changed);
  if (demandChanged) changes.push('demand');
  return { kind: changes.length > 0 ? 'CUSTOM' : 'KIT', changes };
}
