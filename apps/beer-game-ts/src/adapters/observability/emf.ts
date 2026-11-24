import type { Metric, Metrics } from '../../ports/index.js';

/**
 * CloudWatch の Embedded Metric Format。1 行の JSON をログに書くと、CloudWatch がメトリクスとして取り出す
 * （追加のサーバーやエージェントを持たない）。次元にゲームや参加者の ID を入れない。
 */
export class EmfMetrics implements Metrics {
  constructor(
    private readonly options: {
      write: (line: string) => void;
      namespace: string;
      environment: string;
      now: () => number;
    },
  ) {}

  emit(metrics: readonly Metric[], dimensions: Record<string, string> = {}) {
    if (metrics.length === 0) return;
    const dims = { Environment: this.options.environment, ...dimensions };
    const doc: Record<string, unknown> = {
      _aws: {
        Timestamp: this.options.now(),
        CloudWatchMetrics: [
          {
            Namespace: this.options.namespace,
            // 環境だけの組（アラームで全体を合計する）と、指定の次元を加えた組
            Dimensions:
              Object.keys(dimensions).length === 0
                ? [['Environment']]
                : [['Environment'], Object.keys(dims).sort()],
            Metrics: metrics.map((m) => ({ Name: m.name, Unit: m.unit })),
          },
        ],
      },
      ...dims,
    };
    for (const m of metrics) doc[m.name] = m.value;
    this.options.write(JSON.stringify(doc));
  }
}

/** 何もしないメトリクス（テストと、出力しない環境） */
export const NO_METRICS: Metrics = { emit: () => {} };
