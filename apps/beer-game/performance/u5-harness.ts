export class LatencyHistogram {
  private readonly values: number[] = [];
  get count() {
    return this.values.length;
  }
  record(start: number, end: number) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
      throw new Error('Latency samples require one monotonic clock');
    this.values.push(end - start);
  }
  p95() {
    if (!this.values.length) return 0;
    const sorted = [...this.values].sort((left, right) => left - right);
    return sorted[Math.ceil(sorted.length * 0.95) - 1];
  }
  max() {
    return this.values.length ? Math.max(...this.values) : 0;
  }
}

export async function runPollBurst<T>(
  clients: readonly T[],
  request: (client: T) => Promise<unknown>,
  now: () => number = () => performance.now(),
) {
  const histogram = new LatencyHistogram();
  await Promise.all(
    clients.map(async (client) => {
      const start = now();
      await request(client);
      histogram.record(start, now());
    }),
  );
  return histogram;
}
