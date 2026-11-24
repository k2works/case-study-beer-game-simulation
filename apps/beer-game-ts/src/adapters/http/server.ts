import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import cookie from '@fastify/cookie';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import { ZodError } from 'zod';
import type { Application } from '../../application/index.js';
import {
  CredentialAlreadyRevokedError,
  CredentialNotRevokedError,
  DecisionConflictedError,
  DecisionsChangedViewError,
  ForbiddenError,
  IdempotencyKeyReusedError,
  InvalidInvitationError,
  InvalidObserverInvitationError,
  InvitationNotFoundError,
  NotActiveError,
  NotEndedError,
  NotFoundError,
  UnauthorizedError,
} from '../../application/errors.js';
import {
  AlreadyStartedError,
  DomainError,
  IncompleteDecisionsError,
  NotPausedError,
  NotPreparingError,
  ParticipantNotFoundError,
  PermissionError,
  SaveLimitReachedError,
  SessionEndedError,
  SessionPausedError,
  StaleError,
  StartConditionError,
  WeekAdvancedError,
} from '../../domain/values.js';
import {
  ConflictError,
  DuplicateError,
  type Metrics,
  type RateLimiter,
} from '../../ports/index.js';
import { NO_METRICS } from '../observability/emf.js';
import { idempotencyKeyOf } from './idempotency-key.js';
import {
  API_V1,
  ApiProblem,
  alreadyStartedProblem,
  badRequestProblem,
  credentialAlreadyRevokedProblem,
  credentialNotRevokedProblem,
  decisionConflictProblem,
  decisionsChangedProblem,
  gameNotEndedProblem,
  idempotencyKeyReusedProblem,
  incompleteDecisionsProblem,
  internalProblem,
  invalidInvitationProblem,
  invitationNotFoundProblem,
  isApiV1,
  notFoundProblem,
  notPausedProblem,
  notPreparingProblem,
  notReadyProblem,
  participantNotFoundProblem,
  payloadTooLargeProblem,
  saveLimitReachedProblem,
  startConditionProblem,
  retryExhaustedProblem,
  sendApiProblem,
  sessionEndedProblem,
  sessionNotActiveProblem,
  sessionPausedProblem,
  unauthorizedProblem,
  validationProblem,
  weekAdvancedProblem,
} from './problems.js';
import { registerApiV1Reads } from './routes-v1-reads.js';
import { rateLimited, registerApiV1Commands } from './routes-v1-commands.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HttpConfig {
  /** 変更系の要求を受ける送信元（Origin）。画面の配信元。開発・E2E では別のポートも許す */
  allowedOrigins: readonly string[];
  logLevel: string;
  /** 資格の Cookie に `Secure` を付けるか。省略時は付ける（HTTPS が前提） */
  secureCookies?: boolean;
}

export interface ServerDependencies {
  app: Application;
  ready: () => Promise<boolean>;
  /** 通知の受信が生きているか（`/api/v1/ready` の確認。省略時は生きているとみなす） */
  notifierReady?: () => boolean;
  /** 参加・復帰の専用のレート制限（総当たりの対策） */
  rateLimiter: RateLimiter;
  /** メトリクス（省略時は出さない） */
  metrics?: Metrics;
  config: HttpConfig;
  /** ログの出力先（テスト用。省略時は標準出力） */
  logStream?: Writable;
}

/**
 * @guidedTour walking-skeleton 30 HTTP の入口。Origin の検査、Cookie から資格の選択、zod による入力の検証、エラーの Problem JSON への変換を行う。**ルールは持たず**、ユースケースを呼ぶだけ。次は、ユースケース。
 *
 * @landmark HTTP の入口。Origin の検査、資格の選択、入力の検証、エラーの変換を、ここでまとめて行う。ルールは持たない。
 */
export function buildServer(deps: ServerDependencies): FastifyInstance {
  const { app, config } = deps;
  const server = Fastify({
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'res.headers["set-cookie"]',
        ],
        censor: '[REDACTED]',
      },
      ...(deps.logStream ? { stream: deps.logStream } : {}),
    },
    // 相関 ID: 要求の `x-correlation-id` が UUID ならそれを使い、そうでなければ作る（共有の契約）
    requestIdHeader: false,
    genReqId: (request) => {
      const given = request.headers['x-correlation-id'];
      return typeof given === 'string' && UUID.test(given)
        ? given
        : randomUUID();
    },
    // 本文の上限は 64 KB（NF-P12）。超えたら 413
    bodyLimit: 65_536,
  });

  server.register(cookie);

  // 本文の無い要求（開始・停止・再開など、契約が本文を定めない操作）に、`Content-Type: application/json` が付くことがある
  // （共有 UI と受け入れの準備がそうする）。Fastify の既定は空の本文を 400 にするので、空は「本文なし」として通し、
  // 本文が要る経路は、入力の検証（zod）が 422 にする。形の壊れた JSON は 400
  server.removeContentTypeParser('application/json');
  server.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      if (body === '') return done(null, undefined);
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(
          Object.assign(new Error('JSON を解釈できません'), {
            statusCode: 400,
          }),
          undefined,
        );
      }
    },
  );

  // セキュリティヘッダー（NF-S9）。API は JSON だけを返すので、CSP はすべて拒否でよい
  const SECURITY_HEADERS = {
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
  };
  server.addHook('onSend', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
    reply.headers(SECURITY_HEADERS);
  });

  // メトリクス: 要求ごとの応答時間と件数。次元のルートは、ID を含まない定義の形
  const metrics = deps.metrics ?? NO_METRICS;
  const invariantViolations = new WeakSet<FastifyRequest>();
  server.addHook('onResponse', async (request, reply) => {
    const status = reply.statusCode;
    metrics.emit(
      [
        { name: 'Latency', value: reply.elapsedTime, unit: 'Milliseconds' },
        { name: 'Requests', value: 1, unit: 'Count' },
        ...(status >= 500
          ? [{ name: 'ServerErrors', value: 1, unit: 'Count' as const }]
          : []),
        ...(status === 409
          ? [{ name: 'Conflicts', value: 1, unit: 'Count' as const }]
          : []),
        ...(status >= 500 || invariantViolations.has(request)
          ? [{ name: 'InvariantViolations', value: 1, unit: 'Count' as const }]
          : []),
      ],
      {
        Route: request.routeOptions.url ?? 'unknown',
        Method: request.method,
        StatusClass: `${Math.floor(status / 100)}xx`,
      },
    );
  });

  // 変更系: 送信元（Origin）の検査のあと、`Idempotency-Key` が必須（共有の契約）
  server.addHook('onRequest', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const origin = request.headers.origin;
    const allowed =
      origin !== undefined && config.allowedOrigins.includes(origin);
    if (!allowed) return sendApiProblem(reply, unauthorizedProblem());
    if (!isApiV1(request.url)) return;
    try {
      idempotencyKeyOf(request);
    } catch (error) {
      if (error instanceof ApiProblem) return sendApiProblem(reply, error);
      throw error;
    }
  });

  /** 失敗を、共有の契約の `code` を持つ problem+json にする */
  const toApiProblem = (error: FastifyError | Error): ApiProblem => {
    if (error instanceof ApiProblem) return error;
    if (error instanceof ZodError) {
      return validationProblem(
        error.issues.map((i) => ({
          field: i.path.join('.') || 'body',
          message: i.message,
        })),
      );
    }
    // 観察用の招待コードの失敗（UnauthorizedError の一種なので、資格の失敗より先に判定する）。区別しない
    if (error instanceof InvalidObserverInvitationError)
      return invalidInvitationProblem();
    if (
      error instanceof UnauthorizedError ||
      error instanceof ForbiddenError ||
      error instanceof PermissionError
    ) {
      return unauthorizedProblem();
    }
    // 競合（ConflictError）の一種なので、競合の写しより先に判定する
    if (error instanceof IdempotencyKeyReusedError)
      return idempotencyKeyReusedProblem();
    if (error instanceof NotEndedError) return gameNotEndedProblem();
    if (error instanceof NotActiveError) return sessionNotActiveProblem();
    // 不明・形式不正の参加コード（NotFoundError の一種なので、先に判定する）。区別しない（列挙の防止）
    if (error instanceof InvalidInvitationError)
      return invalidInvitationProblem();
    if (error instanceof InvitationNotFoundError)
      return invitationNotFoundProblem();
    if (error instanceof CredentialAlreadyRevokedError)
      return credentialAlreadyRevokedProblem();
    if (error instanceof CredentialNotRevokedError)
      return credentialNotRevokedProblem();
    if (error instanceof NotFoundError) return notFoundProblem();
    // ドメインの失敗のうち、契約が固有の code を定めるもの（一般のドメインの失敗の写しより先に判定する）
    if (error instanceof NotPreparingError) return notPreparingProblem();
    if (error instanceof AlreadyStartedError) return alreadyStartedProblem();
    if (error instanceof StartConditionError)
      return startConditionProblem(error.missingRoles);
    if (error instanceof ParticipantNotFoundError)
      return participantNotFoundProblem();
    if (error instanceof SessionPausedError) return sessionPausedProblem();
    if (error instanceof SessionEndedError) return sessionEndedProblem();
    if (error instanceof NotPausedError) return notPausedProblem();
    if (error instanceof SaveLimitReachedError)
      return saveLimitReachedProblem();
    if (error instanceof IncompleteDecisionsError)
      return incompleteDecisionsProblem(error.missingRoles);
    if (error instanceof WeekAdvancedError)
      return weekAdvancedProblem(error.requestedWeek, error.currentWeek);
    if (error instanceof DecisionConflictedError)
      return decisionConflictProblem(error.role, error.latest);
    if (error instanceof DecisionsChangedViewError)
      return decisionsChangedProblem(error.week, error.current);
    if (error instanceof ConflictError) return retryExhaustedProblem();
    if (error instanceof DomainError && !(error instanceof StaleError)) {
      return validationProblem(
        error.issues.length > 0
          ? error.issues.map((i) => ({
              field: i.field ?? 'body',
              message: i.fix,
              ...(i.week !== undefined ? { week: i.week } : {}),
            }))
          : [{ field: 'body', message: error.message }],
      );
    }
    const status = (error as FastifyError).statusCode;
    if (status === 413) return payloadTooLargeProblem();
    if (status === 404) return notFoundProblem();
    if (status && status >= 400 && status < 500) {
      return badRequestProblem('要求を処理できません。');
    }
    return internalProblem();
  };

  server.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof DuplicateError) invariantViolations.add(request);
    // 復帰・観察者の参加の失敗は、総当たりの検知のために記録する（コードは記録しない）
    if (
      error instanceof UnauthorizedError &&
      request.routeOptions.url === `${API_V1}/participations/recover`
    )
      request.log.warn({ ip: request.ip }, '復帰に失敗しました');
    if (
      error instanceof InvalidObserverInvitationError &&
      request.routeOptions.url === `${API_V1}/participations/observe`
    )
      request.log.warn({ ip: request.ip }, '観察者の参加に失敗しました');
    const mapped = toApiProblem(error);
    if (mapped.code === 'app.internal') {
      request.log.error({ err: error }, '予期しないエラー');
    }
    return sendApiProblem(reply, mapped);
  });

  // 経路が無い。code を持つ problem+json
  server.setNotFoundHandler((_request, reply) =>
    sendApiProblem(reply, notFoundProblem()),
  );

  // /health はコンテナのヘルスチェック、/ready は ALB のヘルスチェック（DB の確認）。
  // 共有の契約の getHealth・getReady は、/api/v1 の下（CloudFront 経由の合成監視もこちら）
  server.get('/health', async () => ({ status: 'ok' }));
  server.get('/ready', async (_request, reply) => {
    let ok: boolean;
    try {
      ok = await deps.ready();
    } catch {
      ok = false;
    }
    return reply
      .code(ok ? 200 : 503)
      .send({ status: ok ? 'ready' : 'unavailable' });
  });
  server.get(`${API_V1}/health`, async () => ({ status: 'ok' }));
  server.get(`${API_V1}/ready`, async (_request, reply) => {
    let database: boolean;
    try {
      database = await deps.ready();
    } catch {
      database = false;
    }
    const notifier = deps.notifierReady ? deps.notifierReady() : true;
    if (database && notifier) return { status: 'ok' };
    // 503 は必ず type を持つ problem+json（共有 UI が、負荷分散の外側の 503 と区別する）
    return sendApiProblem(reply, notReadyProblem({ database, notifier }));
  });

  registerApiV1Reads(server, app);
  registerApiV1Commands(server, {
    app,
    // 超えたら 429（`app.rate_limited`）＋ `Retry-After`（窓の長さ）
    limit: async (request, bucket) => {
      const ok = await deps.rateLimiter.hit(
        `${bucket}:${request.ip}`,
        new Date(),
      );
      if (!ok) {
        request.log.warn({ ip: request.ip, bucket }, 'レート制限を超えました');
        throw rateLimited();
      }
    },
    secureCookies: config.secureCookies ?? true,
  });

  return server;
}
