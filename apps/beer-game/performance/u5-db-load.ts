import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { buildApp } from '../src/api/app.js';
import { LatencyHistogram } from './u5-harness.js';

const databaseUrl = process.env.GAME_TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_u5_test'))
  throw new Error('GAME_TEST_DATABASE_URL must target a dedicated _u5_test database');

const schema = `u5_load_${randomUUID().replaceAll('-', '')}`;
const origin = 'https://beer-game.example.test';
const admin = new Pool({ connectionString: databaseUrl });
const controllers: AbortController[] = [];
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const roles = ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'] as const;

function cookieHeader(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

async function post(
  base: string,
  path: string,
  key: string,
  body: unknown,
  cookie = '',
  version?: number,
) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      origin,
      cookie,
      'idempotency-key': key,
      'content-type': 'application/json',
      ...(version === undefined ? {} : { 'if-match': String(version) }),
    },
    body: JSON.stringify(body),
  });
}

try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const setup = new Pool({ connectionString: url.toString() });
  try {
    for (const name of [
      '001_u1_walking_skeleton.sql',
      '002_u2_session_continuity.sql',
      '003_u3_learning_view.sql',
      '004_u4_retention.sql',
      '005_u5_shared_game_store.sql',
    ])
      await setup.query(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  } finally {
    await setup.end();
  }

  process.env.DATABASE_URL = url.toString();
  process.env.GAME_CREDENTIAL_ENCRYPTION_KEY = '0123456789abcdef'.repeat(4);
  process.env.ALLOWED_ORIGIN = origin;
  process.env.API_RATE_LIMIT_PER_MINUTE = '6000';
  const bases: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const app = await buildApp();
    apps.push(app);
    bases.push(new URL(await app.listen({ host: '127.0.0.1', port: 0 })).origin);
  }

  const clients: {
    gameId: string;
    sessionId: string;
    cookie: string;
    kind: 'FACILITATOR' | 'PARTICIPANT';
  }[] = [];
  for (let gameIndex = 0; gameIndex < 15; gameIndex += 1) {
    const created = await post(bases[0], '/api/v1/games', `load-create-${gameIndex}`, {
      finalWeek: 1,
      demand: [4],
    });
    if (created.status !== 201) throw new Error(`Create failed: ${created.status}`);
    const game = (await created.json()) as { gameId: string; sessionId: string; joinCode: string };
    const facilitator = cookieHeader(created);
    clients.push({
      gameId: game.gameId,
      sessionId: game.sessionId,
      cookie: facilitator,
      kind: 'FACILITATOR',
    });
    for (const [roleIndex, role] of roles.entries()) {
      const joined = await post(
        bases[1],
        '/api/v1/participations/join',
        `load-join-${gameIndex}-${roleIndex}`,
        { joinCode: game.joinCode, displayName: `P${roleIndex}` },
      );
      if (joined.status !== 201) throw new Error(`Join failed: ${joined.status}`);
      const { participantId } = (await joined.json()) as { participantId: string };
      const assigned = await fetch(
        `${bases[0]}/api/v1/games/${game.gameId}/participants/${participantId}/role`,
        {
          method: 'PUT',
          headers: {
            origin,
            cookie: facilitator,
            'content-type': 'application/json',
            'idempotency-key': `load-role-${gameIndex}-${roleIndex}`,
            'if-match': '1',
          },
          body: JSON.stringify({ role }),
        },
      );
      if (assigned.status !== 200) throw new Error(`Role assignment failed: ${assigned.status}`);
      clients.push({
        gameId: game.gameId,
        sessionId: game.sessionId,
        cookie: cookieHeader(joined),
        kind: 'PARTICIPANT',
      });
    }
  }

  const sseOpen = new LatencyHistogram();
  await Promise.all(
    clients.map(async (client, index) => {
      const controller = new AbortController();
      controllers.push(controller);
      const started = performance.now();
      const response = await fetch(`${bases[index % 2]}/api/v1/games/${client.gameId}/events`, {
        headers: { cookie: client.cookie },
        signal: controller.signal,
      });
      sseOpen.record(started, performance.now());
      if (response.status !== 200) throw new Error(`SSE failed: ${response.status}`);
    }),
  );

  const snapshot = new LatencyHistogram();
  let failures = 0;
  for (let burst = 0; burst < 5; burst += 1) {
    await Promise.all(
      clients.map(async (client, index) => {
        const path =
          client.kind === 'FACILITATOR'
            ? `/api/v1/games/${client.gameId}/lobby`
            : `/api/v1/sessions/${client.sessionId}/state`;
        const started = performance.now();
        try {
          const response = await fetch(`${bases[(index + burst) % 2]}${path}`, {
            headers: { cookie: client.cookie },
          });
          snapshot.record(started, performance.now());
          if (response.status !== 200) failures += 1;
          await response.arrayBuffer();
        } catch {
          failures += 1;
        }
      }),
    );
    if (burst < 4) await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  process.stdout.write(
    JSON.stringify({
      games: 15,
      clients: clients.length,
      sseConnections: controllers.length,
      pollingSamples: snapshot.count,
      pollingFailures: failures,
      sseOpenP95Ms: sseOpen.p95(),
      snapshotP95Ms: snapshot.p95(),
      snapshotMaxMs: snapshot.max(),
      note: 'Two Fastify instances and PostgreSQL pools in one OS process; separate-process correctness is covered by multi-process.integration.test.ts. Browser commit-to-render and AWS edge are not measured.',
    }) + '\n',
  );
} finally {
  for (const controller of controllers) controller.abort();
  for (const app of apps) await app.close();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
}
