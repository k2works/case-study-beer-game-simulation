import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import type pg from 'pg';
import type { CredentialValidity } from '../../domain/credential.js';
import { roleOf, type Game, type GameSettings } from '../../domain/game.js';
import { ROLES, type Role } from '../../domain/role.js';
import type { RoleStates } from '../../domain/simulate-week.js';
import type {
  Decision,
  RoleWeekRecord,
  Session,
  WeekRecord,
} from '../../domain/session.js';
import {
  ConflictError,
  DuplicateError,
  type CredentialPurpose,
  type CredentialRepository,
  type EventLog,
  type GameRepository,
  type IdempotencyRecord,
  type IdempotencyRepository,
  type ObserverRepository,
  type RetentionRepository,
  type Principal,
  type Repositories,
  type SessionRepository,
} from '../../ports/index.js';

type Db = Pick<pg.PoolClient, 'query'>;
const UNIQUE_VIOLATION = '23505';

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if ((e as { code?: string }).code === UNIQUE_VIOLATION)
      throw new DuplicateError();
    throw e;
  }
}

class PgGames implements GameRepository {
  constructor(private readonly db: Db) {}

  private async hydrate(row: Record<string, unknown>): Promise<Game> {
    const { rows } = await this.db.query(
      'SELECT participant_id, display_name, role FROM participants WHERE game_id = $1 ORDER BY seq',
      [row.game_id],
    );
    // 参加の順（seq）に、役割ごとの担当の一覧を作る（共同担当）
    const assignments: Partial<Record<Role, string[]>> = {};
    for (const p of rows)
      if (p.role) (assignments[p.role as Role] ??= []).push(p.participant_id);
    const settings: GameSettings = {
      kind: row.settings_kind as GameSettings['kind'],
      finalWeek: row.final_week as number,
      demand: row.demand as GameSettings['demand'],
      holdingCostMinor: row.holding_cost_minor as number,
      backlogCostMinor: row.backlog_cost_minor as number,
      quantityMax: row.quantity_max as number,
      commitMode: row.commit_mode as GameSettings['commitMode'],
      changes: row.settings_changes as GameSettings['changes'],
      initialInventory: row.initial_inventory as number,
      orderDelayWeeks: row.order_delay_weeks as number,
      shipmentDelayWeeks: row.shipment_delay_weeks as number,
      productionDelayWeeks: row.production_delay_weeks as number,
      disclosure: row.disclosure_policy as GameSettings['disclosure'],
    };
    return {
      id: row.game_id as string,
      joinCode: row.join_code as string,
      status: row.status as Game['status'],
      version: row.version as number,
      settings,
      participants: rows.map((p) => ({
        id: p.participant_id,
        displayName: p.display_name,
      })),
      assignments,
    };
  }

  async find(id: string) {
    const { rows } = await this.db.query(
      'SELECT * FROM games WHERE game_id = $1 FOR UPDATE',
      [id],
    );
    return rows[0] ? this.hydrate(rows[0]) : null;
  }

  /** ロックを取らない読み取り（状況の表示のための表示名） */
  async participantNames(gameId: string) {
    const { rows } = await this.db.query(
      'SELECT participant_id, display_name FROM participants WHERE game_id = $1',
      [gameId],
    );
    return Object.fromEntries(
      rows.map((p) => [p.participant_id as string, p.display_name as string]),
    );
  }

  async findByJoinCode(joinCode: string) {
    const { rows } = await this.db.query(
      'SELECT * FROM games WHERE join_code = $1 FOR UPDATE',
      [joinCode],
    );
    return rows[0] ? this.hydrate(rows[0]) : null;
  }

  async save(game: Game, expectedVersion: number | null) {
    const s = game.settings;
    await guarded(async () => {
      if (expectedVersion === null) {
        await this.db.query(
          `INSERT INTO games (game_id, join_code, status, version, settings_kind, final_week,
             demand, holding_cost_minor, backlog_cost_minor, quantity_max, commit_mode,
             settings_changes, initial_inventory, order_delay_weeks, shipment_delay_weeks,
             production_delay_weeks, disclosure_policy)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            game.id,
            game.joinCode,
            game.status,
            game.version,
            s.kind,
            s.finalWeek,
            JSON.stringify(s.demand),
            s.holdingCostMinor,
            s.backlogCostMinor,
            s.quantityMax,
            s.commitMode,
            JSON.stringify(s.changes),
            s.initialInventory,
            s.orderDelayWeeks,
            s.shipmentDelayWeeks,
            s.productionDelayWeeks,
            s.disclosure,
          ],
        );
      } else {
        const { rowCount } = await this.db.query(
          'UPDATE games SET status = $2, version = $3 WHERE game_id = $1 AND version = $4',
          [game.id, game.status, game.version, expectedVersion],
        );
        if (rowCount === 0) throw new ConflictError();
      }
      for (const p of game.participants) {
        const role = roleOf(game, p.id) ?? null;
        await this.db.query(
          `INSERT INTO participants (participant_id, game_id, display_name, role)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (participant_id) DO UPDATE SET role = EXCLUDED.role`,
          [p.id, game.id, p.displayName, role],
        );
      }
    });
  }
}

/**
 * 担当の一覧。B4 までの形式（役割 → 参加者 ID の文字列）も一覧として読む。次の保存で新形式に書き戻る。
 */
function holdersOf(raw: Record<string, unknown>): Session['holders'] {
  const holders = {} as Record<Role, readonly string[]>;
  for (const r of ROLES) {
    const v = raw[r];
    holders[r] = Array.isArray(v) ? (v as string[]) : [v as string];
  }
  return holders;
}

class PgSessions implements SessionRepository {
  constructor(private readonly db: Db) {}

  async findByGame(gameId: string): Promise<Session | null> {
    const { rows } = await this.db.query(
      'SELECT * FROM sessions WHERE game_id = $1 FOR UPDATE',
      [gameId],
    );
    const row = rows[0];
    if (!row) return null;
    const decisionRows = (
      await this.db.query(
        'SELECT role, quantity, version, saved_by FROM role_decisions WHERE session_id = $1',
        [row.session_id],
      )
    ).rows;
    const decisions: Partial<Record<Role, Decision>> = {};
    for (const d of decisionRows) {
      decisions[d.role as Role] = {
        quantity: d.quantity,
        version: d.version,
        savedBy: d.saved_by,
      };
    }
    const resultRows = (
      await this.db.query(
        'SELECT * FROM week_role_results WHERE session_id = $1 ORDER BY week',
        [row.session_id],
      )
    ).rows;
    const byWeek = new Map<number, Partial<Record<Role, RoleWeekRecord>>>();
    for (const r of resultRows) {
      const roles = byWeek.get(r.week) ?? {};
      roles[r.role as Role] = {
        role: r.role,
        demand: r.demand,
        received: r.received,
        shipped: r.shipped,
        order: r.ordered,
        endingInventory: r.ending_inventory,
        endingBacklog: r.ending_backlog,
        weeklyCostMinor: r.weekly_cost_minor,
        cumulativeCostMinor: r.cumulative_cost_minor,
      };
      byWeek.set(r.week, roles);
    }
    const kinds = new Map(
      (
        await this.db.query(
          'SELECT week, commit_kind FROM week_results WHERE session_id = $1',
          [row.session_id],
        )
      ).rows.map((r) => [r.week as number, r.commit_kind as 'MANUAL' | 'AUTO']),
    );
    const history: WeekRecord[] = [...byWeek.entries()].map(
      ([week, roles]) => ({
        week,
        commitKind: kinds.get(week) ?? 'MANUAL',
        roles: roles as WeekRecord['roles'],
      }),
    );
    return {
      id: row.session_id,
      gameId: row.game_id,
      status: row.status,
      version: row.version,
      week: row.week,
      settings: row.settings,
      holders: holdersOf(row.holders),
      states: row.role_states as RoleStates,
      decisions,
      history,
    };
  }

  async save(session: Session, expectedVersion: number | null) {
    await guarded(async () => {
      const json = [
        JSON.stringify(session.settings),
        JSON.stringify(session.holders),
        JSON.stringify(session.states),
      ];
      if (expectedVersion === null) {
        await this.db.query(
          `INSERT INTO sessions (session_id, game_id, status, week, version, settings, holders, role_states)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            session.id,
            session.gameId,
            session.status,
            session.week,
            session.version,
            ...json,
          ],
        );
      } else {
        const { rowCount } = await this.db.query(
          `UPDATE sessions SET status = $2, week = $3, version = $4,
             settings = $5, holders = $6, role_states = $7
           WHERE session_id = $1 AND version = $8`,
          [
            session.id,
            session.status,
            session.week,
            session.version,
            ...json,
            expectedVersion,
          ],
        );
        if (rowCount === 0) throw new ConflictError();
      }
      await this.db.query('DELETE FROM role_decisions WHERE session_id = $1', [
        session.id,
      ]);
      for (const role of ROLES) {
        const d = session.decisions[role];
        if (!d) continue;
        await this.db.query(
          `INSERT INTO role_decisions (session_id, week, role, quantity, version, saved_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [session.id, session.week, role, d.quantity, d.version, d.savedBy],
        );
      }
      const known = new Set(
        (
          await this.db.query(
            'SELECT week FROM week_results WHERE session_id = $1',
            [session.id],
          )
        ).rows.map((r) => r.week as number),
      );
      for (const record of session.history) {
        if (known.has(record.week)) continue;
        await this.db.query(
          'INSERT INTO week_results (session_id, week, commit_kind) VALUES ($1,$2,$3)',
          [session.id, record.week, record.commitKind],
        );
        for (const role of ROLES) {
          const r = record.roles[role];
          await this.db.query(
            `INSERT INTO week_role_results (session_id, week, role, demand, received, shipped,
               ordered, ending_inventory, ending_backlog, weekly_cost_minor, cumulative_cost_minor)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              session.id,
              record.week,
              role,
              r.demand,
              r.received,
              r.shipped,
              r.order,
              r.endingInventory,
              r.endingBacklog,
              r.weeklyCostMinor,
              r.cumulativeCostMinor,
            ],
          );
        }
      }
      // 画面への通知（版の変化だけを伝え、状態の内容は含めない）
      await this.db.query('SELECT pg_notify($1, $2)', [
        'session_changed',
        session.gameId,
      ]);
    });
  }
}

class PgCredentials implements CredentialRepository {
  constructor(private readonly db: Db) {}

  async save(
    digest: string,
    principal: Principal,
    purpose: CredentialPurpose,
    validity: CredentialValidity,
  ) {
    if (purpose === 'SESSION') {
      await this.db.query(
        `INSERT INTO browser_sessions (credential_digest, game_id, actor_kind, participant_id,
           observer_id, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          digest,
          principal.gameId,
          principal.kind,
          principal.participantId ?? null,
          principal.observerId ?? null,
          validity.expiresAt,
        ],
      );
      return;
    }
    if (principal.kind === 'OBSERVER')
      throw new Error('観察者は復帰コードを持ちません');
    // 復帰コードは主体ごとに 1 つ。上書きで、前の復帰コードは使えなくなる
    const { rowCount } =
      principal.kind === 'FACILITATOR'
        ? await this.db.query(
            `UPDATE games SET facilitator_digest = $2, facilitator_expires_at = $3,
               facilitator_revoked_at = NULL
             WHERE game_id = $1`,
            [principal.gameId, digest, validity.expiresAt],
          )
        : await this.db.query(
            `UPDATE participants SET recovery_digest = $3, recovery_expires_at = $4,
               recovery_revoked_at = NULL
             WHERE game_id = $1 AND participant_id = $2`,
            [
              principal.gameId,
              principal.participantId,
              digest,
              validity.expiresAt,
            ],
          );
    if (rowCount === 0) throw new Error('復帰コードの保存先の主体がありません');
  }

  async find(
    digests: readonly string[],
    purpose: CredentialPurpose,
    at: Date,
  ): Promise<Principal | null> {
    const { rows } =
      purpose === 'SESSION'
        ? await this.db.query(
            `SELECT game_id, actor_kind, participant_id, observer_id FROM browser_sessions
             WHERE credential_digest = ANY($1) AND revoked_at IS NULL AND expires_at > $2
             LIMIT 1`,
            [digests, at],
          )
        : await this.db.query(
            `SELECT game_id, 'PARTICIPANT' AS actor_kind, participant_id FROM participants
             WHERE recovery_digest = ANY($1) AND recovery_revoked_at IS NULL AND recovery_expires_at > $2
             UNION ALL
             SELECT game_id, 'FACILITATOR', NULL FROM games
             WHERE facilitator_digest = ANY($1) AND facilitator_revoked_at IS NULL AND facilitator_expires_at > $2
             LIMIT 1`,
            [digests, at],
          );
    const r = rows[0];
    if (!r) return null;
    return {
      gameId: r.game_id,
      kind: r.actor_kind,
      ...(r.participant_id ? { participantId: r.participant_id } : {}),
      ...(r.observer_id ? { observerId: r.observer_id } : {}),
    };
  }

  async revokeAll(principal: Principal, at: Date) {
    const participantId = principal.participantId ?? null;
    await this.db.query(
      `UPDATE browser_sessions SET revoked_at = COALESCE(revoked_at, $5)
       WHERE game_id = $1 AND actor_kind = $2 AND participant_id IS NOT DISTINCT FROM $3
         AND observer_id IS NOT DISTINCT FROM $4`,
      [
        principal.gameId,
        principal.kind,
        participantId,
        principal.observerId ?? null,
        at,
      ],
    );
    if (principal.kind === 'OBSERVER') return;
    if (principal.kind === 'FACILITATOR') {
      await this.db.query(
        `UPDATE games SET facilitator_revoked_at = COALESCE(facilitator_revoked_at, $2)
         WHERE game_id = $1`,
        [principal.gameId, at],
      );
    } else {
      await this.db.query(
        `UPDATE participants SET recovery_revoked_at = COALESCE(recovery_revoked_at, $3)
         WHERE game_id = $1 AND participant_id = $2`,
        [principal.gameId, participantId, at],
      );
    }
  }
}

class PgObservers implements ObserverRepository {
  constructor(private readonly db: Db) {}

  async saveInvitation(
    digest: string,
    inv: { id: string; gameId: string; validity: CredentialValidity },
  ) {
    await this.db.query(
      `INSERT INTO observer_invitations (invitation_id, game_id, code_digest, expires_at)
       VALUES ($1,$2,$3,$4)`,
      [inv.id, inv.gameId, digest, inv.validity.expiresAt],
    );
  }

  async findInvitation(digests: readonly string[], at: Date) {
    const { rows } = await this.db.query(
      `SELECT invitation_id, game_id FROM observer_invitations
       WHERE code_digest = ANY($1) AND revoked_at IS NULL AND expires_at > $2 LIMIT 1`,
      [digests, at],
    );
    return rows[0]
      ? { id: rows[0].invitation_id, gameId: rows[0].game_id }
      : null;
  }

  async revokeInvitation(gameId: string, id: string, at: Date) {
    const { rowCount } = await this.db.query(
      `UPDATE observer_invitations SET revoked_at = COALESCE(revoked_at, $3)
       WHERE game_id = $1 AND invitation_id = $2`,
      [gameId, id, at],
    );
    return (rowCount ?? 0) > 0;
  }

  async activeInvitations(gameId: string, at: Date) {
    const { rows } = await this.db.query(
      `SELECT invitation_id, expires_at FROM observer_invitations
       WHERE game_id = $1 AND revoked_at IS NULL AND expires_at > $2 ORDER BY created_at`,
      [gameId, at],
    );
    return rows.map((r) => ({
      id: r.invitation_id as string,
      expiresAt: r.expires_at as Date,
    }));
  }

  async addObserver(o: {
    id: string;
    gameId: string;
    invitationId: string;
    displayName: string;
  }) {
    await this.db.query(
      `INSERT INTO observers (observer_id, game_id, invitation_id, display_name)
       VALUES ($1,$2,$3,$4)`,
      [o.id, o.gameId, o.invitationId, o.displayName],
    );
  }

  async countObservers(gameId: string) {
    const { rows } = await this.db.query(
      'SELECT count(*)::int AS n FROM observers WHERE game_id = $1',
      [gameId],
    );
    return rows[0].n as number;
  }
}

class PgRetention implements RetentionRepository {
  constructor(private readonly db: Db) {}

  async schedule(gameId: string, policy: { days: number; deleteAfter: Date }) {
    await this.db.query(
      'UPDATE games SET retention_days = $2, delete_after = $3 WHERE game_id = $1',
      [gameId, policy.days, policy.deleteAfter],
    );
  }

  async policyOf(gameId: string) {
    const { rows } = await this.db.query(
      'SELECT retention_days, delete_after FROM games WHERE game_id = $1',
      [gameId],
    );
    return rows[0]
      ? {
          days: rows[0].retention_days as number,
          deleteAfter: rows[0].delete_after as Date,
        }
      : null;
  }

  async due(at: Date, maxAttempts: number, limit: number) {
    const { rows } = await this.db.query(
      `SELECT game_id FROM games
        WHERE delete_after <= $1 AND deletion_attempts < $2
        ORDER BY delete_after LIMIT $3`,
      [at, maxAttempts, limit],
    );
    return rows.map((r) => ({ gameId: r.game_id as string }));
  }

  /** games からの連鎖削除で、ゲームの ID を持つすべての行を消す */
  async deleteGame(gameId: string) {
    const { rowCount } = await this.db.query(
      'DELETE FROM games WHERE game_id = $1',
      [gameId],
    );
    return (rowCount ?? 0) > 0;
  }

  async recordFailure(gameId: string, at: Date) {
    const { rows } = await this.db.query(
      `UPDATE games SET deletion_attempts = deletion_attempts + 1, deletion_failed_at = $2
        WHERE game_id = $1 RETURNING deletion_attempts`,
      [gameId, at],
    );
    return (rows[0]?.deletion_attempts as number | undefined) ?? 0;
  }

  async saveReceipt(receipt: {
    reference: string;
    outcome: 'DELETED';
    recordedAt: Date;
    expiresAt: Date;
  }) {
    await this.db.query(
      `INSERT INTO deletion_receipts (reference, outcome, recorded_at, expires_at)
       VALUES ($1,$2,$3,$4)`,
      [
        receipt.reference,
        receipt.outcome,
        receipt.recordedAt,
        receipt.expiresAt,
      ],
    );
  }
}

/** 応答の暗号化: AES-256-GCM。保存形式は iv(12) | tag(16) | 暗号文 */
export function encrypt(key: Buffer, value: unknown): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
export function decrypt(key: Buffer, data: Buffer): unknown {
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  const text = Buffer.concat([
    decipher.update(data.subarray(28)),
    decipher.final(),
  ]);
  return JSON.parse(text.toString('utf8'));
}

const SCOPE = 'commit';
const digestOfKey = (key: string) =>
  createHash('sha256').update(key).digest('hex');

class PgIdempotency implements IdempotencyRepository {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
  ) {}
  async find(gameId: string, key: string): Promise<IdempotencyRecord | null> {
    const { rows } = await this.db.query(
      `SELECT fingerprint, response FROM idempotency_records
       WHERE game_id = $1 AND scope = $2 AND key_digest = $3 AND expires_at > now()`,
      [gameId, SCOPE, digestOfKey(key)],
    );
    const r = rows[0];
    return r
      ? {
          gameId,
          key,
          fingerprint: r.fingerprint,
          response: decrypt(this.key, r.response),
        }
      : null;
  }
  async save(record: IdempotencyRecord) {
    await guarded(() =>
      this.db.query(
        `INSERT INTO idempotency_records (game_id, scope, key_digest, fingerprint, response)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          record.gameId,
          SCOPE,
          digestOfKey(record.key),
          record.fingerprint,
          encrypt(this.key, record.response),
        ],
      ),
    );
  }
}

class PgEvents implements EventLog {
  constructor(private readonly db: Db) {}
  async append(gameId: string, events: readonly object[]) {
    for (const event of events) {
      await this.db.query(
        'INSERT INTO events (game_id, event_type, payload) VALUES ($1,$2,$3)',
        [
          gameId,
          (event as { type?: string }).type ?? 'Unknown',
          JSON.stringify(event),
        ],
      );
    }
  }
}

export function repositoriesOver(db: Db, idempotencyKey: Buffer): Repositories {
  return {
    games: new PgGames(db),
    sessions: new PgSessions(db),
    credentials: new PgCredentials(db),
    observers: new PgObservers(db),
    retention: new PgRetention(db),
    idempotency: new PgIdempotency(db, idempotencyKey),
    events: new PgEvents(db),
  };
}
