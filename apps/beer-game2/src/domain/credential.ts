import { DomainError } from './values.js';

/**
 * 資格の有効性（発行時刻からの有効期限と、失効時刻）。資格の種類（ブラウザセッション、復帰コード）に共通。
 * 時刻は、注入された時計から受け取る（境界をテストできる）。
 */
export interface CredentialValidity {
  expiresAt: Date;
  revokedAt?: Date;
}

/**
 * 有効期間の**仮の既定値**（運営者と未合意。Unit 定義の未決事項 1）。合意したら、ここだけを変える。
 */
export const CREDENTIAL_TTL = {
  /** ブラウザセッション（Cookie） */
  sessionMs: 24 * 60 * 60 * 1000,
  /** 復帰コード（参加者・進行役） */
  recoveryMs: 30 * 24 * 60 * 60 * 1000,
  /** 観察用の招待（研修の 1 日） */
  observerInvitationMs: 24 * 60 * 60 * 1000,
} as const;

export const CredentialValidity = {
  issue(at: Date, ttlMs: number): CredentialValidity {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)
      throw new DomainError('資格の有効期間は正の整数（ミリ秒）です');
    return { expiresAt: new Date(at.getTime() + ttlMs) };
  },
  revoke(v: CredentialValidity, at: Date): CredentialValidity {
    return v.revokedAt ? v : { ...v, revokedAt: at };
  },
  /** 失効しておらず、期限より前なら有効 */
  isValid(v: CredentialValidity, at: Date): boolean {
    return v.revokedAt === undefined && at.getTime() < v.expiresAt.getTime();
  },
};
