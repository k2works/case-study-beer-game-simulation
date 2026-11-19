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
  CredentialCode,
  DecidedByKind,
  DecisionBy,
  ExclusiveResult,
  GameRow,
  GameTx,
  GameUpdate,
  IdempotencyRow,
  JoinAttemptInput,
  JoinAttemptOutcome,
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

/**
 * 参加の窓のアドバイザリロックの classid（2 つの整数の形の第 1 引数）。
 * ゲームの書き込みは行の占有で、鍵の空間が交わらない（logical-components.md）。
 */
export const JOIN_WINDOW_LOCK_CLASS = 4200101;

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
    lastOperationAt: row.last_operation_at as Date,
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
  'game_id, name, status, week_count, current_week, setup_kind, version, created_at, last_operation_at, ended_at, end_reason, next_log_sequence';

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
        `insert into games (game_id, name, status, week_count, current_week, setup_kind, version, created_at, last_operation_at, ended_at, end_reason, next_log_sequence)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          game.gameId,
          game.name,
          game.status,
          game.weekCount,
          game.currentWeek,
          game.setupKind,
          game.version,
          game.createdAt,
          game.lastOperationAt,
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
      `select t.token_id, t.last_used_at, p.game_id, p.participant_id, a.role
         from return_tokens t
         join participants p on p.participant_id = t.participant_id
         left join role_assignments a on a.participant_id = p.participant_id
        where t.token_hash = $1 and t.revoked_at is null`,
      [hash],
    );
    const row = result.rows[0];
    return row
      ? {
          tokenId: row.token_id as string,
          gameId: row.game_id as string,
          participantId: row.participant_id as string,
          role: (row.role as Role | null) ?? null,
          lastUsedAt: row.last_used_at as Date,
        }
      : null;
  }

  async findCredentialCode(hashes: string[]): Promise<CredentialCode | null> {
    const result = await this.query(
      `select game_id, kind from access_codes
        where kind in ('facilitator', 'observer') and code_hash = any($1::text[]) and revoked_at is null`,
      [hashes],
    );
    const row = result.rows[0];
    return row ? { gameId: row.game_id as string, kind: row.kind as CredentialCode['kind'] } : null;
  }

  async touchToken(tokenId: string, now: Date, minIntervalMs: number): Promise<boolean> {
    const result = await this.query(
      `update return_tokens set last_used_at = $2
        where token_id = $1 and revoked_at is null and last_used_at <= $3`,
      [tokenId, now, new Date(now.getTime() - minIntervalMs)],
    );
    return result.rowCount === 1;
  }

  async attemptJoin(input: JoinAttemptInput): Promise<JoinAttemptOutcome> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      await client.query("select set_config('lock_timeout', $1, true)", [
        `${this.lockTimeoutMs}ms`,
      ]);
      // 接続元ごとの排他。窓が空でも効く。ロックはコミットで解放される。別の接続元は待たない
      await client.query('select pg_advisory_xact_lock($1::int, hashtext($2))', [
        JOIN_WINDOW_LOCK_CLASS,
        input.sourceKey,
      ]);
      await client.query('delete from join_attempts where source_key = $1 and attempted_at < $2', [
        input.sourceKey,
        new Date(input.now.getTime() - input.windowMs),
      ]);
      const counted = await client.query(
        'select count(*)::int as n from join_attempts where source_key = $1',
        [input.sourceKey],
      );
      const record = async (): Promise<void> => {
        await client.query('insert into join_attempts (source_key, attempted_at) values ($1, $2)', [
          input.sourceKey,
          input.now,
        ]);
      };
      let outcome: JoinAttemptOutcome;
      if ((counted.rows[0]?.n as number) >= input.maxAttempts) {
        // コードは検証しない。この試行も窓に加え、接続元ごとに最新の maxAttempts + 1 件だけ残す
        await record();
        await client.query(
          `delete from join_attempts
            where source_key = $1
              and id not in (select id from join_attempts where source_key = $1
                              order by attempted_at desc, id desc limit $2)`,
          [input.sourceKey, input.maxAttempts + 1],
        );
        outcome = { result: 'limited' };
      } else {
        const found = await client.query(
          `select game_id from access_codes
            where kind = 'join' and code_hash = any($1::text[]) and revoked_at is null`,
          [input.codeHashes],
        );
        const row = found.rows[0];
        if (row) {
          outcome = { result: 'valid', gameId: row.game_id as string };
        } else {
          await record();
          outcome = { result: 'invalid' };
        }
      }
      await client.query('COMMIT');
      return outcome;
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

  async sweepJoinAttempts(olderThan: Date): Promise<number> {
    // ロック中の行は飛ばす。参加の要求の処理と行を奪い合わず、待たない
    const result = await this.query(
      `delete from join_attempts
        where ctid in (select ctid from join_attempts where attempted_at < $1 for update skip locked)`,
      [olderThan],
    );
    return result.rowCount ?? 0;
  }

  async countJoinAttempts(sourceKey?: string): Promise<number> {
    const result =
      sourceKey === undefined
        ? await this.query('select count(*)::int as n from join_attempts', [])
        : await this.query('select count(*)::int as n from join_attempts where source_key = $1', [
            sourceKey,
          ]);
    return result.rows[0]?.n as number;
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

  async findStaleGames(before: Date, limit: number, exclude: readonly string[]): Promise<string[]> {
    // 述語は部分索引 games_stale_idx と同じ（status <> 'ended'）。除外は順序と上限の前に行う
    const result = await this.query(
      `select game_id from games
        where status <> 'ended' and last_operation_at <= $1 and game_id <> all($3::uuid[])
        order by last_operation_at asc, game_id asc
        limit $2`,
      [before, limit, [...exclude]],
    );
    return result.rows.map((row) => row.game_id as string);
  }

  async findExpiredGames(
    before: Date,
    limit: number,
    exclude: readonly string[],
  ): Promise<string[]> {
    // 述語は部分索引 games_expired_idx と同じ（status = 'ended'）
    const result = await this.query(
      `select game_id from games
        where status = 'ended' and ended_at <= $1 and game_id <> all($3::uuid[])
        order by ended_at asc, game_id asc
        limit $2`,
      [before, limit, [...exclude]],
    );
    return result.rows.map((row) => row.game_id as string);
  }

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<ExclusiveResult<T>> {
    // ロックを保つためだけの専用の接続。ゲームの処理（fn の中）は、プールのほかの接続を使う
    const client = await this.connect();
    let discard = false;
    try {
      let locked: boolean;
      try {
        const attempt = await client.query<Row>(
          'select pg_try_advisory_lock(hashtextextended($1, 0)) as locked',
          [key],
        );
        locked = attempt.rows[0]?.locked === true;
      } catch (error) {
        discard = true;
        throw error;
      }
      if (!locked) {
        return { acquired: false };
      }
      try {
        return { acquired: true, value: await fn() };
      } finally {
        try {
          const released = await client.query<Row>(
            'select pg_advisory_unlock(hashtextextended($1, 0)) as unlocked',
            [key],
          );
          // 解放できなかった接続は、ロックを持ったまま戻さず、破棄する（接続の終了とともにロックも消える）
          discard = released.rows[0]?.unlocked !== true;
        } catch {
          discard = true;
        }
      }
    } finally {
      client.release(discard);
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
  mutated = false;

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
    this.mutated = true;
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
      // last_used_at は発行の時刻から始める（BR17.6）
      'insert into return_tokens (token_id, participant_id, token_hash, issued_at, last_used_at) values ($1, $2, $3, $4, $4)',
      [randomUUID(), participant.participantId, tokenHash, issuedAt],
    );
  }

  async setAssignment(
    participantId: string,
    role: Role | null,
    assignmentId: string,
  ): Promise<void> {
    this.mutated = true;
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
    this.mutated = true;
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
    this.mutated = true;
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
    this.mutated = true;
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
    this.mutated = true;
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
    this.mutated = true;
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
    this.mutated = true;
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

  async touchOperation(at: Date): Promise<void> {
    // 減らさない（greatest）。版は変えず、履歴にも書かない
    await this.client.query(
      'update games set last_operation_at = greatest(last_operation_at, $2) where game_id = $1',
      [this.gameId, at],
    );
  }

  async deleteGame(): Promise<void> {
    // 子の表は外部キーの on delete cascade で、この 1 文の中で消える。status の条件で二重に守る（NFR6.7）
    const result = await this.client.query(
      "delete from games where game_id = $1 and status = 'ended'",
      [this.gameId],
    );
    if (result.rowCount !== 1) {
      throw new Error('終了していないゲームは削除できません');
    }
  }
}
