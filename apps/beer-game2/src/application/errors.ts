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
/** 資格は有効だが、他のゲーム・他の役割の操作 */
export class ForbiddenError extends Error {
  constructor(message = 'この操作は許可されていません') {
    super(message);
    this.name = 'ForbiddenError';
  }
}
