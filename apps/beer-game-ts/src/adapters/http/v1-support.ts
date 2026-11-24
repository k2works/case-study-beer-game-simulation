import type { FastifyReply, FastifyRequest } from 'fastify';
import { notFoundProblem, validationProblem } from './problems.js';
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

/**
 * `If-Match`（意思決定の版）。整数。`"3"` のように引用符で囲んでもよい。無ければ 0（初回の保存）。
 * 整数でなければ 422（field は `If-Match`）。
 */
export function ifMatchVersionOf(request: FastifyRequest): number {
  const raw = request.headers['if-match'];
  if (raw === undefined) return 0;
  const match = /^"?(\d{1,9})"?$/.exec(raw.trim());
  if (!match)
    throw validationProblem([
      {
        field: 'If-Match',
        message: 'If-Match は、意思決定の版（0 以上の整数）にしてください',
      },
    ]);
  return Number(match[1]);
}

/**
 * 資格の Cookie を読む。タブ別の名前（`X-Tab-Id` があるとき）を優先し、無ければ従来の名前を使う
 * （識別子を付ける前に発行した資格、識別子を付けない呼び出し元が発行した資格の移行。Kotlin 版と同じ。ADR-020）。
 * タブ自身は従来の名前を発行しないので、タブ間の分離は保たれる。
 */
const cookieValueOf = (
  request: FastifyRequest,
  nameOf: (tabId: string | null) => string,
): string | undefined =>
  request.cookies[nameOf(tabIdOf(request))] ?? request.cookies[nameOf(null)];

/** 資格（ブラウザセッションの Cookie）。無ければ空（認可の失敗として扱われる） */
export const tokenOf = (request: FastifyRequest): string =>
  cookieValueOf(request, sessionCookieName) ?? '';

/** 復帰資格の Cookie の値（`bg_recovery`） */
export const recoveryTokenOf = (request: FastifyRequest): string | undefined =>
  cookieValueOf(request, recoveryCookieName);

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
