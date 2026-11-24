import type { FastifyReply } from 'fastify';

/**
 * problem+json（RFC 9457）。共有の契約（apps/beer-game-contracts/openapi.yaml）の `Problem`。
 * `type` は `/problems/{code}`（相対 URI）、拡張メンバー `code` に同じ値を持つ。
 * バックエンド自身が返す失敗（503 を含む）は、必ず `type` を持つ（共有 UI が、`type` の無い失敗を、
 * 負荷分散などの外側の失敗とみなして再送するため）。
 */

/** 契約の `ErrorCode`（小文字のドット区切り `<領域>.<名前>`）。契約の `components.schemas.ErrorCode` と一致する（契約テストが検査する） */
export const ERROR_CODES = [
  'session.decision_conflict',
  'session.week_advanced',
  'session.decisions_changed',
  'session.already_started',
  'session.already_ended',
  'session.not_active',
  'session.paused',
  'session.not_paused',
  'session.save_limit_reached',
  'session.incomplete_decisions',
  'game.invitation_invalid',
  'game.not_preparing',
  'game.already_created',
  'game.participant_not_found',
  'game.start_condition_not_met',
  'game.credential_already_revoked',
  'game.credential_not_revoked',
  'game.not_ended',
  'game.invitation_not_found',
  'validation.invalid_input',
  'app.retry_exhausted',
  'app.idempotency_key_reused',
  'app.unauthorized',
  'app.internal',
  'app.not_ready',
  'app.rate_limited',
  'request.too_large',
  'request.not_found',
  'request.method_not_allowed',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** 入力の項目ごとの誤り。`week` は需要系列の誤りの対象週、`message` は修正内容 */
export interface FieldError {
  field: string;
  message: string;
  week?: number;
}

/** HTTP で返す、`code` を持つ失敗 */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly title: string,
    readonly detail?: string,
    /** 契約が code ごとに定める拡張メンバー（`errors`、`checks`、`missingRoles` など） */
    readonly extras: Record<string, unknown> = {},
    /** `Retry-After`（秒）。`app.retry_exhausted`（1 秒）と `app.rate_limited`（窓の残り秒数）にだけ付ける */
    readonly retryAfterSeconds?: number,
  ) {
    super(detail ?? title);
    this.name = 'ApiProblem';
  }
}

/** 資格が無い・無効・権限が無い、はすべて同じ本文（存在の有無・業務の理由を明かさない。NF-S12） */
export const unauthorizedProblem = () =>
  new ApiProblem(403, 'app.unauthorized', 'この操作を行う権限がありません。');

export const badRequestProblem = (detail: string) =>
  new ApiProblem(
    400,
    'validation.invalid_input',
    'リクエストを解釈できません。',
    detail,
  );

/** 項目ごとの誤りを、すべて集めて返す（AC1.1.2、AC2.2.2） */
export const validationProblem = (errors: FieldError[]) =>
  new ApiProblem(
    422,
    'validation.invalid_input',
    '入力に誤りがあります。',
    undefined,
    { errors },
  );

export const notFoundProblem = () =>
  new ApiProblem(404, 'request.not_found', '指定された対象が見つかりません。');

export const payloadTooLargeProblem = () =>
  new ApiProblem(
    413,
    'request.too_large',
    'リクエストが大きすぎます（64 KB まで）。',
  );

export const rateLimitedProblem = (retryAfterSeconds: number) =>
  new ApiProblem(
    429,
    'app.rate_limited',
    '要求が多すぎます。しばらくしてからお試しください。',
    undefined,
    {},
    retryAfterSeconds,
  );

/** 同時の書き込みの競合で、再試行の上限に達した。すぐに再送してよい（1 秒） */
export const retryExhaustedProblem = () =>
  new ApiProblem(
    503,
    'app.retry_exhausted',
    '混み合っています。しばらくしてからもう一度お試しください。',
    undefined,
    {},
    1,
  );

/** 不明・形式不正の参加コード。区別しない（列挙の防止。AC1.2.2） */
export const invalidInvitationProblem = () =>
  new ApiProblem(
    403,
    'game.invitation_invalid',
    '参加コードが正しくありません。進行役に確認してください。',
  );

/** 準備中でないゲームへの、準備中だけの操作（参加の受付の終了など） */
export const notPreparingProblem = () =>
  new ApiProblem(
    409,
    'game.not_preparing',
    'このゲームは、準備中ではありません（参加の受付を終了しています）。',
  );

/** すでに開始されたゲームの開始 */
export const alreadyStartedProblem = () =>
  new ApiProblem(
    409,
    'session.already_started',
    'このゲームは、すでに開始されています。',
  );

/** 開始の条件を満たさない（役割が足りない）。不足する役割を示す */
export const startConditionProblem = (missingRoles: readonly string[]) =>
  new ApiProblem(
    409,
    'game.start_condition_not_met',
    '開始できません。4 つの役割に、参加者がそろっていません。',
    undefined,
    { missingRoles },
  );

/** このゲームの参加者ではない */
export const participantNotFoundProblem = () =>
  new ApiProblem(
    404,
    'game.participant_not_found',
    'このゲームの参加者が見つかりません。',
  );

/** 同じ冪等キーで、内容の違う要求（ADR-004） */
export const idempotencyKeyReusedProblem = () =>
  new ApiProblem(
    409,
    'app.idempotency_key_reused',
    '同じ冪等キーで、内容の違う要求です。新しいキーで送ってください。',
  );

/** ゲームが終了していない（振り返り・出力は、終了後だけ。AC4.2.2） */
export const gameNotEndedProblem = () =>
  new ApiProblem(409, 'game.not_ended', 'ゲームが終了してから、開けます。');

/** セッションが無い（ゲームが開始されていない） */
export const sessionNotActiveProblem = () =>
  new ApiProblem(409, 'session.not_active', 'ゲームはまだ開始されていません。');

export const internalProblem = () =>
  new ApiProblem(
    500,
    'app.internal',
    '予期しないエラーが発生しました。相関 ID を添えて連絡してください。',
  );

/** 準備できていない（`/ready`）。どの確認が失敗したかを `checks` で返す */
export const notReadyProblem = (checks: {
  database: boolean;
  notifier: boolean;
}) =>
  new ApiProblem(503, 'app.not_ready', '準備できていません。', undefined, {
    checks,
  });

/** 契約のパスの接頭辞（`servers[0].url`）。この接頭辞の経路は、新しい problem+json（`code` つき）で応答する */
export const API_V1 = '/api/v1';

export function isApiV1(url: string): boolean {
  return (
    url === API_V1 ||
    url.startsWith(`${API_V1}/`) ||
    url.startsWith(`${API_V1}?`)
  );
}

/** problem+json を送る。相関 ID は、要求の ID（`x-correlation-id`）と同じ */
export function sendApiProblem(reply: FastifyReply, problem: ApiProblem) {
  if (problem.retryAfterSeconds !== undefined) {
    reply.header('retry-after', String(problem.retryAfterSeconds));
  }
  return reply
    .code(problem.status)
    .type('application/problem+json')
    .send({
      type: `/problems/${problem.code}`,
      title: problem.title,
      status: problem.status,
      ...(problem.detail ? { detail: problem.detail } : {}),
      code: problem.code,
      correlationId: reply.request.id,
      ...problem.extras,
    });
}
