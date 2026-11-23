import { describe, expect, it } from 'vitest';
import { EmfMetrics } from '../../src/adapters/observability/emf.js';

describe('EmfMetrics（CloudWatch Embedded Metric Format）', () => {
  it('[US6.1/AC6.1.3] 1 行の JSON に、名前空間・次元の組（環境だけ、と環境＋指定の次元）・メトリクスの定義と値を出す', () => {
    const lines: string[] = [];
    const metrics = new EmfMetrics({
      write: (l) => lines.push(l),
      namespace: 'BeerGame2',
      environment: 'staging',
      now: () => 1_700_000_000_000,
    });
    metrics.emit(
      [
        { name: 'Latency', value: 12.5, unit: 'Milliseconds' },
        { name: 'Requests', value: 1, unit: 'Count' },
      ],
      { Route: '/api/games/:id/decision', Method: 'PUT' },
    );
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      _aws: {
        Timestamp: 1_700_000_000_000,
        CloudWatchMetrics: [
          {
            Namespace: 'BeerGame2',
            // 環境だけの組は、アラームで全ルートを合計するため
            Dimensions: [['Environment'], ['Environment', 'Method', 'Route']],
            Metrics: [
              { Name: 'Latency', Unit: 'Milliseconds' },
              { Name: 'Requests', Unit: 'Count' },
            ],
          },
        ],
      },
      Environment: 'staging',
      Method: 'PUT',
      Route: '/api/games/:id/decision',
      Latency: 12.5,
      Requests: 1,
    });
  });

  it('次元が無ければ、環境だけを次元にする', () => {
    const lines: string[] = [];
    new EmfMetrics({
      write: (l) => lines.push(l),
      namespace: 'BeerGame2',
      environment: 'production',
      now: () => 0,
    }).emit([{ name: 'RetentionDeleted', value: 3, unit: 'Count' }]);
    const doc = JSON.parse(lines[0]!);
    expect(doc._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Environment']]);
    expect(doc.RetentionDeleted).toBe(3);
  });

  it('メトリクスが空なら、何も出さない', () => {
    const lines: string[] = [];
    new EmfMetrics({
      write: (l) => lines.push(l),
      namespace: 'N',
      environment: 'e',
      now: () => 0,
    }).emit([]);
    expect(lines).toEqual([]);
  });
});
