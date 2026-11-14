import { describe, expect, it } from 'vitest';
import {
  METRICS,
  niceCeiling,
  showMarker,
  valueOf,
  weekTicks,
  type MetricId,
} from '../../../src/web/chart.js';
import { makeView } from './support.js';

describe('chart: 縦軸の上端、印の間引き、横軸の目盛り', () => {
  it('niceCeiling: 最大値以上の、読みやすい値（0 以下は 1）', () => {
    expect(niceCeiling(0)).toBe(1);
    expect(niceCeiling(-5)).toBe(1);
    expect(niceCeiling(1)).toBe(1);
    expect(niceCeiling(7)).toBe(10);
    expect(niceCeiling(30)).toBe(50);
    expect(niceCeiling(21)).toBe(25);
    expect(niceCeiling(1000)).toBe(1000);
    expect(niceCeiling(1001)).toBe(2000);
    for (const max of [3, 11, 99, 480, 12345, 98765]) {
      expect(niceCeiling(max)).toBeGreaterThanOrEqual(max);
    }
  });

  it('showMarker: 25 週までは毎週、超えるときは 1 週・最終週・5 週ごと', () => {
    expect([1, 2, 25].every((w) => showMarker(w, 25))).toBe(true);
    const shown = Array.from({ length: 50 }, (_, i) => i + 1).filter((w) => showMarker(w, 50));
    expect(shown).toEqual([1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
    expect(showMarker(26, 26)).toBe(true);
    expect(showMarker(7, 27)).toBe(false);
  });

  it('weekTicks: 15 週までは毎週、超えるときは 1 週と 5 週ごと', () => {
    expect(weekTicks(3)).toEqual([1, 2, 3]);
    expect(weekTicks(15)).toHaveLength(15);
    expect(weekTicks(20)).toEqual([1, 5, 10, 15, 20]);
    expect(weekTicks(0)).toEqual([]);
  });

  it('valueOf: 指標ごとの値の取り出し（費用は週ごと・累積）', () => {
    const week = makeView(2).roles[1]!.weeks[1]!;
    const expected: Record<MetricId, number> = {
      demand: week.ordersReceived,
      order: week.decision,
      inventory: week.inventory,
      backlog: week.backlog,
      shipped: week.shipped,
      cost: week.cumulativeCost,
    };
    for (const metric of METRICS) {
      expect(valueOf(week, metric.id, 'cumulative'), metric.id).toBe(expected[metric.id]);
    }
    expect(valueOf(week, 'cost', 'weekly')).toBe(week.weeklyCost);
    expect(METRICS.map((m) => m.id)).toEqual([
      'demand',
      'order',
      'inventory',
      'backlog',
      'shipped',
      'cost',
    ]);
  });
});
