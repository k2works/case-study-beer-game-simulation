import { createHash } from 'node:crypto';
import {
  DuplicateError,
  type IdempotencyScope,
  type Repositories,
} from '../ports/index.js';
import { IdempotencyKeyReusedError } from './errors.js';

/**
 * 要求の指紋。項目の順序・省略に左右されない、正規化した JSON の SHA-256。同じキーの要求が「同じ内容」かを比べる。
 * 値には、資格（復帰コードなど）も入りうるので、平文で保存せず、ダイジェストだけを持つ。
 */
export function fingerprintOf(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .filter(([, x]) => x !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

/**
 * 冪等な実行（ゲームが決まっている操作）。同じキー・同じ内容の再送は、保存した応答を返し、内容が違えば
 * `IdempotencyKeyReusedError`。キーが無ければ（旧い経路）、冪等にしない。
 * **呼ぶ側は、認可（資格の検証）を済ませてから呼ぶ**（失効した資格での再送に、保存した応答を返さない。ADR-004）。
 * 応答は、JSON にできる値（暗号化して保存する）。
 */
export async function idempotently<T>(
  repos: Repositories,
  ctx: {
    gameId: string;
    scope: IdempotencyScope;
    key: string | undefined;
    fingerprint: string;
  },
  run: () => Promise<T>,
): Promise<T> {
  if (ctx.key === undefined) return run();
  const prior = await repos.idempotency.find(ctx.gameId, ctx.scope, ctx.key);
  if (prior) {
    if (prior.fingerprint !== ctx.fingerprint)
      throw new IdempotencyKeyReusedError();
    return prior.response as T;
  }
  const result = await run();
  await repos.idempotency.save({
    gameId: ctx.gameId,
    scope: ctx.scope,
    key: ctx.key,
    fingerprint: ctx.fingerprint,
    response: result,
  });
  return result;
}

/**
 * 同時の重複（同じキーの要求が、ほぼ同時に 2 つ届く）: 後から保存した側は一意制約に違反して失敗する。
 * その場合は 1 回だけやり直し、先に保存された応答を返す（503 にも 500 にもしない）。キーが無ければ、やり直さない。
 */
export async function retryOnDuplicate<T>(
  key: string | undefined,
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (e) {
    if (key !== undefined && e instanceof DuplicateError) return attempt();
    throw e;
  }
}
