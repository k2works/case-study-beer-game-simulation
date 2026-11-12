import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { AccessControl, type Principal } from '../access/access-control.js';
import type { KeyRing } from '../access/keys.js';
import type { Clock, RandomSource } from '../clock.js';
import { ROLES } from '../domain/types.js';
import {
  AppError,
  PROBLEM_STATUS,
  forbiddenError,
  notFoundError,
  validationError,
  type Problem,
  type ProblemKind,
} from '../errors.js';
import { GameSession } from '../session/game-session.js';
import type { Store } from '../session/store.js';

export type LogSink = (line: Record<string, unknown>) => void;

export interface AppDeps {
  store: Store;
  keyRing: KeyRing;
  clock: Clock;
  random: RandomSource;
  /** 構造化ログの出力先（1 行 1 件の JSON にして標準出力へ）。許可した項目だけ渡す */
  log: LogSink;
  /** staging と production で true（HSTS を付ける） */
  hsts: boolean;
  /** true のとき、平文の HTTP（x-forwarded-proto: http）を拒否または転送する */
  enforceHttps: boolean;
  /** ビルド済みの画面の置き場。無ければ API だけを配信する */
  webDist?: string;
}

interface RequestContext {
  startedAt: number;
  result: ProblemKind | 'ok';
  gameId?: string;
  role?: string;
  src?: string;
  errorName?: string;
  errorCode?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function credentialOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1] ?? null;
}

function idempotencyKeyOf(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : undefined;
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

function parseWeek(raw: string): number {
  if (!/^\d{1,2}$/.test(raw)) {
    throw validationError('週の指定に誤りがあります', '週は 1〜50 の整数で指定してください', [
      { path: 'week', message: '週は 1〜50 の整数で指定してください' },
    ]);
  }
  return Number(raw);
}

/** 入口（Fastify）を組み立てる。権限の判定は AccessControl、業務の処理は GameSession に任せる。 */
export async function createApp(deps: AppDeps): Promise<FastifyInstance> {
  const access = new AccessControl({
    store: deps.store,
    keyRing: deps.keyRing,
    random: deps.random,
  });
  const session = new GameSession({
    store: deps.store,
    access,
    clock: deps.clock,
    random: deps.random,
  });

  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024,
    trustProxy: deps.enforceHttps,
    genReqId: (request) => {
      const given = request.headers['x-request-id'];
      return typeof given === 'string' && REQUEST_ID.test(given) ? given : randomUUID();
    },
  });

  const contexts = new WeakMap<FastifyRequest, RequestContext>();
  const contextOf = (request: FastifyRequest): RequestContext => {
    let context = contexts.get(request);
    if (!context) {
      context = { startedAt: performance.now(), result: 'ok' };
      contexts.set(request, context);
    }
    return context;
  };

  // 空の本文を許し、壊れた JSON は Problem（422）にする
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      done(
        Object.assign(new Error('JSON の形式が正しくありません'), { statusCode: 400 }),
        undefined,
      );
    }
  });

  const fail = (reply: FastifyReply, request: FastifyRequest, problem: Problem): FastifyReply => {
    contextOf(request).result = problem.kind;
    return reply.code(PROBLEM_STATUS[problem.kind]).send(problem);
  };

  app.addHook('onRequest', async (request, reply) => {
    const context = contextOf(request);
    reply.header('x-request-id', request.id);
    reply.header('content-security-policy', CSP);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    if (deps.hsts) {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    const isApi = request.url.startsWith('/api');
    if (isApi) {
      reply.header('cache-control', 'no-store');
    }
    // NFR6.6: 平文の HTTP は、GET を HTTPS へ転送し、それ以外は拒否する
    if (deps.enforceHttps && request.headers['x-forwarded-proto'] === 'http') {
      if (request.method === 'GET' || request.method === 'HEAD') {
        const host = request.headers.host ?? '';
        return reply.code(308).header('location', `https://${host}${request.url}`).send();
      }
      context.src = access.sourceDigest(request.ip);
      return fail(
        reply,
        request,
        forbiddenError('HTTPS で接続してください', 'https:// から始まる URL を使ってください')
          .problem,
      );
    }
    // NFR6.10: 別のオリジンからの API の要求は許可しない（CORS を許可しない）
    const origin = request.headers.origin;
    if (isApi && typeof origin === 'string') {
      if (hostOf(origin) !== request.headers.host) {
        context.src = access.sourceDigest(request.ip);
        return fail(
          reply,
          request,
          forbiddenError(
            '別のオリジンからの要求は受け付けません',
            'このアプリの画面から操作してください',
          ).problem,
        );
      }
    }
    return undefined;
  });

  app.addHook('onResponse', async (request, reply) => {
    const context = contextOf(request);
    const status = reply.statusCode;
    const line: Record<string, unknown> = {
      time: new Date().toISOString(),
      level: status >= 500 ? 'error' : 'info',
      reqId: request.id,
      operation: `${request.method} ${request.routeOptions.url ?? 'unmatched'}`,
      result: context.result,
      status,
      durationMs: Math.round((performance.now() - context.startedAt) * 100) / 100,
    };
    if (context.gameId) {
      line.gameId = context.gameId;
    }
    if (context.role) {
      line.role = context.role;
    }
    if (context.src) {
      line.src = context.src;
    }
    if (context.errorName) {
      line.errorName = context.errorName;
    }
    if (context.errorCode) {
      line.errorCode = context.errorCode;
    }
    deps.log(line);
  });

  app.setErrorHandler((error, request, reply) => {
    const context = contextOf(request);
    if (error instanceof AppError) {
      if (error.problem.kind === 'forbidden') {
        context.src = access.sourceDigest(request.ip);
      }
      return fail(reply, request, error.problem);
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return fail(
        reply,
        request,
        validationError('要求の形式が正しくありません', 'JSON の形式と大きさを確かめてください')
          .problem,
      );
    }
    // 想定外の例外: 内部の情報を返さず、名前と種類だけをログに残す
    context.errorName = error instanceof Error ? error.name : 'unknown';
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      context.errorCode = code;
    }
    return fail(reply, request, {
      kind: 'internal',
      reason: 'サーバーで問題が起きました',
      hint: '少し待ってから、状態を取り直してください',
    });
  });

  const webIndex = deps.webDist ? path.join(deps.webDist, 'index.html') : null;
  const serveWeb = webIndex !== null && existsSync(webIndex);
  if (serveWeb && deps.webDist) {
    await app.register(fastifyStatic, { root: path.resolve(deps.webDist), wildcard: false });
  }

  app.setNotFoundHandler((request, reply) => {
    if (serveWeb && request.method === 'GET' && !request.url.startsWith('/api')) {
      return reply.sendFile('index.html');
    }
    return fail(reply, request, notFoundError('指定された入口はありません').problem);
  });

  const principalOf = (request: FastifyRequest): Promise<Principal | null> =>
    access.authenticate(credentialOf(request));

  const remember = (request: FastifyRequest, gameId?: string, role?: string): void => {
    const context = contextOf(request);
    if (gameId && UUID.test(gameId)) {
      context.gameId = gameId;
    }
    if (role && (ROLES as readonly string[]).includes(role)) {
      context.role = role;
    }
  };

  app.get('/health', async (request, reply) => {
    try {
      await deps.store.ping();
      return { status: 'ok', database: 'ok' };
    } catch {
      contextOf(request).result = 'unavailable';
      return reply.code(503).send({ status: 'error', database: 'unreachable' });
    }
  });

  app.get('/api/me', async (request) => {
    const principal = await principalOf(request);
    if (!principal) {
      throw forbiddenError();
    }
    remember(request, principal.gameId);
    return principal.kind === 'participant'
      ? {
          kind: principal.kind,
          gameId: principal.gameId,
          participantId: principal.participantId,
          role: principal.role,
        }
      : { kind: principal.kind, gameId: principal.gameId };
  });

  app.post('/api/games', async (request, reply) => {
    const created = await session.createGame(request.body);
    remember(request, created.gameId);
    return reply.code(201).send(created);
  });

  app.post('/api/games/join', async (request, reply) => {
    const joined = await session.joinGame(request.body);
    remember(request, joined.gameId);
    return reply.code(201).send(joined);
  });

  app.get<{ Params: { gameId: string } }>('/api/games/:gameId/state', async (request) => {
    remember(request, request.params.gameId);
    return session.getState(await principalOf(request), request.params.gameId);
  });

  app.get<{ Params: { gameId: string } }>('/api/games/:gameId/codes', async (request) => {
    remember(request, request.params.gameId);
    return session.getCodes(await principalOf(request), request.params.gameId);
  });

  app.put<{
    Params: { gameId: string; participantId: string };
    Body: { role?: unknown } | undefined;
  }>('/api/games/:gameId/assignments/:participantId', async (request, reply) => {
    remember(request, request.params.gameId);
    await session.assignRole(
      await principalOf(request),
      request.params.gameId,
      request.params.participantId,
      request.body?.role,
    );
    return reply.code(200).send({ assigned: true });
  });

  app.post<{ Params: { gameId: string } }>('/api/games/:gameId/start', async (request) => {
    remember(request, request.params.gameId);
    return session.startGame(await principalOf(request), request.params.gameId);
  });

  app.put<{ Params: { gameId: string; week: string; role: string } }>(
    '/api/games/:gameId/weeks/:week/decisions/:role',
    async (request) => {
      remember(request, request.params.gameId, request.params.role);
      const principal = await principalOf(request);
      const week = parseWeek(request.params.week);
      return session.submitDecision(
        principal,
        request.params.gameId,
        week,
        request.params.role,
        request.body,
        idempotencyKeyOf(request),
      );
    },
  );

  app.post<{ Params: { gameId: string; week: string } }>(
    '/api/games/:gameId/weeks/:week/confirm',
    async (request) => {
      remember(request, request.params.gameId);
      const principal = await principalOf(request);
      const week = parseWeek(request.params.week);
      return session.confirmWeek(principal, request.params.gameId, week, idempotencyKeyOf(request));
    },
  );

  app.post<{ Params: { gameId: string } }>('/api/games/:gameId/pause', async (request) => {
    remember(request, request.params.gameId);
    return session.pauseGame(await principalOf(request), request.params.gameId);
  });

  app.post<{ Params: { gameId: string } }>('/api/games/:gameId/resume', async (request) => {
    remember(request, request.params.gameId);
    return session.resumeGame(await principalOf(request), request.params.gameId);
  });

  // 終了の理由は facilitator に固定する。本文の reason は受け取らない（finalWeek と autoEnd は内部の経路だけ、NFR6.1）
  app.post<{ Params: { gameId: string } }>('/api/games/:gameId/end', async (request) => {
    remember(request, request.params.gameId);
    return session.endGame(await principalOf(request), request.params.gameId);
  });

  app.post<{ Params: { gameId: string; role: string } }>(
    '/api/games/:gameId/roles/:role/replacement',
    async (request, reply) => {
      remember(request, request.params.gameId, request.params.role);
      const replaced = await session.replaceAssignee(
        await principalOf(request),
        request.params.gameId,
        request.params.role,
        request.body,
      );
      // token の平文を含む応答は、キャッシュさせない（NFR6.2）
      return reply.code(201).header('cache-control', 'no-store').send(replaced);
    },
  );

  app.get<{ Params: { gameId: string } }>('/api/games/:gameId/history', async (request) => {
    remember(request, request.params.gameId);
    return session.getHistory(await principalOf(request), request.params.gameId);
  });

  return app;
}
