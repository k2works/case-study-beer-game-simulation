import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Pool } from 'pg';
import { GameService, Problem, type Actor } from '../application/game-service.js';
import { ROLES } from '../domain/types.js';
import { LearningViewService, type LearningActor } from '../learning/learning-view.js';
import { RetentionError, RetentionService } from '../retention/retention-service.js';
import { PostgresRetentionService } from '../retention/postgres-retention.js';
import { PostgresGameRepository } from '../infrastructure/postgres-game-repository.js';

const createRetentionService = () => {
  const key = process.env.RETENTION_HMAC_KEY;
  if (process.env.NODE_ENV === 'production' && (!key || !process.env.DATABASE_URL))
    throw new Error('Production retention requires RETENTION_HMAC_KEY and DATABASE_URL');
  if (!key) return undefined;
  if (process.env.DATABASE_URL)
    return new PostgresRetentionService(
      new Pool({ connectionString: process.env.DATABASE_URL }),
      key,
    );
  return new RetentionService({ hmacKey: key });
};

export async function buildApp(
  providedService?: GameService,
  learning = new LearningViewService(),
  retention: RetentionService | PostgresRetentionService | undefined = createRetentionService(),
) {
  const service = providedService ?? new GameService();
  const gameRepository =
    !providedService && process.env.DATABASE_URL
      ? new PostgresGameRepository(
          new Pool({ connectionString: process.env.DATABASE_URL }),
          process.env.GAME_CREDENTIAL_ENCRYPTION_KEY ?? '',
        )
      : undefined;
  const readGame = <T>(gameId: string, action: (domain: GameService) => T): T | Promise<T> =>
    gameRepository ? gameRepository.read(gameId, action) : action(service);
  const writeGame = <T>(gameId: string, action: (domain: GameService) => T): T | Promise<T> =>
    gameRepository ? gameRepository.write(gameId, action) : action(service);
  const app = Fastify({ bodyLimit: 64 * 1024, genReqId: () => randomUUID() });
  const stopLearningFeed = service.onDomainEvent((event) => {
    learning.consume(event);
  });
  app.addHook('onClose', async () => {
    stopLearningFeed();
    await gameRepository?.close();
  });
  const retryResults = new Map<string, { version: number; result: unknown }>();
  await app.register(cookie);
  await app.register(cors, { origin: false });
  const rateLimitMax = Number(process.env.API_RATE_LIMIT_PER_MINUTE ?? 120);
  if (!Number.isSafeInteger(rateLimitMax) || rateLimitMax < 1)
    throw new Error('API_RATE_LIMIT_PER_MINUTE must be a positive integer');
  await app.register(rateLimit, { max: rateLimitMax, timeWindow: '1 minute' });
  const uiRoot = fileURLToPath(new URL('../../dist/ui/', import.meta.url));
  if (existsSync(uiRoot)) await app.register(staticFiles, { root: uiRoot, prefix: '/' });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      const headerOrigin = request.headers.origin;
      let refererOrigin: string | undefined;
      if (!headerOrigin && request.headers.referer) {
        try {
          const parsed = new URL(request.headers.referer);
          if (parsed.protocol === 'https:') refererOrigin = parsed.origin;
        } catch {
          refererOrigin = undefined;
        }
      }
      const origin = headerOrigin ?? refererOrigin;
      if (!origin || !process.env.ALLOWED_ORIGIN || origin !== process.env.ALLOWED_ORIGIN)
        throw new Problem(403, 'ORIGIN_REJECTED', 'Origin is not allowed');
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const httpStatus =
      error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const problem =
      error instanceof Problem
        ? error
        : error instanceof RetentionError
          ? new Problem(
              error.code === 'DELETION_NOT_FOUND'
                ? 404
                : error.code === 'OPERATOR_REQUIRED'
                  ? 403
                  : error.code === 'VERSION_CONFLICT'
                    ? 412
                    : 409,
              error.code,
              error.message,
            )
          : httpStatus === 429
            ? new Problem(429, 'RATE_LIMITED', 'Too many requests; retry later')
            : httpStatus === 413
              ? new Problem(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large')
              : new Problem(500, 'INTERNAL_ERROR', 'Unexpected server error');
    void reply
      .status(problem.status)
      .type('application/problem+json')
      .send({
        type: `urn:beer-game:${problem.code}`,
        title: problem.code,
        status: problem.status,
        detail: problem.message,
        correlationId: request.id,
        latest: problem.latest,
      });
  });
  const actor = async (request: { cookies: Record<string, string | undefined> }) => {
    const value = gameRepository
      ? await gameRepository.resolveBrowserSession(request.cookies.bg_session)
      : service.resolveBrowserSession(request.cookies.bg_session);
    if (!value) throw new Problem(401, 'AUTH_REQUIRED', 'Authentication is required');
    return value;
  };
  const scopedActor = async (
    request: { cookies: Record<string, string | undefined> },
    gameId: string,
  ) => {
    const value = await actor(request);
    if (value.gameId !== gameId) throw new Problem(403, 'FORBIDDEN', 'Access denied');
    return value;
  };
  const sessionActor = async (
    request: { cookies: Record<string, string | undefined> },
    sessionId: string,
  ) => {
    const value = await actor(request);
    const actualGameId = gameRepository
      ? await gameRepository.gameIdForSession(sessionId)
      : value.gameId;
    if (
      actualGameId !== value.gameId ||
      (!gameRepository && service.sessionIdForGame(value.gameId) !== sessionId)
    )
      throw new Problem(403, 'FORBIDDEN', 'Access denied');
    return value;
  };
  const learningActor = async (
    request: {
      cookies: Record<string, string | undefined>;
    },
    gameId: string,
  ): Promise<LearningActor> => {
    const value = await scopedActor(request, gameId);
    return {
      id: value.id,
      gameId: value.gameId,
      kind: value.kind === 'FACILITATOR' ? 'FACILITATOR' : 'PARTICIPANT',
    };
  };
  const setSession = async (reply: any, value: Actor) => {
    reply.setCookie(
      'bg_session',
      gameRepository
        ? await gameRepository.issueBrowserSession(value)
        : service.issueBrowserSession(value),
      {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        path: '/',
      },
    );
  };
  const operator = async (
    request: { cookies: Record<string, string | undefined> },
    gameId: string,
  ) => {
    const value = await actor(request);
    if (
      value.kind !== 'FACILITATOR' ||
      value.gameId !== gameId ||
      !(await readGame(gameId, (domain) =>
        domain.verifyFacilitatorCredential(gameId, request.cookies.bg_operator ?? ''),
      ))
    )
      throw new Problem(403, 'FORBIDDEN', 'Operator access required');
    return value;
  };
  const retentionService = () => {
    if (!retention) throw new Problem(503, 'RETENTION_UNAVAILABLE', 'Retention is unavailable');
    return retention;
  };
  const exportFor = async (
    request: { cookies: Record<string, string | undefined>; params: unknown },
    exportId: string,
  ) => {
    const { gameId } = z.object({ gameId: z.string() }).parse(request.params);
    try {
      const viewer = await learningActor(request, gameId);
      return gameRepository
        ? await gameRepository.getExport(viewer, exportId)
        : (await learningFor(gameId)).getExport(viewer, exportId);
    } catch (error) {
      if (error instanceof Error && error.message === 'NOT_FOUND')
        throw new Problem(404, 'EXPORT_NOT_FOUND', 'Export was not found');
      if (error instanceof Error && error.message === 'FORBIDDEN')
        throw new Problem(403, 'FORBIDDEN', 'Export access denied');
      throw error;
    }
  };

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/api/v1/games', async (request, reply) => {
    const body = z
      .object({
        finalWeek: z.number().int().min(1).max(52),
        demand: z.array(z.number().int().min(0).max(1000)).min(1),
        retentionDays: z.number().int().min(1).max(3650).optional(),
      })
      .parse(request.body);
    const result = gameRepository
      ? await gameRepository.createGame(body, String(request.headers['idempotency-key'] ?? ''))
      : service.createGame(body, String(request.headers['idempotency-key'] ?? ''));
    await retention?.configure(
      result.gameId,
      await readGame(result.gameId, (domain) => domain.retentionDays(result.gameId)),
    );
    reply.setCookie('bg_operator', result.facilitatorCredential, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
    });
    await setSession(reply, {
      id: result.gameId,
      kind: 'FACILITATOR',
      gameId: result.gameId,
    });
    return reply.status(201).send({
      gameId: result.gameId,
      sessionId: result.sessionId,
      joinCode: result.joinCode,
      version: result.version,
    });
  });
  app.post('/api/v1/games/:gameId/participants', async (request, reply) => {
    const { gameId } = z.object({ gameId: z.string() }).parse(request.params);
    const { displayName } = z.object({ displayName: z.string() }).parse(request.body);
    const result = await writeGame(gameId, (domain) =>
      domain.joinGame(gameId, displayName, String(request.headers['idempotency-key'] ?? '')),
    );
    reply.setCookie('bg_recovery', result.recoveryToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/v1/participations/recover',
    });
    await setSession(reply, { id: result.participantId, kind: 'PARTICIPANT', gameId });
    return reply.status(201).send({ participantId: result.participantId });
  });
  app.post('/api/v1/participations/join', async (request, reply) => {
    const { joinCode, displayName } = z
      .object({ joinCode: z.string(), displayName: z.string() })
      .parse(request.body);
    const result = gameRepository
      ? await (async () => {
          const gameId = await gameRepository.gameIdForCode(joinCode);
          const joined = await writeGame(gameId, (domain) =>
            domain.joinGame(gameId, displayName, String(request.headers['idempotency-key'] ?? '')),
          );
          const sessionId = await readGame(gameId, (domain) => domain.sessionIdForGame(gameId));
          return { gameId, sessionId, ...joined };
        })()
      : service.joinByCode(joinCode, displayName, String(request.headers['idempotency-key'] ?? ''));
    reply.setCookie('bg_recovery', result.recoveryToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/v1/participations/recover',
    });
    await setSession(reply, {
      id: result.participantId,
      kind: 'PARTICIPANT',
      gameId: result.gameId,
    });
    return reply.status(201).send({
      gameId: result.gameId,
      sessionId: result.sessionId,
      participantId: result.participantId,
    });
  });
  app.get('/api/v1/games/:gameId/lobby', async (request) => {
    const gameId = (request.params as { gameId: string }).gameId;
    const viewer = await scopedActor(request, gameId);
    return readGame(gameId, (domain) => domain.lobbyState(viewer));
  });
  app.put('/api/v1/games/:gameId/participants/:participantId/role', async (request) => {
    const { participantId } = z.object({ participantId: z.string() }).parse(request.params);
    const { role } = z.object({ role: z.enum(ROLES) }).parse(request.body);
    const { gameId } = z.object({ gameId: z.string() }).parse(request.params);
    const viewer = await scopedActor(request, gameId);
    return writeGame(gameId, (domain) =>
      domain.assignRoleBrowser(
        viewer,
        participantId,
        role,
        Number(request.headers['if-match'] ?? -1),
        String(request.headers['idempotency-key'] ?? ''),
      ),
    );
  });
  app.post('/api/v1/sessions/:sessionId/start', async (request) => {
    const viewer = await sessionActor(request, (request.params as { sessionId: string }).sessionId);
    return writeGame(viewer.gameId, (domain) =>
      domain.startSessionBrowser(
        viewer,
        Number(request.headers['if-match'] ?? -1),
        String(request.headers['idempotency-key'] ?? ''),
      ),
    );
  });
  app.post('/api/v1/sessions/:sessionId/pause', async (request) => {
    const viewer = await sessionActor(request, (request.params as { sessionId: string }).sessionId);
    return writeGame(viewer.gameId, (domain) =>
      domain.pauseSession(
        viewer,
        Number(request.headers['if-match'] ?? -1),
        String(request.headers['idempotency-key'] ?? ''),
      ),
    );
  });
  app.post('/api/v1/sessions/:sessionId/resume', async (request) => {
    const viewer = await sessionActor(request, (request.params as { sessionId: string }).sessionId);
    return writeGame(viewer.gameId, (domain) =>
      domain.resumeSession(
        viewer,
        Number(request.headers['if-match'] ?? -1),
        String(request.headers['idempotency-key'] ?? ''),
      ),
    );
  });
  app.post('/api/v1/sessions/:sessionId/end', async (request) => {
    const viewer = await sessionActor(request, (request.params as { sessionId: string }).sessionId);
    return writeGame(viewer.gameId, (domain) =>
      domain.endSession(
        viewer,
        Number(request.headers['if-match'] ?? -1),
        String(request.headers['idempotency-key'] ?? ''),
      ),
    );
  });
  app.put('/api/v1/sessions/:sessionId/proxy-decisions/:role', async (request) => {
    const { role } = z.object({ role: z.enum(ROLES) }).parse(request.params);
    const { quantity, expectedVersion } = z
      .object({ quantity: z.number().int(), expectedVersion: z.number().int().min(0) })
      .parse(request.body);
    const viewer = await sessionActor(request, (request.params as { sessionId: string }).sessionId);
    return writeGame(viewer.gameId, (domain) =>
      domain.submitProxyDecision(
        viewer,
        role,
        quantity,
        expectedVersion,
        String(request.headers['idempotency-key'] ?? ''),
      ),
    );
  });
  app.post('/api/v1/participations/recover', async (request, reply) => {
    const recoveryToken = request.cookies.bg_recovery;
    if (!recoveryToken)
      throw new Problem(401, 'RECOVERY_NOT_AVAILABLE', 'Recovery is not available');
    const result = gameRepository
      ? await writeGame(await gameRepository.gameIdForRecovery(recoveryToken), (domain) =>
          domain.recoverParticipation(recoveryToken),
        )
      : service.recoverParticipation(recoveryToken);
    reply.setCookie('bg_recovery', result.recoveryToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/api/v1/participations/recover',
    });
    await setSession(reply, result.actor);
    return { gameId: result.actor.gameId, state: result.state };
  });
  app.get('/api/v1/sessions/:sessionId/state', async (request) => {
    const viewer = await sessionActor(request, (request.params as { sessionId: string }).sessionId);
    return readGame(viewer.gameId, (domain) => domain.roleSafeState(viewer));
  });
  app.put('/api/v1/sessions/:sessionId/decisions', async (request) => {
    const { quantity } = z.object({ quantity: z.number().int() }).parse(request.body);
    const viewer = await sessionActor(request, (request.params as { sessionId: string }).sessionId);
    return writeGame(viewer.gameId, (domain) =>
      domain.submitDecision(
        viewer,
        quantity,
        Number(request.headers['if-match'] ?? -1),
        String(request.headers['idempotency-key'] ?? ''),
      ),
    );
  });
  app.post('/api/v1/sessions/:sessionId/weeks/:week/commit', async (request) => {
    const { sessionId, week } = z
      .object({ sessionId: z.string(), week: z.coerce.number().int().positive() })
      .parse(request.params);
    const viewer = await sessionActor(request, sessionId);
    return writeGame(viewer.gameId, (domain) =>
      domain.commitWeek(
        viewer,
        Number(request.headers['if-match'] ?? -1),
        String(request.headers['idempotency-key'] ?? ''),
        week,
      ),
    );
  });
  app.get('/api/v1/games/:gameId/events', async (request, reply) => {
    const { gameId } = z.object({ gameId: z.string() }).parse(request.params);
    const viewer = await scopedActor(request, gameId);
    const cursor = request.headers['last-event-id'];
    const cursorId = typeof cursor === 'string' ? cursor : undefined;
    const replay = gameRepository
      ? await gameRepository.eventsSince(gameId, cursorId)
      : service.eventsSince(viewer, cursorId);
    const writeEvent = (event: {
      eventId: string;
      aggregateVersion: number;
      correlationId: string;
    }) => {
      reply.raw.write(
        `id: ${event.eventId}\nevent: state-version\ndata: ${JSON.stringify({ gameId, version: event.aggregateVersion, correlationId: event.correlationId })}\n\n`,
      );
    };
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const unsubscribe = gameRepository
      ? gameRepository.subscribeEvents(
          gameId,
          replay.at(-1)?.aggregateVersion ?? (await gameRepository.eventVersion(gameId, cursorId)),
          writeEvent,
        )
      : service.subscribeEvents(viewer, writeEvent);
    for (const event of replay) writeEvent(event);
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
  const learningFor = async (gameId: string) => {
    if (!gameRepository) return learning;
    const projection = new LearningViewService();
    for (const event of await gameRepository.eventsSince(gameId)) projection.consume(event);
    return projection;
  };
  app.get('/api/v1/games/:gameId/observation', async (request) => {
    const gameId = (request.params as { gameId: string }).gameId;
    return (await learningFor(gameId)).getObservation(await learningActor(request, gameId));
  });
  app.get('/api/v1/games/:gameId/review', async (request) => {
    try {
      const gameId = (request.params as { gameId: string }).gameId;
      return (await learningFor(gameId)).getReview(await learningActor(request, gameId));
    } catch (error) {
      if (error instanceof Error && error.message === 'GAME_NOT_ENDED')
        throw new Problem(409, 'GAME_NOT_ENDED', 'Game has not ended');
      throw error;
    }
  });
  app.post('/api/v1/games/:gameId/exports', async (request, reply) => {
    try {
      const gameId = (request.params as { gameId: string }).gameId;
      const viewer = await learningActor(request, gameId);
      const key = String(request.headers['idempotency-key'] ?? '');
      const result = gameRepository
        ? await gameRepository.createExport(viewer, key)
        : (await learningFor(gameId)).createExport(viewer, key);
      return reply.status(202).send({
        exportId: result.exportId,
        status: result.status,
        schemaVersion: result.schemaVersion,
        sourceVersion: result.sourceVersion,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'FORBIDDEN')
        throw new Problem(403, 'FORBIDDEN', 'Facilitator access is required');
      if (error instanceof Error && error.message === 'GAME_NOT_ENDED')
        throw new Problem(409, 'GAME_NOT_ENDED', 'Game has not ended');
      if (error instanceof Error && error.message === 'NO_DATA')
        throw new Problem(409, 'NO_DATA', 'No completed week is available');
      if (error instanceof Error && error.message === 'IDEMPOTENCY_REQUIRED')
        throw new Problem(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required');
      throw error;
    }
  });
  app.get('/api/v1/games/:gameId/exports/:exportId', async (request) => {
    const { exportId } = z.object({ exportId: z.string() }).parse(request.params);
    const result = await exportFor(request, exportId);
    return {
      exportId,
      status: result.status,
      schemaVersion: result.schemaVersion,
      sourceVersion: result.sourceVersion,
      checksum: result.checksum,
    };
  });
  app.get('/api/v1/games/:gameId/exports/:exportId/download', async (request, reply) => {
    const { exportId } = z.object({ exportId: z.string() }).parse(request.params);
    const { format } = z.object({ format: z.enum(['csv', 'json']) }).parse(request.query);
    const result = await exportFor(request, exportId);
    return reply
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="beer-game-${exportId}.${format}"`)
      .type(format === 'csv' ? 'text/csv' : 'application/json')
      .send(format === 'csv' ? result.csv : result.json);
  });
  app.get('/api/v1/games/:gameId/retention', async (request) => {
    const { gameId } = z.object({ gameId: z.string() }).parse(request.params);
    await operator(request, gameId);
    const current = retentionService();
    const policy = await current.policy(gameId);
    let deletion = null;
    if (policy) {
      try {
        deletion = await current.status(gameId);
      } catch (error) {
        if (!(error instanceof RetentionError && error.code === 'DELETION_NOT_FOUND')) throw error;
      }
    }
    return { policy, deletion };
  });
  app.post('/api/v1/games/:gameId/retention/retry', async (request) => {
    const { gameId } = z.object({ gameId: z.string() }).parse(request.params);
    await operator(request, gameId);
    const key = String(request.headers['idempotency-key'] ?? '');
    if (!key) throw new Problem(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required');
    const version = Number(request.headers['if-match'] ?? -1);
    const currentRetention = retentionService();
    if (currentRetention instanceof PostgresRetentionService)
      return currentRetention.manualRetry(gameId, true, { key, expectedAttempt: version });
    const saved = retryResults.get(`${gameId}:${key}`);
    if (saved) {
      if (saved.version !== version)
        throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'Key was used with a different version');
      return saved.result;
    }
    const current = await currentRetention.status(gameId);
    if (current.attempt !== version)
      throw new Problem(412, 'VERSION_CONFLICT', 'Deletion attempt is stale', {
        attempt: current.attempt,
      });
    const result = await currentRetention.manualRetry(gameId, true);
    retryResults.set(`${gameId}:${key}`, { version, result });
    return result;
  });
  return app;
}
