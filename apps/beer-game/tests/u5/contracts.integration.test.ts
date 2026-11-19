import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { GameService } from '../../src/application/game-service.js';
import { LearningViewService } from '../../src/learning/learning-view.js';
import { RetentionService } from '../../src/retention/retention-service.js';

const ORIGIN = 'https://beer-game.example.test';
const credentials = (setCookie: string | string[] | undefined): string =>
  (Array.isArray(setCookie) ? setCookie : [setCookie ?? ''])
    .map((cookie) => cookie.split(';')[0])
    .filter(Boolean)
    .join('; ');

describe('Given the browser contract', () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const previousOrigin = process.env.ALLOWED_ORIGIN;

  beforeEach(() => {
    process.env.ALLOWED_ORIGIN = ORIGIN;
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    if (previousOrigin === undefined) delete process.env.ALLOWED_ORIGIN;
    else process.env.ALLOWED_ORIGIN = previousOrigin;
  });

  const createGame = async () => {
    const app = await buildApp();
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/games',
      headers: { origin: ORIGIN, 'idempotency-key': crypto.randomUUID() },
      payload: { finalWeek: 1, demand: [4] },
    });
    return { app, response };
  };

  it('rejects a state-changing request when Origin and Referer are absent', async () => {
    const app = await buildApp();
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/games',
      headers: { 'idempotency-key': 'without-origin' },
      payload: { finalWeek: 1, demand: [4] },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().title).toBe('ORIGIN_REJECTED');
  });

  it('answers the ALB health check without exposing a game', async () => {
    const app = await buildApp();
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('accepts a matching HTTPS Referer and rejects a foreign Origin', async () => {
    const app = await buildApp();
    apps.push(app);
    const body = { finalWeek: 1, demand: [4] };
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/v1/games',
      headers: { referer: `${ORIGIN}/create`, 'idempotency-key': 'referer-allowed' },
      payload: body,
    });
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/games',
      headers: {
        origin: 'https://evil.example',
        referer: `${ORIGIN}/create`,
        'idempotency-key': 'origin-rejected',
      },
      payload: body,
    });
    expect(allowed.statusCode).toBe(201);
    expect(rejected.statusCode).toBe(403);
  });

  it('rejects an HTTP Referer fallback even on a configured local origin', async () => {
    const app = await buildApp();
    apps.push(app);
    process.env.ALLOWED_ORIGIN = 'http://127.0.0.1:3100';
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/games',
      headers: { referer: 'http://127.0.0.1:3100/create', 'idempotency-key': 'http-referer' },
      payload: { finalWeek: 1, demand: [4] },
    });
    expect(response.statusCode).toBe(403);
  });

  it('issues only HttpOnly Strict credential cookies, without a CSRF token', async () => {
    const { response } = await createGame();
    expect(response.statusCode).toBe(201);
    const cookies = Array.isArray(response.headers['set-cookie'])
      ? response.headers['set-cookie']
      : [String(response.headers['set-cookie'])];
    expect(cookies.some((cookie) => cookie.startsWith('bg_session='))).toBe(true);
    expect(cookies.every((cookie) => cookie.includes('HttpOnly'))).toBe(true);
    expect(cookies.every((cookie) => cookie.includes('SameSite=Strict'))).toBe(true);
    expect(response.json()).not.toHaveProperty('csrfToken');
  });

  it('accepts a same-origin lifecycle command without a CSRF token', async () => {
    const { app, response } = await createGame();
    const result = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${response.json().sessionId}/start`,
      headers: {
        origin: ORIGIN,
        cookie: credentials(response.headers['set-cookie']),
        'if-match': '1',
        'idempotency-key': 'start-roles-missing',
      },
    });
    expect(result.statusCode).toBe(409);
    expect(result.json().title).toBe('ROLES_MISSING');
  });

  it('rejects a forged actor cookie', async () => {
    const { app, response } = await createGame();
    const forged = Buffer.from(
      JSON.stringify({ id: 'forged', kind: 'FACILITATOR', gameId: response.json().gameId }),
    ).toString('base64url');
    const result = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${response.json().sessionId}/state`,
      headers: { cookie: `bg_session=${forged}` },
    });
    expect(result.statusCode).toBe(401);
  });

  it('rejects another game’s event stream', async () => {
    const { app, response } = await createGame();
    const result = await app.inject({
      method: 'GET',
      url: '/api/v1/games/other-game/events',
      headers: { cookie: credentials(response.headers['set-cookie']) },
    });
    expect(result.statusCode).toBe(403);
  });

  it('rejects another session’s state even with a valid cookie', async () => {
    const { app, response } = await createGame();
    const result = await app.inject({
      method: 'GET',
      url: '/api/v1/sessions/another-session/state',
      headers: { cookie: credentials(response.headers['set-cookie']) },
    });
    expect(result.statusCode).toBe(403);
  });

  it('rejects another game’s review and export endpoints', async () => {
    const { app, response } = await createGame();
    const cookie = credentials(response.headers['set-cookie']);
    const review = await app.inject({
      method: 'GET',
      url: '/api/v1/games/another-game/review',
      headers: { cookie },
    });
    const exportResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/games/another-game/exports',
      headers: { cookie, origin: ORIGIN, 'idempotency-key': 'cross-game-export' },
    });
    expect(review.statusCode).toBe(403);
    expect(exportResponse.statusCode).toBe(403);
  });

  it('joins by invitation code and returns only the participant’s lobby view', async () => {
    const { app, response } = await createGame();
    const game = response.json();
    const joined = await app.inject({
      method: 'POST',
      url: '/api/v1/participations/join',
      headers: { origin: ORIGIN, 'idempotency-key': 'join-by-code' },
      payload: { joinCode: game.joinCode, displayName: 'Retailer' },
    });
    expect(joined.statusCode).toBe(201);
    const own = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${game.gameId}/lobby`,
      headers: { cookie: credentials(joined.headers['set-cookie']) },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().participants).toEqual([
      { participantId: joined.json().participantId, displayName: 'Retailer' },
    ]);
    expect(own.json()).not.toHaveProperty('joinCode');
  });

  it('recovers a participant with a rotated cookie and game scope', async () => {
    const { app, response } = await createGame();
    const game = response.json();
    const joined = await app.inject({
      method: 'POST',
      url: `/api/v1/games/${game.gameId}/participants`,
      headers: { origin: ORIGIN, 'idempotency-key': 'recover-join' },
      payload: { displayName: 'R' },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/games/${game.gameId}/participants/${joined.json().participantId}/role`,
      headers: {
        origin: ORIGIN,
        cookie: credentials(response.headers['set-cookie']),
        'if-match': '1',
        'idempotency-key': 'recover-role',
      },
      payload: { role: 'RETAILER' },
    });
    const recovered = await app.inject({
      method: 'POST',
      url: '/api/v1/participations/recover',
      headers: { origin: ORIGIN, cookie: credentials(joined.headers['set-cookie']) },
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().gameId).toBe(game.gameId);
    expect(recovered.json().state.own.role).toBe('RETAILER');
    expect(recovered.headers['set-cookie']).toBeDefined();
  });

  it('keeps join input and reports an invalid invitation code', async () => {
    const { app } = await createGame();
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/participations/join',
      headers: { origin: ORIGIN, 'idempotency-key': 'invalid-join' },
      payload: { joinCode: 'INVALID0', displayName: 'Retailer' },
    });
    expect(result.statusCode).toBe(404);
    expect(result.json().title).toBe('JOIN_CODE_NOT_FOUND');
  });

  it('checks facilitator role assignment version and replays its idempotency key', async () => {
    const { app, response } = await createGame();
    const game = response.json();
    const facilitatorCookie = credentials(response.headers['set-cookie']);
    const joined = await app.inject({
      method: 'POST',
      url: `/api/v1/games/${game.gameId}/participants`,
      headers: { origin: ORIGIN, 'idempotency-key': 'role-join' },
      payload: { displayName: 'R' },
    });
    const url = `/api/v1/games/${game.gameId}/participants/${joined.json().participantId}/role`;
    const headers = {
      origin: ORIGIN,
      cookie: facilitatorCookie,
      'idempotency-key': 'role-set',
      'if-match': '1',
    };
    const first = await app.inject({ method: 'PUT', url, headers, payload: { role: 'RETAILER' } });
    const repeated = await app.inject({
      method: 'PUT',
      url,
      headers,
      payload: { role: 'RETAILER' },
    });
    const stale = await app.inject({
      method: 'PUT',
      url,
      headers: { ...headers, 'idempotency-key': 'role-stale', 'if-match': '0' },
      payload: { role: 'RETAILER' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual(repeated.json());
    expect(first.json().version).toBe(1);
    expect(stale.statusCode).toBe(412);
  });

  it('requires version and idempotency headers for facilitator lifecycle commands', async () => {
    const { app, response } = await createGame();
    const headers = { origin: ORIGIN, cookie: credentials(response.headers['set-cookie']) };
    const url = `/api/v1/sessions/${response.json().sessionId}/start`;
    const missing = await app.inject({ method: 'POST', url, headers });
    const stale = await app.inject({
      method: 'POST',
      url,
      headers: { ...headers, 'if-match': '0', 'idempotency-key': 'start-stale' },
    });
    const valid = await app.inject({
      method: 'POST',
      url,
      headers: { ...headers, 'if-match': '1', 'idempotency-key': 'start-valid' },
    });
    expect(missing.statusCode).toBe(400);
    expect(stale.statusCode).toBe(412);
    expect(valid.statusCode).toBe(409);
    expect(valid.json().title).toBe('ROLES_MISSING');
  });

  it('keeps export downloads private and marks them as attachments', async () => {
    const { app, response } = await createGame();
    const game = response.json();
    const result = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${game.gameId}/exports/missing/download?format=csv`,
      headers: { cookie: credentials(response.headers['set-cookie']) },
    });
    expect(result.statusCode).toBe(404);
    expect(result.json().title).toBe('EXPORT_NOT_FOUND');
  });
});

describe('Given a live game event stream', () => {
  it('delivers later versions and stops after unsubscribe', () => {
    const service = new GameService();
    const game = service.createGame({ finalWeek: 1, demand: [4] }, 'stream-create');
    const actor = { id: game.gameId, gameId: game.gameId, kind: 'FACILITATOR' as const };
    const received: string[] = [];
    const stop = service.subscribeEvents(actor, (event) => received.push(event.eventType));
    service.joinGame(game.gameId, 'Retailer', 'stream-join');
    expect(received).toEqual(['ParticipantJoined']);
    stop();
    service.joinGame(game.gameId, 'Wholesaler', 'stream-join-2');
    expect(received).toEqual(['ParticipantJoined']);
  });

  it('replays events after a known cursor only', () => {
    const service = new GameService();
    const game = service.createGame({ finalWeek: 1, demand: [4] }, 'stream-create');
    const actor = { id: game.gameId, gameId: game.gameId, kind: 'FACILITATOR' as const };
    const first = service.events(game.gameId)[0].eventId;
    service.joinGame(game.gameId, 'Retailer', 'stream-join');
    expect(service.eventsSince(actor, first).map((event) => event.eventType)).toEqual([
      'ParticipantJoined',
    ]);
  });
  it('rejects an unknown replay cursor without exposing state', () => {
    const service = new GameService();
    const game = service.createGame({ finalWeek: 1, demand: [4] }, 'stream-create');
    const actor = { id: game.gameId, gameId: game.gameId, kind: 'FACILITATOR' as const };
    expect(() => service.eventsSince(actor, 'unknown')).toThrow('Event cursor is unknown');
  });
});

describe('Given a participant snapshot', () => {
  it('reports the own decision version so a browser can send If-Match', () => {
    const service = new GameService();
    const game = service.createGame({ finalWeek: 1, demand: [4] }, 'state-create');
    const joined = service.joinGame(game.gameId, 'Retailer', 'state-join');
    const facilitator = { id: game.gameId, gameId: game.gameId, kind: 'FACILITATOR' as const };
    service.assignRole(facilitator, joined.participantId, 'RETAILER');
    const actor = service.actorForParticipant(game.gameId, joined.participantId);
    expect(service.roleSafeState(actor).decisionVersion).toBe(0);
  });
});

describe('Given facilitator completion status', () => {
  it('shows role completion only to the facilitator lobby', () => {
    const service = new GameService();
    const game = service.createGame({ finalWeek: 1, demand: [4] }, 'completion-create');
    const facilitator = { id: game.gameId, gameId: game.gameId, kind: 'FACILITATOR' as const };
    for (const [index, role] of (
      ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'] as const
    ).entries()) {
      const joined = service.joinGame(game.gameId, role, `completion-join-${index}`);
      service.assignRole(facilitator, joined.participantId, role);
    }
    service.startSession(facilitator);
    const retailer = service.lobbyState(facilitator).participants[0];
    service.submitDecision(
      service.actorForParticipant(game.gameId, retailer.participantId),
      4,
      0,
      'completion-decision',
    );
    const operatorView = service.lobbyState(facilitator);
    const participantView = service.lobbyState(
      service.actorForParticipant(game.gameId, retailer.participantId),
    );
    expect(operatorView.decisions?.RETAILER).toEqual({ complete: true, version: 1 });
    expect(operatorView.decisions?.FACTORY).toEqual({ complete: false, version: 0 });
    expect(participantView).not.toHaveProperty('decisions');
  });

  it('rejects a commit URL for a different week before changing state', async () => {
    const previous = process.env.ALLOWED_ORIGIN;
    process.env.ALLOWED_ORIGIN = ORIGIN;
    const service = new GameService();
    const game = service.createGame({ finalWeek: 1, demand: [4] }, 'week-create');
    const facilitator = { id: game.gameId, gameId: game.gameId, kind: 'FACILITATOR' as const };
    for (const [index, role] of (
      ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'] as const
    ).entries()) {
      const joined = service.joinGame(game.gameId, role, `week-join-${index}`);
      service.assignRole(facilitator, joined.participantId, role);
    }
    service.startSession(facilitator);
    for (const role of ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'] as const)
      service.submitProxyDecision(facilitator, role, 4, 0, `week-proxy-${role}`);
    const app = await buildApp(service);
    try {
      const cookie = `bg_session=${service.issueBrowserSession(facilitator)}`;
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${game.sessionId}/weeks/999/commit`,
        headers: { origin: ORIGIN, cookie, 'if-match': '2', 'idempotency-key': 'wrong-week' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().title).toBe('WEEK_MISMATCH');
    } finally {
      await app.close();
      if (previous === undefined) delete process.env.ALLOWED_ORIGIN;
      else process.env.ALLOWED_ORIGIN = previous;
    }
  });
});

describe('Given a failed retention saga', () => {
  const ORIGIN = 'https://beer-game.example.test';
  it('retries once for a matching attempt and replays the same key', async () => {
    const previous = process.env.ALLOWED_ORIGIN;
    process.env.ALLOWED_ORIGIN = ORIGIN;
    let now = new Date('2026-01-01T00:00:00Z');
    const retention = new RetentionService({
      hmacKey: 'test-key',
      now: () => now,
      jitter: () => 0,
    });
    const app = await buildApp(new GameService(), new LearningViewService(), retention);
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/games',
        headers: { origin: ORIGIN, 'idempotency-key': 'retention-create' },
        payload: { finalWeek: 1, demand: [4], retentionDays: 1 },
      });
      const gameId = created.json().gameId;
      const cookie = credentials(created.headers['set-cookie']);
      now = new Date('2026-01-03T00:00:00Z');
      const [saga] = retention.startDueDeletions();
      retention.consumeCompletion({
        eventId: 'failed-1',
        deletionId: saga.deletionId,
        ownerUnit: 'u1-walking-skeleton',
        status: 'permanent-failure',
        completedAt: now.toISOString(),
        attempt: 1,
        schemaVersion: 2,
        failureCode: 'OWNER_ERROR',
      });
      const url = `/api/v1/games/${gameId}/retention/retry`;
      const base = { origin: ORIGIN, cookie, 'idempotency-key': 'retry-1' };
      const stale = await app.inject({
        method: 'POST',
        url,
        headers: { ...base, 'if-match': '0' },
      });
      const first = await app.inject({
        method: 'POST',
        url,
        headers: { ...base, 'if-match': '1' },
      });
      const repeated = await app.inject({
        method: 'POST',
        url,
        headers: { ...base, 'if-match': '1' },
      });
      expect(stale.statusCode).toBe(412);
      expect(first.statusCode).toBe(200);
      expect(first.json().attempt).toBe(2);
      expect(repeated.json()).toEqual(first.json());
      expect(retention.status(gameId).attempt).toBe(2);
    } finally {
      await app.close();
      if (previous === undefined) delete process.env.ALLOWED_ORIGIN;
      else process.env.ALLOWED_ORIGIN = previous;
    }
  });
});
