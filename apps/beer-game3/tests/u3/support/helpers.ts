import { expect } from 'vitest';
import { AppError } from '../../../src/server/errors.js';

/** AppError の種類を確かめ、そのエラーを返す。 */
export async function expectProblem(promise: Promise<unknown>, kind: string): Promise<AppError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).problem.kind).toBe(kind);
  return error as AppError;
}

/** 結果の種類（ok か Problem の kind）。 */
export async function outcome(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof AppError ? error.problem.kind : String(error)),
  );
}
