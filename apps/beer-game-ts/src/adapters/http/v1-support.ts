import type { FastifyReply, FastifyRequest } from 'fastify';
import { notFoundProblem } from './problems.js';
import {
  cookieOptions,
  recoveryCookieName,
  sessionCookieName,
  tabIdOf,
} from './session-cookies.js';

/** 共有の API の契約（/api/v1）の経路で、共通に使う補助 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 経路の ID（UUID）。UUID でなければ 404 */
export function idParam(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, string>)[name];
  if (typeof value !== 'string' || !UUID.test(value)) throw notFoundProblem();
  return value;
}

/** 資格（ブラウザセッションの Cookie）。`X-Tab-Id` があれば、タブ別の名前。無ければ空（認可の失敗として扱われる） */
export const tokenOf = (request: FastifyRequest): string =>
  request.cookies[sessionCookieName(tabIdOf(request))] ?? '';

/** 復帰資格の Cookie の値（`bg_recovery`。`X-Tab-Id` があれば、タブ別の名前） */
export const recoveryTokenOf = (request: FastifyRequest): string | undefined =>
  request.cookies[recoveryCookieName(tabIdOf(request))] ?? undefined;

/**
 * 資格の Cookie を発行する。ブラウザセッション（`bg_session`。24 時間）と、復帰資格（`bg_recovery`。30 日。復帰の経路だけ）。
 * `X-Tab-Id` があれば、Cookie の名前はタブ別になる（ADR-020）。
 */
export function issueCookies(
  request: FastifyRequest,
  reply: FastifyReply,
  credentials: { session?: string; recovery?: string },
  secure: boolean,
): void {
  const tab = tabIdOf(request);
  if (credentials.session !== undefined)
    reply.setCookie(
      sessionCookieName(tab),
      credentials.session,
      cookieOptions('session', secure),
    );
  if (credentials.recovery !== undefined)
    reply.setCookie(
      recoveryCookieName(tab),
      credentials.recovery,
      cookieOptions('recovery', secure),
    );
}
