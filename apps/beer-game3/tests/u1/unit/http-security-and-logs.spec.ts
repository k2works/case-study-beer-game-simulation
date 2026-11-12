import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../../src/server/session/memory-store.js';
import { bearer, buildTestApp, json, runThinSlice } from '../support/app.js';
import { newKey } from '../support/world.js';

describe('セキュリティヘッダと CORS（NFR6.6、NFR6.10）', () => {
  it('CSP・nosniff・フレーム禁止・Referrer の制限を付け、CORS の許可ヘッダを出さない', async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['strict-transport-security']).toBeUndefined();
    await app.close();
  });

  it('HSTS は有効にしたとき（staging と production）だけ付く', async () => {
    const { app } = await buildTestApp({ hsts: true });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['strict-transport-security']).toContain('max-age=');
    await app.close();
  });

  it('別のオリジンからの API の要求は 403 で拒否し、同じオリジンは通す', async () => {
    const { app } = await buildTestApp();
    const evil = await app.inject({
      method: 'POST',
      url: '/api/games',
      headers: { origin: 'https://evil.example', host: 'beer.example' },
      payload: { name: '授業', weekCount: 3 },
    });
    expect(evil.statusCode).toBe(403);
    expect(json(evil).kind).toBe('forbidden');
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/games',
      headers: {
        origin: 'https://evil.example',
        host: 'beer.example',
        'access-control-request-method': 'POST',
      },
    });
    expect(preflight.statusCode).toBe(403);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    const same = await app.inject({
      method: 'POST',
      url: '/api/games',
      headers: { origin: 'https://beer.example', host: 'beer.example' },
      payload: { name: '授業', weekCount: 3 },
    });
    expect(same.statusCode).toBe(201);
    await app.close();
  });

  it('HTTPS の強制: 平文の HTTP（x-forwarded-proto: http）は GET を HTTPS へ転送し、書き込みは拒否する', async () => {
    const { app } = await buildTestApp({ enforceHttps: true });
    const get = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: 'beer.example', 'x-forwarded-proto': 'http' },
    });
    expect(get.statusCode).toBe(308);
    expect(get.headers.location).toBe('https://beer.example/health');
    const post = await app.inject({
      method: 'POST',
      url: '/api/games',
      headers: { host: 'beer.example', 'x-forwarded-proto': 'http' },
      payload: { name: '授業', weekCount: 3 },
    });
    expect(post.statusCode).toBe(403);
    const https = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { host: 'beer.example', 'x-forwarded-proto': 'https' },
    });
    expect(https.statusCode).toBe(200);
    await app.close();
  });
});

describe('共通のエラー形式（Problem）', () => {
  it('壊れた JSON・存在しない入口・資格情報なしは、すべて Problem の形で返す', async () => {
    const { app } = await buildTestApp();
    const broken = await app.inject({
      method: 'POST',
      url: '/api/games',
      headers: { 'content-type': 'application/json' },
      payload: '{"name": ',
    });
    expect(broken.statusCode).toBe(422);
    expect(json(broken)).toMatchObject({ kind: 'validation' });
    const missing = await app.inject({ method: 'GET', url: '/api/nothing' });
    expect(missing.statusCode).toBe(404);
    expect(json(missing).kind).toBe('not_found');
    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/games/00000000-0000-4000-8000-000000000000/state',
    });
    const wrong = await app.inject({
      method: 'GET',
      url: '/api/games/00000000-0000-4000-8000-000000000000/state',
      headers: bearer('tok_invalid'),
    });
    expect(anonymous.statusCode).toBe(403);
    // 失敗の応答の形は同じ（コードの推測に手がかりを与えない）
    expect(json(wrong)).toEqual(json(anonymous));
    await app.close();
  });

  it('想定外の例外は 500 の internal で、内部の情報を返さず、エラーとしてログに残す', async () => {
    const store = new MemoryStore();
    const { app, logs } = await buildTestApp({ store });
    const created = json(
      await app.inject({
        method: 'POST',
        url: '/api/games',
        payload: { name: '授業', weekCount: 3 },
      }),
    );
    store.readSnapshot = async () => {
      throw new Error('接続文字列 postgres://secret@db/host に失敗');
    };
    const response = await app.inject({
      method: 'GET',
      url: `/api/games/${created.gameId}/state`,
      headers: bearer(created.codes.facilitatorCode),
    });
    expect(response.statusCode).toBe(500);
    expect(json(response).kind).toBe('internal');
    expect(response.body).not.toContain('postgres://');
    const errorLog = logs.find((line) => line.level === 'error');
    expect(errorLog).toBeDefined();
    expect(JSON.stringify(logs)).not.toContain('postgres://');
    await app.close();
  });

  it('NFR3.7 順番待ちの時間切れは 503 の unavailable', async () => {
    const store = new MemoryStore({ lockTimeoutMs: 30 });
    const { app } = await buildTestApp({ store });
    const result = await runThinSlice(app);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = store.transact(result.gameId, async () => {
      await hold;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const response = await app.inject({
      method: 'PUT',
      url: `/api/games/${result.gameId}/weeks/2/decisions/retailer`,
      headers: { ...bearer(result.tokens.retailer!), 'idempotency-key': newKey() },
      payload: { quantity: 3 },
    });
    expect(response.statusCode).toBe(503);
    expect(json(response).kind).toBe('unavailable');
    release();
    await holder;
    await app.close();
  });
});

describe('ヘルスチェックと構造化ログ（NFR3.5、NFR3.6、NFR6.4）', () => {
  it('GET /health は稼働とデータベースへの接続を返し、内部の情報を含まない', async () => {
    const { app } = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(json(response)).toEqual({ status: 'ok', database: 'ok' });
    await app.close();
  });

  it('データベースに接続できないときは 503', async () => {
    const store = new MemoryStore();
    store.ping = async () => {
      throw new Error('connection refused');
    };
    const { app } = await buildTestApp({ store });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(json(response)).toEqual({ status: 'error', database: 'unreachable' });
    await app.close();
  });

  it('すべての要求に要求の識別子を付け、ログの全行に同じ識別子が出る', async () => {
    const { app, logs } = await buildTestApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/games',
      payload: { name: '授業', weekCount: 99 },
    });
    const requestId = response.headers['x-request-id'] as string;
    expect(requestId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    const line = logs.find((entry) => entry.reqId === requestId);
    expect(line).toMatchObject({
      level: 'info',
      operation: 'POST /api/games',
      result: 'validation',
      status: 422,
    });
    expect(typeof line?.time).toBe('string');
    expect(typeof line?.durationMs).toBe('number');
    // 呼び出し側が付けた識別子は、形が正しければそのまま使う
    const given = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'client-req-0001' },
    });
    expect(given.headers['x-request-id']).toBe('client-req-0001');
    // 形が不正なら採用しない
    const bad = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'a b\nc' },
    });
    expect(bad.headers['x-request-id']).not.toBe('a b\nc');
    await app.close();
  });

  it('ゲームの識別子・役割・結果・応答時間を出し、コード・token・Authorization・接続元を出さない', async () => {
    const { app, logs } = await buildTestApp();
    const result = await runThinSlice(app);
    await app.inject({
      method: 'POST',
      url: '/api/games/join',
      remoteAddress: '203.0.113.9',
      payload: { joinCode: 'WRONGCODE9', displayName: '誰か' },
    });
    await app.inject({
      method: 'GET',
      url: `/api/games/${result.gameId}/state`,
      headers: bearer('tok_attacker-guess'),
    });
    const text = JSON.stringify(logs);
    for (const secret of [
      result.joinCode,
      result.facilitatorCode,
      ...Object.values(result.tokens),
      'WRONGCODE9',
      'tok_attacker-guess',
      '203.0.113.9',
      'Bearer',
    ]) {
      expect(text, `ログに ${secret} が出ている`).not.toContain(secret);
    }
    const input = logs.find((line) => String(line.operation).includes('decisions'));
    expect(input).toMatchObject({ gameId: result.gameId, result: 'ok', status: 200 });
    expect(input?.role).toBeDefined();
    // 無効なコードの試行は、接続元を鍵付きの要約で残す（生の接続元は残さない）
    const rejected = logs.filter((line) => line.result === 'forbidden');
    expect(rejected.length).toBeGreaterThanOrEqual(2);
    for (const line of rejected) {
      expect(String(line.src)).toMatch(/^[0-9a-f]{16}$/);
    }
    await app.close();
  });
});
