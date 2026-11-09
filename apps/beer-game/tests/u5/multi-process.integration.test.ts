import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxDispatcher } from '../../src/infrastructure/outbox-dispatcher.js';
import { PostgresRetentionService } from '../../src/retention/postgres-retention.js';

const databaseUrl = process.env.GAME_TEST_DATABASE_URL;
const schema = `u5_${randomUUID().replaceAll('-', '')}`;
const origin = 'https://beer-game.example.test';
const processes: ChildProcess[] = [];
const ports = [31271, 31272];

async function waitForHealth(port: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // The child has not opened its listener yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`API process on ${port} did not become healthy`);
}

function cookieHeader(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

async function createGame(port = ports[0]) {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/games`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ finalWeek: 1, demand: [4] }),
  });
  expect(response.status).toBe(201);
  return {
    response,
    game: (await response.json()) as { gameId: string; sessionId: string; joinCode: string },
  };
}

async function command(
  port: number,
  path: string,
  method: string,
  cookie: string,
  key: string,
  payload?: unknown,
  version?: number,
) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      origin,
      cookie,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      'idempotency-key': key,
      ...(version === undefined ? {} : { 'if-match': String(version) }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}

describe.skipIf(!databaseUrl)('Given two independent API processes sharing PostgreSQL', () => {
  let admin: Pool;

  beforeAll(async () => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_u5_test'))
      throw new Error('GAME_TEST_DATABASE_URL must target a dedicated _u5_test database');
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const setup = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    try {
      for (const name of [
        '001_u1_walking_skeleton.sql',
        '002_u2_session_continuity.sql',
        '003_u3_learning_view.sql',
        '004_u4_retention.sql',
        '005_u5_shared_game_store.sql',
      ]) {
        const sql = readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
        await setup.query(sql);
      }
    } finally {
      await setup.end();
    }
    const url = new URL(databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema}`);
    for (const port of ports) {
      const child = spawn(resolve('node_modules/.bin/tsx'), ['src/server.ts'], {
        cwd: resolve('.'),
        env: {
          ...process.env,
          PORT: String(port),
          HOST: '127.0.0.1',
          ALLOWED_ORIGIN: origin,
          DATABASE_URL: url.toString(),
          GAME_CREDENTIAL_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
          RETENTION_HMAC_KEY: 'test-only-key',
          NODE_ENV: 'test',
        },
        stdio: 'ignore',
      });
      processes.push(child);
      await waitForHealth(port);
    }
  }, 30_000);

  afterAll(async () => {
    for (const child of processes) child.kill();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('When A creates a game Then B accepts the same cookie and sees the same lobby', async () => {
    const { response: created, game } = await createGame();
    const lobby = await fetch(`http://127.0.0.1:${ports[1]}/api/v1/games/${game.gameId}/lobby`, {
      headers: { cookie: cookieHeader(created) },
    });
    expect(lobby.status).toBe(200);
    expect((await lobby.json()).gameId).toBe(game.gameId);
  });

  it('When the same creation key races across tasks Then one durable game and credential are replayed', async () => {
    const key = `create-race-${randomUUID()}`;
    const create = (port: number) =>
      fetch(`http://127.0.0.1:${port}/api/v1/games`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ finalWeek: 1, demand: [4] }),
      });
    const [first, second] = await Promise.all([create(ports[0]), create(ports[1])]);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await first.json()).toEqual(await second.json());
    expect(cookieHeader(first)).toContain('bg_operator=');
    expect(cookieHeader(second)).toContain('bg_operator=');
  });

  it('When participants join across tasks Then role, decision and commit remain shared and idempotent', async () => {
    const { response: created, game } = await createGame();
    const facilitator = cookieHeader(created);
    const roles = ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'];
    const participants: { id: string; cookie: string }[] = [];
    for (const [index, role] of roles.entries()) {
      const joined = await command(
        ports[1],
        '/api/v1/participations/join',
        'POST',
        '',
        `join-${game.gameId}-${index}`,
        { joinCode: game.joinCode, displayName: role },
      );
      expect(joined.status).toBe(201);
      const body = (await joined.json()) as { participantId: string };
      participants.push({ id: body.participantId, cookie: cookieHeader(joined) });
      const assigned = await command(
        ports[0],
        `/api/v1/games/${game.gameId}/participants/${body.participantId}/role`,
        'PUT',
        facilitator,
        `role-${game.gameId}-${index}`,
        { role },
        1,
      );
      expect(assigned.status).toBe(200);
    }
    const started = await command(
      ports[1],
      `/api/v1/sessions/${game.sessionId}/start`,
      'POST',
      facilitator,
      `start-${game.gameId}`,
      undefined,
      1,
    );
    expect(started.status).toBe(200);
    for (const [index, participant] of participants.entries()) {
      const decision = await command(
        ports[index % 2],
        `/api/v1/sessions/${game.sessionId}/decisions`,
        'PUT',
        participant.cookie,
        `decision-${game.gameId}-${index}`,
        { quantity: 4 },
        0,
      );
      expect(decision.status).toBe(200);
    }
    const committed = await command(
      ports[1],
      `/api/v1/sessions/${game.sessionId}/weeks/1/commit`,
      'POST',
      facilitator,
      `commit-${game.gameId}`,
      undefined,
      2,
    );
    expect(committed.status).toBe(200);
    const repeated = await command(
      ports[0],
      `/api/v1/sessions/${game.sessionId}/weeks/1/commit`,
      'POST',
      facilitator,
      `commit-${game.gameId}`,
      undefined,
      2,
    );
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(await committed.json());
    const state = await fetch(
      `http://127.0.0.1:${ports[0]}/api/v1/sessions/${game.sessionId}/state`,
      { headers: { cookie: participants[0].cookie } },
    );
    expect(state.status).toBe(200);
    expect((await state.json()).status).toBe('ENDED');
  });

  it('When two tasks edit one decision version Then exactly one wins', async () => {
    const { response: created, game } = await createGame();
    const joined = await command(
      ports[1],
      '/api/v1/participations/join',
      'POST',
      '',
      `race-join-${game.gameId}`,
      { joinCode: game.joinCode, displayName: 'Retailer' },
    );
    const participant = (await joined.json()) as { participantId: string };
    expect(
      (
        await command(
          ports[0],
          `/api/v1/games/${game.gameId}/participants/${participant.participantId}/role`,
          'PUT',
          cookieHeader(created),
          `race-role-${game.gameId}`,
          { role: 'RETAILER' },
          1,
        )
      ).status,
    ).toBe(200);
    for (const [index, role] of ['WHOLESALER', 'DISTRIBUTOR', 'FACTORY'].entries()) {
      const other = await command(
        ports[1],
        '/api/v1/participations/join',
        'POST',
        '',
        `race-other-${game.gameId}-${index}`,
        { joinCode: game.joinCode, displayName: role },
      );
      const { participantId } = (await other.json()) as { participantId: string };
      expect(
        (
          await command(
            ports[0],
            `/api/v1/games/${game.gameId}/participants/${participantId}/role`,
            'PUT',
            cookieHeader(created),
            `race-other-role-${game.gameId}-${index}`,
            { role },
            1,
          )
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await command(
          ports[0],
          `/api/v1/sessions/${game.sessionId}/start`,
          'POST',
          cookieHeader(created),
          `race-start-${game.gameId}`,
          undefined,
          1,
        )
      ).status,
    ).toBe(200);
    const path = `/api/v1/sessions/${game.sessionId}/decisions`;
    const [left, right] = await Promise.all([
      command(
        ports[0],
        path,
        'PUT',
        cookieHeader(joined),
        `race-left-${game.gameId}`,
        { quantity: 4 },
        0,
      ),
      command(
        ports[1],
        path,
        'PUT',
        cookieHeader(joined),
        `race-right-${game.gameId}`,
        { quantity: 5 },
        0,
      ),
    ]);
    expect([left.status, right.status].sort()).toEqual([200, 412]);
    const state = await fetch(
      `http://127.0.0.1:${ports[1]}/api/v1/sessions/${game.sessionId}/state`,
      { headers: { cookie: cookieHeader(joined) } },
    );
    expect((await state.json()).decisionVersion).toBe(1);
  });

  it('When a client reconnects to the other task Then persisted event IDs replay after its cursor', async () => {
    const { response: created, game } = await createGame();
    const facilitator = cookieHeader(created);
    const replay = await fetch(`http://127.0.0.1:${ports[1]}/api/v1/games/${game.gameId}/events`, {
      headers: { cookie: facilitator },
    });
    expect(replay.status).toBe(200);
    const reader = replay.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    const cursor = first.match(/^id: ([^\n]+)/m)?.[1];
    expect(cursor).toBeTruthy();
    const joined = await command(
      ports[0],
      '/api/v1/participations/join',
      'POST',
      '',
      `replay-${game.gameId}`,
      { joinCode: game.joinCode, displayName: 'Replay' },
    );
    expect(joined.status).toBe(201);
    const after = await fetch(`http://127.0.0.1:${ports[1]}/api/v1/games/${game.gameId}/events`, {
      headers: { cookie: facilitator, 'last-event-id': cursor! },
    });
    expect(after.status).toBe(200);
    const nextReader = after.body!.getReader();
    const next = new TextDecoder().decode((await nextReader.read()).value);
    await nextReader.cancel();
    expect(next).toContain('event: state-version');
    expect(next).not.toContain(`id: ${cursor}\n`);
  });

  it('When another task commits an event Then an open SSE stream receives the new version', async () => {
    const { response: created, game } = await createGame();
    const facilitator = cookieHeader(created);
    const controller = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${ports[0]}/api/v1/games/${game.gameId}/events`, {
      headers: { cookie: facilitator },
      signal: controller.signal,
    });
    const reader = stream.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    expect(initial).toContain('event: state-version');
    const joined = await command(
      ports[1],
      '/api/v1/participations/join',
      'POST',
      '',
      `live-${game.gameId}`,
      { joinCode: game.joinCode, displayName: 'Live' },
    );
    expect(joined.status).toBe(201);
    const changed = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('SSE notification timeout')), 3_000),
      ),
    ]);
    controller.abort();
    expect(new TextDecoder().decode(changed.value)).toContain('event: state-version');
  }, 10_000);

  it('When recovery rotates on A Then B accepts the new session and rejects the old recovery token', async () => {
    const { response: created, game } = await createGame();
    const joined = await command(
      ports[1],
      '/api/v1/participations/join',
      'POST',
      '',
      `recover-${game.gameId}`,
      { joinCode: game.joinCode, displayName: 'Recover' },
    );
    expect(joined.status).toBe(201);
    const participant = (await joined.json()) as { participantId: string };
    const assigned = await command(
      ports[0],
      `/api/v1/games/${game.gameId}/participants/${participant.participantId}/role`,
      'PUT',
      cookieHeader(created),
      `recover-role-${game.gameId}`,
      { role: 'RETAILER' },
      1,
    );
    expect(assigned.status).toBe(200);
    const recovered = await command(
      ports[0],
      '/api/v1/participations/recover',
      'POST',
      cookieHeader(joined),
      `recover-command-${game.gameId}`,
    );
    expect(recovered.status).toBe(200);
    const old = await command(
      ports[1],
      '/api/v1/participations/recover',
      'POST',
      cookieHeader(joined),
      `recover-old-${game.gameId}`,
    );
    expect(old.status).toBe(401);
    const state = await fetch(
      `http://127.0.0.1:${ports[1]}/api/v1/sessions/${game.sessionId}/state`,
      { headers: { cookie: cookieHeader(recovered) } },
    );
    expect(state.status).toBe(200);
    expect((await state.json()).own.role).toBe('RETAILER');
  });

  it('When a review export is created on A Then B serves its status and download', async () => {
    const { response: created, game } = await createGame();
    const facilitator = cookieHeader(created);
    for (const [index, role] of ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'].entries()) {
      const joined = await command(
        ports[1],
        '/api/v1/participations/join',
        'POST',
        '',
        `export-join-${game.gameId}-${index}`,
        { joinCode: game.joinCode, displayName: role },
      );
      const { participantId } = (await joined.json()) as { participantId: string };
      const assigned = await command(
        ports[0],
        `/api/v1/games/${game.gameId}/participants/${participantId}/role`,
        'PUT',
        facilitator,
        `export-role-${game.gameId}-${index}`,
        { role },
        1,
      );
      expect(assigned.status).toBe(200);
    }
    expect(
      (
        await command(
          ports[0],
          `/api/v1/sessions/${game.sessionId}/start`,
          'POST',
          facilitator,
          `export-start-${game.gameId}`,
          undefined,
          1,
        )
      ).status,
    ).toBe(200);
    for (const role of ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY']) {
      const proxy = await command(
        ports[1],
        `/api/v1/sessions/${game.sessionId}/proxy-decisions/${role}`,
        'PUT',
        facilitator,
        `export-proxy-${game.gameId}-${role}`,
        { quantity: 4, expectedVersion: 0 },
      );
      expect(proxy.status).toBe(200);
    }
    expect(
      (
        await command(
          ports[0],
          `/api/v1/sessions/${game.sessionId}/weeks/1/commit`,
          'POST',
          facilitator,
          `export-commit-${game.gameId}`,
          undefined,
          2,
        )
      ).status,
    ).toBe(200);
    const observation = await fetch(
      `http://127.0.0.1:${ports[1]}/api/v1/games/${game.gameId}/observation`,
      { headers: { cookie: facilitator } },
    );
    expect(observation.status).toBe(200);
    const exported = await command(
      ports[0],
      `/api/v1/games/${game.gameId}/exports`,
      'POST',
      facilitator,
      `export-create-${game.gameId}`,
    );
    expect(exported.status).toBe(202);
    const { exportId } = (await exported.json()) as { exportId: string };
    const status = await fetch(
      `http://127.0.0.1:${ports[1]}/api/v1/games/${game.gameId}/exports/${exportId}`,
      { headers: { cookie: facilitator } },
    );
    expect(status.status).toBe(200);
    const download = await fetch(
      `http://127.0.0.1:${ports[1]}/api/v1/games/${game.gameId}/exports/${exportId}/download?format=csv`,
      { headers: { cookie: facilitator } },
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toContain('week,inventory,backlog');
  });

  it('When two dispatchers race Then each committed outbox event is published at most once', async () => {
    await createGame();
    const url = new URL(databaseUrl!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const pool = new Pool({ connectionString: url.toString() });
    const published: string[] = [];
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      signalFirst = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const transport = {
      publish: async (value: unknown) => {
        const eventId = (value as { event_id: string }).event_id;
        if (published.length === 0) {
          signalFirst();
          await firstGate;
        }
        published.push(eventId);
      },
    };
    try {
      const first = new OutboxDispatcher(pool, transport).dispatchBatch(1);
      await firstEntered;
      const second = new OutboxDispatcher(pool, transport).dispatchBatch(1);
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      releaseFirst();
      await Promise.all([first, second]);
      expect(new Set(published).size).toBe(published.length);
    } finally {
      await pool.end();
    }
  });

  it('When retention retry is replayed on another task Then its attempt changes only once', async () => {
    const { response: created, game } = await createGame();
    const url = new URL(databaseUrl!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const pool = new Pool({ connectionString: url.toString() });
    try {
      await pool.query(
        "UPDATE retention_policies SET retention_starts_at=now()-interval '3 days',delete_after=now()-interval '2 days' WHERE game_id=$1",
        [game.gameId],
      );
      const retention = new PostgresRetentionService(pool, 'test-only-key');
      const [saga] = await retention.startDueDeletions();
      await retention.consumeCompletion({
        eventId: randomUUID(),
        deletionId: saga.deletionId,
        ownerUnit: 'u1-walking-skeleton',
        attempt: 1,
        schemaVersion: 2,
        status: 'permanent-failure',
        completedAt: new Date().toISOString(),
        failureCode: 'OWNER_ERROR',
      });
      const key = `retry-${game.gameId}`;
      const path = `/api/v1/games/${game.gameId}/retention/retry`;
      const first = await command(ports[0], path, 'POST', cookieHeader(created), key, undefined, 1);
      expect(first.status).toBe(200);
      const repeated = await command(
        ports[1],
        path,
        'POST',
        cookieHeader(created),
        key,
        undefined,
        1,
      );
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toEqual(await first.json());
      expect((await retention.status(game.gameId)).attempt).toBe(2);
    } finally {
      await pool.end();
    }
  });
});
