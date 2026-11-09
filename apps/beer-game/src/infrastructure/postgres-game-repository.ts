import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  GameService,
  Problem,
  type Actor,
  type CreateGameResult,
  type DomainEvent,
  type PersistedGame,
} from '../application/game-service.js';
import { digestCredential, issueCredential } from '../security/credentials.js';
import type { Role } from '../domain/types.js';
import {
  LearningViewService,
  type LearningActor,
  type ExportPackage,
} from '../learning/learning-view.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class PostgresGameRepository {
  private readonly secret: Buffer;
  private hintClient?: PoolClient;
  private hintConnecting = false;
  private readonly hints = new Map<string, Set<() => void>>();

  constructor(
    readonly pool: Pool,
    secretHex: string,
  ) {
    if (!/^[a-f0-9]{64}$/i.test(secretHex))
      throw new Error('GAME_CREDENTIAL_ENCRYPTION_KEY must be 32 bytes of hex');
    this.secret = Buffer.from(secretHex, 'hex');
  }

  private seal(value: unknown) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.secret, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return {
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
  }

  private open(value: { iv: string; tag: string; ciphertext: string }) {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.secret,
      Buffer.from(value.iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(value.ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8'),
    ) as unknown;
  }

  async createGame(
    input: { finalWeek: number; demand: number[]; retentionDays?: number },
    key: string,
  ): Promise<CreateGameResult> {
    if (!key) throw new Problem(400, 'IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const keyDigest = hash(key);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`create:${keyDigest}`]);
      const previous = await client.query(
        "SELECT request_digest,response FROM idempotency_records WHERE actor_id='system' AND operation='create' AND resource_id='global' AND key_digest=$1 AND expires_at>now()",
        [keyDigest],
      );
      await client.query(
        "DELETE FROM idempotency_records WHERE actor_id='system' AND operation='create' AND resource_id='global' AND key_digest=$1 AND expires_at<=now()",
        [keyDigest],
      );
      const requestDigest = hash(input);
      if (previous.rowCount) {
        if (previous.rows[0].request_digest !== requestDigest)
          throw new Problem(409, 'IDEMPOTENCY_CONFLICT', 'Key was used with a different request');
        const result = this.open(previous.rows[0].response) as CreateGameResult;
        await client.query('COMMIT');
        return result;
      }
      const domain = new GameService();
      const result = domain.createGame(input, key);
      await this.saveGame(client, domain.exportGame(result.gameId), true);
      await client.query(
        "INSERT INTO idempotency_records(actor_id,operation,resource_id,key_digest,request_digest,status_code,response,expires_at) VALUES ('system','create','global',$1,$2,201,$3,now()+interval '30 days')",
        [keyDigest, requestDigest, this.seal(result)],
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async read<T>(gameId: string, action: (service: GameService) => T): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const domain = new GameService();
      domain.importGame(await this.loadGame(client, gameId));
      const result = action(domain);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async write<T>(gameId: string, action: (service: GameService) => T): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT game_id FROM games WHERE game_id=$1 FOR UPDATE', [gameId]);
      const domain = new GameService();
      const before = await this.loadGame(client, gameId);
      domain.importGame(before);
      const result = action(domain);
      await this.saveGame(client, domain.exportGame(gameId), false, before);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async gameIdForCode(joinCode: string): Promise<string> {
    const result = await this.pool.query('SELECT game_id FROM games WHERE join_code=$1', [
      joinCode.trim().toUpperCase(),
    ]);
    if (!result.rowCount)
      throw new Problem(404, 'JOIN_CODE_NOT_FOUND', 'Invitation code was not found');
    return result.rows[0].game_id as string;
  }

  async gameIdForSession(sessionId: string): Promise<string> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId))
      throw new Problem(403, 'FORBIDDEN', 'Access denied');
    const result = await this.pool.query('SELECT game_id FROM sessions WHERE session_id=$1', [
      sessionId,
    ]);
    if (!result.rowCount) throw new Problem(404, 'GAME_NOT_FOUND', 'Game was not found');
    return result.rows[0].game_id as string;
  }

  async gameIdForRecovery(rawToken: string): Promise<string> {
    const result = await this.pool.query(
      'SELECT game_id FROM participants WHERE credential_digest=$1 AND credential_revoked=false AND credential_expires_at>now()',
      [digestCredential(rawToken)],
    );
    if (!result.rowCount)
      throw new Problem(401, 'RECOVERY_NOT_AVAILABLE', 'Recovery is not available');
    return result.rows[0].game_id as string;
  }

  async issueBrowserSession(actor: Actor): Promise<string> {
    const session = issueCredential();
    await this.pool.query(
      "INSERT INTO browser_sessions(credential_digest,game_id,actor_id,actor_kind,expires_at) VALUES ($1,$2,$3,$4,now()+interval '24 hours')",
      [session.digest, actor.gameId, actor.id, actor.kind],
    );
    return session.raw;
  }

  async resolveBrowserSession(raw: string | undefined): Promise<Actor | undefined> {
    if (!raw) return undefined;
    const result = await this.pool.query(
      `SELECT b.game_id,b.actor_id,b.actor_kind,p.role,p.credential_revoked
       FROM browser_sessions b LEFT JOIN participants p ON p.participant_id=b.actor_id AND p.game_id=b.game_id
       WHERE b.credential_digest=$1 AND b.expires_at>now()`,
      [digestCredential(raw)],
    );
    if (!result.rowCount) return undefined;
    const row = result.rows[0];
    if (
      row.actor_kind === 'PARTICIPANT' &&
      (row.credential_revoked === null || row.credential_revoked)
    )
      return undefined;
    return {
      id: row.actor_id,
      kind: row.actor_kind,
      gameId: row.game_id,
      ...(row.role ? { role: row.role as Role } : {}),
    };
  }

  async eventsSince(gameId: string, cursor?: string): Promise<DomainEvent[]> {
    let after = 0;
    if (cursor) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor))
        throw new Problem(400, 'INVALID_EVENT_CURSOR', 'Event cursor is unknown');
      const found = await this.pool.query(
        'SELECT aggregate_version FROM outbox_events WHERE aggregate_id=$1 AND event_id=$2',
        [gameId, cursor],
      );
      if (!found.rowCount)
        throw new Problem(400, 'INVALID_EVENT_CURSOR', 'Event cursor is unknown');
      after = Number(found.rows[0].aggregate_version);
    }
    const rows = await this.pool.query(
      'SELECT payload FROM outbox_events WHERE aggregate_id=$1 AND aggregate_version>$2 ORDER BY aggregate_version',
      [gameId, after],
    );
    return rows.rows.map((row) => row.payload as DomainEvent);
  }

  async eventVersion(gameId: string, cursor?: string): Promise<number> {
    if (!cursor) return 0;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor))
      throw new Problem(400, 'INVALID_EVENT_CURSOR', 'Event cursor is unknown');
    const found = await this.pool.query(
      'SELECT aggregate_version FROM outbox_events WHERE aggregate_id=$1 AND event_id=$2',
      [gameId, cursor],
    );
    if (!found.rowCount) throw new Problem(400, 'INVALID_EVENT_CURSOR', 'Event cursor is unknown');
    return Number(found.rows[0].aggregate_version);
  }

  subscribeEvents(
    gameId: string,
    fromVersion: number,
    listener: (event: DomainEvent) => void,
  ): () => void {
    let version = fromVersion;
    let busy = false;
    const reconcile = async () => {
      if (busy) return;
      busy = true;
      try {
        const rows = await this.pool.query(
          'SELECT payload FROM outbox_events WHERE aggregate_id=$1 AND aggregate_version>$2 ORDER BY aggregate_version',
          [gameId, version],
        );
        for (const row of rows.rows) {
          const event = row.payload as DomainEvent;
          version = event.aggregateVersion;
          listener(event);
        }
      } catch {
        // A later reconciliation retries from the last delivered version.
      } finally {
        busy = false;
      }
    };
    const callbacks = this.hints.get(gameId) ?? new Set<() => void>();
    const callback = () => void reconcile();
    callbacks.add(callback);
    this.hints.set(gameId, callbacks);
    void this.ensureHints();
    const timer = setInterval(() => {
      if (!this.hintClient) void this.ensureHints();
      void reconcile();
    }, 1_000);
    void reconcile();
    return () => {
      clearInterval(timer);
      callbacks.delete(callback);
      if (callbacks.size === 0) this.hints.delete(gameId);
    };
  }

  private async ensureHints(): Promise<void> {
    if (this.hintClient || this.hintConnecting) return;
    this.hintConnecting = true;
    let pendingClient: PoolClient | undefined;
    try {
      const client = await this.pool.connect();
      pendingClient = client;
      await client.query('LISTEN beer_game_events');
      client.on('notification', (message) => {
        if (!message.payload) return;
        try {
          const hint = JSON.parse(message.payload) as { gameId?: string };
          for (const callback of this.hints.get(hint.gameId ?? '') ?? []) callback();
        } catch {
          // Periodic version reconciliation remains authoritative.
        }
      });
      client.on('error', () => {
        if (this.hintClient === client) {
          this.hintClient = undefined;
          client.release(true);
        }
      });
      this.hintClient = client;
      pendingClient = undefined;
    } catch {
      // The periodic query keeps streams live if LISTEN is unavailable.
      pendingClient?.release(true);
    } finally {
      this.hintConnecting = false;
    }
  }

  async close(): Promise<void> {
    if (this.hintClient) {
      await this.hintClient.query('UNLISTEN beer_game_events');
      this.hintClient.release();
      this.hintClient = undefined;
    }
    await this.pool.end();
  }

  async createExport(actor: LearningActor, key: string): Promise<ExportPackage> {
    if (actor.kind !== 'FACILITATOR') throw new Error('FORBIDDEN');
    if (!key) throw new Error('IDEMPOTENCY_REQUIRED');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT game_id FROM games WHERE game_id=$1 FOR UPDATE', [actor.gameId]);
      const keyDigest = hash(key);
      const previous = await client.query(
        "SELECT response FROM idempotency_records WHERE actor_id='export' AND operation='create' AND resource_id=$1 AND key_digest=$2 AND expires_at>now()",
        [actor.gameId, keyDigest],
      );
      await client.query(
        "DELETE FROM idempotency_records WHERE actor_id='export' AND operation='create' AND resource_id=$1 AND key_digest=$2 AND expires_at<=now()",
        [actor.gameId, keyDigest],
      );
      if (previous.rowCount) {
        const result = this.open(previous.rows[0].response) as ExportPackage;
        await client.query('COMMIT');
        return result;
      }
      const events = await client.query(
        'SELECT payload FROM outbox_events WHERE aggregate_id=$1 ORDER BY aggregate_version',
        [actor.gameId],
      );
      const projection = new LearningViewService();
      for (const row of events.rows) projection.consume(row.payload);
      const result = projection.createExport(actor, key);
      await client.query(
        'INSERT INTO export_packages(export_id,game_id,source_version,schema_version,status,artifact_refs) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          result.exportId,
          actor.gameId,
          result.sourceVersion,
          result.schemaVersion,
          result.status,
          { csv: result.csv, json: result.json, checksum: result.checksum },
        ],
      );
      await client.query(
        "INSERT INTO idempotency_records(actor_id,operation,resource_id,key_digest,request_digest,status_code,response,expires_at) VALUES ('export','create',$1,$2,$3,202,$4,now()+interval '30 days')",
        [actor.gameId, keyDigest, hash({ gameId: actor.gameId }), this.seal(result)],
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getExport(actor: LearningActor, exportId: string): Promise<ExportPackage> {
    if (actor.kind !== 'FACILITATOR') throw new Error('FORBIDDEN');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(exportId))
      throw new Error('NOT_FOUND');
    const result = await this.pool.query('SELECT * FROM export_packages WHERE export_id=$1', [
      exportId,
    ]);
    if (!result.rowCount) throw new Error('NOT_FOUND');
    const row = result.rows[0];
    if (row.game_id !== actor.gameId) throw new Error('FORBIDDEN');
    return {
      exportId,
      gameId: row.game_id,
      status: row.status,
      schemaVersion: row.schema_version,
      sourceVersion: Number(row.source_version),
      csv: row.artifact_refs.csv,
      json: row.artifact_refs.json,
      checksum: row.artifact_refs.checksum,
    } as ExportPackage;
  }

  private async loadGame(client: PoolClient, gameId: string): Promise<PersistedGame> {
    const game = await client.query('SELECT * FROM games WHERE game_id=$1', [gameId]);
    if (!game.rowCount) throw new Problem(404, 'GAME_NOT_FOUND', 'Game was not found');
    const session = await client.query('SELECT * FROM sessions WHERE game_id=$1', [gameId]);
    const sessionId = session.rows[0].session_id as string;
    const participants = await client.query('SELECT * FROM participants WHERE game_id=$1', [
      gameId,
    ]);
    const decisions = await client.query(
      'SELECT * FROM decisions WHERE session_id=$1 AND week=$2 AND committed=false',
      [sessionId, session.rows[0].week],
    );
    const idempotency = await client.query(
      "SELECT key_digest,request_digest,response FROM idempotency_records WHERE actor_id='game' AND resource_id=$1 AND expires_at>now()",
      [gameId],
    );
    const results = await client.query(
      'SELECT result FROM week_results WHERE session_id=$1 ORDER BY week',
      [sessionId],
    );
    const events = await client.query(
      'SELECT payload FROM outbox_events WHERE aggregate_id=$1 ORDER BY aggregate_version',
      [gameId],
    );
    return {
      id: gameId,
      joinCode: game.rows[0].join_code,
      facilitatorDigest: game.rows[0].facilitator_digest,
      retentionDays: game.rows[0].retention_days,
      session: session.rows[0].state,
      participants: participants.rows.map((row) => ({
        id: row.participant_id,
        name: row.display_name,
        role: row.role ?? undefined,
        credentialDigest: row.credential_digest,
        credentialExpiresAt: new Date(row.credential_expires_at).getTime(),
        credentialRevoked: row.credential_revoked,
      })),
      decisions: decisions.rows.map((row) => [
        row.role,
        { quantity: row.quantity, version: Number(row.version) },
      ]),
      idempotency: idempotency.rows.map((row) => [
        row.key_digest,
        { requestDigest: row.request_digest, value: this.open(row.response) },
      ]),
      results: results.rows.map((row) => row.result),
      events: events.rows.map((row) => row.payload),
    } as PersistedGame;
  }

  private async saveGame(
    client: PoolClient,
    game: PersistedGame,
    create: boolean,
    before?: PersistedGame,
  ): Promise<void> {
    if (create) {
      await client.query(
        'INSERT INTO games(game_id,join_code,facilitator_digest,final_week,demand,retention_days) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          game.id,
          game.joinCode,
          game.facilitatorDigest,
          game.session.finalWeek,
          JSON.stringify(game.session.demand),
          game.retentionDays,
        ],
      );
      await client.query(
        'INSERT INTO sessions(session_id,game_id,status,week,version,state,aggregate_version) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [
          game.session.sessionId,
          game.id,
          game.session.status,
          game.session.week,
          game.session.version,
          JSON.stringify(game.session),
          game.events.length,
        ],
      );
    } else {
      await client.query(
        'UPDATE sessions SET status=$2,week=$3,version=$4,state=$5,aggregate_version=$6 WHERE game_id=$1',
        [
          game.id,
          game.session.status,
          game.session.week,
          game.session.version,
          JSON.stringify(game.session),
          game.events.length,
        ],
      );
    }
    for (const participant of game.participants) {
      await client.query(
        `INSERT INTO participants(participant_id,game_id,display_name,credential_digest,role,credential_expires_at,credential_revoked)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(participant_id) DO UPDATE SET display_name=EXCLUDED.display_name,credential_digest=EXCLUDED.credential_digest,role=EXCLUDED.role,credential_expires_at=EXCLUDED.credential_expires_at,credential_revoked=EXCLUDED.credential_revoked`,
        [
          participant.id,
          game.id,
          participant.name,
          participant.credentialDigest,
          participant.role ?? null,
          new Date(participant.credentialExpiresAt),
          participant.credentialRevoked,
        ],
      );
    }
    if (before && game.session.week !== before.session.week)
      await client.query('UPDATE decisions SET committed=true WHERE session_id=$1 AND week=$2', [
        game.session.sessionId,
        before.session.week,
      ]);
    await client.query(
      'DELETE FROM decisions WHERE session_id=$1 AND week=$2 AND committed=false',
      [game.session.sessionId, game.session.week],
    );
    for (const [role, decision] of game.decisions) {
      const participant = game.participants.find((candidate) => candidate.role === role);
      await client.query(
        'INSERT INTO decisions(session_id,week,role,participant_id,quantity,version,committed) VALUES ($1,$2,$3,$4,$5,$6,false)',
        [
          game.session.sessionId,
          game.session.week,
          role,
          participant?.id ?? null,
          decision.quantity,
          decision.version,
        ],
      );
    }
    const previousKeys = new Set(before?.idempotency.map(([key]) => key) ?? []);
    await client.query(
      "DELETE FROM idempotency_records WHERE actor_id='game' AND resource_id=$1 AND expires_at<=now()",
      [game.id],
    );
    for (const [keyDigest, record] of game.idempotency) {
      if (previousKeys.has(keyDigest)) continue;
      await client.query(
        "INSERT INTO idempotency_records(actor_id,operation,resource_id,key_digest,request_digest,status_code,response,expires_at) VALUES ('game','command',$1,$2,$3,200,$4,now()+interval '30 days') ON CONFLICT DO NOTHING",
        [game.id, keyDigest, record.requestDigest, this.seal(record.value)],
      );
    }
    const previousWeeks = new Set(before?.results.map((result) => result.week) ?? []);
    for (const result of game.results) {
      if (previousWeeks.has(result.week)) continue;
      await client.query(
        'INSERT INTO week_results(session_id,week,result,aggregate_version) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [game.session.sessionId, result.week, JSON.stringify(result), game.session.version],
      );
    }
    const previousVersion = before?.events.at(-1)?.aggregateVersion ?? 0;
    for (const event of game.events) {
      if (event.aggregateVersion <= previousVersion) continue;
      const inserted = await client.query(
        'INSERT INTO outbox_events(event_id,aggregate_id,aggregate_version,event_type,payload,correlation_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING event_id',
        [
          event.eventId,
          game.id,
          event.aggregateVersion,
          event.eventType,
          JSON.stringify(event),
          event.correlationId,
          event.occurredAt,
        ],
      );
      if (inserted.rowCount)
        await client.query("SELECT pg_notify('beer_game_events',$1)", [
          JSON.stringify({ gameId: game.id, version: event.aggregateVersion }),
        ]);
    }
  }
}
