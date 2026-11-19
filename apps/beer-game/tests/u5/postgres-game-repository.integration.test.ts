import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresGameRepository } from '../../src/infrastructure/postgres-game-repository.js';
import type { Actor } from '../../src/application/game-service.js';
import { OutboxDispatcher } from '../../src/infrastructure/outbox-dispatcher.js';

const databaseUrl = process.env.GAME_TEST_DATABASE_URL;
const schema = `u5_repo_${randomUUID().replaceAll('-', '')}`;
const roles = ['RETAILER', 'WHOLESALER', 'DISTRIBUTOR', 'FACTORY'] as const;

describe.skipIf(!databaseUrl)('Given a PostgreSQL authoritative game repository', () => {
  let admin: Pool;
  let repository: PostgresGameRepository;

  beforeAll(async () => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_u5_test'))
      throw new Error('GAME_TEST_DATABASE_URL must target a dedicated _u5_test database');
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(databaseUrl);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const pool = new Pool({ connectionString: url.toString() });
    for (const name of [
      '001_u1_walking_skeleton.sql',
      '002_u2_session_continuity.sql',
      '003_u3_learning_view.sql',
      '004_u4_retention.sql',
      '005_u5_shared_game_store.sql',
    ])
      await pool.query(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
    repository = new PostgresGameRepository(pool, '0123456789abcdef'.repeat(4));
  });

  afterAll(async () => {
    await repository?.close();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('When creation is retried Then it returns one encrypted durable credential and shared cookie session', async () => {
    const key = randomUUID();
    const input = { finalWeek: 1, demand: [4] };
    const first = await repository.createGame(input, key);
    expect(await repository.createGame(input, key)).toEqual(first);
    await expect(repository.createGame({ finalWeek: 1, demand: [5] }, key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const actor: Actor = { id: first.gameId, gameId: first.gameId, kind: 'FACILITATOR' };
    const raw = await repository.issueBrowserSession(actor);
    expect(await repository.resolveBrowserSession(raw)).toEqual(actor);
    expect(await repository.resolveBrowserSession('invalid')).toBeUndefined();
    await expect(repository.gameIdForSession('not-a-uuid')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(
      await repository.read(first.gameId, (service) => service.lobbyState(actor)),
    ).toMatchObject({ joinCode: first.joinCode });
    const records = await repository.pool.query(
      "SELECT response::text FROM idempotency_records WHERE actor_id='system' AND resource_id='global'",
    );
    expect(records.rows.map((row) => row.response).join('')).not.toContain(
      first.facilitatorCredential,
    );
  });

  it('When roles decide across transactions Then commit, replay and export are durable', async () => {
    const game = await repository.createGame({ finalWeek: 1, demand: [4] }, randomUUID());
    const facilitator: Actor = { id: game.gameId, gameId: game.gameId, kind: 'FACILITATOR' };
    const actors: Actor[] = [];
    for (const [index, role] of roles.entries()) {
      const joined = await repository.write(game.gameId, (service) =>
        service.joinGame(game.gameId, role, `join-${game.gameId}-${index}`),
      );
      await repository.write(game.gameId, (service) =>
        service.assignRoleBrowser(
          facilitator,
          joined.participantId,
          role,
          1,
          `role-${game.gameId}-${index}`,
        ),
      );
      actors.push(
        await repository.read(game.gameId, (service) =>
          service.actorForParticipant(game.gameId, joined.participantId),
        ),
      );
    }
    expect(await repository.gameIdForCode(game.joinCode)).toBe(game.gameId);
    expect(await repository.gameIdForSession(game.sessionId)).toBe(game.gameId);
    expect(
      (
        await repository.write(game.gameId, (service) =>
          service.startSessionBrowser(facilitator, 1, `start-${game.gameId}`),
        )
      ).status,
    ).toBe('ACTIVE');
    for (const [index, actor] of actors.entries())
      await repository.write(game.gameId, (service) =>
        service.submitDecision(actor, 4, 0, `decision-${game.gameId}-${index}`),
      );
    const first = await repository.write(game.gameId, (service) =>
      service.commitWeek(facilitator, 2, `commit-${game.gameId}`, 1),
    );
    expect(
      await repository.write(game.gameId, (service) =>
        service.commitWeek(facilitator, 2, `commit-${game.gameId}`, 1),
      ),
    ).toEqual(first);
    const events = await repository.eventsSince(game.gameId);
    expect(events.at(-1)?.eventType).toBe('SessionEnded');
    expect((await repository.eventsSince(game.gameId, events[0].eventId)).length).toBe(
      events.length - 1,
    );
    expect(await repository.eventVersion(game.gameId, events[0].eventId)).toBe(1);
    await expect(repository.eventVersion(game.gameId, 'unknown')).rejects.toMatchObject({
      code: 'INVALID_EVENT_CURSOR',
    });
    const exported = await repository.createExport(facilitator, `export-${game.gameId}`);
    expect(exported.exportId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(await repository.createExport(facilitator, `export-${game.gameId}`)).toEqual(exported);
    expect(await repository.getExport(facilitator, exported.exportId)).toEqual(exported);
    await expect(repository.getExport(facilitator, 'not-a-uuid')).rejects.toThrow('NOT_FOUND');
    const decisions = await repository.pool.query(
      'SELECT committed FROM decisions WHERE session_id=$1',
      [game.sessionId],
    );
    expect(decisions.rows).toHaveLength(4);
    expect(decisions.rows.every((row) => row.committed)).toBe(true);
  });

  it('When a participant recovers Then only the rotated digest can recover again', async () => {
    const game = await repository.createGame({ finalWeek: 1, demand: [4] }, randomUUID());
    const facilitator: Actor = { id: game.gameId, gameId: game.gameId, kind: 'FACILITATOR' };
    const joined = await repository.write(game.gameId, (service) =>
      service.joinGame(game.gameId, 'Recover', randomUUID()),
    );
    await repository.write(game.gameId, (service) =>
      service.assignRole(facilitator, joined.participantId, 'RETAILER'),
    );
    expect(await repository.gameIdForRecovery(joined.recoveryToken)).toBe(game.gameId);
    const recovered = await repository.write(game.gameId, (service) =>
      service.recoverParticipation(joined.recoveryToken),
    );
    expect(recovered.actor.role).toBe('RETAILER');
    await expect(repository.gameIdForRecovery(joined.recoveryToken)).rejects.toMatchObject({
      code: 'RECOVERY_NOT_AVAILABLE',
    });
    expect(await repository.gameIdForRecovery(recovered.recoveryToken)).toBe(game.gameId);
  });

  it('When a committed event is notified Then an open subscriber reconciles it', async () => {
    const game = await repository.createGame({ finalWeek: 1, demand: [4] }, randomUUID());
    const seen = new Promise<string>((resolve) => {
      const stop = repository.subscribeEvents(game.gameId, 1, (event) => {
        stop();
        resolve(event.eventType);
      });
    });
    await repository.write(game.gameId, (service) =>
      service.joinGame(game.gameId, 'Subscriber', randomUUID()),
    );
    expect(await seen).toBe('ParticipantJoined');
  });

  it('When dispatchers scan committed events Then one transaction claims each row', async () => {
    const sent: string[] = [];
    const dispatcher = new OutboxDispatcher(repository.pool, {
      publish: async (row: unknown) => {
        sent.push((row as { event_id: string }).event_id);
      },
    });
    const count = await dispatcher.dispatchBatch(100);
    expect(count).toBeGreaterThan(0);
    expect(sent).toHaveLength(count);
    expect(new Set(sent).size).toBe(count);
  });

  it('When publishing fails Then the event is scheduled for a later retry', async () => {
    await repository.createGame({ finalWeek: 1, demand: [4] }, randomUUID());
    const failing = new OutboxDispatcher(repository.pool, {
      publish: async () => {
        throw new Error('transport unavailable');
      },
    });
    await expect(failing.dispatchBatch(1)).rejects.toThrow('transport unavailable');
    const pending = await repository.pool.query(
      'SELECT attempts,next_attempt_at FROM outbox_events WHERE published_at IS NULL ORDER BY occurred_at LIMIT 1',
    );
    expect(pending.rows[0].attempts).toBe(1);
    expect(new Date(pending.rows[0].next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    expect(await failing.dispatchBatch(1)).toBe(0);
  });
});
