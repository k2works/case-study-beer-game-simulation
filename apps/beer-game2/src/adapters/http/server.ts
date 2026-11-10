import { randomUUID } from 'node:crypto';
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
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../application/errors.js';
import { ROLES } from '../../domain/role.js';
import {
  DomainError,
  PermissionError,
  StaleError,
} from '../../domain/values.js';
import { ConflictError, type ChangeNotifier } from '../../ports/index.js';

export interface HttpConfig {
  allowedOrigin: string;
  logLevel: string;
}

export interface ServerDependencies {
  app: Application;
  ready: () => Promise<boolean>;
  notifier: ChangeNotifier;
  config: HttpConfig;
  /** ログの出力先（テスト用。省略時は標準出力） */
  logStream?: Writable;
}

/** 進行役と参加者の資格は別の Cookie。同じブラウザで、進行役が参加者を兼ねられる */
export const COOKIE = {
  facilitator: 'bg_facilitator',
  participant: 'bg_participant',
} as const;
type Kind = keyof typeof COOKIE;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const roleSchema = z.enum(ROLES);
const createBody = z.object({
  weeks: z.number().int(),
  demand: z.array(z.number()).optional(),
  commitMode: z.enum(['MANUAL', 'AUTO']).optional(),
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
const commitBody = z.object({ week: z.number().int() });

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
      correlationId: reply.request.id,
    });
}

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
      return problem(reply, error.status, 'Bad Request', error.message);
    if (error instanceof UnauthorizedError)
      return problem(reply, 401, 'Unauthorized', error.message);
    if (error instanceof ForbiddenError)
      return problem(reply, 403, 'Forbidden', error.message);
    if (error instanceof NotFoundError)
      return problem(reply, 404, 'Not Found', error.message);
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

  server.post('/api/games', async (request, reply) => {
    const body = createBody.parse(request.body);
    const created = await app.createGame(body);
    setSession(reply, 'facilitator', created.facilitatorToken);
    return reply
      .code(201)
      .send({ gameId: created.gameId, joinCode: created.joinCode });
  });

  server.post('/api/join', async (request, reply) => {
    const body = joinBody.parse(request.body);
    const joined = await app.joinGame(body);
    setSession(reply, 'participant', joined.token);
    return reply
      .code(201)
      .send({ gameId: joined.gameId, participantId: joined.participantId });
  });

  server.get('/api/games/:id/lobby', async (request) =>
    app.lobby({
      token: await tokenOf(request, 'facilitator', 'participant'),
      gameId: gameParam(request),
    }),
  );

  server.post('/api/games/:id/assignments', async (request, reply) => {
    const body = assignBody.parse(request.body);
    await app.assignRole({
      token: await tokenOf(request, 'facilitator', 'participant'),
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
        token: await tokenOf(request, 'facilitator', 'participant'),
        gameId: gameParam(request),
        participantId,
      });
      return reply.code(204).send();
    },
  );

  server.post('/api/games/:id/start', async (request, reply) => {
    await app.startGame({
      token: await tokenOf(request, 'facilitator', 'participant'),
      gameId: gameParam(request),
    });
    return reply.code(204).send();
  });

  server.get('/api/games/:id/me', async (request) =>
    app.roleState({
      token: await tokenOf(request, 'participant', 'facilitator'),
      gameId: gameParam(request),
    }),
  );

  // 振り返り（役割別の時系列）。ゲームが終了してから、進行役・参加者に開示する
  server.get('/api/games/:id/review', async (request) =>
    app.review({
      token: await tokenOf(request, 'facilitator', 'participant'),
      gameId: gameParam(request),
    }),
  );

  server.get('/api/games/:id/console', async (request) =>
    app.console({
      token: await tokenOf(request, 'facilitator', 'participant'),
      gameId: gameParam(request),
    }),
  );

  server.put('/api/games/:id/decision', async (request) => {
    const body = decisionBody.parse(request.body);
    const saved = await app.saveDecision({
      token: await tokenOf(request, 'participant', 'facilitator'),
      gameId: gameParam(request),
      role: body.role,
      quantity: body.quantity,
      expectedVersion: ifMatch(request),
    });
    return saved;
  });

  server.post('/api/games/:id/commit', async (request) => {
    const body = commitBody.parse(request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0) {
      throw new HttpError(400, 'Idempotency-Key ヘッダーが必要です');
    }
    return app.commitWeek({
      token: await tokenOf(request, 'facilitator', 'participant'),
      gameId: gameParam(request),
      week: body.week,
      version: ifMatch(request),
      idempotencyKey: key,
    });
  });

  // 状態の変化の通知（SSE）。内容は含めず、変化があったことだけを伝える
  server.get('/api/games/:id/stream', async (request, reply) => {
    const gameId = gameParam(request);
    await app.lobby({
      token: await tokenOf(request, 'facilitator', 'participant'),
      gameId,
    }); // 認証・認可の確認
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-correlation-id': request.id,
    });
    res.write(': connected\n\n');
    const unsubscribe = deps.notifier.subscribe(gameId, () => {
      res.write('event: changed\ndata: {}\n\n');
    });
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return server;
}
