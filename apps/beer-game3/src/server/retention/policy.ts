import { parseInteger } from '../env.js';

/**
 * 保持と自動終了の方針（RetentionPolicy、entities.md）。永続の実体ではなく、アプリケーションの設定から読む値で、
 * 全ゲームに共通。ゲームごとには記録しない（BR24.1）。値は起動時に一度読み、範囲の外なら起動を拒否する。
 */
export interface RetentionPolicy {
  /** 終了から削除までの日数（1〜3650） */
  retentionDays: number;
  /** 最後の操作から自動終了までの日数（1〜3650） */
  autoEndDays: number;
  /** 定期処理の間隔（分、1〜1440） */
  jobIntervalMinutes: number;
  /** 1 回の処理で、自動終了と削除のそれぞれに扱うゲームの数の上限（1〜1000） */
  batchLimit: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  retentionDays: 30,
  autoEndDays: 30,
  jobIntervalMinutes: 60,
  batchLimit: 100,
};

export const DAY_MS = 24 * 60 * 60 * 1000;

/** 環境変数から読む。未指定は既定。範囲の外や整数でない値は ConfigError（BR24.1、BR25.1、BR26.1）。 */
export function loadRetentionPolicy(env: Record<string, string | undefined>): RetentionPolicy {
  const d = DEFAULT_RETENTION_POLICY;
  return {
    retentionDays: parseInteger(env, 'RETENTION_DAYS', d.retentionDays, 1, 3650),
    autoEndDays: parseInteger(env, 'AUTO_END_DAYS', d.autoEndDays, 1, 3650),
    jobIntervalMinutes: parseInteger(
      env,
      'RETENTION_JOB_INTERVAL_MINUTES',
      d.jobIntervalMinutes,
      1,
      1440,
    ),
    batchLimit: parseInteger(env, 'RETENTION_BATCH_LIMIT', d.batchLimit, 1, 1000),
  };
}

/** 削除の対象とするための、終了の時刻の境界（これ以前に終了したゲームが期限切れ）。 */
export const expiredBefore = (now: Date, retentionDays: number): Date =>
  new Date(now.getTime() - retentionDays * DAY_MS);

/** 自動終了の対象とするための、最後の操作の時刻の境界（これ以前に操作されたゲームが放置）。 */
export const staleBefore = (now: Date, autoEndDays: number): Date =>
  new Date(now.getTime() - autoEndDays * DAY_MS);

/** 終了から保持期間を過ぎたか。「以降」の境界で判定する（BR24.2）。 */
export const isExpired = (endedAt: Date, now: Date, retentionDays: number): boolean =>
  endedAt.getTime() <= expiredBefore(now, retentionDays).getTime();

/** 最後の操作から自動終了の期間を過ぎたか。「以降」の境界で判定する（BR25.1）。 */
export const isStale = (lastOperationAt: Date, now: Date, autoEndDays: number): boolean =>
  lastOperationAt.getTime() <= staleBefore(now, autoEndDays).getTime();

/**
 * 起動の完了時に出す、有効な設定値の 1 行（info）と、既定より短いときの警告（NFR6.6）。
 * 範囲の中の入力ミス（たとえば 30 日のつもりで 3 日）への守りで、値は数値だけなので個人情報を含まない。
 */
export function describeRetentionPolicy(policy: RetentionPolicy): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [
    { time: new Date().toISOString(), level: 'info', event: 'retention_config', ...policy },
  ];
  const d = DEFAULT_RETENTION_POLICY;
  if (policy.retentionDays < d.retentionDays || policy.autoEndDays < d.autoEndDays) {
    lines.push({
      time: new Date().toISOString(),
      level: 'warn',
      event: 'retention_config_shorter_than_default',
      retentionDays: policy.retentionDays,
      autoEndDays: policy.autoEndDays,
      defaultRetentionDays: d.retentionDays,
      defaultAutoEndDays: d.autoEndDays,
    });
  }
  return lines;
}
