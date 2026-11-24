import { ConflictError } from '../ports/index.js';

export class NotFoundError extends Error {
  constructor(message = '見つかりません') {
    super(message);
    this.name = 'NotFoundError';
  }
}
/**
 * 不明・形式不正の参加コード（区別しない。列挙の防止。AC1.2.2）。共有の契約では 403 `game.invitation_invalid`。
 * 旧い経路では、これまでどおり「見つからない」（404）として扱えるように、`NotFoundError` の一種にする。
 */
export class InvalidInvitationError extends NotFoundError {
  constructor(message = '参加コードが見つかりません') {
    super(message);
    this.name = 'InvalidInvitationError';
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

/**
 * 同じ冪等キーで、内容の違う要求（409。`app.idempotency_key_reused`）。
 * 旧い経路が、これまでどおり 409 の競合として扱えるように、競合（`ConflictError`）の一種にする。
 */
export class IdempotencyKeyReusedError extends ConflictError {
  constructor(message = '同じ冪等キーで、内容の違う要求です') {
    super(message);
    this.name = 'IdempotencyKeyReusedError';
  }
}

/**
 * 不明・失効・期限切れ・形式不正の観察用の招待コード（区別しない。列挙の防止。AC1.3.4）。
 * 共有の契約では 403 `game.invitation_invalid`。旧い経路では、これまでどおり 401 として扱えるように、`UnauthorizedError` の一種にする。
 */
export class InvalidObserverInvitationError extends UnauthorizedError {
  constructor(
    message = '招待が無効です（失効または期限切れ）。進行役に確認してください',
  ) {
    super(message);
    this.name = 'InvalidObserverInvitationError';
  }
}

/** このゲームに無い観察用の招待。共有の契約では 404 `game.invitation_not_found` */
export class InvitationNotFoundError extends NotFoundError {
  constructor(message = '招待が見つかりません') {
    super(message);
    this.name = 'InvitationNotFoundError';
  }
}

/** すでに失効している資格・招待の失効。共有の契約では 409 `game.credential_already_revoked` */
export class CredentialAlreadyRevokedError extends Error {
  constructor(message = 'すでに失効しています') {
    super(message);
    this.name = 'CredentialAlreadyRevokedError';
  }
}

/** 失効していない資格の再発行（有効な資格は置き換えない）。共有の契約では 409 `game.credential_not_revoked` */
export class CredentialNotRevokedError extends Error {
  constructor(
    message = '資格は失効していません。先に失効させてから、再発行してください',
  ) {
    super(message);
    this.name = 'CredentialNotRevokedError';
  }
}

/** ゲームが終了していない（振り返りと出力は、終了してから） */
export class NotEndedError extends Error {
  constructor(message = 'ゲームが終了してから、開けます') {
    super(message);
    this.name = 'NotEndedError';
  }
}

/** セッションが無い（ゲームがまだ開始されていない） */
export class NotActiveError extends Error {
  constructor(message = 'ゲームはまだ開始されていません') {
    super(message);
    this.name = 'NotActiveError';
  }
}

/** 資格は有効だが、他のゲーム・他の役割の操作 */
export class ForbiddenError extends Error {
  constructor(message = 'この操作は許可されていません') {
    super(message);
    this.name = 'ForbiddenError';
  }
}
