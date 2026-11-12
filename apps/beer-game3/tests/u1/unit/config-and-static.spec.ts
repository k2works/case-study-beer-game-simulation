import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/server/config.js';
import { ConfigError } from '../../../src/server/errors.js';
import { buildTestApp } from '../support/app.js';
import { TEST_ENV } from '../support/world.js';

const fixtureWeb = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../support/fixtures/web',
);

describe('設定の読み込み（鍵が無ければ起動しない）', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost/db', ...TEST_ENV };

  it('必要な値がそろっていれば、既定値を補って読める', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      port: 3100,
      host: '0.0.0.0',
      lockTimeoutMs: 3000,
      hsts: false,
      webDist: 'dist/web',
      runMigrations: false,
    });
  });

  it('接続先が無ければ拒否する', () => {
    expect(() => loadConfig({ ...TEST_ENV })).toThrow(ConfigError);
  });

  it('鍵が無ければ拒否する（NFR6.11）', () => {
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CODE_HMAC_KEY: '' })).toThrow(ConfigError);
  });

  it('ポートなどの数値の誤りは拒否し、真偽値は true のときだけ有効にする', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow(ConfigError);
    expect(
      loadConfig({ ...base, ENABLE_HSTS: 'true', RUN_MIGRATIONS: 'true', PORT: '4000' }),
    ).toMatchObject({
      hsts: true,
      runMigrations: true,
      port: 4000,
    });
  });
});

describe('画面の配信', () => {
  it('ビルド済みの画面があれば配信し、API 以外の経路は index.html にする。API の未定義は Problem', async () => {
    const { app } = await buildTestApp({ webDist: fixtureWeb });
    const index = await app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('beer-game3-fixture');
    const route = await app.inject({ method: 'GET', url: '/lobby/anything' });
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain('beer-game3-fixture');
    const api = await app.inject({ method: 'GET', url: '/api/unknown' });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toMatchObject({ kind: 'not_found' });
    await app.close();
  });

  it('画面が無いときは API だけを配信し、画面の経路は 404 の Problem', async () => {
    const { app } = await buildTestApp({ webDist: path.join(fixtureWeb, 'missing') });
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ kind: 'not_found' });
    await app.close();
  });
});
