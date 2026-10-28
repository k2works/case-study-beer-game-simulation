import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';

describe('Given the HTTP boundary', () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });
  it('creates a game with RFC-safe headers and secure cookies', async () => {
    const app = await buildApp();
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/games',
      headers: { 'idempotency-key': 'create' },
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
      headers: { 'idempotency-key': 'x', 'content-type': 'application/json' },
      payload: JSON.stringify({ finalWeek: 1, demand: [4], padding: 'x'.repeat(70_000) }),
    });
    expect(response.statusCode).toBe(500);
  });
});
