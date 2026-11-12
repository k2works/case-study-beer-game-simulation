import type { Role } from './domain/types.js';

/** `Problem` の種類（contract-summary.md の C1）。 */
export type ProblemKind =
  | 'validation'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'state'
  | 'rate_limited'
  | 'unavailable'
  | 'internal';

export const PROBLEM_STATUS: Record<ProblemKind, number> = {
  validation: 422,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  state: 409,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

export interface FieldProblem {
  /** 入力の項目の名前（例: weekCount、quantity） */
  path: string;
  message: string;
}

/** 共通のエラー形式 `Problem`。reason と hint は日本語。fields は後方互換の追加項目。 */
export interface Problem {
  kind: ProblemKind;
  reason: string;
  hint: string;
  missingRoles?: Role[];
  fields?: FieldProblem[];
}

export class AppError extends Error {
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.reason);
    this.name = 'AppError';
    this.problem = problem;
  }

  get status(): number {
    return PROBLEM_STATUS[this.problem.kind];
  }
}

export const validationError = (reason: string, hint: string, fields?: FieldProblem[]): AppError =>
  new AppError({ kind: 'validation', reason, hint, ...(fields ? { fields } : {}) });

/** 無効な資格情報・権限のない操作。失敗の形を同じにして、コードの推測に手がかりを与えない。 */
export const forbiddenError = (
  reason = 'この操作を行う権限がありません',
  hint = '正しいコードで、もう一度操作してください',
): AppError => new AppError({ kind: 'forbidden', reason, hint });

export const notFoundError = (reason: string, hint = '一覧を取り直してください'): AppError =>
  new AppError({ kind: 'not_found', reason, hint });

export const conflictError = (reason: string, hint: string): AppError =>
  new AppError({ kind: 'conflict', reason, hint });

export const stateError = (reason: string, hint: string, missingRoles?: Role[]): AppError =>
  new AppError({ kind: 'state', reason, hint, ...(missingRoles ? { missingRoles } : {}) });

export const unavailableError = (
  reason = '同じゲームへの操作が重なっています',
  hint = 'しばらくして、もう一度操作してください',
): AppError => new AppError({ kind: 'unavailable', reason, hint });

export const internalError = (
  reason = 'サーバーで問題が起きました',
  hint = '少し待ってから、状態を取り直してください',
): AppError => new AppError({ kind: 'internal', reason, hint });

/** 保存の版が食い違った（安全装置。直列処理が働いていれば通常は起きない）。 */
export class VersionConflictError extends Error {
  constructor() {
    super('保存の版が食い違いました');
    this.name = 'VersionConflictError';
  }
}

/** 参加コードなどの照合用の値が重なった（生成をやり直す）。 */
export class CodeCollisionError extends Error {
  constructor() {
    super('コードが重なりました');
    this.name = 'CodeCollisionError';
  }
}

/** 起動の設定の誤り（鍵が無いなど）。起動を拒否する。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
