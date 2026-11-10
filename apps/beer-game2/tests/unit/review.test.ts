import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ROLES } from '../../src/domain/role.js';
import { METRICS, buildReview, canDisclose } from '../../src/domain/review.js';
import { DomainError } from '../../src/domain/values.js';
import {
  AMPLIFICATION_DEMAND,
  AMPLIFICATION_ORDERS,
  amplificationRows,
} from '../support/amplification.js';

describe('buildReview', () => {
  const review = buildReview(amplificationRows());

  it('[US4.2/AC4.2.1] 週の軸が 1 から連続し、需要と、役割別の全指標が同じ軸で並ぶ', () => {
    expect(review.weeks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(review.demand).toEqual(AMPLIFICATION_DEMAND);
    for (const metric of METRICS) {
      for (const role of ROLES)
        expect(review.series[metric][role]).toHaveLength(12);
    }
  });

  it('[US4.2/AC4.2.1] 注文は役割別に、その週の意思決定をそのまま返す', () => {
    for (const role of ROLES)
      expect(review.series.order[role]).toEqual(AMPLIFICATION_ORDERS[role]);
  });

  it('[US4.2/AC4.2.1] 増幅: 上流ほど注文の最大値が大きい（需要 8 → 小売店 24 → 一次卸 84）', () => {
    const max = (xs: number[]) => Math.max(...xs);
    expect(max(review.demand)).toBe(8);
    expect(max(review.series.order.RETAILER)).toBe(24);
    expect(max(review.series.order.DISTRIBUTOR)).toBe(84);
    expect(max(review.series.order.WHOLESALER)).toBe(80);
    expect(max(review.series.order.DISTRIBUTOR)).toBeGreaterThan(
      max(review.series.order.RETAILER),
    );
  });

  it('[US4.2/AC4.2.1] 費用は最小単位で、累積と週次の整合が取れる（BR-09）', () => {
    for (const role of ROLES) {
      const cost = review.series.cost[role];
      const stock = review.series.inventory[role];
      const back = review.series.backlog[role];
      cost.forEach((c, i) => expect(c).toBe(stock[i]! * 50 + back[i]! * 100));
    }
  });

  it('[US4.2/AC4.2.3] 0 件は空の振り返りになる（エラーではない）', () => {
    const empty = buildReview([]);
    expect(empty.weeks).toEqual([]);
    expect(empty.demand).toEqual([]);
    for (const role of ROLES) expect(empty.series.order[role]).toEqual([]);
  });

  it('[US4.2/AC4.2.1] 役割が欠けた週や、週の抜けは不正なデータとして拒否する', () => {
    const rows = amplificationRows();
    expect(() =>
      buildReview(rows.filter((r) => !(r.week === 3 && r.role === 'FACTORY'))),
    ).toThrow(DomainError);
    expect(() => buildReview(rows.filter((r) => r.week !== 2))).toThrow(
      DomainError,
    );
  });

  it('[US4.2/AC4.2.4] 性質: 行の順序に依存せず、同じ結果になる', () => {
    const rows = amplificationRows();
    fc.assert(
      fc.property(
        fc.shuffledSubarray(rows, {
          minLength: rows.length,
          maxLength: rows.length,
        }),
        (shuffled) => {
          expect(buildReview(shuffled)).toEqual(review);
        },
      ),
    );
  });
});

describe('canDisclose（開示の判定）', () => {
  it('[US4.2/AC4.2.2] 終了したときだけ開示する', () => {
    expect(canDisclose('ENDED')).toBe(true);
    expect(canDisclose('ACTIVE')).toBe(false);
    expect(canDisclose(null)).toBe(false); // 未開始
  });
});
