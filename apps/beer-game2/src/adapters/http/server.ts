import { createHash, randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import cookie from '@fastify/cookie';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z, ZodError } from 'zod';
import type { Application } from '../../application/index.js';
import {
  DecisionConflict,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../application/errors.js';
import { DISCLOSURE_POLICIES } from '../../domain/conditions.js';
import { ROLES } from '../../domain/role.js';
import {
  DomainError,
  PermissionError,
  StaleError,
} from '../../domain/values.js';
import {
  ConflictError,
  DuplicateError,
  type ChangeNotifier,
  type Metrics,
  type RateLimiter,
} from '../../ports/index.js';
import { NO_METRICS } from '../observability/emf.js';

export interface HttpConfig {
  allowedOrigin: string;
  logLevel: string;
}

export interface ServerDependencies {
  app: Application;
  ready: () => Promise<boolean>;
  notifier: ChangeNotifier;
  /** 参加・復帰の専用のレート制限（総当たりの対策） */
  rateLimiter: RateLimiter;
  /** メトリクス（省略時は出さない） */
  metrics?: Metrics;
  config: HttpConfig;
  /** ログの出力先（テスト用。省略時は標準出力） */
  logStream?: Writable;
}

/** 進行役と参加者の資格は別の Cookie。同じブラウザで、進行役が参加者を兼ねられる */
export const COOKIE = {
  facilitator: 'bg_facilitator',
  participant: 'bg_participant',
  observer: 'bg_observer',
} as const;
type Kind = keyof typeof COOKIE;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly title = 'Bad Request',
  ) {
    super(message);
  }
}

const roleSchema = z.enum(ROLES);
const createBody = z.object({
  weeks: z.number().int(),
  demand: z.array(z.number()).optional(),
  commitMode: z.enum(['MANUAL', 'AUTO']).optional(),
  // 保持期間（日）。範囲の検査はドメイン
  retentionDays: z.number().optional(),
  // 範囲の検査はドメイン（項目ごとの修正内容を返す）。ここでは形と、未知の項目だけを拒否する
  conditions: z
    .strictObject({
      initialInventory: z.number(),
      orderDelayWeeks: z.number(),
      shipmentDelayWeeks: z.number(),
      productionDelayWeeks: z.number(),
      holdingCostMinor: z.number(),
      backlogCostMinor: z.number(),
      disclosure: z.enum(DISCLOSURE_POLICIES),
    })
    .partial()
    .optional(),
});
const joinBody = z.object({
  joinCode: z.string().min(1),
  displayName: z.string(),
});
const assignBody = z.object({
  participantId: z.string().min(1),
  role: roleSchema,
});
const decisionBody = z.object({ role: roleSchema, quantity: z.number() });
const recoverBody = z.object({ code: z.string().max(200) });
const observeBody = z.object({
  code: z.string().max(200),
  displayName: z.string().optional(),
});
const reissueBody = z.discriminatedUnion('target', [
  z.object({ target: z.literal('FACILITATOR') }),
  z.object({
    target: z.literal('PARTICIPANT'),
    participantId: z.string().min(1),
  }),
]);
const commitBody = z.object({ week: z.number().int() });
const commitModeBody = z.object({ commitMode: z.enum(['MANUAL', 'AUTO']) });
const exportQuery = z.object({ format: z.enum(['csv', 'json']) });

function ifMatch(request: FastifyRequest): number {
  const raw = request.headers['if-match'];
  const n =
    typeof raw === 'string' ? Number(raw.replace(/"/g, '')) : Number.NaN;
  if (!Number.isInteger(n) || n < 0)
    throw new HttpError(400, 'If-Match ヘッダーに版が必要です');
  return n;
}

function problem(
  reply: FastifyReply,
  status: number,
  title: string,
  detail: string,
  issues?: unknown,
  extensions: Record<string, unknown> = {},
) {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({
      type: 'about:blank',
      title,
      status,
      detail,
      ...(issues ? { issues } : {}),
      ...extensions,
      correlationId: reply.request.id,
    });
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
    requestIdHeader: 'x-correlation-id',
    genReqId: () => randomUUID(),
  });

  server.register(cookie);

  server.addHook('onSend', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
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
  // SSE の接続数（このタスクの現在の値。タスクの合計はダッシュボードで足し合わせる）
  let sseConnections = 0;
  const emitConnections = () =>
    metrics.emit([
      { name: 'SseConnections', value: sseConnections, unit: 'Count' },
    ]);
  const committed = (kind: 'MANUAL' | 'AUTO') =>
    metrics.emit([{ name: 'WeekCommitted', value: 1, unit: 'Count' }], {
      CommitKind: kind,
    });

  server.addHook('onRequest', async (request, reply) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      if (request.headers.origin !== config.allowedOrigin) {
        return problem(reply, 403, 'Forbidden', '許可されていない送信元です');
      }
    }
  });

  server.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof ZodError) {
      return problem(
        reply,
        400,
        'Bad Request',
        '入力の形式が正しくありません',
        error.issues.map((i) => ({
          problem: i.message,
          fix: `${i.path.join('.') || '本文'} を確認してください`,
        })),
      );
    }
    if (error instanceof HttpError)
      return problem(reply, error.status, error.title, error.message);
    if (error instanceof UnauthorizedError) {
      // 復帰の失敗は、総当たりの検知のために記録する（コードは記録しない）
      if (request.routeOptions.url === '/api/recover')
        request.log.warn({ ip: request.ip }, '復帰に失敗しました');
      if (request.routeOptions.url === '/api/observe')
        request.log.warn({ ip: request.ip }, '観察者の参加に失敗しました');
      return problem(reply, 401, 'Unauthorized', error.message);
    }
    if (error instanceof ForbiddenError)
      return problem(reply, 403, 'Forbidden', error.message);
    if (error instanceof NotFoundError)
      return problem(reply, 404, 'Not Found', error.message);
    // 共同入力の競合: 最新の値・版・保存者を同じ応答で返す（同じ役割の担当にだけ起きる）
    if (error instanceof DecisionConflict) {
      return problem(reply, 409, 'Conflict', error.message, undefined, {
        latest: error.latest,
      });
    }
    if (error instanceof DuplicateError) invariantViolations.add(request);
    if (error instanceof ConflictError || error instanceof StaleError) {
      return problem(reply, 409, 'Conflict', error.message);
    }
    if (error instanceof PermissionError) {
      return problem(reply, 403, 'Forbidden', error.message);
    }
    if (error instanceof DomainError) {
      return problem(
        reply,
        422,
        'Unprocessable Content',
        error.message,
        error.issues,
      );
    }
    const status = (error as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      return problem(reply, status, 'Bad Request', '要求を処理できません');
    }
    request.log.error({ err: error }, '予期しないエラー');
    return problem(
      reply,
      500,
      'Internal Server Error',
      '予期しないエラーが発生しました。相関 ID を添えて連絡してください',
    );
  });

  /** 候補の資格のうち、このゲームのものを選ぶ（別のゲームの古い資格は使わない） */
  const tokenOf = (request: FastifyRequest, ...kinds: Kind[]) => {
    const tokens = kinds
      .map((k) => request.cookies[COOKIE[k]])
      .filter((t): t is string => Boolean(t));
    return app.identify({ tokens, gameId: gameParam(request) });
  };
  const setSession = (reply: FastifyReply, kind: Kind, value: string) =>
    reply.setCookie(COOKIE[kind], value, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 24 * 60 * 60,
    });
  const gameParam = (request: FastifyRequest) =>
    (request.params as { id: string }).id;

  /** 参加・復帰の専用のレート制限。送信元ごと、エンドポイントごとに数える */
  const limit = async (request: FastifyRequest, name: string) => {
    const ok = await deps.rateLimiter.hit(`${name}:${request.ip}`, new Date());
    if (!ok) {
      request.log.warn(
        { ip: request.ip, bucket: name },
        'レート制限を超えました',
      );
      throw new HttpError(
        429,
        '試行が多すぎます。時間をおいてから、もう一度試してください',
        'Too Many Requests',
      );
    }
  };

  server.get('/health', async () => ({ status: 'ok' }));
  // /ready は ALB のヘルスチェック、/api/ready は CloudFront 経由の合成監視（/api/* だけが API へ届く）
  for (const path of ['/ready', '/api/ready'])
    server.get(path, async (_request, reply) => {
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

  server.post('/api/games', async (request, reply) => {
    const body = createBody.parse(request.body);
    const created = await app.createGame(body);
    setSession(reply, 'facilitator', created.facilitatorToken);
    // 復帰コードは、この応答で一度だけ返す（保存はダイジェストだけ）
    return reply.code(201).send({
      gameId: created.gameId,
      joinCode: created.joinCode,
      recoveryCode: created.recoveryCode,
    });
  });

  server.post('/api/join', async (request, reply) => {
    await limit(request, 'join');
    const body = joinBody.parse(request.body);
    const joined = await app.joinGame(body);
    setSession(reply, 'participant', joined.token);
    return reply.code(201).send({
      gameId: joined.gameId,
      participantId: joined.participantId,
      recoveryCode: joined.recoveryCode,
    });
  });

  // 復帰コードで戻る。新しいブラウザセッションの Cookie を設定する
  server.post('/api/recover', async (request, reply) => {
    await limit(request, 'recover');
    const body = recoverBody.parse(request.body);
    const back = await app.recover(body);
    setSession(
      reply,
      back.kind === 'FACILITATOR' ? 'facilitator' : 'participant',
      back.token,
    );
    return {
      gameId: back.gameId,
      kind: back.kind,
      gameStatus: back.gameStatus,
      ...(back.participantId ? { participantId: back.participantId } : {}),
    };
  });

  // 観察用の招待（進行役）。招待コードは、この応答で一度だけ返す
  server.post('/api/games/:id/observer-invitations', async (request, reply) => {
    const issued = await app.issueObserverInvitation({
      token: await tokenOf(request, 'facilitator', 'participant', 'observer'),
      gameId: gameParam(request),
    });
    return reply.code(201).send(issued);
  });

  server.delete(
    '/api/games/:id/observer-invitations/:invitationId',
    async (request, reply) => {
      const { invitationId } = request.params as { invitationId: string };
      await app.revokeObserverInvitation({
        token: await tokenOf(request, 'facilitator', 'participant', 'observer'),
        gameId: gameParam(request),
        invitationId,
      });
      return reply.code(204).send();
    },
  );

  // 観察者の参加。参加コードとは別の招待コードで、専用のレート制限を受ける
  server.post('/api/observe', async (request, reply) => {
    await limit(request, 'observe');
    const body = observeBody.parse(request.body);
    const joined = await app.joinAsObserver(body);
    setSession(reply, 'observer', joined.token);
    return reply.code(201).send({ gameId: joined.gameId });
  });

  // 観察（観察者と進行役）。逆算できない集計だけを返す
  server.get('/api/games/:id/observation', async (request) =>
    app.observation({
      token: await tokenOf(request, 'observer', 'facilitator', 'participant'),
      gameId: gameParam(request),
    }),
  );

  // 漏れた資格の失効と再発行（進行役）。進行役自身なら、新しい Cookie も設定する
  server.post('/api/games/:id/credentials/reissue', async (request, reply) => {
    const body = reissueBody.parse(request.body);
    const reissued = await app.reissueCredential({
      token: await tokenOf(request, 'facilitator', 'participant', 'observer'),
      gameId: gameParam(request),
      target:
        body.target === 'FACILITATOR'
          ? { kind: 'FACILITATOR' }
          : { kind: 'PARTICIPANT', participantId: body.participantId },
    });
    if (reissued.facilitatorToken)
      setSession(reply, 'facilitator', reissued.facilitatorToken);
    return { recoveryCode: reissued.recoveryCode };
  });

  server.get('/api/games/:id/lobby', async (request) =>
    app.lobby({
      token: await tokenOf(request, 'facilitator', 'participant', 'observer'),
      gameId: gameParam(request),
    }),
  );

  server.post('/api/games/:id/assignments', async (request, reply) => {
    const body = assignBody.parse(request.body);
    await app.assignRole({
      token: await tokenOf(request, 'facilitator', 'participant', 'observer'),
      gameId: gameParam(request),
      ...body,
    });
    return reply.code(204).send();
  });

  server.delete(
    '/api/games/:id/assignments/:participantId',
    async (request, reply) => {
      const { participantId } = request.params as { participantId: string };
      await app.unassignRole({
        token: await tokenOf(request, 'facilitator', 'participant', 'observer'),
        gameId: gameParam(request),
        participantId,
      });
      return reply.code(204).send();
    },
  );

  server.post('/api/games/:id/start', async (request, reply) => {
    await app.startGame({
      token: await tokenOf(request, 'facilitator', 'participant', 'observer'),
      gameId: gameParam(request),
    });
    return reply.code(204).send();
  });

  server.get('/api/games/:id/me', async (request) =>
    app.roleState({
      token: await tokenOf(request, 'participant', 'facilitator', 'observer'),
      gameId: gameParam(request),
    }),
  );

  // 振り返り（役割別の時系列）。ゲームが終了してから、進行役・参加者に開示する
  server.get('/api/games/:id/review', async (request) =>
    app.review({
      token: await tokenOf(request, 'facilitator', 'participant', 'observer'),
      gameId: gameParam(request),
    }),
  );

  // 出力（進行役・終了後）。全体を組み立ててから送る。本文の SHA-256 をヘッダーで返す
  server.get('/api/games/:id/export', async (request, reply) => {
    const { format } = exportQuery.parse(request.query);
    const out = await app.exportGame({
      token: await tokenOf(request, 'facilitator', 'participant', 'observer'),
      gameId: gameParam(request),
      format,
    });
    return reply
      .type(out.contentType)
      .header('content-disposition', `attachment; filename="${out.filename}"`)
      .header('cache-control', 'no-store')
      .header(
        'x-checksum-sha256',
        createHash('sha256').update(out.body).digest('hex'),
      )
      .send(out.body);
  });

  server.get('/api/games/:id/console', async (request) =>
    app.console({
      token: await tokenOf(request, 'facilitator', 'participant', 'observer'),
      gameId: gameParam(request),
    }),
  );

  server.put('/api/games/:id/decision', async (request) => {
    const body = decisionBody.parse(request.body);
    const saved = await app.saveDecision({
      token: await tokenOf(request, 'participant', 'facilitator', 'observer'),
      gameId: gameParam(request),
      role: body.role,
      quantity: body.quantity,
      expectedVersion: ifMatch(request),
    });
    if (saved.committed) committed('AUTO');
    return saved;
  });

  for (const action of ['pause', 'resume'] as const) {
    server.post(`/api/games/:id/${action}`, async (request, reply) => {
      const input = {
        token: await tokenOf(request, 'facilitator', 'participant', 'observer'),
        gameId: gameParam(request),
      };
      await (action === 'pause'
        ? app.pauseSession(input)
        : app.resumeSession(input));
      return reply.code(204).send();
    });
  }

  server.put('/api/games/:id/commit-mode', async (request, reply) => {
    const body = commitModeBody.parse(request.body);
    await app.changeCommitMode({
      token: await tokenOf(request, 'facilitator', 'participant', 'observer'),
      gameId: gameParam(request),
      commitMode: body.commitMode,
    });
    return reply.code(204).send();
  });

  server.put('/api/games/:id/proxy-decision', async (request) => {
    const body = decisionBody.parse(request.body);
    return app.proxyDecision({
      token: await tokenOf(request, 'facilitator', 'participant', 'observer'),
      gameId: gameParam(request),
      role: body.role,
      quantity: body.quantity,
      expectedVersion: ifMatch(request),
    });
  });

  server.post('/api/games/:id/commit', async (request) => {
    const body = commitBody.parse(request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) {
      throw new HttpError(400, 'Idempotency-Key ヘッダーが必要です');
    }
    const result = await app.commitWeek({
      token: await tokenOf(request, 'facilitator', 'participant', 'observer'),
      gameId: gameParam(request),
      week: body.week,
      version: ifMatch(request),
      idempotencyKey: key,
    });
    committed('MANUAL');
    return result;
  });

  // 状態の変化の通知（SSE）。内容は含めず、変化があったことだけを伝える
  server.get('/api/games/:id/stream', async (request, reply) => {
    const gameId = gameParam(request);
    await app.authorizeStream({
      token: await tokenOf(request, 'facilitator', 'participant', 'observer'),
      gameId,
    }); // 認証・認可の確認（観察者にはロビーを見せないため、専用の確認）
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-correlation-id': request.id,
    });
    res.write(': connected\n\n');
    sseConnections += 1;
    emitConnections();
    const unsubscribe = deps.notifier.subscribe(gameId, () => {
      res.write('event: changed\ndata: {}\n\n');
      metrics.emit([{ name: 'SseNotifications', value: 1, unit: 'Count' }]);
    });
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      sseConnections -= 1;
      emitConnections();
    });
  });

  return server;
}
