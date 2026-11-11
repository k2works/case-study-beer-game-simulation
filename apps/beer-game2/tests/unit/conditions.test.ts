import { describe, expect, it } from 'vitest';
import {
  CONDITION_LIMITS,
  KIT_CONDITIONS,
  conditionsOf,
  kitPreset,
} from '../../src/domain/conditions.js';
import { DomainError } from '../../src/domain/values.js';

describe('KIT_CONDITIONS（改訂版キットの準拠値）', () => {
  it('初期在庫 12、遅延はすべて 2 週、在庫 $0.50・受注残 $1.00、公開範囲はチーム合計', () => {
    expect(KIT_CONDITIONS).toEqual({
      initialInventory: 12,
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

  it('[US1.1/AC1.1.4] 初期在庫、遅延、費用単価、公開範囲を変えられる', () => {
    expect(
      conditionsOf({
        initialInventory: 20,
        orderDelayWeeks: 1,
        shipmentDelayWeeks: 3,
        productionDelayWeeks: 4,
        holdingCostMinor: 25,
        backlogCostMinor: 200,
        disclosure: 'PROGRESS_ONLY',
      }),
    ).toEqual({
      initialInventory: 20,
      orderDelayWeeks: 1,
      shipmentDelayWeeks: 3,
      productionDelayWeeks: 4,
      holdingCostMinor: 25,
      backlogCostMinor: 200,
      disclosure: 'PROGRESS_ONLY',
    });
  });

  it('[US1.1/AC1.1.4] 範囲外の値は、作成せず、項目ごとに修正内容を示す', () => {
    try {
      conditionsOf({
        initialInventory: 101,
        orderDelayWeeks: 0,
        shipmentDelayWeeks: 5,
        holdingCostMinor: -1,
        backlogCostMinor: 1.5,
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      const issues = (e as DomainError).issues;
      expect(issues.map((i) => i.problem)).toEqual([
        '初期在庫は 0〜100 の整数です',
        '注文の遅延は 1〜4 週の整数です',
        '配送の遅延は 1〜4 週の整数です',
        '在庫の費用単価は 0〜1000 の整数（最小単位）です',
        '受注残の費用単価は 0〜1000 の整数（最小単位）です',
      ]);
      expect(issues[0]!.fix).toBe('初期在庫を 0〜100 にしてください');
    }
  });

  it('[US1.1/AC1.1.4] 境界値（下限・上限）は受け付ける', () => {
    const { initialInventory, delayWeeks, costMinor } = CONDITION_LIMITS;
    expect(() =>
      conditionsOf({
        initialInventory: initialInventory.max,
        orderDelayWeeks: delayWeeks.min,
        shipmentDelayWeeks: delayWeeks.max,
        productionDelayWeeks: delayWeeks.min,
        holdingCostMinor: costMinor.min,
        backlogCostMinor: costMinor.max,
      }),
    ).not.toThrow();
    expect(() =>
      conditionsOf({ initialInventory: initialInventory.min }),
    ).not.toThrow();
  });

  it('公開範囲は選択肢のどれか', () => {
    try {
      conditionsOf({ disclosure: 'EVERYTHING' as 'TEAM_TOTAL' });
      expect.unreachable();
    } catch (e) {
      expect((e as DomainError).issues[0]!.problem).toMatch(/公開範囲/);
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
          initialInventory: 20,
          shipmentDelayWeeks: 1,
          disclosure: 'PROGRESS_ONLY',
        },
        false,
      ),
    ).toEqual({
      kind: 'CUSTOM',
      changes: ['initialInventory', 'shipmentDelayWeeks', 'disclosure'],
    });
  });

  it('[US1.1/AC1.1.3] 需要系列をキットから変えたら「カスタム」で、需要を変更項目に含める', () => {
    expect(kitPreset(KIT_CONDITIONS, true)).toEqual({
      kind: 'CUSTOM',
      changes: ['demand'],
    });
  });
});
