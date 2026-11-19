import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type RouteHandlerMethod,
} from 'fastify';
import type { Action, Principal, TokenTouch } from '../access/access-control.js';
import type { KeyRing } from '../access/keys.js';
import type { AccessPolicy } from '../access/policy.js';
import { createServices } from '../access/session-gateway.js';
import type { Clock, RandomSource } from '../clock.js';
import { ROLES } from '../domain/types.js';
import {
  AppError,
  PROBLEM_STATUS,
  forbiddenError,
  invalidCredentialError,
  notFoundError,
  rateLimitedError,
  validationError,
  type Problem,
  type ProblemKind,
} from '../errors.js';
import type { Store } from '../session/store.js';
import { isGuardedUrl, routeCatalog, type RegisteredRoute, type RouteId } from './routes.js';

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
  /**
   * 信頼するプロキシの段数（BR18.3）。未設定または 0 なら転送元のヘッダを使わず、接続の相手のアドレスを使う。
   * 設定した段数の範囲でだけ転送元のヘッダを信じる。
   */
  trustedProxyHops?: number;
  /** 資格情報と試行の窓の数値（既定は仮の値） */
  policy?: Partial<AccessPolicy>;
}

/** 資格情報の拒否の分類（NFR9.1）。 */
export type RejectionKind = 'invalid_token' | 'invalid_code' | 'rate_limited';
export type RejectionCounts = Record<RejectionKind, number>;

declare module 'fastify' {
  interface FastifyInstance {
    /** 背景の処理（最後の操作の時刻の更新）が終わるまで待つ。試験用 */
    whenIdle(): Promise<void>;
    /** 拒否の種類ごとの件数（NFR9.2） */
    rejectionCounts(): RejectionCounts;
    /** 経路の表から登録した経路の一覧 */
    registeredRoutes(): RegisteredRoute[];
  }
  interface FastifyContextConfig {
    action?: Action | 'public';
  }
}

interface RequestContext {
  startedAt: number;
  result: ProblemKind | 'ok';
  gameId?: string;
  role?: string;
  src?: string;
  errorName?: string;
  errorCode?: string;
  rejection?: RejectionKind;
  principal?: Principal | null;
  touch?: TokenTouch;
  verifiedGameId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * 構造化ログに出してよい項目の許可リスト（NFR6.9、NFR9.1）。1 か所に定め、ここに無い項目は出力されない。
 * 資格情報（コード、token、鍵）は項目に持たない。
 */
const LOG_FIELDS: readonly string[] = [
  'time',
  'level',
  'reqId',
  'operation',
  'result',
  'status',
  'durationMs',
  'gameId',
  'role',
  'src',
  'errorName',
  'errorCode',
  'rejection',
];

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

/** 本文から参加コードを取り出す。文字列でない、または空なら undefined（形式の不正は 422 のままにして、窓に数えない）。 */
function joinCodeOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const code = (body as { joinCode?: unknown }).joinCode;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

type Params = { gameId: string; week: string; role: string; participantId: string };

/**
 * 入口（Fastify）を組み立てる。経路は経路の表（routeCatalog）から登録する。
 * 認可は onRequest で、本文の解析より前に行う（権限のない人に 422 や 409 の違いを見せない、BR19.1）。
 * GameSession は import せず、AccessControl と SessionGateway（access/）を経由する（BR19.2）。
 */
export async function createApp(deps: AppDeps): Promise<FastifyInstance> {
  const { access, gateway } = createServices({
    store: deps.store,
    keyRing: deps.keyRing,
    clock: deps.clock,
    random: deps.random,
    ...(deps.policy ? { policy: deps.policy } : {}),
  });

  const hops = deps.trustedProxyHops ?? 0;
  const app = Fastify({
    logger: false,
    bodyLimit: 16 * 1024,
    // 設定した段数の範囲でだけ転送元のヘッダを信じる。未設定なら信じない（窓の回避を許さない）
    trustProxy: hops > 0 ? (_address: string, hop: number) => hop < hops : false,
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

  const counts: RejectionCounts = { invalid_token: 0, invalid_code: 0, rate_limited: 0 };
  const pending = new Set<Promise<void>>();
  const registered: RegisteredRoute[] = [];
  app.decorate('rejectionCounts', () => ({ ...counts }));
  app.decorate('registeredRoutes', () => registered.map((route) => ({ ...route })));
  app.decorate('whenIdle', async () => {
    // 応答の完了の直後に積まれる背景の処理を拾うため、1 回譲ってから待つ
    await new Promise<void>((resolve) => setImmediate(resolve));
    while (pending.size > 0) {
      await Promise.all([...pending]);
    }
  });

  // 経路の表に無い経路は、登録の時点で失敗させる（BR19.3）。画面の配信の経路は、組み立ての間だけ許す
  let building = true;
  const catalogKeys = new Map(routeCatalog.map((row) => [`${row.method} ${row.url}`, row]));
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (methods.every((method) => method === 'HEAD')) {
      return;
    }
    if (building && !isGuardedUrl(route.url)) {
      return;
    }
    const method = methods[0] ?? '';
    const spec = catalogKeys.get(`${method} ${route.url}`);
    if (!spec || route.config?.action !== spec.action) {
      throw new Error(`経路の表に無い経路です: ${method} ${route.url}`);
    }
    registered.push({ method, url: route.url });
  });

  const fail = (reply: FastifyReply, request: FastifyRequest, problem: Problem): FastifyReply => {
    const context = contextOf(request);
    context.result = problem.kind;
    if (context.rejection) {
      counts[context.rejection] += 1;
    }
    return reply.code(PROBLEM_STATUS[problem.kind]).send(problem);
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

  const remember = (request: FastifyRequest, gameId?: string, role?: string): void => {
    const context = contextOf(request);
    if (gameId && UUID.test(gameId)) {
      context.gameId = gameId;
    }
    if (role && (ROLES as readonly string[]).includes(role)) {
      context.role = role;
    }
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

    // 認可（BR19.1、NFR6.7）。本文の解析・入力の検証・占有より前に、資格情報の種類とゲーム・役割への権限を検証する。
    // 経路の表に無い /api の経路は、登録の時点で失敗するため、ここには届かない
    const action = request.routeOptions.config?.action;
    if (action === undefined || action === 'public') {
      return undefined;
    }
    const credential = credentialOf(request);
    const { principal, touch } = await access.authenticateWithTouch(credential);
    context.principal = principal;
    if (touch) {
      context.touch = touch;
    }
    if (credential !== null && principal === null) {
      // 不明・失効・期限切れを区別しない固定の応答（NFR6.4）
      context.rejection = 'invalid_token';
      throw invalidCredentialError();
    }
    const params = request.params as Partial<Params>;
    remember(request, params.gameId, params.role);
    access.authorize(principal, action, {
      ...(params.gameId !== undefined ? { gameId: params.gameId } : {}),
      ...(params.role !== undefined ? { role: params.role } : {}),
    });
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
      gameId: context.gameId,
      role: context.role,
      src: context.src,
      errorName: context.errorName,
      errorCode: context.errorCode,
      rejection: context.rejection,
    };
    // 許可リストの項目だけを、値があるものに限って出力する
    deps.log(
      Object.fromEntries(
        Object.entries(line).filter(
          ([key, value]) => LOG_FIELDS.includes(key) && value !== undefined,
        ),
      ),
    );

    // 認証に成功した要求の最後の操作の時刻を、応答のあとに延ばす（BR17.2）。失敗しても要求は拒否せず、ログに出すだけ
    if (context.touch) {
      const task = access.touch(context.touch).then(
        () => undefined,
        (error: unknown) => {
          deps.log({
            time: new Date().toISOString(),
            level: 'warn',
            event: 'last_used_update_failed',
            reqId: request.id,
            errorName: error instanceof Error ? error.name : 'unknown',
          });
        },
      );
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
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

  const principalOf = (request: FastifyRequest): Principal | null =>
    contextOf(request).principal ?? null;
  const paramsOf = (request: FastifyRequest): Params => request.params as Params;

  const handlers: Record<RouteId, RouteHandlerMethod> = {
    health: async (request, reply) => {
      try {
        await deps.store.ping();
        return { status: 'ok', database: 'ok' };
      } catch {
        contextOf(request).result = 'unavailable';
        return reply.code(503).send({ status: 'error', database: 'unreachable' });
      }
    },

    me: async (request) => {
      const principal = principalOf(request);
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
    },

    createGame: async (request, reply) => {
      const created = await gateway.createGame(request.body);
      remember(request, created.gameId);
      return reply.code(201).send(created);
    },

    joinGame: async (request, reply) => {
      const joined = await gateway.joinGame(request.body, contextOf(request).verifiedGameId);
      remember(request, joined.gameId);
      return reply.code(201).send(joined);
    },

    getState: async (request) => gateway.getState(principalOf(request), paramsOf(request).gameId),

    getCodes: async (request) => gateway.getCodes(principalOf(request), paramsOf(request).gameId),

    assignRole: async (request, reply) => {
      const { gameId, participantId } = paramsOf(request);
      await gateway.assignRole(
        principalOf(request),
        gameId,
        participantId,
        (request.body as { role?: unknown } | undefined)?.role,
      );
      return reply.code(200).send({ assigned: true });
    },

    startGame: async (request) => gateway.startGame(principalOf(request), paramsOf(request).gameId),

    submitDecision: async (request) => {
      const { gameId, week, role } = paramsOf(request);
      const principal = principalOf(request);
      return gateway.submitDecision(
        principal,
        gameId,
        parseWeek(week),
        role,
        request.body,
        idempotencyKeyOf(request),
      );
    },

    confirmWeek: async (request) => {
      const { gameId, week } = paramsOf(request);
      const principal = principalOf(request);
      return gateway.confirmWeek(principal, gameId, parseWeek(week), idempotencyKeyOf(request));
    },

    pauseGame: async (request) => gateway.pauseGame(principalOf(request), paramsOf(request).gameId),

    resumeGame: async (request) =>
      gateway.resumeGame(principalOf(request), paramsOf(request).gameId),

    // 終了の理由は facilitator に固定する。本文の reason は受け取らない（finalWeek と autoEnd は内部の経路だけ、NFR6.1）
    endGame: async (request) => gateway.endGame(principalOf(request), paramsOf(request).gameId),

    replaceAssignee: async (request, reply) => {
      const { gameId, role } = paramsOf(request);
      const replaced = await gateway.replaceAssignee(
        principalOf(request),
        gameId,
        role,
        request.body,
      );
      // token の平文を含む応答は、キャッシュさせない（NFR6.2）
      return reply.code(201).header('cache-control', 'no-store').send(replaced);
    },

    getHistory: async (request) =>
      gateway.getHistory(principalOf(request), paramsOf(request).gameId),

    // 終了後の結果（BR21）。認可は onRequest で済み、読み取りだけ。取得のログは種類と大きさだけ（NFR9.4）
    viewResults: async (request, reply) => {
      const started = performance.now();
      const { gameId } = paramsOf(request);
      const view = await gateway.viewResults(principalOf(request), gameId);
      deps.log({
        time: new Date().toISOString(),
        level: 'info',
        event: 'results_served',
        reqId: request.id,
        kind: 'results',
        gameId,
        rows: view.roles.reduce((sum, role) => sum + role.weeks.length, 0),
        durationMs: Math.round((performance.now() - started) * 100) / 100,
      });
      return reply.header('cache-control', 'no-store').send(view);
    },

    // 結果の出力（BR23）。ファイルとして保存できる形で返し、キャッシュさせない（NFR6.3）
    exportGame: async (request, reply) => {
      const started = performance.now();
      const { gameId } = paramsOf(request);
      const format = (request.query as { format?: unknown } | undefined)?.format;
      const file = await gateway.exportGame(principalOf(request), gameId, format);
      deps.log({
        time: new Date().toISOString(),
        level: 'info',
        event: 'export_served',
        reqId: request.id,
        kind: `export:${String(format)}`,
        gameId,
        rows: file.rows,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
      });
      return reply
        .header('content-type', file.contentType)
        .header('content-disposition', `attachment; filename="${file.filename}"`)
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .send(file.body);
    },
  };

  for (const spec of routeCatalog) {
    app.route({
      method: spec.method,
      url: spec.url,
      config: { action: spec.action },
      handler: handlers[spec.id],
      ...(spec.id === 'joinGame'
        ? {
            // 参加の窓（BR18）。参加コードは本文にあるため、本文の解析後に検査する。
            // コードの欠落などの形式の不正は、窓に数えず、通常の 422 にする
            preValidation: async (request: FastifyRequest) => {
              const code = joinCodeOf(request.body);
              if (code === undefined) {
                return;
              }
              const context = contextOf(request);
              const outcome = await access.attemptJoin(request.ip, code);
              if (outcome.result === 'limited') {
                context.rejection = 'rate_limited';
                context.src = access.sourceDigest(request.ip);
                throw rateLimitedError();
              }
              if (outcome.result === 'invalid') {
                context.rejection = 'invalid_code';
                throw forbiddenError(
                  '参加コードが無効です',
                  '参加コードを確かめて、もう一度入力してください',
                );
              }
              context.verifiedGameId = outcome.gameId;
            },
          }
        : {}),
    });
  }
  // 経路の登録を確定させる（登録の失敗を、起動の失敗として表に出す）
  await app.after();

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

  building = false;
  return app;
}
