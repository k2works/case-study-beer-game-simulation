import type { FastifyRequest } from 'fastify';
import { API_V1 } from './problems.js';

/**
 * 資格の Cookie の名前と属性（共有の契約の `securitySchemes`。ADR-020）。
 * - ブラウザセッション: `bg_session`（24 時間）
 * - 復帰資格: `bg_recovery`（30 日。送る経路は復帰の経路だけ）
 * リクエストヘッダー `X-Tab-Id`（英数字 16〜64 文字。画面がタブごとに作る。秘密ではない）があれば、Cookie の名前は
 * `bg_session_<X-Tab-Id>`・`bg_recovery_<X-Tab-Id>` になる（発行も読み取りも）。ヘッダーが無い・形が不正なら、既定の名前。
 */
export const SESSION_COOKIE = 'bg_session';
export const RECOVERY_COOKIE = 'bg_recovery';

export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
export const RECOVERY_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/** 復帰資格の Cookie を送る経路（復帰の経路だけ。ほかの要求には付かない） */
export const RECOVERY_PATH = `${API_V1}/participations/recover`;

const TAB_ID = /^[A-Za-z0-9]{16,64}$/;

/** `X-Tab-Id`。無い・形が不正なら null */
export function tabIdOf(
  request: Pick<FastifyRequest, 'headers'>,
): string | null {
  const raw = request.headers['x-tab-id'];
  return typeof raw === 'string' && TAB_ID.test(raw) ? raw : null;
}

export const sessionCookieName = (tabId: string | null): string =>
  tabId ? `${SESSION_COOKIE}_${tabId}` : SESSION_COOKIE;

export const recoveryCookieName = (tabId: string | null): string =>
  tabId ? `${RECOVERY_COOKIE}_${tabId}` : RECOVERY_COOKIE;

/** 発行する Cookie の属性。HttpOnly・SameSite=Strict は常に付け、`Secure` は HTTPS の環境でだけ付ける */
export function cookieOptions(kind: 'session' | 'recovery', secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'strict' as const,
    path: kind === 'session' ? '/' : RECOVERY_PATH,
    maxAge:
      kind === 'session' ? SESSION_MAX_AGE_SECONDS : RECOVERY_MAX_AGE_SECONDS,
  };
}
