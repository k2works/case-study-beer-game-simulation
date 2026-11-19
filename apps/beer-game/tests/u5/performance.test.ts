import { describe, expect, it, vi } from 'vitest';
import { LatencyHistogram, runPollBurst } from '../../performance/u5-harness.js';

describe('Given a single-clock browser performance measurement', () => {
  it('calculates the end-to-end p95 from complete operations', () => {
    const histogram = new LatencyHistogram();
    for (let index = 0; index < 20; index++)
      histogram.record(index * 1000, index * 1000 + (index === 19 ? 900 : 100));
    expect(histogram.count).toBe(20);
    expect(histogram.p95()).toBe(100);
    expect(histogram.max()).toBe(900);
  });

  it('issues a full 75-user polling burst and counts every response', async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const histogram = await runPollBurst(
      Array.from({ length: 75 }, (_, index) => index),
      request,
      () => 100,
    );
    expect(request).toHaveBeenCalledTimes(75);
    expect(histogram.count).toBe(75);
  });
});
