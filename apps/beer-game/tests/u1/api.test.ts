import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';

describe('Given the HTTP boundary', () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const previousOrigin = process.env.ALLOWED_ORIGIN;
  const previousRateLimit = process.env.API_RATE_LIMIT_PER_MINUTE;
  beforeEach(() => {
    process.env.ALLOWED_ORIGIN = 'https://beer-game.example.test';
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
    if (previousOrigin === undefined) delete process.env.ALLOWED_ORIGIN;
    else process.env.ALLOWED_ORIGIN = previousOrigin;
    if (previousRateLimit === undefined) delete process.env.API_RATE_LIMIT_PER_MINUTE;
    else process.env.API_RATE_LIMIT_PER_MINUTE = previousRateLimit;
  });
  it('creates a game with RFC-safe headers and secure cookies', async () => {
    const app = await buildApp();
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/games',
      headers: { origin: 'https://beer-game.example.test', 'idempotency-key': 'create' },
      payload: { finalWeek: 1, demand: [4] },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['x-correlation-id']).toBeTruthy();
    expect(String(response.headers['set-cookie'])).toContain('HttpOnly');
  });
  it('rejects missing idempotency keys as problem details', async () => {
    const app = await buildApp();
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/games',
      headers: { origin: 'https://beer-game.example.test' },
      payload: { finalWeek: 1, demand: [4] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json().correlationId).toBeTruthy();
  });
  it('rejects untrusted origins', async () => {
    const app = await buildApp();
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/games',
      headers: { origin: 'https://evil.example', 'idempotency-key': 'x' },
      payload: { finalWeek: 1, demand: [4] },
    });
    expect(response.statusCode).toBe(403);
  });
  it('rejects oversized payloads', async () => {
    const app = await buildApp();
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/games',
      headers: {
        origin: 'https://beer-game.example.test',
        'idempotency-key': 'x',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ finalWeek: 1, demand: [4], padding: 'x'.repeat(70_000) }),
    });
    expect(response.statusCode).toBe(413);
  });
  it('Given a per-client rate limit When it is exceeded Then the response is a retryable 429 problem', async () => {
    process.env.API_RATE_LIMIT_PER_MINUTE = '1';
    const app = await buildApp();
    apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(429);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json().title).toBe('RATE_LIMITED');
  });
});
