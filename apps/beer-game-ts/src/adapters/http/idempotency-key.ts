import type { FastifyRequest } from 'fastify';
import { badRequestProblem } from './problems.js';

/** `Idempotency-Key` の長さの上限（文字） */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/**
 * `Idempotency-Key`（共有の契約では、変更系は必須）。1〜200 文字の、表示できる ASCII。
 * 満たさなければ 400（`validation.invalid_input`）。
 */
export function idempotencyKeyOf(
  request: Pick<FastifyRequest, 'headers'>,
): string {
  const raw = request.headers['idempotency-key'];
  if (typeof raw !== 'string') {
    throw badRequestProblem('Idempotency-Key ヘッダーが必要です。');
  }
  if (
    raw.length < 1 ||
    raw.length > IDEMPOTENCY_KEY_MAX_LENGTH ||
    !PRINTABLE_ASCII.test(raw)
  ) {
    throw badRequestProblem(
      `Idempotency-Key は 1〜${IDEMPOTENCY_KEY_MAX_LENGTH} 文字の、表示できる ASCII にしてください。`,
    );
  }
  return raw;
}
