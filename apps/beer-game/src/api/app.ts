import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GameService, Problem, type Actor } from '../application/game-service.js';
import { ROLES } from '../domain/types.js';

const actorSchema = z.object({
  id: z.string(),
  kind: z.enum(['FACILITATOR', 'PARTICIPANT']),
  gameId: z.string(),
  role: z.enum(ROLES).optional(),
});
const encodeActor = (actor: Actor) => Buffer.from(JSON.stringify(actor)).toString('base64url');
const decodeActor = (value?: string): Actor | undefined => {
  try {
    return value
      ? actorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString()))
      : undefined;
  } catch {
    return undefined;
  }
};

export async function buildApp(service = new GameService()) {
  const app = Fastify({ bodyLimit: 64 * 1024, genReqId: () => randomUUID() });
  await app.register(cookie);
  await app.register(cors, { origin: false });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-correlation-id', request.id);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin && origin !== process.env.ALLOWED_ORIGIN)
        throw new Problem(403, 'ORIGIN_REJECTED', 'Origin is not allowed');
      if (
        request.url !== '/api/v1/games' &&
        request.headers['x-csrf-token'] !== request.cookies.bg_csrf
      )
        throw new Problem(403, 'CSRF_REJECTED', 'CSRF token is required');
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const problem =
      error instanceof Problem
        ? error
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
  const actor = (request: { cookies: Record<string, string | undefined> }) => {
    const value = decodeActor(request.cookies.bg_session);
    if (!value) throw new Problem(401, 'AUTH_REQUIRED', 'Authentication is required');
    return value;
  };
  const setSession = (reply: any, value: Actor) => {
    const csrf = randomUUID();
    reply.setCookie('bg_session', encodeActor(value), {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
    });
    reply.setCookie('bg_csrf', csrf, {
      httpOnly: false,
      secure: true,
      sameSite: 'strict',
      path: '/',
    });
    return csrf;
  };

  app.post('/api/v1/games', async (request, reply) => {
    const body = z
      .object({
        finalWeek: z.number().int().min(1).max(52),
        demand: z.array(z.number().int().min(0).max(1000)).min(1),
      })
      .parse(request.body);
    const result = service.createGame(body, String(request.headers['idempotency-key'] ?? ''));
    const csrfToken = setSession(reply, {
      id: result.gameId,
      kind: 'FACILITATOR',
      gameId: result.gameId,
    });
    return reply.status(201).send({ ...result, csrfToken });
  });
  app.post('/api/v1/games/:gameId/participants', async (request, reply) => {
    const { gameId } = z.object({ gameId: z.string() }).parse(request.params);
    const { displayName } = z.object({ displayName: z.string() }).parse(request.body);
    const result = service.joinGame(
      gameId,
      displayName,
      String(request.headers['idempotency-key'] ?? ''),
    );
    const csrfToken = setSession(reply, { id: result.participantId, kind: 'PARTICIPANT', gameId });
    return reply.status(201).send({ ...result, csrfToken });
  });
  app.put('/api/v1/games/:gameId/participants/:participantId/role', async (request) => {
    const { participantId } = z.object({ participantId: z.string() }).parse(request.params);
    const { role } = z.object({ role: z.enum(ROLES) }).parse(request.body);
    return service.assignRole(actor(request), participantId, role);
  });
  app.post('/api/v1/sessions/:sessionId/start', async (request) =>
    service.startSession(actor(request)),
  );
  app.post('/api/v1/sessions/:sessionId/pause', async (request) =>
    service.pauseSession(
      actor(request),
      Number(request.headers['if-match'] ?? -1),
      String(request.headers['idempotency-key'] ?? ''),
    ),
  );
  app.post('/api/v1/sessions/:sessionId/resume', async (request) =>
    service.resumeSession(
      actor(request),
      Number(request.headers['if-match'] ?? -1),
      String(request.headers['idempotency-key'] ?? ''),
    ),
  );
  app.post('/api/v1/sessions/:sessionId/end', async (request) =>
    service.endSession(
      actor(request),
      Number(request.headers['if-match'] ?? -1),
      String(request.headers['idempotency-key'] ?? ''),
    ),
  );
  app.put('/api/v1/sessions/:sessionId/proxy-decisions/:role', async (request) => {
    const { role } = z.object({ role: z.enum(ROLES) }).parse(request.params);
    const { quantity, expectedVersion } = z
      .object({ quantity: z.number().int(), expectedVersion: z.number().int().min(0) })
      .parse(request.body);
    return service.submitProxyDecision(
      actor(request),
      role,
      quantity,
      expectedVersion,
      String(request.headers['idempotency-key'] ?? ''),
    );
  });
  app.post('/api/v1/participations/recover', async (request, reply) => {
    const { recoveryToken } = z.object({ recoveryToken: z.string().min(1) }).parse(request.body);
    const result = service.recoverParticipation(recoveryToken);
    const csrfToken = setSession(reply, result.actor);
    return { recoveryToken: result.recoveryToken, state: result.state, csrfToken };
  });
  app.get('/api/v1/sessions/:sessionId/state', async (request) =>
    service.roleSafeState(actor(request)),
  );
  app.put('/api/v1/sessions/:sessionId/decisions', async (request) => {
    const { quantity } = z.object({ quantity: z.number().int() }).parse(request.body);
    return service.submitDecision(
      actor(request),
      quantity,
      Number(request.headers['if-match'] ?? -1),
      String(request.headers['idempotency-key'] ?? ''),
    );
  });
  app.post('/api/v1/sessions/:sessionId/weeks/:week/commit', async (request) =>
    service.commitWeek(
      actor(request),
      Number(request.headers['if-match'] ?? -1),
      String(request.headers['idempotency-key'] ?? ''),
    ),
  );
  app.get('/api/v1/games/:gameId/events', async (request, reply) => {
    const { gameId } = z.object({ gameId: z.string() }).parse(request.params);
    actor(request);
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for (const event of service.events(gameId))
      reply.raw.write(
        `id: ${event.aggregateVersion}\nevent: ${event.eventType}\ndata: ${JSON.stringify({ version: event.aggregateVersion })}\n\n`,
      );
    reply.raw.end();
  });
  return app;
}
