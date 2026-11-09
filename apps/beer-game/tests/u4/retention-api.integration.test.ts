import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { GameService } from '../../src/application/game-service.js';
import { LearningViewService } from '../../src/learning/learning-view.js';
import { RetentionService } from '../../src/retention/retention-service.js';

describe('Given the retention HTTP boundary', () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const previousOrigin = process.env.ALLOWED_ORIGIN;
  beforeEach(() => {
    process.env.ALLOWED_ORIGIN = 'https://beer-game.example.test';
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    if (previousOrigin === undefined) delete process.env.ALLOWED_ORIGIN;
    else process.env.ALLOWED_ORIGIN = previousOrigin;
  });

  it('records a requested retention period and returns it to the authorized operator', async () => {
    const app = await buildApp(
      new GameService(),
      new LearningViewService(),
      new RetentionService({ hmacKey: 'test-only-key' }),
    );
    apps.push(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/games',
      headers: { origin: 'https://beer-game.example.test', 'idempotency-key': 'u4-create' },
      payload: { finalWeek: 1, demand: [4], retentionDays: 45 },
    });
    expect(created.statusCode).toBe(201);
    const cookies = (created.headers['set-cookie'] as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const gameId = created.json().gameId as string;
    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${gameId}/retention`,
      headers: { cookie: cookies },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().policy.retentionDays).toBe(45);
  });

  it('denies a forged actor cookie without the operator credential', async () => {
    const app = await buildApp(
      new GameService(),
      new LearningViewService(),
      new RetentionService({ hmacKey: 'test-only-key' }),
    );
    apps.push(app);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/games',
      headers: { origin: 'https://beer-game.example.test', 'idempotency-key': 'u4-create' },
      payload: { finalWeek: 1, demand: [4] },
    });
    const gameId = created.json().gameId as string;
    const forgedActor = Buffer.from(
      JSON.stringify({ id: gameId, gameId, kind: 'FACILITATOR' }),
    ).toString('base64url');
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${gameId}/retention`,
      headers: { cookie: `bg_session=${forgedActor}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an out-of-range retention period at the API boundary', async () => {
    const app = await buildApp(
      new GameService(),
      new LearningViewService(),
      new RetentionService({ hmacKey: 'test-only-key' }),
    );
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/games',
      headers: { origin: 'https://beer-game.example.test', 'idempotency-key': 'invalid-u4' },
      payload: { finalWeek: 1, demand: [4], retentionDays: 0 },
    });
    expect(response.statusCode).not.toBe(201);
  });

  it('denies an operator credential scoped to another game', async () => {
    const app = await buildApp(
      new GameService(),
      new LearningViewService(),
      new RetentionService({ hmacKey: 'test-only-key' }),
    );
    apps.push(app);
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/games',
      headers: { origin: 'https://beer-game.example.test', 'idempotency-key': 'first-u4' },
      payload: { finalWeek: 1, demand: [4] },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/games',
      headers: { origin: 'https://beer-game.example.test', 'idempotency-key': 'second-u4' },
      payload: { finalWeek: 1, demand: [4] },
    });
    const cookies = (first.headers['set-cookie'] as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${second.json().gameId}/retention`,
      headers: { cookie: cookies },
    });
    expect(response.statusCode).toBe(403);
  });
});
