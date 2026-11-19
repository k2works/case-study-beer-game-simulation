import { DomainError } from './values.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 保持と削除の方針（NF-S16） */
export const RETENTION = {
  defaultDays: 90,
  minDays: 1,
  maxDays: 3650,
  /** 削除後も、データベースの自動バックアップに残る最大の日数（運営者へ示す） */
  backupDays: 7,
  /** この回数だけ失敗したら、再試行をやめて恒久的な失敗として扱う */
  maxAttempts: 5,
  /** 削除の受領記録を残す期間 */
  receiptMs: 365 * DAY_MS,
} as const;

export interface RetentionPolicy {
  days: number;
  /** 作成時から数えた削除期限 */
  deleteAfter: Date;
  backupDays: number;
}

/** 保持方針。作成時から数え、日数は 1〜3650（既定 90） */
export function retentionPolicyOf(
  createdAt: Date,
  days: number = RETENTION.defaultDays,
): RetentionPolicy {
  if (
    !Number.isInteger(days) ||
    days < RETENTION.minDays ||
    days > RETENTION.maxDays
  )
    throw new DomainError('保持期間が無効です', [
      {
        problem: `保持期間は ${RETENTION.minDays}〜${RETENTION.maxDays} 日の整数です`,
        fix: `保持期間を ${RETENTION.minDays}〜${RETENTION.maxDays} 日にしてください`,
      },
    ]);
  return {
    days,
    deleteAfter: new Date(createdAt.getTime() + days * DAY_MS),
    backupDays: RETENTION.backupDays,
  };
}
