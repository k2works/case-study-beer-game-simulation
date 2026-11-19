/**
 * 資格情報と試行の窓の数値（NFR 要件の仮の値。設定で上書きできる）。
 * 時間はすべてミリ秒。
 */
export interface AccessPolicy {
  /** 復帰用 token の有効期間（最後の操作から）。既定 24 時間（BR17.1） */
  tokenTtlMs: number;
  /** lastUsedAt を書き込む最短の間隔。既定 1 分（BR17.2） */
  touchIntervalMs: number;
  /** 参加の無効な試行を数える窓の長さ。既定 60 秒（BR18.2） */
  joinWindowMs: number;
  /** 窓に許す件数。これを超える（既定 11 件目の）試行を拒否する（BR18.2） */
  joinMaxAttempts: number;
}

export const DEFAULT_ACCESS_POLICY: AccessPolicy = {
  tokenTtlMs: 24 * 60 * 60 * 1000,
  touchIntervalMs: 60 * 1000,
  joinWindowMs: 60 * 1000,
  joinMaxAttempts: 10,
};

/** 窓の古い行を削除する周期。既定 10 分（reliability-design.md） */
export const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export function withDefaults(policy: Partial<AccessPolicy> | undefined): AccessPolicy {
  return { ...DEFAULT_ACCESS_POLICY, ...policy };
}
