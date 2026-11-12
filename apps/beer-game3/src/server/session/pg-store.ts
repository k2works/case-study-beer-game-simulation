import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  CodeCollisionError,
  VersionConflictError,
  notFoundError,
  unavailableError,
} from '../errors.js';
import type { EndReason, GameStatus, Role, SetupKind, SlotKind } from '../domain/types.js';
import type { ActorKind, LogEntryRow, LogKind, NewLogEntry } from './history.js';
import { toSafeInteger, toSafeIntegerOrNull } from './numeric.js';
import type {
  AccessCodeKind,
  AccessCodeRow,
  AssignmentRow,
  ConfirmedRecord,
  DecidedByKind,
  DecisionBy,
  GameRow,
  GameTx,
  GameUpdate,
  IdempotencyRow,
  NewGame,
  ParticipantRow,
  ResolvedToken,
  SettingsRow,
  SlotRow,
  Snapshot,
  Store,
  WeekRecordRow,
} from './store.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCK_NOT_AVAILABLE = '55P03';
const UNIQUE_VIOLATION = '23505';

export interface PgStoreOptions {
  connectionString: string;
  /** 同じゲームの書き込みの順番待ちの上限（ミリ秒）。既定 3000（NFR3.7） */
  lockTimeoutMs?: number;
  /** 接続プールの大きさ。既定 20 */
  poolSize?: number;
}

type Row = Record<string, unknown>;

/** 64 ビット整数（pg は文字列で返す）を、安全な整数の範囲で数値にする（BR8.2）。範囲外は失敗にする。 */
const num = toSafeInteger;
const numOrNull = toSafeIntegerOrNull;

function mapGame(row: Row): GameRow {
  return {
    gameId: row.game_id as string,
    name: row.name as string,
    status: row.status as GameStatus,
    weekCount: num(row.week_count),
    currentWeek: num(row.current_week),
    setupKind: row.setup_kind as SetupKind,
    version: num(row.version),
    createdAt: row.created_at as Date,
    endedAt: (row.ended_at as Date | null) ?? null,
    endReason: (row.end_reason as EndReason | null) ?? null,
    nextLogSequence: num(row.next_log_sequence),
  };
}

function mapWeekRecord(row: Row): WeekRecordRow {
  return {
    weekRecordId: row.week_record_id as string,
    gameId: row.game_id as string,
    week: num(row.week),
    role: row.role as Role,
    decision: numOrNull(row.decision),
    receipt: numOrNull(row.receipt),
    ordersReceived: numOrNull(row.orders_received),
    shipped: numOrNull(row.shipped),
    inventory: numOrNull(row.inventory),
    backlog: numOrNull(row.backlog),
    weeklyCost: numOrNull(row.weekly_cost),
    cumulativeCost: numOrNull(row.cumulative_cost),
    isConfirmed: row.is_confirmed as boolean,
    decidedByKind: (row.decided_by_kind as DecidedByKind | null) ?? null,
    decidedByParticipantId: (row.decided_by_participant_id as string | null) ?? null,
    decidedAt: (row.decided_at as Date | null) ?? null,
    decisionRevision: num(row.decision_revision),
  };
}

function mapLog(row: Row): LogEntryRow {
  return {
    entryId: row.entry_id as string,
    gameId: row.game_id as string,
    sequence: num(row.sequence),
    kind: row.kind as LogKind,
    actorKind: row.actor_kind as ActorKind,
    occurredAt: row.occurred_at as Date,
    week: row.week === null ? null : num(row.week),
    role: (row.role as Role | null) ?? null,
    detail: row.detail as LogEntryRow['detail'],
  };
}

/** 履歴の 1 件を書く。履歴の表に対して、アプリケーションが書く文はこの INSERT だけ（NFR9.2）。 */
async function insertLog(
  client: pg.ClientBase,
  gameId: string,
  sequence: number,
  entry: NewLogEntry,
): Promise<void> {
  await client.query(
    `insert into operation_log_entries
       (entry_id, game_id, sequence, kind, actor_kind, occurred_at, week, role, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.entryId,
      gameId,
      sequence,
      entry.kind,
      entry.actorKind,
      entry.occurredAt,
      entry.week,
      entry.role,
      JSON.stringify(entry.detail),
    ],
  );
}

const GAME_COLUMNS =
  'game_id, name, status, week_count, current_week, setup_kind, version, created_at, ended_at, end_reason, next_log_sequence';

/**
 * PostgreSQL の保存（C3）。
 * - 書き込みはゲームの行を `select ... for update` で占有し（ゲーム単位の直列処理）、待ちの上限は lock_timeout（NFR3.7）。
 * - 占有は 1 つのトランザクションの間だけ。結果、枠、週の進行は同じトランザクションでコミットする（NFR2.1）。
 * - 読み取りは行を占有しない（NFR4.4）。複数の問い合わせを 1 つの読み取り専用トランザクションにして一貫させる。
 */
export class PgStore implements Store {
  private readonly pool: pg.Pool;
  private readonly lockTimeoutMs: number;

  constructor(options: PgStoreOptions) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? 3000;
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.poolSize ?? 20,
      // 接続を待てないときも、順番待ちの時間切れと同じ unavailable で返す
      connectionTimeoutMillis: Math.max(this.lockTimeoutMs, 1000),
    });
    // アイドルの接続の切断でプロセスを落とさない（次の要求で張り直す）
    this.pool.on('error', () => undefined);
  }

  async createGame(input: NewGame): Promise<void> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      const { game, settings } = input;
      await client.query(
        `insert into games (game_id, name, status, week_count, current_week, setup_kind, version, created_at, ended_at, end_reason, next_log_sequence)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          game.gameId,
          game.name,
          game.status,
          game.weekCount,
          game.currentWeek,
          game.setupKind,
          game.version,
          game.createdAt,
          game.endedAt,
          game.endReason,
          input.logs.length + 1,
        ],
      );
      await client.query(
        `insert into game_settings (settings_id, game_id, week_count, initial_inventory, initial_pipeline_quantity,
           inventory_unit_cost, backlog_unit_cost, visibility_scope)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          settings.settingsId,
          settings.gameId,
          settings.weekCount,
          settings.initialInventory,
          settings.initialPipelineQuantity,
          settings.inventoryUnitCost,
          settings.backlogUnitCost,
          settings.visibilityScope,
        ],
      );
      await client.query(
        `insert into demand_series (series_id, settings_id, series_values, is_provisional_default)
         values ($1, $2, $3, $4)`,
        [randomUUID(), settings.settingsId, settings.demandSeries, settings.isProvisionalDefault],
      );
      for (const code of input.codes) {
        await client.query(
          `insert into access_codes (code_id, game_id, kind, code_hash, code_sealed, issued_at)
           values ($1, $2, $3, $4, $5, $6)`,
          [code.codeId, code.gameId, code.kind, code.codeHash, code.codeSealed, code.issuedAt],
        );
      }
      for (const [index, entry] of input.logs.entries()) {
        await insertLog(client, game.gameId, index + 1, entry);
      }
      await client.query('COMMIT');
    } catch (error) {
      await this.rollback(client);
      if (isPgError(error, UNIQUE_VIOLATION) && String(error.constraint).includes('code_hash')) {
        throw new CodeCollisionError();
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async findCodeByHash(
    hashes: string[],
    kind: AccessCodeKind,
  ): Promise<{ gameId: string; kind: AccessCodeKind } | null> {
    const result = await this.query(
      'select game_id, kind from access_codes where kind = $1 and code_hash = any($2::text[]) and revoked_at is null',
      [kind, hashes],
    );
    const row = result.rows[0];
    return row ? { gameId: row.game_id as string, kind: row.kind as AccessCodeKind } : null;
  }

  async findTokenByHash(hash: string): Promise<ResolvedToken | null> {
    const result = await this.query(
      `select p.game_id, p.participant_id, a.role
         from return_tokens t
         join participants p on p.participant_id = t.participant_id
         left join role_assignments a on a.participant_id = p.participant_id
        where t.token_hash = $1 and t.revoked_at is null`,
      [hash],
    );
    const row = result.rows[0];
    return row
      ? {
          gameId: row.game_id as string,
          participantId: row.participant_id as string,
          role: (row.role as Role | null) ?? null,
        }
      : null;
  }

  async getAccessCode(gameId: string, kind: AccessCodeKind): Promise<AccessCodeRow | null> {
    if (!UUID.test(gameId)) {
      return null;
    }
    const result = await this.query(
      'select code_id, game_id, kind, code_hash, code_sealed, issued_at from access_codes where game_id = $1 and kind = $2',
      [gameId, kind],
    );
    const row = result.rows[0];
    return row
      ? {
          codeId: row.code_id as string,
          gameId: row.game_id as string,
          kind: row.kind as AccessCodeKind,
          codeHash: row.code_hash as string,
          codeSealed: (row.code_sealed as string | null) ?? null,
          issuedAt: row.issued_at as Date,
        }
      : null;
  }

  async readSnapshot(gameId: string): Promise<Snapshot | null> {
    if (!UUID.test(gameId)) {
      return null;
    }
    const client = await this.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshot = await readSnapshotWith(client, gameId);
      await client.query('COMMIT');
      return snapshot;
    } catch (error) {
      await this.rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async readHistory(gameId: string): Promise<LogEntryRow[]> {
    if (!UUID.test(gameId)) {
      return [];
    }
    const result = await this.query(
      'select * from operation_log_entries where game_id = $1 order by sequence',
      [gameId],
    );
    return result.rows.map(mapLog);
  }

  async transact<T>(gameId: string, fn: (tx: GameTx) => Promise<T>): Promise<T> {
    if (!UUID.test(gameId)) {
      throw notFoundError('ゲームが見つかりません');
    }
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      await client.query("select set_config('lock_timeout', $1, true)", [
        `${this.lockTimeoutMs}ms`,
      ]);
      const locked = await client.query(
        `select ${GAME_COLUMNS} from games where game_id = $1 for update`,
        [gameId],
      );
      const row = locked.rows[0];
      if (!row) {
        throw notFoundError('ゲームが見つかりません');
      }
      const tx = new PgTx(client, gameId, mapGame(row));
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await this.rollback(client);
      if (isPgError(error, LOCK_NOT_AVAILABLE)) {
        throw unavailableError();
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.query('select 1', []);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** 接続を取る。待てなければ unavailable（接続の順番待ちの時間切れ）。 */
  private async connect(): Promise<pg.PoolClient> {
    try {
      return await this.pool.connect();
    } catch (error) {
      if (error instanceof Error && /timeout exceeded when trying to connect/.test(error.message)) {
        throw unavailableError();
      }
      throw error;
    }
  }

  private async query(text: string, values: unknown[]): Promise<pg.QueryResult<Row>> {
    const client = await this.connect();
    try {
      return await client.query<Row>(text, values);
    } finally {
      client.release();
    }
  }

  private async rollback(client: pg.PoolClient): Promise<void> {
    try {
      await client.query('ROLLBACK');
    } catch {
      // 接続が壊れている場合は、プールが次の取得で捨てる
    }
  }
}

function isPgError(error: unknown, code: string): error is { code: string; constraint?: string } {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

async function readSnapshotWith(client: pg.ClientBase, gameId: string): Promise<Snapshot | null> {
  const game = await client.query<Row>(`select ${GAME_COLUMNS} from games where game_id = $1`, [
    gameId,
  ]);
  const gameRow = game.rows[0];
  if (!gameRow) {
    return null;
  }
  return {
    game: mapGame(gameRow),
    settings: await readSettings(client, gameId),
    participants: await readParticipants(client, gameId),
    assignments: await readAssignments(client, gameId),
    weekRecords: await readWeekRecords(client, gameId),
    slots: await readSlots(client, gameId),
  };
}

async function readSettings(client: pg.ClientBase, gameId: string): Promise<SettingsRow> {
  const result = await client.query<Row>(
    `select s.settings_id, s.game_id, s.week_count, s.initial_inventory, s.initial_pipeline_quantity,
            s.inventory_unit_cost, s.backlog_unit_cost, s.visibility_scope, d.series_values, d.is_provisional_default
       from game_settings s join demand_series d on d.settings_id = s.settings_id
      where s.game_id = $1`,
    [gameId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('ゲームの設定が見つかりません');
  }
  return {
    settingsId: row.settings_id as string,
    gameId: row.game_id as string,
    weekCount: num(row.week_count),
    initialInventory: num(row.initial_inventory),
    initialPipelineQuantity: num(row.initial_pipeline_quantity),
    inventoryUnitCost: num(row.inventory_unit_cost),
    backlogUnitCost: num(row.backlog_unit_cost),
    visibilityScope: row.visibility_scope as 'team_totals',
    demandSeries: (row.series_values as number[]).map(Number),
    isProvisionalDefault: row.is_provisional_default as boolean,
  };
}

async function readParticipants(client: pg.ClientBase, gameId: string): Promise<ParticipantRow[]> {
  const result = await client.query<Row>(
    'select participant_id, game_id, display_name, join_order, joined_at, replaced_at, created_by_facilitator from participants where game_id = $1 order by join_order',
    [gameId],
  );
  return result.rows.map((row) => ({
    participantId: row.participant_id as string,
    gameId: row.game_id as string,
    displayName: row.display_name as string,
    joinOrder: num(row.join_order),
    joinedAt: row.joined_at as Date,
    replacedAt: (row.replaced_at as Date | null) ?? null,
    createdByFacilitator: row.created_by_facilitator as boolean,
  }));
}

async function readAssignments(client: pg.ClientBase, gameId: string): Promise<AssignmentRow[]> {
  const result = await client.query<Row>(
    `select a.assignment_id, a.game_id, a.participant_id, a.role
       from role_assignments a join participants p on p.participant_id = a.participant_id
      where a.game_id = $1 order by p.join_order`,
    [gameId],
  );
  return result.rows.map((row) => ({
    assignmentId: row.assignment_id as string,
    gameId: row.game_id as string,
    participantId: row.participant_id as string,
    role: row.role as Role,
  }));
}

async function readWeekRecords(
  client: pg.ClientBase,
  gameId: string,
  week?: number,
): Promise<WeekRecordRow[]> {
  const result = await client.query<Row>(
    `select * from week_records where game_id = $1 ${week === undefined ? '' : 'and week = $2'} order by week, role`,
    week === undefined ? [gameId] : [gameId, week],
  );
  return result.rows.map(mapWeekRecord);
}

async function readSlots(client: pg.ClientBase, gameId: string): Promise<SlotRow[]> {
  const result = await client.query<Row>(
    'select kind, role, remaining_weeks, quantity from pipeline_slots where game_id = $1 order by kind, role, remaining_weeks',
    [gameId],
  );
  return result.rows.map((row) => ({
    kind: row.kind as SlotKind,
    role: row.role as Role,
    remainingWeeks: num(row.remaining_weeks) as 1 | 2,
    quantity: num(row.quantity),
  }));
}

class PgTx implements GameTx {
  constructor(
    private readonly client: pg.PoolClient,
    private readonly gameId: string,
    private current: GameRow,
  ) {}

  game(): GameRow {
    return { ...this.current };
  }

  settings(): Promise<SettingsRow> {
    return readSettings(this.client, this.gameId);
  }

  participants(): Promise<ParticipantRow[]> {
    return readParticipants(this.client, this.gameId);
  }

  assignments(): Promise<AssignmentRow[]> {
    return readAssignments(this.client, this.gameId);
  }

  weekRecords(week?: number): Promise<WeekRecordRow[]> {
    return readWeekRecords(this.client, this.gameId, week);
  }

  slots(): Promise<SlotRow[]> {
    return readSlots(this.client, this.gameId);
  }

  async snapshot(): Promise<Snapshot> {
    const snapshot = await readSnapshotWith(this.client, this.gameId);
    if (!snapshot) {
      throw notFoundError('ゲームが見つかりません');
    }
    return snapshot;
  }

  async addParticipant(
    participant: ParticipantRow,
    tokenHash: string,
    issuedAt: Date,
  ): Promise<void> {
    await this.client.query(
      `insert into participants (participant_id, game_id, display_name, join_order, joined_at, replaced_at, created_by_facilitator)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        participant.participantId,
        participant.gameId,
        participant.displayName,
        participant.joinOrder,
        participant.joinedAt,
        participant.replacedAt,
        participant.createdByFacilitator,
      ],
    );
    await this.client.query(
      'insert into return_tokens (token_id, participant_id, token_hash, issued_at) values ($1, $2, $3, $4)',
      [randomUUID(), participant.participantId, tokenHash, issuedAt],
    );
  }

  async setAssignment(
    participantId: string,
    role: Role | null,
    assignmentId: string,
  ): Promise<void> {
    await this.client.query('delete from role_assignments where participant_id = $1', [
      participantId,
    ]);
    if (role !== null) {
      await this.client.query(
        'insert into role_assignments (assignment_id, game_id, participant_id, role) values ($1, $2, $3, $4)',
        [assignmentId, this.gameId, participantId, role],
      );
    }
  }

  async insertWeekRecords(rows: WeekRecordRow[]): Promise<void> {
    await this.client.query(
      `insert into week_records (week_record_id, game_id, week, role, decision)
       select * from unnest($1::uuid[], $2::uuid[], $3::int[], $4::text[], $5::int[])`,
      [
        rows.map((r) => r.weekRecordId),
        rows.map((r) => r.gameId),
        rows.map((r) => r.week),
        rows.map((r) => r.role),
        rows.map((r) => r.decision),
      ],
    );
  }

  async setDecision(
    week: number,
    role: Role,
    quantity: number,
    by: DecisionBy,
    at: Date,
  ): Promise<void> {
    const result = await this.client.query(
      `update week_records
          set decision = $4, decided_by_kind = $5, decided_by_participant_id = $6,
              decided_at = $7, decision_revision = decision_revision + 1
        where game_id = $1 and week = $2 and role = $3 and not is_confirmed`,
      [this.gameId, week, role, quantity, by.kind, by.participantId, at],
    );
    if (result.rowCount !== 1) {
      throw new Error('入力できる週の記録がありません');
    }
  }

  async hasActiveToken(participantId: string): Promise<boolean> {
    const result = await this.client.query(
      'select 1 from return_tokens where participant_id = $1 and revoked_at is null limit 1',
      [participantId],
    );
    return result.rowCount === 1;
  }

  async replaceParticipant(participantId: string, at: Date): Promise<void> {
    const updated = await this.client.query(
      'update participants set replaced_at = $2 where participant_id = $1 and game_id = $3',
      [participantId, at, this.gameId],
    );
    if (updated.rowCount !== 1) {
      throw new Error('入れ替える参加者がいません');
    }
    await this.client.query(
      'update return_tokens set revoked_at = $2 where participant_id = $1 and revoked_at is null',
      [participantId, at],
    );
  }

  async confirmRecords(week: number, records: ConfirmedRecord[]): Promise<void> {
    for (const record of records) {
      const result = await this.client.query(
        `update week_records
            set receipt = $4, orders_received = $5, shipped = $6, inventory = $7, backlog = $8,
                weekly_cost = $9, cumulative_cost = $10, is_confirmed = true
          where game_id = $1 and week = $2 and role = $3`,
        [
          this.gameId,
          week,
          record.role,
          record.receipt,
          record.ordersReceived,
          record.shipped,
          record.inventory,
          record.backlog,
          record.weeklyCost,
          record.cumulativeCost,
        ],
      );
      if (result.rowCount !== 1) {
        throw new Error('確定する週の記録がありません');
      }
    }
  }

  async replaceSlots(rows: SlotRow[]): Promise<void> {
    await this.client.query('delete from pipeline_slots where game_id = $1', [this.gameId]);
    await this.client.query(
      `insert into pipeline_slots (pipeline_slot_id, game_id, kind, role, remaining_weeks, quantity)
       select gen_random_uuid(), $1, k, r, w, q
         from unnest($2::text[], $3::text[], $4::int[], $5::int[]) as t(k, r, w, q)`,
      [
        this.gameId,
        rows.map((r) => r.kind),
        rows.map((r) => r.role),
        rows.map((r) => r.remainingWeeks),
        rows.map((r) => r.quantity),
      ],
    );
  }

  async findIdempotency(
    operation: IdempotencyRow['operation'],
    requesterId: string,
    key: string,
  ): Promise<IdempotencyRow | null> {
    const result = await this.client.query<Row>(
      `select record_id, game_id, key, operation, requester_id, request_digest, response_body, created_at
         from idempotency_records
        where game_id = $1 and operation = $2 and requester_id = $3 and key = $4`,
      [this.gameId, operation, requesterId, key],
    );
    const row = result.rows[0];
    return row
      ? {
          recordId: row.record_id as string,
          gameId: row.game_id as string,
          key: row.key as string,
          operation: row.operation as IdempotencyRow['operation'],
          requesterId: row.requester_id as string,
          requestDigest: row.request_digest as string,
          responseBody: row.response_body,
          createdAt: row.created_at as Date,
        }
      : null;
  }

  async saveIdempotency(row: IdempotencyRow): Promise<void> {
    await this.client.query(
      `insert into idempotency_records (record_id, game_id, key, operation, requester_id, request_digest, response_body, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.recordId,
        row.gameId,
        row.key,
        row.operation,
        row.requesterId,
        row.requestDigest,
        JSON.stringify(row.responseBody),
        row.createdAt,
      ],
    );
  }

  async updateGame(
    update: GameUpdate,
    expectedVersion: number,
    logs: readonly NewLogEntry[],
  ): Promise<GameRow> {
    const firstSequence = this.current.nextLogSequence;
    const result = await this.client.query<Row>(
      `update games
          set status = coalesce($3, status),
              current_week = coalesce($4, current_week),
              ended_at = case when $5::boolean then $6::timestamptz else ended_at end,
              end_reason = case when $7::boolean then $8::text else end_reason end,
              next_log_sequence = next_log_sequence + $9::int,
              version = version + 1
        where game_id = $1 and version = $2
        returning ${GAME_COLUMNS}`,
      [
        this.gameId,
        expectedVersion,
        update.status ?? null,
        update.currentWeek ?? null,
        update.endedAt !== undefined,
        update.endedAt ?? null,
        update.endReason !== undefined,
        update.endReason ?? null,
        logs.length,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new VersionConflictError();
    }
    // 履歴は、状態の更新と同じトランザクションの中で足す（BR13.1）
    for (const [index, entry] of logs.entries()) {
      await insertLog(this.client, this.gameId, firstSequence + index, entry);
    }
    this.current = mapGame(row);
    return { ...this.current };
  }
}
