import { describe, expect, it } from 'vitest';
import {
  CONDITION_LIMITS,
  KIT_CONDITIONS,
  conditionsOf,
  kitPreset,
} from '../../src/domain/conditions.js';
import { ROLES } from '../../src/domain/role.js';
import { DomainError } from '../../src/domain/values.js';

const uniform = (n: number) =>
  Object.fromEntries(ROLES.map((r) => [r, n])) as Record<
    (typeof ROLES)[number],
    number
  >;

describe('KIT_CONDITIONS（改訂版キットの準拠値）', () => {
  it('初期在庫は全役割 12、初期の流れ 4、遅延はすべて 2 週、在庫 $0.50・受注残 $1.00、公開範囲はチーム合計', () => {
    expect(KIT_CONDITIONS).toEqual({
      initialInventory: uniform(12),
      initialFlow: 4,
      orderDelayWeeks: 2,
      shipmentDelayWeeks: 2,
      productionDelayWeeks: 2,
      holdingCostMinor: 50,
      backlogCostMinor: 100,
      disclosure: 'TEAM_TOTAL',
    });
  });
});

describe('conditionsOf（条件の検査）', () => {
  it('[US1.1/AC1.1.4] 指定しなければ、キットの値になる', () => {
    expect(conditionsOf({})).toEqual(KIT_CONDITIONS);
  });

  it('[US1.1/AC1.1.4] 初期在庫は役割ごとに変えられ、省略した役割はキットの値（12）', () => {
    expect(
      conditionsOf({ initialInventory: { RETAILER: 20 } }).initialInventory,
    ).toEqual({ ...uniform(12), RETAILER: 20 });
  });

  it('[US1.1/AC1.1.4] 初期の流れ、遅延、費用単価、公開範囲を変えられる', () => {
    expect(
      conditionsOf({
        initialInventory: { FACTORY: 0, RETAILER: 20 },
        initialFlow: 6,
        orderDelayWeeks: 1,
        shipmentDelayWeeks: 3,
        productionDelayWeeks: 8,
        holdingCostMinor: 25,
        backlogCostMinor: 200,
        disclosure: 'PROGRESS_ONLY',
      }),
    ).toEqual({
      initialInventory: { ...uniform(12), FACTORY: 0, RETAILER: 20 },
      initialFlow: 6,
      orderDelayWeeks: 1,
      shipmentDelayWeeks: 3,
      productionDelayWeeks: 8,
      holdingCostMinor: 25,
      backlogCostMinor: 200,
      disclosure: 'PROGRESS_ONLY',
    });
  });

  it('[US1.1/AC1.1.4] 範囲外の値は、作成せず、項目ごとに修正内容と対象（field）を示す', () => {
    try {
      conditionsOf({
        initialInventory: { RETAILER: 1001, FACTORY: -1 },
        initialFlow: 1001,
        orderDelayWeeks: 0,
        shipmentDelayWeeks: 9,
        holdingCostMinor: -1,
        backlogCostMinor: 100_001,
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      const issues = (e as DomainError).issues;
      expect(issues.map((i) => [i.field, i.problem])).toEqual([
        [
          'conditions.initialInventory.FACTORY',
          '初期在庫（工場）は 0〜1000 の整数です',
        ],
        [
          'conditions.initialInventory.RETAILER',
          '初期在庫（小売店）は 0〜1000 の整数です',
        ],
        ['conditions.initialFlow', '初期の流れは 0〜1000 の整数です'],
        ['conditions.orderDelayWeeks', '注文の遅延は 1〜8 週の整数です'],
        ['conditions.shipmentDelayWeeks', '配送の遅延は 1〜8 週の整数です'],
        [
          'conditions.holdingCostMinor',
          '在庫の費用単価は 0〜100000 の整数（最小単位）です',
        ],
        [
          'conditions.backlogCostMinor',
          '受注残の費用単価は 0〜100000 の整数（最小単位）です',
        ],
      ]);
      expect(issues[1]!.fix).toBe(
        '初期在庫（小売店）を 0〜1000 にしてください',
      );
    }
  });

  it('[US1.1/AC1.1.4] 小数・非数も範囲外として、項目ごとに示す', () => {
    try {
      conditionsOf({ backlogCostMinor: 1.5, initialFlow: Number.NaN });
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).issues.map((i) => i.field)).toEqual([
        'conditions.initialFlow',
        'conditions.backlogCostMinor',
      ]);
    }
  });

  it('[US1.1/AC1.1.4] 境界値（下限・上限）は受け付ける', () => {
    const { initialInventory, initialFlow, delayWeeks, costMinor } =
      CONDITION_LIMITS;
    expect(() =>
      conditionsOf({
        initialInventory: uniform(initialInventory.max),
        initialFlow: initialFlow.max,
        orderDelayWeeks: delayWeeks.min,
        shipmentDelayWeeks: delayWeeks.max,
        productionDelayWeeks: delayWeeks.min,
        holdingCostMinor: costMinor.min,
        backlogCostMinor: costMinor.max,
      }),
    ).not.toThrow();
    expect(() =>
      conditionsOf({
        initialInventory: uniform(initialInventory.min),
        initialFlow: initialFlow.min,
      }),
    ).not.toThrow();
  });

  it('範囲は共有の契約と同じ（初期在庫・初期の流れ 0〜1000、遅延 1〜8 週、費用 0〜100000）', () => {
    expect(CONDITION_LIMITS).toEqual({
      initialInventory: { min: 0, max: 1000 },
      initialFlow: { min: 0, max: 1000 },
      delayWeeks: { min: 1, max: 8 },
      costMinor: { min: 0, max: 100_000 },
    });
  });

  it('公開範囲は選択肢のどれか（field は conditions.disclosurePolicy）', () => {
    try {
      conditionsOf({ disclosure: 'EVERYTHING' as 'TEAM_TOTAL' });
      expect.unreachable();
    } catch (e) {
      const issue = (e as DomainError).issues[0]!;
      expect(issue.problem).toMatch(/公開範囲/);
      expect(issue.field).toBe('conditions.disclosurePolicy');
    }
  });
});

describe('kitPreset（準拠か、カスタムか）', () => {
  it('[US1.1/AC1.1.3] キットの値と需要なら準拠で、変更項目は無い', () => {
    expect(kitPreset(KIT_CONDITIONS, false)).toEqual({
      kind: 'KIT',
      changes: [],
    });
  });

  it('[US1.1/AC1.1.3] 準拠値から変えたら「カスタム」で、変更した項目を順に列挙する', () => {
    expect(
      kitPreset(
        {
          ...KIT_CONDITIONS,
          initialInventory: { ...uniform(12), RETAILER: 20 },
          initialFlow: 5,
          shipmentDelayWeeks: 1,
          disclosure: 'PROGRESS_ONLY',
        },
        false,
      ),
    ).toEqual({
      kind: 'CUSTOM',
      changes: [
        'initialInventory',
        'initialFlow',
        'shipmentDelayWeeks',
        'disclosure',
      ],
    });
  });

  it('[US1.1/AC1.1.3] 初期在庫は、どれか 1 つの役割が違えば、1 つの変更項目（initialInventory）', () => {
    expect(
      kitPreset(
        {
          ...KIT_CONDITIONS,
          initialInventory: { ...uniform(12), FACTORY: 0, RETAILER: 20 },
        },
        false,
      ).changes,
    ).toEqual(['initialInventory']);
  });

  it('[US1.1/AC1.1.3] 需要系列をキットから変えたら「カスタム」で、需要を変更項目に含める', () => {
    expect(kitPreset(KIT_CONDITIONS, true)).toEqual({
      kind: 'CUSTOM',
      changes: ['demand'],
    });
  });
});
