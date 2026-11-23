import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { bootServer, ORIGIN } from './boot.js';
import { expectConforms } from './spec.js';

// 横断の約束（段階 1）: 運用の 2 操作、problem+json、Origin、Idempotency-Key、本文の上限

let server: FastifyInstance | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const UUID = '3f9c1b9e-5b0a-4a53-8b52-0c6b8f2d4a11';

describe('getHealth（GET /api/v1/health）', () => {
  it('200 で、HealthStatus に適合する', async () => {
    server = await bootServer();
    const res = await server.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expectConforms('HealthStatus', res.json());
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('getReady（GET /api/v1/ready）', () => {
  it('準備できていれば 200 で、HealthStatus に適合する', async () => {
    server = await bootServer();
    const res = await server.inject({ method: 'GET', url: '/api/v1/ready' });
    expect(res.statusCode).toBe(200);
    expectConforms('HealthStatus', res.json());
  });

  it('データベースに接続できなければ 503 で、type を持つ problem+json（NotReadyProblem）', async () => {
    server = await bootServer({ ready: async () => false });
    const res = await server.inject({ method: 'GET', url: '/api/v1/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json();
    expectConforms('NotReadyProblem', body);
    expect(body.type).toBe('/problems/app.not_ready');
    expect(body.checks).toEqual({ database: false, notifier: true });
  });

  it('データベースの確認が例外でも、503（database: false）', async () => {
    server = await bootServer({
      ready: async () => {
        throw new Error('接続できない');
      },
    });
    const res = await server.inject({ method: 'GET', url: '/api/v1/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.database).toBe(false);
  });

  it('通知の受信が生きていなければ 503（notifier: false）', async () => {
    server = await bootServer({ notifierReady: () => false });
    const res = await server.inject({ method: 'GET', url: '/api/v1/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks).toEqual({ database: true, notifier: false });
  });
});

describe('problem+json（共有の契約の Problem）', () => {
  it('存在しない経路は 404 request.not_found で、type・code・correlationId を持つ', async () => {
    server = await bootServer();
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/no-such-route',
      headers: { 'x-correlation-id': UUID },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json();
    expectConforms('Problem', body);
    expect(body).toMatchObject({
      type: '/problems/request.not_found',
      code: 'request.not_found',
      status: 404,
      correlationId: UUID,
    });
    expect(res.headers['x-correlation-id']).toBe(UUID);
  });

  it('旧い経路（/api/*）の problem は、段階 4 まで従来の形のまま', async () => {
    server = await bootServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/games',
      payload: { weeks: 2 },
      headers: { origin: 'https://evil.example.test' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toBe('about:blank');
  });
});

describe('Origin の検査（変更系。ALLOWED_ORIGINS）', () => {
  it('許可されていない送信元は 403 app.unauthorized', async () => {
    server = await bootServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/games',
      payload: {},
      headers: {
        origin: 'https://evil.example.test',
        'idempotency-key': 'k-1',
      },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expectConforms('Problem', body);
    expect(body.code).toBe('app.unauthorized');
  });

  it('送信元が無い変更系も 403', async () => {
    server = await bootServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/games',
      payload: {},
      headers: { 'idempotency-key': 'k-1' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('許可する送信元は、複数を指定できる', async () => {
    server = await bootServer({
      allowedOrigins: [ORIGIN, 'http://localhost:5273'],
    });
    for (const origin of [ORIGIN, 'http://localhost:5273']) {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/no-such-route',
        payload: {},
        headers: { origin, 'idempotency-key': 'k-1' },
      });
      // Origin と Idempotency-Key を通り、経路が無いので 404
      expect(res.statusCode).toBe(404);
    }
  });
});

describe('Idempotency-Key（変更系は必須）', () => {
  it('無ければ 400 validation.invalid_input', async () => {
    server = await bootServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/no-such-route',
      payload: {},
      headers: { origin: ORIGIN },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expectConforms('Problem', body);
    expect(body.code).toBe('validation.invalid_input');
  });

  it('読み取り（GET）には要らない', async () => {
    server = await bootServer();
    const res = await server.inject({
      method: 'GET',
      url: '/api/v1/no-such-route',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('本文の上限（64 KB）', () => {
  it('超えたら 413 request.too_large', async () => {
    server = await bootServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/no-such-route',
      payload: { filler: 'x'.repeat(70_000) },
      headers: { origin: ORIGIN, 'idempotency-key': 'k-1' },
    });
    expect(res.statusCode).toBe(413);
    const body = res.json();
    expectConforms('Problem', body);
    expect(body.code).toBe('request.too_large');
  });

  it('JSON として解釈できない本文は 400 validation.invalid_input', async () => {
    server = await bootServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/no-such-route',
      payload: '{not json',
      headers: {
        origin: ORIGIN,
        'idempotency-key': 'k-1',
        'content-type': 'application/json',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('validation.invalid_input');
  });
});
