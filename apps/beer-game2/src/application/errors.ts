export class NotFoundError extends Error {
  constructor(message = '見つかりません') {
    super(message);
    this.name = 'NotFoundError';
  }
}
/** 資格が無い、または無効 */
export class UnauthorizedError extends Error {
  constructor(message = '参加または復帰が必要です') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}
/**
 * 共同入力の版の競合。拒否した側へ、最新の値・版・保存者の表示名を返す（同じ役割の担当にだけ起きる）。
 */
export class DecisionConflict extends Error {
  constructor(
    message: string,
    readonly latest: {
      quantity: number;
      version: number;
      /** 表示名。代理入力なら「進行役」 */
      savedBy: string;
    } | null,
  ) {
    super(message);
    this.name = 'DecisionConflict';
  }
}

/** 資格は有効だが、他のゲーム・他の役割の操作 */
export class ForbiddenError extends Error {
  constructor(message = 'この操作は許可されていません') {
    super(message);
    this.name = 'ForbiddenError';
  }
}
