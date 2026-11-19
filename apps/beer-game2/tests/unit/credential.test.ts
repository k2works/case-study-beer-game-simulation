import { describe, expect, it } from 'vitest';
import {
  CREDENTIAL_TTL,
  CredentialValidity,
} from '../../src/domain/credential.js';

const issuedAt = new Date('2026-11-11T00:00:00.000Z');
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);

describe('CredentialValidity', () => {
  it('[US3.2/AC3.2.5] 有効期限の直前までは有効で、期限ちょうど以降は無効（境界）', () => {
    const v = CredentialValidity.issue(issuedAt, 1000);
    expect(v.expiresAt).toEqual(ms(issuedAt, 1000));
    expect(CredentialValidity.isValid(v, ms(issuedAt, 999))).toBe(true);
    expect(CredentialValidity.isValid(v, ms(issuedAt, 1000))).toBe(false);
    expect(CredentialValidity.isValid(v, ms(issuedAt, 1001))).toBe(false);
  });

  it('[US3.2/AC3.2.5] 失効した資格は、期限内でも無効', () => {
    const v = CredentialValidity.revoke(
      CredentialValidity.issue(issuedAt, 1000),
      ms(issuedAt, 10),
    );
    expect(v.revokedAt).toEqual(ms(issuedAt, 10));
    expect(CredentialValidity.isValid(v, ms(issuedAt, 11))).toBe(false);
  });

  it('二度失効させても、最初の失効時刻を保つ', () => {
    const once = CredentialValidity.revoke(
      CredentialValidity.issue(issuedAt, 1000),
      ms(issuedAt, 10),
    );
    expect(CredentialValidity.revoke(once, ms(issuedAt, 20)).revokedAt).toEqual(
      ms(issuedAt, 10),
    );
  });

  it('有効期間の仮の既定値: ブラウザセッション 24 時間、復帰コード 30 日、観察用の招待 24 時間', () => {
    expect(CREDENTIAL_TTL).toEqual({
      sessionMs: 24 * 60 * 60 * 1000,
      recoveryMs: 30 * 24 * 60 * 60 * 1000,
      observerInvitationMs: 24 * 60 * 60 * 1000,
    });
  });

  it('有効期間が正でなければ発行できない', () => {
    expect(() => CredentialValidity.issue(issuedAt, 0)).toThrow();
  });
});
