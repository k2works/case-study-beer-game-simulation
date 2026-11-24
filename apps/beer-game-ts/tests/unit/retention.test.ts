import { describe, expect, it } from 'vitest';
import { RETENTION, retentionPolicyOf } from '../../src/domain/retention.js';
import { DomainError } from '../../src/domain/values.js';

const created = new Date('2026-11-11T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('retentionPolicyOf（保持方針）', () => {
  it('[US5.1/AC5.1.1] 未設定なら 90 日で、作成から 90 日後が削除期限', () => {
    expect(retentionPolicyOf(created)).toEqual({
      days: 90,
      deleteAfter: new Date(created.getTime() + 90 * DAY),
      backupDays: 7,
    });
  });

  it.each([1, 3650])('[US5.1/AC5.1.1] %i 日（境界）を設定できる', (days) => {
    expect(retentionPolicyOf(created, days).days).toBe(days);
  });

  it.each([0, 3651, 1.5])('保持日数 %s は拒否し、修正内容を示す', (days) => {
    try {
      retentionPolicyOf(created, days);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).issues[0]!.fix).toMatch(/1〜3650/);
    }
  });

  it('[US5.1/AC5.1.5] バックアップに残る期間（7 日）と、恒久的な失敗までの試行回数（5 回）を持つ', () => {
    expect(RETENTION).toMatchObject({ backupDays: 7, maxAttempts: 5 });
  });
});
